/**
 * Claude cross-verification (step 9).
 *
 * After the sheet is generated the user can trigger a pass where Claude reads the
 * finished rows and reports anything that looks wrong — malformed merged addresses,
 * a proprietor name that reads like an institution, a price that does not fit the
 * neighbourhood, an owner address that is not mailable.
 *
 * Design notes:
 *  - Rows are sent in batches with a JSON-schema-constrained response, so the output is
 *    always parseable and never needs regex rescue.
 *  - The instruction block is identical for every batch and marked with `cache_control`,
 *    so batch 2 onwards reads the prefix from cache instead of paying for it again.
 *  - Claude only reports; it never rewrites the sheet. Findings land on their own
 *    "Claude Cross-Check" subsheet with a suggested fix for a human to accept.
 */
import Anthropic from '@anthropic-ai/sdk';
import { LawyerLetterRow, PostcardRow } from '../core/types.js';
import { formatDate, squash } from '../core/text.js';

export const DEFAULT_MODEL = 'claude-opus-5';

export interface CrossCheckFinding {
  row: number;
  field: string;
  severity: 'error' | 'warning' | 'info';
  issue: string;
  suggestion: string;
}

export interface CrossCheckResult {
  findings: CrossCheckFinding[];
  batches: number;
  rowsChecked: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  errors: string[];
}

/**
 * Findings come back through a forced tool call rather than free text, so the response
 * is always valid JSON against this schema and never needs regex rescue. Tool use is
 * used in preference to `output_config.format` because it is available on every
 * @anthropic-ai/sdk version, including the one pinned here.
 */
const REPORT_TOOL: Anthropic.Tool = {
  name: 'report_findings',
  description:
    'Report every problem found in the supplied rows. Call this exactly once, with an empty findings array if every row is fine.',
  input_schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        description: 'One entry per problem found. Empty when every row in the batch is fine.',
        items: {
          type: 'object',
          properties: {
            row: {
              type: 'integer',
              description: 'The "row" value from the input record the finding refers to.',
            },
            field: {
              type: 'string',
              description: 'Column name the problem is in, e.g. Full_Address or minimum_Price.',
            },
            severity: {
              type: 'string',
              enum: ['error', 'warning', 'info'],
              description:
                'error = do not send this row as-is; warning = check before sending; info = worth knowing.',
            },
            issue: { type: 'string', description: 'What is wrong, in one sentence.' },
            suggestion: { type: 'string', description: 'The concrete correction to make.' },
          },
          required: ['row', 'field', 'severity', 'issue', 'suggestion'],
          additionalProperties: false,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
  },
};

const LAWYER_LETTER_INSTRUCTIONS = `You are checking rows of a mail-merge sheet for Figment's PropCo shophouse acquisition outreach. Each row becomes one physical letter to a Singapore shophouse owner, so an error here is a letter that arrives wrong, undeliverable, or embarrassing.

Check each record for these specific problems and report only real ones:

1. Full_Address — must be a deliverable Singapore address: house number(s), street, then "SINGAPORE" and a 6-digit postal code. Merged addresses use " / " between house numbers and collapse postal codes to the first full code plus the last two digits of the others (e.g. "27 / 29 CLUB STREET SINGAPORE 069413 / 14"). Separate streets are joined with "; ". Flag leftover conservation-area text, missing postal codes, duplicated street names, or a merge that reads as nonsense.

2. Registered_Proprietor — must read as a name that can be printed on an envelope. Flag: text that is a placeholder rather than a name; a name that still contains an alias in brackets; the same person repeated; a company that reads like a statutory board, temple, clan association, town council or management corporation (those should not receive an offer letter); a string so long it will not fit an envelope.

3. Registered_Proprietor_mailing_address — must be a mailable address. Flag missing postal codes, obvious truncation, or boilerplate text instead of an address.

4. minimum_Price / higher_Price — must both be present, minimum below higher, and plausible for a Singapore shophouse (roughly S$1m to S$40m). Flag a blank pair, an inverted pair, or a figure that does not fit the Neighbourhood and Land Use on the row.

5. Comp_Address_1 / Comp_Address_2 — comparables should be in or near the row's Neighbourhood. Flag a comparable that is clearly in a different part of Singapore, or a price range that sits far outside both comparables.

6. Mail_Date / Valid_Date — Valid_Date must be after Mail_Date.

7. Internal consistency — the Comments column carries notes from the generator. If a comment says a price was derived rather than taken from a benchmark, or flags an institution, surface that as a warning so a human confirms it.

Report nothing for a row that is fine. Do not invent problems to fill the response, and do not restate a comment that is already in the Comments column unless it needs action.`;

const POSTCARD_INSTRUCTIONS = `You are checking rows of a mail-merge sheet for Figment's PropCo shophouse postcard outreach. Each row becomes one physical postcard to a Singapore shophouse owner.

Check each record for these specific problems and report only real ones:

1. Full Address — must be a deliverable Singapore address: house number(s), street, then "SINGAPORE" and a 6-digit postal code. Merged addresses use " / " between house numbers and collapse postal codes; separate streets are joined with "; ". Flag leftover conservation-area text, missing postal codes or a merge that reads as nonsense.

2. Owner Name — must read as a name that can be printed on a postcard. Flag placeholders, un-stripped aliases in brackets, repeated names, statutory boards / temples / clan associations / management corporations, or a string too long for a postcard.

3. Owner Address — must be a mailable Singapore address. Flag missing postal codes, truncation, or boilerplate instead of an address.

4. Neighbourhood / Land Use — flag a value that contradicts the address (e.g. a Geylang address labelled D1).

Report nothing for a row that is fine. Do not invent problems to fill the response.`;

export interface CrossCheckOptions {
  apiKey?: string;
  model?: string;
  /** Rows per request. 40 keeps each response comfortably inside the output budget. */
  batchSize?: number;
  /** How many requests to run at once. */
  concurrency?: number;
  /** Cap the number of rows checked (useful for a cheap smoke test). */
  maxRows?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Compact a lawyer-letter row down to the fields Claude needs to judge it. */
function lawyerLetterRecord(row: LawyerLetterRow, index: number) {
  return {
    row: index + 2, // sheet row number: header is row 1
    Target: row.Target,
    Neighbourhood: row.Neighbourhood,
    Land_Use: row['Land Use'],
    Full_Address: row.Full_Address,
    Registered_Proprietor: row.Registered_Proprietor,
    Registered_Proprietor_mailing_address: row.Registered_Proprietor_mailing_address,
    Mail_Date: formatDate(row.Mail_Date),
    Valid_Date: formatDate(row.Valid_Date),
    minimum_Price: row.minimum_Price === '' ? null : row.minimum_Price,
    higher_Price: row.higher_Price === '' ? null : row.higher_Price,
    Comp_Address_1: row.Comp_Address_1,
    Comp_1: row.Comp_1 === '' ? null : row.Comp_1,
    Comp_Address_2: row.Comp_Address_2,
    Comp_2: row.Comp_2 === '' ? null : row.Comp_2,
    Comments: squash(row.Comments).slice(0, 300),
  };
}

function postcardRecord(row: PostcardRow, index: number) {
  return {
    row: index + 2,
    Target: row.Target,
    Neighbourhood: row.Neighbourhood,
    Land_Use: row['Land Use'],
    Full_Address: row['Full Address'],
    Owner_Name: row['Owner Name'],
    Owner_Address: row['Owner Address'],
    Checking: squash(row.Checking).slice(0, 300),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function crossCheck(
  channel: 'lawyer-letter' | 'postcard',
  rows: { lawyerLetterRows: LawyerLetterRow[]; postcardRows: PostcardRow[] },
  options: CrossCheckOptions = {},
): Promise<CrossCheckResult> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example) to run the Claude cross-check.',
    );
  }
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const batchSize = options.batchSize ?? 40;
  const concurrency = Math.max(1, options.concurrency ?? 3);

  const client = new Anthropic({ apiKey });

  const records: Record<string, unknown>[] =
    channel === 'lawyer-letter'
      ? rows.lawyerLetterRows.map(lawyerLetterRecord)
      : rows.postcardRows.map(postcardRecord);

  const limited = options.maxRows ? records.slice(0, options.maxRows) : records;
  const batches = chunk(limited, batchSize);

  const instructions =
    channel === 'lawyer-letter' ? LAWYER_LETTER_INSTRUCTIONS : POSTCARD_INSTRUCTIONS;

  const findings: CrossCheckFinding[] = [];
  const errors: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let done = 0;

  const runBatch = async (batch: Record<string, unknown>[]) => {
    const firstRow = batch[0]?.row;
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 16_000,
        // The instruction block and the tool definition are byte-identical across
        // batches, so caching the prefix means only the per-batch record JSON is
        // charged at full rate from the second call onward.
        system: [
          {
            type: 'text',
            text: instructions,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [REPORT_TOOL],
        tool_choice: { type: 'tool', name: REPORT_TOOL.name },
        messages: [
          {
            role: 'user',
            content: `Check these ${batch.length} rows and report the problems you find.\n\n${JSON.stringify(
              batch,
              null,
              1,
            )}`,
          },
        ],
      });

      inputTokens += response.usage.input_tokens ?? 0;
      outputTokens += response.usage.output_tokens ?? 0;
      cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

      if (response.stop_reason === 'refusal') {
        errors.push(`Batch starting at row ${firstRow}: request was declined`);
        return;
      }

      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === 'tool_use' && block.name === REPORT_TOOL.name,
      );
      if (!toolUse) {
        errors.push(`Batch starting at row ${firstRow}: model did not call report_findings`);
        return;
      }
      const input = toolUse.input as { findings?: CrossCheckFinding[] };
      for (const f of input.findings ?? []) findings.push(f);
    } catch (error) {
      errors.push(
        `Batch starting at row ${firstRow}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      done++;
      options.onProgress?.(done, batches.length);
    }
  };

  // Simple concurrency window — enough for a few thousand rows without hammering limits.
  for (let i = 0; i < batches.length; i += concurrency) {
    await Promise.all(batches.slice(i, i + concurrency).map(runBatch));
  }

  findings.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.row - b.row,
  );

  return {
    findings,
    batches: batches.length,
    rowsChecked: limited.length,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    errors,
  };
}

function severityRank(severity: string): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

export const CLAUDE_SHEET_HEADERS = ['Severity', 'Sheet Row', 'Field', 'Issue', 'Suggested Fix'];

export function findingsToRows(result: CrossCheckResult): unknown[][] {
  const rows: unknown[][] = result.findings.map((f) => [
    f.severity,
    f.row,
    f.field,
    f.issue,
    f.suggestion,
  ]);
  if (result.errors.length) {
    rows.push([]);
    rows.push(['— batch errors —', '', '', '', '']);
    for (const e of result.errors) rows.push(['error', '', 'batch', e, 'Re-run the cross-check']);
  }
  rows.push([]);
  rows.push([
    'info',
    '',
    'summary',
    `${result.rowsChecked} rows in ${result.batches} batches via ${result.model}`,
    `tokens in ${result.inputTokens} / out ${result.outputTokens} / cache read ${result.cacheReadTokens}`,
  ]);
  return rows;
}
