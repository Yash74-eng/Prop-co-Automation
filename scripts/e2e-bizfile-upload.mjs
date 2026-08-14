/**
 * Proves the recommended BizFile path end-to-end: build a small export-shaped workbook
 * from the job's own queue, upload it, and read back the verdicts.
 *
 * The addresses here are SYNTHETIC — deliberately a mix of exact match, same-building,
 * different-building and struck-off — so each verdict branch is exercised. This checks
 * the plumbing and the verdict logic, not real ACRA data.
 */
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:5173/api';
const JOB = process.argv[2];
const TMP = process.argv[3] ?? 'bizfile-upload.xlsx';

const queue = await (await fetch(`${BASE}/jobs/${JOB}/bizfile/queue`)).json();
const sample = (queue.rows ?? []).slice(0, 4);
if (sample.length === 0) throw new Error('no corporate owners in the queue');

// Build one row per verdict branch we want to see.
const rows = sample.map((q, i) => {
  const sheetAddr = q.mailingAddresses?.[0] ?? '';
  const postal = (sheetAddr.match(/\b(\d{6})\b/) ?? [])[1] ?? '000000';
  if (i === 0) return [q.ownerName, '201000001A', 'LIVE COMPANY', sheetAddr]; // exact
  if (i === 1) return [q.ownerName, '201000002B', 'LIVE COMPANY', `1 SOME ROAD #99-99 SINGAPORE ${postal}`]; // same building
  if (i === 2) return [q.ownerName, '201000003C', 'STRUCK OFF', sheetAddr]; // inactive
  return [q.ownerName, '201000004D', 'LIVE COMPANY', '1 ELSEWHERE ROAD SINGAPORE 999999']; // mismatch
});

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ['Entity Name', 'UEN', 'Entity Status', 'Registered Office Address'],
    ...rows,
  ]),
  'BizFile Export',
);
XLSX.writeFile(wb, TMP);
console.log(`built a ${rows.length}-record export-shaped workbook\n`);

const form = new FormData();
form.append('file', new Blob([readFileSync(TMP)]), 'bizfile-export.xlsx');
const res = await fetch(`${BASE}/jobs/${JOB}/bizfile`, { method: 'POST', body: form });
const out = await res.json();
console.log('HTTP', res.status);
if (out.error) {
  console.log('error:', out.error);
  process.exit(1);
}

console.log(`resolver: ${out.bizfile?.resolver ?? '(see job)'}`);
console.log(`verifications returned: ${out.rows?.length ?? 0}\n`);
const counts = {};
for (const r of out.rows ?? []) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
console.log('verdict tally across all', out.rows?.length, 'owners:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(16)} ${v}`);
}

console.log('\nthe four seeded owners (names redacted):');
for (const r of (out.rows ?? []).filter((r) => r.uen?.startsWith('2010000'))) {
  console.log(`  ${r.uen}  ${String(r.entityStatus).padEnd(13)} -> ${r.verdict.padEnd(15)} ${r.detail}`);
}
