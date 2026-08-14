/**
 * Round-trips the Main Database template: download it, upload it back, and generate.
 * A template that the app cannot itself read would be worse than none at all.
 */
import { writeFileSync, readFileSync } from 'node:fs';

const BASE = 'http://localhost:5173/api';
const TMP = process.argv[2] ?? 'template-roundtrip.xlsx';

console.log('1. download the Main Database template');
const dl = await fetch(`${BASE}/templates/main-database`);
console.log(`   HTTP ${dl.status}`);
writeFileSync(TMP, Buffer.from(await dl.arrayBuffer()));

console.log('2. upload it back as a job');
const fd = new FormData();
fd.append('file', new Blob([readFileSync(TMP)]), 'PropCo Template - Main Database.xlsx');
const up = await (await fetch(`${BASE}/jobs`, { method: 'POST', body: fd })).json();
if (up.error) throw new Error(up.error);
console.log(`   job ${up.id}`);
console.log(`   sheets: ${up.sheetNames.join(', ')}`);

console.log('3. preview — do the headers map?');
const pv = await (
  await fetch(`${BASE}/jobs/${up.id}/sheets/${encodeURIComponent('Main Database')}/preview`)
).json();
console.log(`   parsed rows: ${pv.parsedRows}`);
console.log(`   fields mapped: ${pv.mappedFields?.length}`);
console.log(`   fields missing: ${pv.missingFields?.length} (${(pv.missingFields ?? []).join(', ') || 'none'})`);

console.log('4. generate a postcard run from the template');
const run = await (
  await fetch(`${BASE}/jobs/${up.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'postcard', mailDate: '2026-09-01' }),
  })
).json();
if (run.error) throw new Error(run.error);
console.log(`   recipients: ${run.stats?.recipients}`);
console.log(`   output: ${run.outputFileName}`);

const ok = (run.stats?.recipients ?? 0) > 0;
console.log(
  ok
    ? '\n>> the template is valid: it parses and produces recipients'
    : '\n!! the template produced no recipients — it does not work as a starter file',
);
process.exit(ok ? 0 : 1);
