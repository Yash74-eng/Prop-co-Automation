/**
 * The mail-merge setup path, which works with or without Word: template validation
 * against the sheet actually being merged, and the script escape hatch.
 *
 * Split out from e2e-mailmerge.mjs so the half that does not need Word can still be run
 * on a machine that cannot produce PDFs.
 */
import { writeFileSync } from 'node:fs';

const BASE = 'http://localhost:5173/api';
const OUT = process.argv[2] ?? 'merge-setup';

const post = async (path, body) => {
  const r = await fetch(
    `${BASE}${path}`,
    body instanceof FormData
      ? { method: 'POST', body }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  return { status: r.status, body: await r.json() };
};

const health = await (await fetch(`${BASE}/health`)).json();
console.log(`0. Word usable here: ${health.wordAvailable}`);
if (health.wordReason) console.log(`   ${health.wordReason}`);

console.log('1. job from the Main Database template');
const tpl = Buffer.from(await (await fetch(`${BASE}/templates/main-database`)).arrayBuffer());
const fd = new FormData();
fd.append('file', new Blob([tpl]), 'Main Database.xlsx');
const job = (await post('/jobs', fd)).body;
if (job.error) throw new Error(job.error);
const run = (await post(`/jobs/${job.id}/run`, { channel: 'lawyer-letter', mailDate: '2026-09-01' }))
  .body;
console.log(`   job ${job.id} — ${run.stats?.recipients} recipients`);

console.log('2. the right template validates against the generated sheet');
const letter = Buffer.from(await (await fetch(`${BASE}/templates/letter-docx`)).arrayBuffer());
const setup = new FormData();
setup.append('file', new Blob([letter]), 'Lawyer Letter Template.docx');
const ok = (await post(`/jobs/${job.id}/mailmerge`, setup)).body;
if (ok.error) throw new Error(ok.error);
console.log(`   sheet ${ok.merge.sheetName}, ${ok.merge.dataRows} records`);
console.log(`   fields ${ok.merge.check.templateFields.length}, missing: ${ok.merge.check.missingInSheet.join(', ') || 'none'}`);
const matched = ok.merge.check.ok;

console.log('3. the wrong template is caught, not merged blank');
const postcard = Buffer.from(await (await fetch(`${BASE}/templates/postcard-docx`)).arrayBuffer());
const wrong = new FormData();
wrong.append('file', new Blob([postcard]), 'Postcard Template.docx');
const bad = (await post(`/jobs/${job.id}/mailmerge`, wrong)).body;
console.log(`   ok=${bad.merge.check.ok}, missing: ${bad.merge.check.missingInSheet.join(', ') || 'none'}`);
const caught = !bad.merge.check.ok;

console.log('4. re-point at the right template and download the script');
await post(`/jobs/${job.id}/mailmerge`, (() => {
  const f = new FormData();
  f.append('file', new Blob([letter]), 'Lawyer Letter Template.docx');
  return f;
})());
const script = await (await fetch(`${BASE}/jobs/${job.id}/mailmerge/script`)).text();
writeFileSync(`${OUT}.ps1`, script);
const hasQuery = script.includes("'$]'") && script.includes('OpenDataSource');
console.log(`   ${script.length} bytes -> ${OUT}.ps1  (OLEDB query built: ${hasQuery})`);

console.log('5. running without Word must refuse quickly, not hang');
const started = Date.now();
const attempt = await post(`/jobs/${job.id}/mailmerge/run`, { limit: 1 });
const took = Date.now() - started;
console.log(`   HTTP ${attempt.status} in ${took}ms`);
console.log(`   ${attempt.body.error ?? 'accepted — Word is usable here'}`);
const refusedWell = health.wordAvailable ? attempt.status === 202 : attempt.status === 400 && took < 5000;

const pass = matched && caught && hasQuery && refusedWell;
console.log(pass ? '\n>> setup path is sound' : '\n!! setup path failed');
process.exit(pass ? 0 : 1);
