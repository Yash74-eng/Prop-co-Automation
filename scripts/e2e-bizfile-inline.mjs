/**
 * The correct-it-on-the-sheet loop:
 *   generate -> BizFile -> verdict columns land on the deliverable -> type a Corrected
 *   Address -> upload the same workbook -> the address is applied and everything re-runs.
 *
 * The assertion that matters is the last one. Columns that appear but are not read back
 * would be worse than no columns at all — they would look like a working loop.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import XLSX from 'xlsx';

const BASE = 'http://localhost:5173/api';
const TMP = process.argv[2] ?? 'bizfile-inline';

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
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error}`);
  return j;
};

const pollBizfile = async (id) => {
  for (;;) {
    const job = await (await fetch(`${BASE}/jobs/${id}`)).json();
    if (!job.bizfileRun?.running) return job;
    process.stdout.write(`\r   checking ${job.bizfileRun.done} / ${job.bizfileRun.total}   `);
    await new Promise((r) => setTimeout(r, 2000));
  }
};

console.log('1. build a postcard job from the Main Database template');
const tpl = Buffer.from(await (await fetch(`${BASE}/templates/main-database`)).arrayBuffer());
const fd = new FormData();
fd.append('file', new Blob([tpl]), 'Main Database.xlsx');
const job = await post('/jobs', fd);
const run = await post(`/jobs/${job.id}/run`, { channel: 'postcard', mailDate: '2026-09-01' });
console.log(`   job ${job.id} — ${run.stats?.recipients} recipients`);

console.log('2. verify against an uploaded BizFile export with a deliberate mismatch');
const rows = await (await fetch(`${BASE}/jobs/${job.id}/rows?limit=50`)).json();
const owner = rows.rows.find((r) => /PTE|LTD|LIMITED|LLP/i.test(String(r['Owner Name'] ?? '')));
if (!owner) throw new Error('no corporate owner in the template run');
console.log(`   owner: ${owner['Owner Name']}`);
console.log(`   sheet address: ${owner['Owner Address']}`);

const exportWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  exportWb,
  XLSX.utils.aoa_to_sheet([
    ['Entity Name', 'UEN', 'Entity Status', 'Registered Office Address'],
    [owner['Owner Name'], '200012345A', 'Live', '9 SOMEWHERE ELSE ROAD SINGAPORE 555555'],
  ]),
  'Export',
);
const exportPath = `${TMP}-export.xlsx`;
XLSX.writeFile(exportWb, exportPath);
const upload = new FormData();
upload.append('file', new Blob([readFileSync(exportPath)]), 'bizfile-export.xlsx');
await post(`/jobs/${job.id}/bizfile`, upload);
const verified = await pollBizfile(job.id);
console.log('');
if (verified.bizfileRun?.error) throw new Error(verified.bizfileRun.error);
console.log(`   verdicts: ${JSON.stringify(verified.bizfile.verdicts)}`);

console.log('3. do the verdict columns appear on Postcards Final?');
const wbBuf = Buffer.from(await (await fetch(`${BASE}/jobs/${job.id}/download`)).arrayBuffer());
writeFileSync(`${TMP}-after-bizfile.xlsx`, wbBuf);
const wb = XLSX.read(wbBuf, { cellDates: true });
const finalSheet = XLSX.utils.sheet_to_json(wb.Sheets['Postcards Final'], { header: 1, defval: '' });
console.log(`   headers: ${finalSheet[0].join(' | ')}`);
const hasCols = ['BizFile Verdict', 'BizFile Registered Address', 'Corrected Address'].every((h) =>
  finalSheet[0].includes(h),
);
const verdictCol = finalSheet[0].indexOf('BizFile Verdict');
const acraCol = finalSheet[0].indexOf('BizFile Registered Address');
const correctedCol = finalSheet[0].indexOf('Corrected Address');
const mismatchRow = finalSheet.findIndex((r, i) => i > 0 && r[verdictCol] === 'mismatch');
console.log(`   columns present: ${hasCols}`);
if (mismatchRow > 0) {
  console.log(`   row ${mismatchRow + 1}: verdict=${finalSheet[mismatchRow][verdictCol]}`);
  console.log(`             ACRA says: ${finalSheet[mismatchRow][acraCol]}`);
  console.log(`             Corrected Address is empty: ${finalSheet[mismatchRow][correctedCol] === ''}`);
}

console.log('4. type a Corrected Address into that row and upload the workbook back');
const TYPED = '77 FIXED BY HAND ROAD #05-02 SINGAPORE 069999';
finalSheet[mismatchRow][correctedCol] = TYPED;
wb.Sheets['Postcards Final'] = XLSX.utils.aoa_to_sheet(finalSheet);
const editedPath = `${TMP}-edited.xlsx`;
XLSX.writeFile(wb, editedPath);

const rerunForm = new FormData();
rerunForm.append('file', new Blob([readFileSync(editedPath)]), 'edited-workbook.xlsx');
const rerun = await post(`/jobs/${job.id}/rerun-addresses`, rerunForm);
console.log(`   offered ${rerun.offered}, typed ${rerun.typedCorrections}, applied ${rerun.applied}`);
console.log(`   recipients ${rerun.recipientsBefore} -> ${rerun.recipientsAfter}`);
for (const o of rerun.overrides ?? []) console.log(`   override: ${JSON.stringify(o)}`);

console.log('5. did the typed address actually reach the sheet?');
const after = await (await fetch(`${BASE}/jobs/${job.id}/rows?limit=50`)).json();
const fixed = after.rows.find((r) => String(r['Owner Address'] ?? '') === TYPED);
console.log(fixed ? `   yes — ${fixed['Owner Name']} now posts to ${fixed['Owner Address']}` : '   NOT FOUND');

const pass = hasCols && mismatchRow > 0 && rerun.typedCorrections >= 1 && !!fixed;
console.log(pass ? '\n>> correct-on-the-sheet loop works' : '\n!! the loop is broken');
process.exit(pass ? 0 : 1);
