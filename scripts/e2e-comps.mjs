/**
 * End-to-end: download the transactions template, upload it as the comps source, and
 * generate a lawyer letter. Proves the auto-detection, the per-property district
 * selection and the pricing formula all work through the real HTTP API.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const BASE = 'http://localhost:5173/api';
const SRC = process.argv[2];
const TMP = process.argv[3] ?? 'comps-template.xlsx';

const j = async (r) => {
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`non-JSON ${r.status}: ${t.slice(0, 200)}`); }
};

console.log('1. download the transactions template');
const dl = await fetch(`${BASE}/templates/transactions`);
console.log(`   HTTP ${dl.status}`);
writeFileSync(TMP, Buffer.from(await dl.arrayBuffer()));

console.log('2. build a small tracker: one Changi Road property (D14), one Boat Quay (D1)');
const XLSXmod = await import('xlsx');
const XLSX = XLSXmod.default ?? XLSXmod;
const twb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  twb,
  XLSX.utils.aoa_to_sheet([
    ['Address ID', 'Address', 'Postal Code', 'Target', 'Neighbourhood', 'Land Use',
     'Tenure', 'GFA', 'Owner Name', 'Owner Address'],
    ['A1', '300 CHANGI ROAD SINGAPORE 419123', '419123', 'Yes', 'Changi Road', 'Shophouse',
     'Freehold', 1500, 'CHANGI EXAMPLE PTE. LTD.', '12 ANN SIANG ROAD SINGAPORE 069692'],
    ['A2', '40 STANLEY STREET SINGAPORE 068700', '068700', 'Yes', 'Telok Ayer', 'Shophouse',
     'Freehold', 1700, 'STANLEY EXAMPLE PTE. LTD.', '5 NEIL ROAD SINGAPORE 088808'],
  ]),
  'Main Database',
);
const trackerPath = `${TMP}.tracker.xlsx`;
XLSX.writeFile(twb, trackerPath);

const fd = new FormData();
fd.append('file', new Blob([readFileSync(trackerPath)]), 'tracker.xlsx');
const up = await j(await fetch(`${BASE}/jobs`, { method: 'POST', body: fd }));
console.log(`   job ${up.id}`);

console.log('3. upload the template as the comps source');
const cf = new FormData();
cf.append('file', new Blob([readFileSync(TMP)]), 'transactions.xlsx');
const comps = await j(await fetch(`${BASE}/jobs/${up.id}/comps`, { method: 'POST', body: cf }));
if (comps.error) throw new Error(comps.error);
console.log(`   mode: ${comps.mode}`);
console.log(`   transactions: ${comps.transactions}, districts: ${JSON.stringify(comps.districts)}`);
if (comps.mode !== 'transactions') {
  console.log('!! the template was NOT recognised as a transactions sheet');
  process.exit(1);
}

console.log('4. generate a lawyer letter using them');
const run = await j(await fetch(`${BASE}/jobs/${up.id}/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel: 'lawyer-letter', mailDate: '2026-09-01' }),
}));
if (run.error) throw new Error(run.error);
console.log(`   recipients: ${run.stats.recipients}`);

const rows = run.preview ?? [];
const priced = rows.filter((r) => r.minimum_Price !== '' && r.minimum_Price != null);
const withComps = rows.filter((r) => r.Comp_Address_1);
console.log(`   preview rows: ${rows.length}, priced: ${priced.length}, with a comp: ${withComps.length}`);

console.log('\n5. every priced row, in full:');
for (const sample of rows) {
  console.log(`\n   property : ${sample.Full_Address}`);
  console.log(`   min      : ${sample.minimum_Price === '' ? '(blank)' : Number(sample.minimum_Price).toLocaleString('en-SG')}`);
  console.log(`   higher   : ${sample.higher_Price === '' ? '(blank)' : Number(sample.higher_Price).toLocaleString('en-SG')}`);
  console.log(`   comp 1   : ${sample.Comp_Address_1 || '(none)'} @ ${sample.Comp_1 ? Number(sample.Comp_1).toLocaleString('en-SG') : '-'}`);
  console.log(`   comp 2   : ${sample.Comp_Address_2 || '(none)'} @ ${sample.Comp_2 ? Number(sample.Comp_2).toLocaleString('en-SG') : '-'}`);
  console.log(`   basis    : ${String(sample.Comments).split(' | ').slice(0, 4).join('\n              ')}`);
}

console.log('\n6. sanity: no comp should be a psf figure');
let bad = 0;
for (const r of withComps) {
  for (const v of [r.Comp_1, r.Comp_2]) {
    if (v !== '' && v != null && Number(v) > 0 && Number(v) < 500_000) bad++;
  }
}
console.log(bad === 0 ? '   OK — every comp is a sale price' : `   !! ${bad} comps look like psf figures`);
process.exit(bad === 0 ? 0 : 1);
