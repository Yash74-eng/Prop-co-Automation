/**
 * The three things the operator now chooses, plus the failure that started it.
 *
 *  1. A missing local file heals instead of leaking `ENOENT ... \uploads\<uuid>.xlsx`.
 *  2. Outreach states are picked from a list, so "sent but came back undelivered" is
 *     selectable on its own.
 *  3. The pricing method is picked, and each one actually produces a different range.
 */
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

const BASE = 'http://localhost:5173/api';

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json() };
};

const upload = async (path, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path)]), name);
  const r = await fetch(`${BASE}/jobs`, { method: 'POST', body: fd });
  return r.json();
};

const dir = mkdtempSync(join(tmpdir(), 'selectable-'));
const checks = [];
try {
  // A tracker with one row per outreach state, and comps far enough apart that the
  // pricing methods cannot coincidentally agree.
  const header = [
    'Address', 'Postal Code', 'Target', 'Neighbourhood', 'Land Use', 'Tenure', 'GFA',
    'Owner Name', 'Owner Address', 'Lawyer Letter Outreach',
  ];
  const states = [
    ['', 'blank'],
    ['27 Jun 2025 - Delivery Failed', 'delivery-failed'],
    ['Batch 3', 'batch-tag'],
    ['14 Feb 2026', 'sent-date'],
  ];
  const rows = states.map(([cell], i) => [
    `${10 + i} CIRCULAR ROAD SINGAPORE 0494${String(10 + i).padStart(2, '0')}`,
    `0494${String(10 + i).padStart(2, '0')}`, 'Yes', 'Boat Quay', 'Shophouse', 'Freehold', 3000,
    `OWNER ${i + 1} PTE LTD`,
    `${20 + i} ANN SIANG ROAD SINGAPORE 0696${String(10 + i).padStart(2, '0')}`,
    cell,
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Main Database');
  const tracker = join(dir, 'states.xlsx');
  XLSX.writeFile(wb, tracker);

  console.log('1. a missing local file — the ENOENT that started this');
  const doomed = await upload(tracker, 'states.xlsx');
  // Delete the whole storage tree under the running server, exactly as clearing disk does.
  rmSync('storage', { recursive: true, force: true });
  const preview = await fetch(
    `${BASE}/jobs/${doomed.id}/sheets/${encodeURIComponent('Main Database')}/preview`,
  );
  const previewBody = await preview.json();
  console.log(`   HTTP ${preview.status}`);
  console.log(`   ${String(previewBody.error ?? 'read OK').split('\n')[0]}`);
  checks.push(['a missing file gives an explanation, not ENOENT', !/ENOENT/.test(previewBody.error ?? '')]);
  checks.push(['it says what to do', /[Uu]pload the file again/.test(previewBody.error ?? '')]);

  console.log('\n2. a fresh upload works even though storage was just deleted');
  const job = await upload(tracker, 'states.xlsx');
  checks.push(['upload recreated the storage folders', !!job.id]);
  console.log(`   job ${job.id?.slice(0, 8)}`);

  console.log('\n3. outreach states are selectable one at a time');
  for (const [, status] of states) {
    const j = await upload(tracker, 'states.xlsx');
    const run = await post(`/jobs/${j.id}/run`, {
      channel: 'lawyer-letter',
      mailDate: '2026-09-01',
      outreachInclude: [status],
    });
    const n = run.body.stats?.recipients ?? 0;
    console.log(`   include ["${status}"] -> ${n} recipient(s)`);
    checks.push([`"${status}" selects exactly its own row`, n === 1]);
  }

  console.log('\n4. every pricing method is honoured and they differ');
  const compsWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    compsWb,
    XLSX.utils.aoa_to_sheet([
      ['Date', 'District', 'Address', 'Type of Area', 'Area (sq ft)', 'Price ($psf)', 'Price ($)', 'URA Zoning'],
      ['2026-05-01', 1, '60 CLUB STREET', 'Land', 2400, 3750, 9_000_000, 'Full Commercial'],
      ['2026-04-01', 1, '78 PAGODA STREET', 'Land', 3000, 5000, 15_000_000, 'Full Commercial'],
    ]),
    'District 1',
  );
  const compsPath = join(dir, 'comps.xlsx');
  XLSX.writeFile(compsWb, compsPath);

  const ranges = {};
  for (const method of ['figment-band', 'comps-range', 'comps-median-band', 'comps-psf-band', 'manual']) {
    const j = await upload(tracker, 'states.xlsx');
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(compsPath)]), 'comps.xlsx');
    const loaded = await (await fetch(`${BASE}/jobs/${j.id}/comps`, { method: 'POST', body: fd })).json();
    if (method === 'figment-band') console.log(`   comps: mode=${loaded.mode} n=${loaded.transactions} districts=${JSON.stringify(loaded.districts)} err=${loaded.error ?? '-'}`);
    const run = await post(`/jobs/${j.id}/run`, {
      channel: 'lawyer-letter',
      mailDate: '2026-09-01',
      pricingMethod: method,
    });
    const row = run.body.preview?.[0] ?? {};
    const range = `${row.minimum_Price || 'blank'} / ${row.higher_Price || 'blank'}`;
    if (method === 'figment-band') console.log(`   basis: ${String(row.Comments).slice(0, 160)}`);
    ranges[method] = range;
    console.log(`   ${method.padEnd(19)} ${range}`);
  }
  checks.push(['manual leaves both blank', ranges.manual === 'blank / blank']);
  checks.push([
    'the methods produce different ranges',
    new Set(Object.values(ranges)).size >= 4,
  ]);
  checks.push([
    'comps-range is exactly the two comp prices',
    ranges['comps-range'] === '9000000 / 15000000',
  ]);

  console.log('');
  for (const [label, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
