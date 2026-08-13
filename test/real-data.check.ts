/**
 * Manual verification harness — runs every stage against the real PropCo Dealflow
 * Tracker and prints coverage reports so each rule can be eyeballed against live data.
 *
 *   npm run test:real -- "C:\path\to\PropCo Dealflow Tracker.xlsx"
 *
 * Nothing here asserts; it reports. Use it to check that the parsers and the
 * name-matching rules actually cover the sheet before trusting a run.
 */
import { existsSync } from 'node:fs';
import { readSheet, readWorkbookSheets, sheetToTable } from '../src/excel/read.js';
import { parseMainDatabase, classifyOutreach } from '../src/core/mainDatabase.js';
import { parseAddress, mergeAddresses, isStrataPlaceholder, looksOverseas } from '../src/core/address.js';
import { classifyName, isCorporateName, looksLikeMultipleNames } from '../src/core/names.js';
import { parseCompsTable, CompsIndex, lookupComps } from '../src/core/comps.js';
import { compsLandUse, compsNeighbourhood, normaliseTenure } from '../src/core/vocab.js';
import { defaultOptions, runPipeline } from '../src/core/pipeline.js';
import { findInstitutionsSheetName, loadConfig, parseInstitutionsSheet } from '../src/core/config.js';
import { squash, upper } from '../src/core/text.js';

const DEFAULT_TRACKER = 'C:\\Users\\Figment\\Downloads\\PropCo Dealflow Tracker.xlsx';
const trackerPath = process.argv[2] ?? DEFAULT_TRACKER;

if (!existsSync(trackerPath)) {
  console.error(`Tracker not found: ${trackerPath}`);
  console.error('Usage: npm run test:real -- "<path to PropCo Dealflow Tracker.xlsx>"');
  process.exit(1);
}

function heading(text: string): void {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function table(rows: [string, unknown][]): void {
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(width)}  ${v}`);
}

function pct(n: number, total: number): string {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`;
}

console.log(`Tracker: ${trackerPath}`);

const { wb, names } = readWorkbookSheets(trackerPath);
console.log(`Sheets: ${names.length}`);

// ---------------------------------------------------------------------------
heading('1. Main Database header mapping');
const mainTable = sheetToTable(wb, 'Main Database');
const db = parseMainDatabase(mainTable);
table([
  ['header columns', db.headers.length],
  ['data rows parsed', db.rows.length],
  ['fields mapped', Object.keys(db.columnMap).length],
  ['fields missing', db.missingFields.length ? db.missingFields.join(', ') : 'none'],
  ['headers unmapped', db.unmappedHeaders.length ? db.unmappedHeaders.join(', ') : 'none'],
]);

// ---------------------------------------------------------------------------
heading('2. Address parsing coverage');
let parsed = 0;
let unparsed = 0;
let withCa = 0;
let caMatchedByList = 0;
const unparsedSamples: string[] = [];
const caFallbackSamples: string[] = [];

for (const row of db.rows) {
  if (!row.address) continue;
  const a = parseAddress(row.address);
  const hasCaPhrase = upper(row.address).includes('CONSERVATION AREA');
  if (hasCaPhrase) {
    withCa++;
    if (a.conservationArea) caMatchedByList++;
    else if (caFallbackSamples.length < 8) caFallbackSamples.push(row.address);
  }
  if (a.unparsed) {
    unparsed++;
    if (unparsedSamples.length < 10) unparsedSamples.push(row.address);
  } else {
    parsed++;
  }
}
const addressTotal = parsed + unparsed;
table([
  ['addresses', addressTotal],
  ['fully parsed', `${parsed} (${pct(parsed, addressTotal)})`],
  ['unparsed / flagged', `${unparsed} (${pct(unparsed, addressTotal)})`],
  ['with CONSERVATION AREA', withCa],
  ['  area name recognised', `${caMatchedByList} (${pct(caMatchedByList, withCa)})`],
  ['  fell back to heuristic', withCa - caMatchedByList],
]);
if (unparsedSamples.length) {
  console.log('\n  Unparsed samples:');
  unparsedSamples.forEach((s) => console.log(`    ${JSON.stringify(s)}`));
}
if (caFallbackSamples.length) {
  console.log('\n  Conservation-area fallback samples (add to CONSERVATION_AREAS if real):');
  caFallbackSamples.forEach((s) => console.log(`    ${JSON.stringify(s)}`));
}

// ---------------------------------------------------------------------------
heading('3. Owner-name matching coverage  <-- the name logic, over every real name');

interface NameBucket {
  count: number;
  samples: string[];
}
const buckets: Record<string, NameBucket> = {};
const bump = (key: string, sample: string) => {
  if (!buckets[key]) buckets[key] = { count: 0, samples: [] };
  buckets[key].count++;
  if (buckets[key].samples.length < 6) buckets[key].samples.push(sample);
};

// Config is loaded exactly as a real run loads it: the workbook's own sheet first.
const institutionSheetForConfig = findInstitutionsSheetName(names);
const runConfig = loadConfig(
  institutionSheetForConfig
    ? parseInstitutionsSheet(sheetToTable(wb, institutionSheetForConfig))
    : undefined,
);

let ownerCells = 0;
const distinctNames = new Map<string, number>();

for (const row of db.rows) {
  for (const owner of row.owners) {
    const raw = squash(owner.name);
    if (!raw) continue;
    ownerCells++;
    distinctNames.set(raw, (distinctNames.get(raw) ?? 0) + 1);

    const cls = classifyName(raw, runConfig);
    if (cls.isStrataPlaceholder) bump('strata placeholder name (EXCLUDED)', raw);
    else bump(cls.isCorporate ? 'corporate entity' : 'natural person', raw);
    if (cls.declaredOwnerCount) bump(`declared owner count parsed (${'n'})`, `${cls.declaredOwnerCount}: ${raw.slice(0, 60)}`);
    if (cls.alias) bump('alias stripped', `${raw}  ->  ${cls.cleaned}`);
    if (cls.institutionMatch) bump(`INSTITUTION (comment only): ${cls.institutionMatch.status}`, raw);
    if (cls.agencyMatch) bump('agency / association (REMOVED)', raw);
    if (cls.developerMatch) bump(`large developer (REMOVED): ${cls.developerMatch}`, raw);
    if (cls.reviewMatch) bump('corporate-sounding — review only (KEPT)', raw);
    if (cls.possibleMultiName) bump('possible multiple names in one cell (flagged)', raw);
    if (!cls.cleaned) bump('EMPTY after cleaning (would be dropped)', raw);
  }
}

table([
  ['owner name cells', ownerCells],
  ['distinct owner names', distinctNames.size],
]);
console.log('');
const sorted = Object.entries(buckets).sort((a, b) => b[1].count - a[1].count);
for (const [key, bucket] of sorted) {
  console.log(`  ${String(bucket.count).padStart(6)}  ${pct(bucket.count, ownerCells).padStart(6)}  ${key}`);
  for (const s of bucket.samples) console.log(`            ${JSON.stringify(s)}`);
}

// Cross-check: which of the 8 institutions-to-avoid actually appear in the data?
console.log('\n  Institutions-to-avoid hit check:');
// The list is read from the workbook, never hardcoded. Names are abbreviated in this
// report so a pasted terminal log does not carry the whole avoid-list.
const institutionSheetName = findInstitutionsSheetName(names);
const institutions = institutionSheetName
  ? parseInstitutionsSheet(sheetToTable(wb, institutionSheetName))
  : [];
console.log(`    source sheet: ${institutionSheetName ?? '(none found)'} — ${institutions.length} entries`);
for (const inst of institutions) {
  let hits = 0;
  for (const [name, count] of distinctNames) {
    if (classifyName(name, { institutions }).institutionMatch?.name === inst.name) hits += count;
  }
  const label = `${inst.name.slice(0, 6)}…${inst.name.slice(-4)} [${inst.status}]`;
  console.log(`    ${hits ? 'HIT ' : '--- '} ${String(hits).padStart(4)}  ${label}`);
}

// Corporate-name detector spot check on names that contain no obvious token.
console.log('\n  Names classed corporate WITHOUT a PTE/LTD/LIMITED token (verify these):');
let oddCorp = 0;
for (const [name] of distinctNames) {
  if (!isCorporateName(name)) continue;
  if (/\bPTE\b|\bLTD\b|\bLIMITED\b|\bLLP\b|\bLLC\b|\bPRIVATE\b/i.test(name)) continue;
  if (oddCorp < 15) console.log(`    ${JSON.stringify(name)}`);
  oddCorp++;
}
console.log(`    ... ${oddCorp} total`);

console.log('\n  Names with a comma NOT flagged as multi-name (should be single people):');
let commaSingles = 0;
for (const [name] of distinctNames) {
  if (!name.includes(',')) continue;
  if (looksLikeMultipleNames(name)) continue;
  if (commaSingles < 10) console.log(`    ${JSON.stringify(name)}`);
  commaSingles++;
}
console.log(`    ... ${commaSingles} total`);

// ---------------------------------------------------------------------------
heading('4. Owner mailing-address quality');
let mailBlank = 0;
let mailStrata = 0;
let mailOverseas = 0;
let mailOk = 0;
for (const row of db.rows) {
  for (const owner of row.owners) {
    if (!squash(owner.name)) continue;
    const addr = squash(owner.address);
    if (!addr) mailBlank++;
    else if (isStrataPlaceholder(addr)) mailStrata++;
    else if (looksOverseas(addr)) mailOverseas++;
    else mailOk++;
  }
}
table([
  ['mailable', mailOk],
  ['blank', mailBlank],
  ['strata placeholder', mailStrata],
  ['no SG postal (overseas?)', mailOverseas],
]);

// ---------------------------------------------------------------------------
heading('5. Outreach column classification');
for (const channel of ['lawyer-letter', 'postcard'] as const) {
  const counts: Record<string, number> = {};
  for (const row of db.rows) {
    const v = channel === 'lawyer-letter' ? row.lawyerLetterOutreach : row.postcardOutreach;
    const c = classifyOutreach(v);
    counts[c.status] = (counts[c.status] ?? 0) + 1;
  }
  console.log(`\n  ${channel}:`);
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(6)}  ${k}`));
}

// ---------------------------------------------------------------------------
heading('6. Vocabulary mapping coverage (land use / tenure / neighbourhood)');
const compsTable = sheetToTable(wb, 'Lawyer Letter Comps Benchmarks');
const comps = parseCompsTable(compsTable);
const compsIndex = new CompsIndex(comps);
console.log(`  comps benchmark rows: ${comps.length}`);

const landUseMiss = new Map<string, number>();
const tenureMiss = new Map<string, number>();
const nbhdMiss = new Map<string, number>();
for (const row of db.rows) {
  if (!compsLandUse(row.landUse)) landUseMiss.set(row.landUse ?? '(blank)', (landUseMiss.get(row.landUse ?? '(blank)') ?? 0) + 1);
  if (!normaliseTenure(row.tenure).comps) tenureMiss.set(row.tenure ?? '(blank)', (tenureMiss.get(row.tenure ?? '(blank)') ?? 0) + 1);
  if (!compsNeighbourhood(row.neighbourhood)) nbhdMiss.set(row.neighbourhood ?? '(blank)', (nbhdMiss.get(row.neighbourhood ?? '(blank)') ?? 0) + 1);
}
const showMiss = (label: string, m: Map<string, number>) => {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  console.log(`\n  ${label}: ${total} rows unmapped across ${m.size} distinct values`);
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, v]) =>
    console.log(`    ${String(v).padStart(6)}  ${JSON.stringify(k.slice(0, 70))}`),
  );
};
showMiss('land use', landUseMiss);
showMiss('tenure', tenureMiss);
showMiss('neighbourhood', nbhdMiss);

// Comps hit rate across the whole sheet.
let compsHit = 0;
let compsDerived = 0;
let compsNone = 0;
for (const row of db.rows) {
  const r = lookupComps(
    compsIndex,
    {
      neighbourhood: row.neighbourhood,
      landUse: row.landUse,
      tenure: row.tenure,
      gfaSqft: row.gfaSqft,
      benchmarkPsf: row.benchmarkPsf,
    },
    { deriveMissingPrices: true, derivedHigherMultiplier: 1.125, derivedRounding: 250_000 },
  );
  if (r.source === 'comps-benchmark') compsHit++;
  else if (r.source === 'derived-from-psf') compsDerived++;
  else compsNone++;
}
console.log('');
table([
  ['priced from comps benchmark', `${compsHit} (${pct(compsHit, db.rows.length)})`],
  ['derived from GFA x psf', `${compsDerived} (${pct(compsDerived, db.rows.length)})`],
  ['no price at all', `${compsNone} (${pct(compsNone, db.rows.length)})`],
]);

// GFA-unit sanity check: GFA should equal land area (sqm -> sqft) x floors.
console.log('\n  GFA unit check (expect GFA ~= LandAreaSqM * 10.7639 * floors):');
let gfaChecked = 0;
let gfaMatches = 0;
for (const row of db.rows) {
  if (!row.gfaSqft || !row.landAreaSqm || !row.noOfFloors) continue;
  gfaChecked++;
  const expected = row.landAreaSqm * 10.7639 * row.noOfFloors;
  if (Math.abs(expected - row.gfaSqft) / row.gfaSqft < 0.02) gfaMatches++;
}
table([
  ['rows checked', gfaChecked],
  ['within 2% of sqft formula', `${gfaMatches} (${pct(gfaMatches, gfaChecked)})`],
]);

// ---------------------------------------------------------------------------
heading('7. Full pipeline — lawyer letter');
const llOptions = defaultOptions('lawyer-letter', {
  mailDate: new Date(Date.UTC(2026, 7, 20)),
  comps,
});
const ll = runPipeline(db.rows, llOptions, runConfig);
table(Object.entries(ll.stats) as [string, unknown][]);
console.log('\n  Warnings:');
ll.warnings.forEach((w) => console.log(`    [${w.scope}] ${w.message}${w.count ? ` (${w.count})` : ''}`));

console.log('\n  Exclusion reasons:');
const exReasons = new Map<string, number>();
ll.exclusions.forEach((e) => exReasons.set(e.reason, (exReasons.get(e.reason) ?? 0) + 1));
[...exReasons.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
  console.log(`    ${String(v).padStart(6)}  ${k}`),
);

console.log('\n  Owners removed for holding too many properties (top 15):');
ll.exclusions
  .filter((e) => e.reason.startsWith('Owner holds more than'))
  .reduce((m, e) => m.set(e.detail ?? '', (m.get(e.detail ?? '') ?? 0) + 1), new Map<string, number>())
  .forEach(() => undefined);
const bigOwners = new Map<string, number>();
ll.exclusions
  .filter((e) => e.reason.startsWith('Owner holds more than'))
  .forEach((e) => bigOwners.set(e.detail ?? '', (bigOwners.get(e.detail ?? '') ?? 0) + 1));
[...bigOwners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) =>
  console.log(`    ${String(v).padStart(5)} rows  ${k}`),
);

console.log('\n  Review flags:');
const flagCounts = new Map<string, number>();
ll.flags.forEach((f) => flagCounts.set(`${f.severity}: ${f.flag}`, (flagCounts.get(`${f.severity}: ${f.flag}`) ?? 0) + 1));
[...flagCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
  console.log(`    ${String(v).padStart(6)}  ${k}`),
);

console.log('\n  Sample output rows:');
ll.lawyerLetterRows.slice(0, 5).forEach((r, i) => {
  console.log(`\n    [${i + 1}] ${r.Registered_Proprietor}`);
  console.log(`        Full_Address : ${r.Full_Address}`);
  console.log(`        mailing      : ${r.Registered_Proprietor_mailing_address}`);
  console.log(`        Owner No.    : ${r['Owner No.']}`);
  console.log(`        price        : ${r.minimum_Price} - ${r.higher_Price}`);
  console.log(`        comps        : ${r.Comp_Address_1} / ${r.Comp_Address_2}`);
  console.log(`        comments     : ${String(r.Comments).slice(0, 140)}`);
});

// Show the merges that actually fired, so the "/" and "&" rules can be verified.
const audit = (ll as unknown as { dedupeAudit: { stage: string; action: string; before: string[]; after: string }[] }).dedupeAudit ?? [];
console.log(`\n  Merge operations: ${audit.length}`);
console.log('\n  Sample "&" co-owner merges:');
audit.filter((a) => a.stage === 'A').slice(0, 6).forEach((a) =>
  console.log(`    ${a.before.join(' + ')}  ->  ${a.after}`),
);
console.log('\n  Sample address merges:');
audit.filter((a) => a.stage === 'B' && a.before.length > 1).slice(0, 8).forEach((a) =>
  console.log(`    ${a.before.join(' + ')}\n      ->  ${a.after}`),
);

// ---------------------------------------------------------------------------
heading('8. Full pipeline — postcard');
const pc = runPipeline(
  db.rows,
  defaultOptions('postcard', { mailDate: new Date(Date.UTC(2026, 7, 20)) }),
  runConfig,
);
table(Object.entries(pc.stats) as [string, unknown][]);
console.log('\n  Sample rows:');
pc.postcardRows.slice(0, 5).forEach((r, i) =>
  console.log(`    [${i + 1}] ${r['Owner Name']}  |  ${r['Owner Address']}`),
);

heading('Done');
