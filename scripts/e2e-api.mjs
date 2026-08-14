/**
 * End-to-end drive of the running app over its real HTTP API.
 * Uploads the tracker, generates ONE channel, and inspects the output workbook's sheets.
 * Prints counts and sheet names only — never owner rows (confidential data).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const BASE = 'http://localhost:5173/api';
const SRC = process.argv[2];
const CHANNEL = process.argv[3] ?? 'postcard';

const j = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON ${res.status}: ${text.slice(0, 300)}`);
  }
};

console.log(`\n=== 1. UPLOAD (${basename(SRC)}) ===`);
const form = new FormData();
form.append('file', new Blob([readFileSync(SRC)]), basename(SRC));
const up = await j(await fetch(`${BASE}/jobs`, { method: 'POST', body: form }));
if (up.error) throw new Error(up.error);
console.log(`job=${up.id}`);
console.log(`sheet picked: ${up.sheetName}`);
console.log(`sheets in file: ${up.sheetNames?.length}`);
console.log(`comps rows auto-loaded: ${up.compsRows} (${up.compsSource ?? 'none'})`);

console.log(`\n=== 2. RUN (channel=${CHANNEL}) ===`);
const run = await j(
  await fetch(`${BASE}/jobs/${up.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: CHANNEL,
      mailDate: '2026-09-01',
      validityDays: 14,
      outreachMode: 'exclude-contacted',
      includeAuditSheets: true,
    }),
  }),
);
if (run.error) throw new Error(run.error);
console.log(`channel returned: ${run.channel}`);
console.log(`recipients: ${run.stats?.recipients}`);
console.log(`lawyerLetterRows=${run.stats?.lawyerLetterRows} postcardRows=${run.stats?.postcardRows}`);
console.log(`output: ${run.outputFileName}`);
console.log(`preview rows returned: ${run.preview?.length ?? 0}`);
if (run.preview?.[0]) console.log(`preview columns: ${Object.keys(run.preview[0]).join(', ')}`);

console.log('\n=== 3. FUNNEL ===');
const funnel = await j(await fetch(`${BASE}/jobs/${up.id}/funnel`));
for (const s of funnel.stages ?? []) {
  console.log(`  ${String(s.label).padEnd(34)} in=${s.in ?? '-'} out=${s.out ?? '-'} dropped=${s.dropped ?? '-'}`);
}

console.log('\n=== 4. ROWS / FLAGS / EXCLUSIONS ===');
const rows = await j(await fetch(`${BASE}/jobs/${up.id}/rows?limit=3`));
console.log(`rows total=${rows.total} channel=${rows.channel}`);
const flags = await j(await fetch(`${BASE}/jobs/${up.id}/flags`));
console.log(`flags total=${flags.total ?? flags.rows?.length ?? 0}`);
const excl = await j(await fetch(`${BASE}/jobs/${up.id}/exclusions`));
console.log(`exclusions total=${excl.total ?? excl.rows?.length ?? 0}`);

console.log('\n=== 5. BIZFILE QUEUE ===');
const queue = await j(await fetch(`${BASE}/jobs/${up.id}/bizfile/queue`));
console.log(`corporate owners awaiting verification: ${queue.total ?? queue.queue?.length ?? 0}`);

console.log('\n=== 6. DOWNLOAD + SHEET CHECK ===');
const dl = await fetch(`${BASE}/jobs/${up.id}/download`);
const out = `${process.argv[4] ?? 'e2e-out'}.xlsx`;
writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
const { readWorkbookSheets } = await import('../src/excel/read.js');
const { names } = readWorkbookSheets(out);
console.log(`downloaded ${out}`);
console.log('sheets in deliverable:');
for (const n of names) console.log(`  - ${n}`);

const hasLetter = names.some((n) => /^Lawyer Letter$/i.test(n));
const hasPostcard = names.some((n) => /^Postcard/i.test(n));
console.log(`\nlawyer-letter sheet present: ${hasLetter}`);
console.log(`postcard sheet present:      ${hasPostcard}`);
console.log(
  hasLetter && hasPostcard
    ? '!! BOTH channels present — the "one channel only" rule is broken'
    : '>> exactly one channel in the workbook, as intended',
);
console.log(`\njobId=${up.id}`);
