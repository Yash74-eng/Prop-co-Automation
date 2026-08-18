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
  /** The operator's own instructions for this run, recorded so findings can be explained. */
  extraInstructions?: string;
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

1. Full_Address — the property being written about. It is correct when it has house number(s), a street name, then "SINGAPORE" and a 6-digit postal code.

   These forms are all correct — do not flag them:
   - Merged house numbers: " / " between them, with postal codes collapsed to the first full code plus the last two digits of the others, e.g. "27 / 29 CLUB STREET SINGAPORE 069413 / 14".
   - Separate streets joined with "; ".
   - Letter suffixes on house numbers, e.g. "271, 271A GEYLANG ROAD".
   - A unit number such as "#01-05".

   Flag it when: there is no 6-digit postal code, or a code that is not 6 digits; there is no house number at all, only a street; leftover conservation-area or estate boilerplate is still in the text ("... CONSERVATION AREA", "... INDUSTRIAL ESTATE"); the same street name is repeated within the one address; the merge has produced something that does not read as a real address; or the text is truncated.

2. Registered_Proprietor — must read as a name that can be printed on an envelope.

   Do NOT flag any of the following. They are all correct and expected:
   - A company. Most owners here are companies — PTE. LTD., PTE LTD, PRIVATE LIMITED, LLP, LIMITED, (S) PTE LTD and similar are normal, not problems.
   - Several owners in one cell. Co-owners are deliberately joined with "&" (e.g. "TAN AH KOW & LIM BEE HOON"), and one owner's several properties are joined with "/". Multiple names is the intended output, never a defect.
   - "Owners of ___" — the deliberate collapse used when a property has more owners than will fit.
   - A long name, unless it is so long it plainly cannot be printed on an envelope.
   - A name you simply do not recognise. Unfamiliar is not wrong.

   Only flag: a value that is not a name at all (a placeholder, a number, boilerplate, an address in the name field); a name that still carries an un-stripped alias in brackets or an "Alias :" prefix; or an owner that is a statutory board, temple, clan association, town council or management corporation, since those should not receive an offer letter.

3. Registered_Proprietor_mailing_address — this is where the letter is posted, so judge it as a postal address and nothing else. It is correct when it has a building or house number, a street name, and "SINGAPORE" followed by a 6-digit postal code. A unit number such as "#03-01" is fine and expected. A merged address using " / " or "; " is fine.

   Flag it when: there is no postal code, or the postal code is not 6 digits; there is no building or house number, so the postman has a street but no address on it; the text is boilerplate rather than an address ("STRATA LOT", "N/A", "-", a land-lot reference); it is obviously truncated mid-word or mid-number; it is an overseas address with no Singapore postal code; or the same street appears twice in a way that reads as a bad merge.

4. minimum_Price / higher_Price — must both be present, minimum below higher, and plausible for a Singapore shophouse (roughly S$1m to S$40m). Flag a blank pair, an inverted pair, or a figure that does not fit the Neighbourhood and Land Use on the row.

5. Comp_Address_1 / Comp_Address_2 — comparables should be in or near the row's Neighbourhood. Flag a comparable that is clearly in a different part of Singapore, or a price range that sits far outside both comparables.

6. Mail_Date / Valid_Date — Valid_Date must be after Mail_Date.

7. Characters that cannot be printed — in ANY field. These arrive from copy-paste and print exactly as they appear. Flag as an error, and give the cleaned text as the suggestion:
   - Trademark, registered or copyright marks: ™ ® © ℠ ℗, and the typed forms "(TM)", "(R)", "(C)" trailing a word.
   - Footnote markers left over from a source document: ¹ ² ³, †, ‡, or a stray trailing asterisk.
   - Emoji or any pictographic character.
   - Text that is clearly a fragment of a web page or a listing rather than an address: "View on map", "Contact agent", a URL, an email address, a phone number inside the address field.
   - Any run of characters that reads as encoding damage: "Â", "â€™", "ï»¿", a lone "?" where an apostrophe or dash should be.
   Note that invisible characters (zero-width spaces, direction marks) are stripped before you see the row, so do not speculate about them — only report what is visible in the text you are given.

8. Internal consistency — the Comments column carries notes from the generator. If a comment says a price was derived rather than taken from a benchmark, or flags an institution, surface that as a warning so a human confirms it.

Report nothing for a row that is fine. Do not invent problems to fill the response, and do not restate a comment that is already in the Comments column unless it needs action.`;

const POSTCARD_INSTRUCTIONS = `You are checking rows of a mail-merge sheet for Figment's PropCo shophouse postcard outreach. Each row becomes one physical postcard to a Singapore shophouse owner.

Check each record for these specific problems and report only real ones:

1. Full Address — the property. Correct when it has house number(s), a street, then "SINGAPORE" and a 6-digit postal code. Merged house numbers use " / " with collapsed postal codes; separate streets are joined with "; "; letter suffixes ("271, 271A") and unit numbers ("#01-05") are all fine — do not flag any of those.

   Flag it when: there is no 6-digit postal code, or one that is not 6 digits; there is no house number, only a street; leftover conservation-area or estate boilerplate is still present; the same street repeats within the address; or the text is truncated.

2. Owner Name — must read as a name that can be printed on a postcard.

   Do NOT flag: a company (PTE. LTD., PTE LTD, PRIVATE LIMITED, LLP and similar are normal — most owners are companies); several owners joined with "&" or properties joined with "/", which is the intended output; "Owners of ___"; or a name you simply do not recognise.

   Only flag: a value that is not a name at all (placeholder, number, boilerplate, an address in the name field); an un-stripped alias in brackets or an "Alias :" prefix; a statutory board, temple, clan association, town council or management corporation; or a name so long it plainly will not fit on a postcard.

3. Owner Address — where the postcard is posted. Correct when it has a building or house number, a street, and "SINGAPORE" plus a 6-digit postal code; a unit number is fine.

   Flag it when: there is no postal code or it is not 6 digits; there is no building or house number; the text is boilerplate ("STRATA LOT", "N/A", "-"); it is truncated; or it is overseas with no Singapore postal code.

4. Neighbourhood / Land Use — flag a value that contradicts the address (e.g. a Geylang address labelled D1).

5. Characters that cannot be printed — in ANY field. These arrive from copy-paste and print exactly as they appear. Flag as an error, and give the cleaned text as the suggestion:
   - Trademark, registered or copyright marks: ™ ® © ℠ ℗, and the typed forms "(TM)", "(R)", "(C)" trailing a word.
   - Footnote markers: ¹ ² ³, †, ‡, or a stray trailing asterisk.
   - Emoji or any pictographic character.
   - Text that is a fragment of a web page or listing rather than an address: "View on map", "Contact agent", a URL, an email address, a phone number inside the address field.
   - Any run of characters that reads as encoding damage: "Â", "â€™", "ï»¿", a lone "?" where an apostrophe or dash should be.
   Invisible characters are stripped before you see the row, so only report what is visible in the text you are given.

Report nothing for a row that is fine. Do not invent problems to fill the response.`;

/**
 * Where an operator's own instructions are joined to the built-in rules.
 *
 * Appended rather than substituted: the rules above encode what has already been learned
 * about this data — that most owners are companies, that "&" is deliberate, that merged
 * postal codes are correct — and losing them would bring back the false positives they
 * were written to stop. Anything here wins on the specific point it addresses, which is
 * how "also check X" and "stop flagging Y" both work without rewriting the prompt.
 */
function withExtraInstructions(base: string, extra?: string): string {
  const text = squash(extra);
  if (!text) return base;
  return `${base}

------------------------------------------------------------------
ADDITIONAL INSTRUCTIONS FROM THE OPERATOR

These are written by the person running this check, for this run. They take precedence
over the numbered rules above wherever the two speak to the same point — including
telling you to stop reporting something the rules ask for, or to report something they
do not mention. Where they are silent, the rules above still apply in full.

${text}`;
}

export interface CrossCheckOptions {
  apiKey?: string;
  model?: string;
  /** Rows per request. 40 keeps each response comfortably inside the output budget. */
  batchSize?: number;
  /** How many requests to run at once. */
  concurrency?: number;
  /** Cap the number of rows checked (useful for a cheap smoke test). */
  maxRows?: number;
  /** The operator's own checks, appended to the built-in rules. */
  extraInstructions?: string;
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

  const instructions = withExtraInstructions(
    channel === 'lawyer-letter' ? LAWYER_LETTER_INSTRUCTIONS : POSTCARD_INSTRUCTIONS,
    options.extraInstructions,
  );

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
    extraInstructions: squash(options.extraInstructions) || undefined,
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
  // Custom instructions change what counts as a finding, so the sheet has to say what
  // they were. Without this, a later reader cannot tell why a row was or was not flagged.
  if (result.extraInstructions) {
    rows.push([
      'info',
      '',
      'your instructions',
      result.extraInstructions,
      'These were applied on top of the built-in rules for this run',
    ]);
  }
  return rows;
}
