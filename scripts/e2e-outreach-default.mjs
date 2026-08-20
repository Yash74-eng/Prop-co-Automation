/**
 * The outreach filter default, against a tracker whose outreach column carries batch tags.
 *
 * This is the shape that produced 274 source rows and 0 recipients: every row tagged with a
 * batch name, and "exclude-contacted" keeping only rows where that column is blank. The
 * failure was silent — a funnel of zeroes and no error anywhere — so the assertion is that
 * the default keeps rows, not merely that the run succeeds.
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

const BASE = 'http://localhost:5173/api';

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

const dir = mkdtempSync(join(tmpdir(), 'outreach-'));
try {
  // A tracker where every row is tagged, as Figment's is.
  const header = [
    'Address',
    'Postal Code',
    'Target',
    'Neighbourhood',
    'Land Use',
    'Tenure',
    'Owner Name',
    'Owner Address',
    'Postcard Outreach Date',
    'Lawyer Letter Outreach',
  ];
  const rows = Array.from({ length: 12 }, (_, i) => [
    `${10 + i} CIRCULAR ROAD SINGAPORE 0494${String(10 + i).padStart(2, '0')}`,
    `0494${String(10 + i).padStart(2, '0')}`,
    'Yes',
    'Boat Quay',
    'Shophouse',
    'Freehold',
    `OWNER ${i + 1} PTE LTD`,
    `${20 + i} ANN SIANG ROAD SINGAPORE 0696${String(10 + i).padStart(2, '0')}`,
    'Batch 3',
    'Batch 3',
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Main Database');
  const path = join(dir, 'tagged-tracker.xlsx');
  XLSX.writeFile(wb, path);

  const results = {};
  for (const mode of [undefined, 'exclude-contacted']) {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(path)]), 'tagged-tracker.xlsx');
    const job = await post('/jobs', fd);
    const body = { channel: 'postcard', mailDate: '2026-09-01' };
    if (mode) body.outreachMode = mode;
    const run = await post(`/jobs/${job.id}/run`, body);

    const funnel = await (await fetch(`${BASE}/jobs/${job.id}/funnel`)).json();
    const stages = Object.fromEntries(funnel.stages.map((s) => [s.key, s.value]));
    results[mode ?? 'default'] = { recipients: run.stats?.recipients ?? 0, stages };

    console.log(`=== outreachMode: ${mode ?? '(default)'}`);
    for (const s of funnel.stages) console.log(`   ${s.label.padEnd(22)} ${s.value}`);
  }

  const def = results.default;
  const strict = results['exclude-contacted'];

  console.log('');
  const checks = [
    ['source rows were read', def.stages.sourceRows === 12],
    ['default keeps every tagged row', def.stages.afterOutreachFilter === 12],
    ['default produces recipients', def.recipients > 0],
    ['exclude-contacted still drops them all', strict.stages.afterOutreachFilter === 0],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
