/**
 * The corrective path that is actually safe: upload full registered addresses (block and
 * unit included, as a purchased Business Profile export carries) and rebuild.
 * Builds the export from the job's own owners so the names match real data.
 */
import * as XLSXmod from 'xlsx';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const XLSX = XLSXmod.default ?? XLSXmod;
const BASE = 'http://localhost:5173/api';
const SRC = process.argv[2];
const TMP = process.argv[3] ?? 'corrections.xlsx';

const j = async (r) => JSON.parse(await r.text());

console.log('1. upload + generate');
const fd = new FormData();
fd.append('file', new Blob([readFileSync(SRC)]), basename(SRC));
const up = await j(await fetch(`${BASE}/jobs`, { method: 'POST', body: fd }));
const run = await j(
  await fetch(`${BASE}/jobs/${up.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'lawyer-letter', mailDate: '2026-09-01' }),
  }),
);
console.log(`   ${run.stats.recipients} recipients`);

console.log('2. build a corrections file with COMPLETE addresses');
const queue = await j(await fetch(`${BASE}/jobs/${up.id}/bizfile/queue`));
const targets = (queue.rows ?? []).slice(0, 5);
const rows = targets.map((q, i) => [
  q.ownerName,
  `20000000${i}A`,
  'Live Company',
  // A full address: block number, street, unit, postal code.
  `${10 + i} ROBINSON ROAD #0${i + 1}-01 SINGAPORE 04854${i}`,
  'Local Company',
]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ['Entity Name', 'UEN', 'Entity Status', 'Registered Office Address', 'Entity Type'],
    ...rows,
  ]),
  'BizFile Export',
);
XLSX.writeFile(wb, TMP);
console.log(`   ${rows.length} corrections, all with block numbers`);

console.log('3. rebuild from the upload');
const form = new FormData();
form.append('file', new Blob([readFileSync(TMP)]), 'corrections.xlsx');
const rr = await j(await fetch(`${BASE}/jobs/${up.id}/rerun-addresses`, { method: 'POST', body: form }));
if (rr.error) {
  console.log(`   ERROR: ${rr.error}`);
  process.exit(1);
}
console.log(`   offered ${rr.offered}, rejected ${rr.skippedIncomplete}, applied to ${rr.applied} rows`);
console.log(`   recipients ${rr.recipientsBefore} -> ${rr.recipientsAfter}`);
for (const o of (rr.overrides ?? []).slice(0, 3)) {
  console.log(`     ${o.ownerName}`);
  console.log(`       was: ${o.previousAddress}`);
  console.log(`       now: ${o.newAddress}`);
}

console.log('4. sheets in the rebuilt workbook');
const dl = await fetch(`${BASE}/jobs/${up.id}/download`);
const out = `${process.argv[4] ?? 'rerun-upload'}.xlsx`;
writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
const book = XLSX.readFile(out);
for (const n of book.SheetNames) console.log(`   - ${n}`);

const ov = book.Sheets['Address Overrides'];
if (ov) {
  const data = XLSX.utils.sheet_to_json(ov, { header: 1 });
  console.log(`\n5. Address Overrides sheet: ${data.length - 1} rows`);
  console.log(`   headers: ${data[0].join(' | ')}`);
} else {
  console.log('\n!! no Address Overrides sheet');
  process.exit(1);
}
