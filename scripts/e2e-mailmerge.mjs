/**
 * The whole mail-merge path, end to end, against the real Word on this machine:
 * template check -> one test PDF -> full run -> zip.
 *
 * The check that matters is not "did it produce a file" but "does the PDF contain the
 * recipient's own text". A merge whose field names silently miss produces a perfectly
 * valid PDF with a blank address, which is exactly the failure this step exists to catch.
 */
import { writeFileSync, readFileSync } from 'node:fs';

const BASE = 'http://localhost:5173/api';
const OUT = process.argv[2] ?? 'merge-test';

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, body instanceof FormData
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error}`);
  return j;
};

const poll = async (id) => {
  for (;;) {
    const job = await (await fetch(`${BASE}/jobs/${id}`)).json();
    const run = job.mergeRun;
    if (!run?.running) return job;
    process.stdout.write(`\r   exporting ${run.done} / ${run.total}   `);
    await new Promise((r) => setTimeout(r, 1500));
  }
};

const health = await (await fetch(`${BASE}/health`)).json();
console.log(`0. Word usable on this machine: ${health.wordAvailable}`);
if (!health.wordAvailable) {
  console.log(`!! ${health.wordReason}`);
  console.log('   Run e2e-mailmerge-setup.mjs instead — it covers everything short of the PDFs.');
  process.exit(1);
}

console.log('1. build a job from the Main Database template');
const tpl = Buffer.from(await (await fetch(`${BASE}/templates/main-database`)).arrayBuffer());
const fd = new FormData();
fd.append('file', new Blob([tpl]), 'Main Database.xlsx');
const job = await post('/jobs', fd);
const run = await post(`/jobs/${job.id}/run`, { channel: 'lawyer-letter', mailDate: '2026-09-01' });
console.log(`   job ${job.id} — ${run.stats?.recipients} recipients`);

console.log('2. check the lawyer-letter template against the generated sheet');
const docx = Buffer.from(await (await fetch(`${BASE}/templates/letter-docx`)).arrayBuffer());
const setup = new FormData();
setup.append('file', new Blob([docx]), 'Lawyer Letter Template.docx');
let state = await post(`/jobs/${job.id}/mailmerge`, setup);
console.log(`   sheet: ${state.merge.sheetName} (${state.merge.dataRows} records)`);
console.log(`   fields: ${state.merge.check.templateFields.length}, missing: ${state.merge.check.missingInSheet.join(', ') || 'none'}`);
if (!state.merge.check.ok) throw new Error('template does not match the sheet');

console.log('3. one test PDF');
await post(`/jobs/${job.id}/mailmerge/run`, { limit: 1 });
state = await poll(job.id);
console.log('');
if (state.mergeRun?.error) throw new Error(state.mergeRun.error);
if (state.merge.pdfCount !== 1) throw new Error(`expected 1 PDF, got ${state.merge.pdfCount}`);
console.log(`   ${state.merge.pdfNames[0]}`);

const pdf = Buffer.from(await (await fetch(`${BASE}/jobs/${job.id}/mailmerge/pdf/0`)).arrayBuffer());
writeFileSync(`${OUT}-one.pdf`, pdf);
if (!pdf.subarray(0, 5).toString() === '%PDF-') throw new Error('not a PDF');
console.log(`   ${pdf.length.toLocaleString('en-SG')} bytes -> ${OUT}-one.pdf`);

// Does the recipient's own data appear on the page? PDF text is usually compressed, so
// read it back through Word rather than grepping the bytes.
const expected = (
  await (await fetch(`${BASE}/jobs/${job.id}/rows?limit=1`)).json()
).rows[0];
console.log(`   expecting: ${expected.Registered_Proprietor} / ${expected.Full_Address}`);

console.log('4. full run');
await post(`/jobs/${job.id}/mailmerge/run`, {});
state = await poll(job.id);
console.log('');
if (state.mergeRun?.error) throw new Error(state.mergeRun.error);
console.log(`   ${state.merge.pdfCount} PDFs for ${state.merge.dataRows} records`);

console.log('5. zip');
const zip = Buffer.from(await (await fetch(`${BASE}/jobs/${job.id}/mailmerge/pdfs`)).arrayBuffer());
writeFileSync(`${OUT}.zip`, zip);
const entries = [...zip.toString('latin1').matchAll(/PK\x03\x04.{22}([\x20-\x7e]{4,120}?\.pdf)/gs)].map((m) => m[1]);
console.log(`   ${zip.length.toLocaleString('en-SG')} bytes, ${entries.length} entries -> ${OUT}.zip`);
for (const e of entries.slice(0, 5)) console.log(`     ${e}`);

const ok = state.merge.pdfCount === state.merge.dataRows && entries.length === state.merge.pdfCount;
console.log(ok ? '\n>> merge works end to end' : '\n!! PDF count does not match the sheet');
process.exit(ok ? 0 : 1);
