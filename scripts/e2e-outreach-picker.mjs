/**
 * The Excel-style outreach picker: list the real values in the column, then filter on the
 * exact ones chosen.
 *
 * The point of picking values rather than states is that two rows can share a state and
 * still need separating — "Batch 3" and "Batch 4" are both batch tags. A state filter
 * cannot tell them apart; this can, and that is what the test checks.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

const BASE = 'http://localhost:5173/api';

const upload = async (path) => {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path)]), 'tracker.xlsx');
  return (await fetch(`${BASE}/jobs`, { method: 'POST', body: fd })).json();
};
const run = async (id, body) => {
  const r = await fetch(`${BASE}/jobs/${id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'lawyer-letter', mailDate: '2026-09-01', ...body }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.stats?.recipients ?? 0;
};

const dir = mkdtempSync(join(tmpdir(), 'picker-'));
const checks = [];
try {
  // Two different batch tags, so a state filter cannot separate them but a value pick can.
  const cells = [
    '', '', '',
    'Batch 3', 'Batch 3',
    'Batch 4',
    '27 Jun 2025 - Delivery Failed',
    '14 Feb 2026',
  ];
  const header = [
    'Address', 'Postal Code', 'Target', 'Neighbourhood', 'Land Use', 'Tenure',
    'Owner Name', 'Owner Address', 'Lawyer Letter Outreach',
  ];
  const rows = cells.map((cell, i) => [
    `${10 + i} CIRCULAR ROAD SINGAPORE 0494${String(10 + i).padStart(2, '0')}`,
    `0494${String(10 + i).padStart(2, '0')}`, 'Yes', 'Boat Quay', 'Shophouse', 'Freehold',
    `OWNER ${i + 1} PTE LTD`,
    `${20 + i} ANN SIANG ROAD SINGAPORE 0696${String(10 + i).padStart(2, '0')}`,
    cell,
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Main Database');
  const tracker = join(dir, 'tracker.xlsx');
  XLSX.writeFile(wb, tracker);

  const job = await upload(tracker);

  console.log('1. what the picker shows');
  const listed = await (
    await fetch(`${BASE}/jobs/${job.id}/outreach-values?channel=lawyer-letter`)
  ).json();
  if (listed.error) throw new Error(listed.error);
  console.log(`   column: ${listed.column}   rows: ${listed.rows}`);
  for (const v of listed.values) {
    console.log(`     ${String(v.count).padStart(2)}  ${(v.value || '(blank)').padEnd(32)} ${v.label}`);
  }
  checks.push(['every distinct value is listed', listed.values.length === 5]);
  checks.push(['counts add up to the row count', listed.values.reduce((s, v) => s + v.count, 0) === cells.length]);
  checks.push(['a blank is offered as a value', listed.values.some((v) => v.value === '')]);
  checks.push([
    'each value carries a readable state',
    listed.values.every((v) => v.label && v.label !== v.status),
  ]);

  console.log('\n2. filtering on exact values');
  const cases = [
    [['Batch 3'], 2, 'one batch tag, not the other'],
    [['Batch 4'], 1, 'the other batch tag alone'],
    [['Batch 3', 'Batch 4'], 3, 'both batch tags'],
    [[''], 3, 'blanks only'],
    [['27 Jun 2025 - Delivery Failed'], 1, 'the returned one'],
    [['', '27 Jun 2025 - Delivery Failed'], 4, 'blanks plus returned'],
  ];
  for (const [values, expected, why] of cases) {
    const j = await upload(tracker);
    const n = await run(j.id, { outreachIncludeValues: values });
    const ok = n === expected;
    console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${String(n).padStart(2)}/${expected}  ${why}`);
    checks.push([why, ok]);
  }

  console.log('\n3. a state filter cannot do that');
  const j = await upload(tracker);
  const byState = await run(j.id, { outreachInclude: ['batch-tag'] });
  console.log(`   include ["batch-tag"] -> ${byState} recipients (both tags, as expected)`);
  checks.push(['the state filter still takes both batch tags', byState === 3]);

  console.log('');
  for (const [label, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
