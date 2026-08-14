/**
 * End-to-end: generate, verify a slice against ACRA, then rebuild with the corrected
 * addresses applied before dedupe. Checks the coverage and override sheets land.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const BASE = 'http://localhost:5173/api';
const SRC = process.argv[2];
const LIMIT = Number(process.argv[3] ?? 40);

const j = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`non-JSON ${r.status}: ${t.slice(0, 200)}`);
  }
};

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
console.log(`   job ${up.id} — ${run.stats.recipients} recipients`);

console.log(`2. verify ${LIMIT} owners against ACRA`);
const started = await j(
  await fetch(`${BASE}/jobs/${up.id}/bizfile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: LIMIT }),
  }),
);
if (started.error) throw new Error(started.error);
let job = started;
while (job.bizfileRun?.running) {
  await new Promise((r) => setTimeout(r, 4000));
  job = await j(await fetch(`${BASE}/jobs/${up.id}`));
  process.stdout.write(`\r   ${job.bizfileRun?.done ?? 0}/${job.bizfileRun?.total ?? 0}   `);
}
console.log('');
if (job.bizfileRun?.error) throw new Error(job.bizfileRun.error);
const verdicts = job.bizfile?.verdicts ?? {};
console.log(`   verdicts: ${JSON.stringify(verdicts)}`);

console.log('3. rebuild with corrected addresses');
const rr = await j(
  await fetch(`${BASE}/jobs/${up.id}/rerun-addresses`, { method: 'POST', body: new FormData() }),
);
if (rr.error) {
  console.log(`   ${rr.error}`);
} else {
  console.log(`   corrections offered: ${rr.offered}`);
  console.log(`   rejected as incomplete (no block number): ${rr.skippedIncomplete ?? 0}`);
  console.log(`   rows actually changed: ${rr.applied}`);
  console.log(`   recipients ${rr.recipientsBefore} -> ${rr.recipientsAfter}`);
  for (const o of (rr.overrides ?? []).slice(0, 3)) {
    console.log(`     ${o.ownerName}`);
    console.log(`       was: ${o.previousAddress}`);
    console.log(`       now: ${o.newAddress}`);
  }
}

console.log('4. sheets in the rebuilt workbook');
const dl = await fetch(`${BASE}/jobs/${up.id}/download`);
const out = `${process.argv[4] ?? 'rerun-out'}.xlsx`;
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
const XLSXmod = await import('xlsx');
const XLSX = XLSXmod.default ?? XLSXmod;
const wb = XLSX.readFile(out);
for (const n of wb.SheetNames) console.log(`   - ${n}`);

const cov = wb.Sheets['BizFile Coverage'];
if (cov) {
  console.log('\n5. BizFile Coverage sheet:');
  for (const row of XLSX.utils.sheet_to_json(cov, { header: 1 })) {
    if (row.length) console.log(`   ${String(row[0] ?? '').padEnd(34)} ${row[1] ?? ''}  ${row[2] ?? ''}`);
  }
} else {
  console.log('\n!! no BizFile Coverage sheet');
}
