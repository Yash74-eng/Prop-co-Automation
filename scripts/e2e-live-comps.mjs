/**
 * Live comps from Google Sheets, and the channel split.
 *
 * Two assertions that matter:
 *   - a lawyer letter priced off 2,800 live transactions carries real prices and comps;
 *   - a postcard run with the same comps loaded produces no pricing at all.
 *
 * The second is the one worth a test. Comps are only consumed by the lawyer letter, so a
 * postcard sheet that ever gained a price column would be leaking financials onto a
 * deliverable that is not supposed to have them.
 */
const BASE = 'http://localhost:5173/api';
const SHEET =
  process.argv[2] ??
  'https://docs.google.com/spreadsheets/d/1UeigMbJP-mueP6yAW6urbEYaPWrM75g6fw1HUZ_HXuY/edit';

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

const template = Buffer.from(
  await (await fetch(`${BASE}/templates/main-database`)).arrayBuffer(),
);

const results = {};
for (const channel of ['lawyer-letter', 'postcard']) {
  const fd = new FormData();
  fd.append('file', new Blob([template]), 'Main Database.xlsx');
  const job = await post('/jobs', fd);

  const comps = await post(`/jobs/${job.id}/comps-from-google-sheet`, { url: SHEET });
  const run = await post(`/jobs/${job.id}/run`, { channel, mailDate: '2026-09-01' });

  const row = run.preview?.[0] ?? {};
  const priceCols = Object.keys(row).filter((k) => /price|^comp_[12]$/i.test(k));

  console.log(`=== ${channel}`);
  console.log(`   comps loaded : ${comps.transactions?.toLocaleString('en-SG')} transactions, ${comps.districts?.length} districts`);
  console.log(`   recipients   : ${run.stats?.recipients}`);
  console.log(`   columns      : ${Object.keys(row).length}`);
  console.log(`   price columns: ${priceCols.length ? priceCols.join(', ') : 'none'}`);
  if (channel === 'lawyer-letter') {
    console.log(`   min / higher : ${row.minimum_Price} / ${row.higher_Price}`);
    console.log(`   comp 1       : ${row.Comp_Address_1} @ ${row.Comp_1}`);
    console.log(`   comp 2       : ${row.Comp_Address_2} @ ${row.Comp_2}`);
  }
  results[channel] = { priceCols, row, transactions: comps.transactions ?? 0 };
}

const letter = results['lawyer-letter'];
const card = results.postcard;

const checks = [
  ['live comps reached the server', letter.transactions > 1000],
  ['lawyer letter has price columns', letter.priceCols.length > 0],
  ['lawyer letter is actually priced', Number(letter.row.minimum_Price) > 0],
  ['lawyer letter carries a comparable', !!letter.row.Comp_Address_1],
  ['postcard has NO price columns', card.priceCols.length === 0],
];

console.log('');
for (const [label, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
