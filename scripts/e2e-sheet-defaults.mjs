/**
 * The two things a user should not have to know:
 *
 *  1. Which tab of the tracker holds the owner rows. A link is copied from whichever tab
 *     was last open, so the server finds the Main Database rather than trusting the gid.
 *  2. Where the comps live. It is the same Market Watch workbook every time, so no link.
 *
 * Both failure modes are quiet — the wrong tab produces a run with no recipients, and a
 * mistyped comps id produces prices from the wrong sheet — so each is asserted rather
 * than eyeballed.
 */
const BASE = 'http://localhost:5173/api';

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error}`);
  return j;
};

const health = await (await fetch(`${BASE}/health`)).json();
console.log('1. the comps workbook is served, so nothing has to be pasted');
console.log(`   compsSheetUrl: ${health.compsSheetUrl}`);
const pinned = /1UeigMbJP-mueP6yAW6urbEYaPWrM75g6fw1HUZ_HXuY/.test(health.compsSheetUrl ?? '');

console.log('\n2. a job from an uploaded template, then comps with NO url supplied');
const template = Buffer.from(
  await (await fetch(`${BASE}/templates/main-database`)).arrayBuffer(),
);
const fd = new FormData();
fd.append('file', new Blob([template]), 'Main Database.xlsx');
const job = await (await fetch(`${BASE}/jobs`, { method: 'POST', body: fd })).json();

const comps = await post(`/jobs/${job.id}/comps-from-google-sheet`, {});
console.log(`   mode         : ${comps.mode}`);
console.log(`   transactions : ${comps.transactions?.toLocaleString('en-SG')}`);
console.log(`   districts    : ${comps.districts?.length}`);
console.log(`   source       : ${comps.compsSource}`);
const compsOk = comps.mode === 'transactions' && comps.transactions > 1000;

console.log('\n3. a tracker link pointing at the WRONG tab still finds the owner rows');
// District 1 of Market Watch is a transactions tab with no owner columns. Pointed at it,
// the server should look past the link — this spreadsheet has no Main Database at all, so
// the honest outcome is to say so rather than to pretend.
const wrongTab =
  'https://docs.google.com/spreadsheets/d/1UeigMbJP-mueP6yAW6urbEYaPWrM75g6fw1HUZ_HXuY/edit?gid=1663840271#gid=1663840271';
const fetched = await post('/jobs/from-google-sheet', { url: wrongTab });
console.log(`   tab chosen : ${fetched.tabChosen}`);
console.log(`   reason     : ${fetched.reason}`);
console.log(`   tabs seen  : ${fetched.candidates?.length}`);
// Match on the substance rather than the exact sentence: the reason must say an owner
// column is what is missing, so a run with no recipients is explained rather than silent.
const searched = /owner column/i.test(fetched.reason ?? '');

console.log('\n4. an explicit tab choice is still honoured');
const explicit = await post('/jobs/from-google-sheet', { url: wrongTab, gid: '582252607' });
console.log(`   tab chosen : ${explicit.tabChosen}`);
console.log(`   reason     : ${explicit.reason}`);
const honoured = explicit.tabChosen === 'District 2';

console.log('');
const checks = [
  ['comps workbook is pinned and served', pinned],
  ['comps fetch works with no url', compsOk],
  ['a wrong-tab link triggers a search, and says so', searched],
  ['every tab was considered', (fetched.candidates?.length ?? 0) > 20],
  ['an explicit gid overrides the search', honoured],
];
for (const [label, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
