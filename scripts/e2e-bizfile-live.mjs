/**
 * Drives the async BizFile route the way the UI does: POST, expect 202, then poll
 * job.bizfileRun until it finishes. Reports the verdict tally and the resolve rate.
 */
const BASE = 'http://localhost:5173/api';
const JOB = process.argv[2];
const LIMIT = Number(process.argv[3] ?? 60);

const t0 = Date.now();
const res = await fetch(`${BASE}/jobs/${JOB}/bizfile`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ limit: LIMIT }),
});
console.log(`POST returned HTTP ${res.status} in ${Date.now() - t0}ms (expect 202, not a long hold)`);
const started = await res.json();
if (started.error) {
  console.log('error:', started.error);
  process.exit(1);
}
console.log(`run started: total=${started.bizfileRun?.total} resolver=${started.bizfileRun?.resolver}`);

let job = started;
let lastDone = -1;
while (job.bizfileRun?.running) {
  await new Promise((r) => setTimeout(r, 4000));
  job = await (await fetch(`${BASE}/jobs/${JOB}`)).json();
  const run = job.bizfileRun;
  if (run && run.done !== lastDone) {
    lastDone = run.done;
    process.stdout.write(`\r  progress ${run.done}/${run.total}  (${run.current ?? ''})`.padEnd(90));
  }
}
console.log(`\n\nfinished in ${Math.round((Date.now() - t0) / 1000)}s`);

if (job.bizfileRun?.error) {
  console.log('RUN FAILED (nothing written):');
  console.log('  ' + job.bizfileRun.error);
  process.exit(1);
}

const v = job.bizfile?.verdicts ?? {};
const total = Object.values(v).reduce((a, b) => a + b, 0);
console.log(`resolver: ${job.bizfile?.resolver}`);
console.log(`owners checked: ${total}\n`);
console.log('verdict tally:');
for (const [k, n] of Object.entries(v).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(17)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(1)}%`);
}
const resolved = total - (v['not-found'] ?? 0) - (v['lookup-failed'] ?? 0);
console.log(`\nresolved against ACRA: ${resolved}/${total} (${((resolved / total) * 100).toFixed(1)}%)`);
console.log(`could not be checked:  ${v['lookup-failed'] ?? 0}`);
