/**
 * Command-line runner, for batch use and for scripting without the UI.
 *
 *   npm run cli -- --in "PropCo Dealflow Tracker.xlsx" --channel lawyer-letter --out out.xlsx
 *
 * Flags:
 *   --in <path>            source workbook (required)
 *   --sheet <name>         sheet to read (default: auto-detect the Main Database)
 *   --channel <c>          lawyer-letter | postcard        (default lawyer-letter)
 *   --out <path>           output workbook (default alongside the input)
 *   --mail-date <date>     e.g. 2026-09-01                 (default today)
 *   --validity <days>      Valid_Date = Mail_Date + days   (default 14)
 *   --outreach <mode>      exclude-contacted | only-tagged | match | all
 *   --outreach-text <s>    substring, used with --outreach match
 *   --comps <path>         comps benchmark workbook (default: the input's own sheet)
 *   --comps-sheet <name>   sheet inside --comps
 *   --suppress <path>      compset / do-not-contact workbook (all sheets read)
 *   --max-properties <n>   remove owners above this many properties (default 5)
 *   --max-owners <n>       collapse to "Owners of ___" above this many (default 4)
 *   --keep-agencies        do not remove agencies / associations / developers
 *   --no-derive            leave prices blank when no comps row matches
 *   --no-audit             emit only the deliverable sheets
 *   --template <path>      .docx to validate merge fields against
 *   --cross-check          run the Claude cross-check (needs ANTHROPIC_API_KEY)
 */
import { basename, dirname, extname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import {
  findSheetByName,
  readSheet,
  readSuppressionList,
  readWorkbookSheets,
  sheetToTable,
} from './excel/read.js';
import { parseMainDatabase } from './core/mainDatabase.js';
import { parseCompsTable } from './core/comps.js';
import { findInstitutionsSheetName, loadConfig, parseInstitutionsSheet } from './core/config.js';
import { defaultOptions, runPipeline } from './core/pipeline.js';
import { buildWorkbook, SHEET_NAMES, writeWorkbook, appendSheet } from './excel/write.js';
import { CLAUDE_SHEET_HEADERS, crossCheck, findingsToRows } from './verify/claude.js';
import { checkMergeFields } from './mailmerge/wordMerge.js';
import { formatDate, parseLooseDate } from './core/text.js';
import type { CompsRecord, SuppressionEntry } from './core/types.js';

loadEnv();

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.in) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(args.in ? 0 : 1);
}

const inputPath = resolve(String(args.in));
if (!existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  process.exit(1);
}

const channel = args.channel === 'postcard' ? 'postcard' : 'lawyer-letter';

console.log(`Reading ${inputPath}`);
const table = readSheet(inputPath, args.sheet ? String(args.sheet) : undefined);
console.log(`  sheet "${table.sheetName}" — ${table.rows.length} rows, ${table.headers.length} columns`);

const db = parseMainDatabase(table);
console.log(`  parsed ${db.rows.length} data rows, mapped ${Object.keys(db.columnMap).length} fields`);
if (db.missingFields.length) console.log(`  fields not present: ${db.missingFields.join(', ')}`);

// Comps benchmark: an explicit --comps file, else the input's own sheet.
let comps: CompsRecord[] = [];
let compsSource = 'none';
const compsPath = args.comps ? resolve(String(args.comps)) : inputPath;
const compsSheet = args['comps-sheet']
  ? String(args['comps-sheet'])
  : findSheetByName(compsPath, 'lawyer letter comps');
if (compsSheet) {
  const { wb } = readWorkbookSheets(compsPath);
  comps = parseCompsTable(sheetToTable(wb, compsSheet));
  compsSource = `${basename(compsPath)} [${compsSheet}]`;
  console.log(`  comps benchmark: ${comps.length} rows from ${compsSource}`);
} else if (channel === 'lawyer-letter') {
  console.log('  comps benchmark: none found — prices will be derived or left blank');
}

let suppression: SuppressionEntry[] = [];
if (args.suppress) {
  const path = resolve(String(args.suppress));
  const { names } = readWorkbookSheets(path);
  suppression = names.flatMap((name) => {
    try {
      return readSuppressionList(path, name);
    } catch {
      return [];
    }
  });
  console.log(`  suppression list: ${suppression.length} entries from ${basename(path)}`);
}

const options = defaultOptions(channel, {
  mailDate: parseLooseDate(args['mail-date']) ?? new Date(),
  validityDays: Number(args.validity ?? 14),
  outreachFilter: {
    mode: (args.outreach as never) ?? 'all',
    matchText: args['outreach-text'] ? String(args['outreach-text']) : undefined,
    alwaysExcludeOptOut: true,
  },
  maxPropertiesPerOwner: Number(args['max-properties'] ?? 5),
  maxOwnersBeforeCollapse: Number(args['max-owners'] ?? 4),
  removeAgenciesAndDevelopers: !args['keep-agencies'],
  deriveMissingPrices: !args['no-derive'],
  includeAuditSheets: !args['no-audit'],
  suppressionList: suppression as never[],
  comps,
});

// Institutions-to-avoid: prefer the uploaded workbook's own sheet over config/.
const institutionsSheet = findInstitutionsSheetName(readWorkbookSheets(inputPath).names);
const institutionsFromWorkbook = institutionsSheet
  ? parseInstitutionsSheet(sheetToTable(readWorkbookSheets(inputPath).wb, institutionsSheet))
  : undefined;
const config = loadConfig(institutionsFromWorkbook);
console.log(`  institutions to avoid: ${config.sources.institutions}`);
console.log(`  developers list: ${config.sources.developers}`);

console.log(`\nRunning ${channel} pipeline (mail date ${formatDate(options.mailDate)})`);
const result = runPipeline(db.rows, options, {
  institutions: config.institutions,
  developerNames: config.developerNames,
  neighbourhoodOverrides: config.neighbourhoodOverrides,
});

for (const [key, value] of Object.entries(result.stats)) {
  console.log(`  ${key.padEnd(26)} ${value}`);
}
for (const warning of result.warnings) {
  console.log(`  ! [${warning.scope}] ${warning.message}${warning.count ? ` (${warning.count})` : ''}`);
}

const outPath = args.out
  ? resolve(String(args.out))
  : join(
      dirname(inputPath),
      `${basename(inputPath, extname(inputPath))} — ${
        channel === 'lawyer-letter' ? 'Lawyer Letter' : 'Postcard'
      } ${new Date().toISOString().slice(0, 10)}.xlsx`,
    );

// Create the output directory if it does not exist yet — --out may point anywhere.
mkdirSync(dirname(outPath), { recursive: true });

const wb = await buildWorkbook({
  result,
  source: table,
  comps,
  notes: [
    `Source: ${basename(inputPath)} [${table.sheetName}]`,
    `Comps benchmark: ${compsSource}`,
    'The input workbook was not modified.',
  ],
});
await writeWorkbook(wb, outPath);
console.log(`\nWrote ${outPath}`);

if (args.template) {
  const templatePath = resolve(String(args.template));
  const check = checkMergeFields(templatePath, channel);
  console.log(`\nMerge-field check against ${basename(templatePath)}`);
  console.log(`  template fields : ${check.templateFields.join(', ') || '(none found)'}`);
  if (check.ok) {
    console.log('  OK — every template field has a matching sheet column');
  } else {
    console.log(`  MISSING in sheet: ${check.missingInSheet.join(', ')}`);
  }
}

if (args['cross-check']) {
  console.log('\nRunning Claude cross-check...');
  const cc = await crossCheck(
    channel,
    { lawyerLetterRows: result.lawyerLetterRows, postcardRows: result.postcardRows },
    {
      maxRows: args['cross-check-rows'] ? Number(args['cross-check-rows']) : undefined,
      onProgress: (done, total) => process.stdout.write(`\r  batch ${done}/${total}`),
    },
  );
  console.log(
    `\n  ${cc.rowsChecked} rows, ${cc.findings.length} findings (model ${cc.model}, tokens in ${cc.inputTokens} / out ${cc.outputTokens} / cache ${cc.cacheReadTokens})`,
  );
  for (const e of cc.errors) console.log(`  ! ${e}`);
  for (const f of cc.findings.slice(0, 25)) {
    console.log(`  [${f.severity}] row ${f.row} ${f.field}: ${f.issue}`);
  }
  await appendSheet(outPath, SHEET_NAMES.claude, CLAUDE_SHEET_HEADERS, findingsToRows(cc));
  console.log(`  Findings written to the "${SHEET_NAMES.claude}" sheet`);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function loadEnv(): void {
  const path = resolve('.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    let value = match[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
