import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { JobState } from '../useJob.js';
import { Card, DataGrid, Empty, Field, Msg, Pill, Spinner, StatTile, SummaryList } from '../ui.jsx';

export function VerifyView({ state }: { state: JobState }) {
  const { job, health, busy, guard, setJob } = state;
  const [queue, setQueue] = useState<{ total: number } | null>(null);
  const [bizfileRows, setBizfileRows] = useState<Record<string, unknown>[]>([]);
  const [findings, setFindings] = useState<Record<string, unknown>[]>([]);
  const [bizfileFile, setBizfileFile] = useState<File | null>(null);

  const jobId = job?.id;
  useEffect(() => {
    if (!jobId) return;
    api.bizfileQueue(jobId).then(setQueue).catch(() => setQueue(null));
  }, [jobId]);

  if (!job || !job.hasResult) {
    return <Empty>Generate a sheet first — there is nothing to verify yet.</Empty>;
  }

  const severities = job.crossCheck?.severities ?? {};

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Verify</h1>
          <p className="lede">
            Two independent checks, both run only when you ask. Neither edits the sheet — each
            writes its findings to its own subsheet for a human to act on.
          </p>
        </div>
      </div>

      {/* ------------------------------------------------------------ BizFile */}
      <Card
        title="BizFile registered addresses"
        aside={
          job.bizfile ? (
            <span className="muted" style={{ fontSize: 12.5 }}>
              last run {new Date(job.bizfile.runAt).toLocaleString('en-SG')}
            </span>
          ) : null
        }
        hint={
          <>
            Compares ACRA's registered office address against the mailing address in the sheet, for
            every corporate owner. The reliable path is to search the names on{' '}
            <a href="https://www.bizfile.gov.sg/buy-info/search/results" target="_blank" rel="noreferrer">
              bizfile.gov.sg
            </a>{' '}
            and upload the export — columns like <code>Entity Name</code>, <code>UEN</code> and{' '}
            <code>Registered Office Address</code> are picked up automatically.
          </>
        }
      >
        <div className="stats" style={{ marginBottom: 14 }}>
          <StatTile label="Corporate owners" value={queue?.total ?? 0} detail="in this run" accent />
          {job.bizfile
            ? Object.entries(job.bizfile.verdicts).map(([k, v]) => (
                <StatTile key={k} label={k.replace(/-/g, ' ')} value={v} />
              ))
            : null}
        </div>

        <div className="grid">
          <Field
            label="BizFile export"
            hint="Excel or CSV. Leave empty to try the live lookup instead."
          >
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => setBizfileFile(e.target.files?.[0] ?? null)}
            />
          </Field>
        </div>

        {!health?.bizfileEnabled && !bizfileFile ? (
          <Msg kind="info">
            Live scraping is disabled on this machine. Upload an export, or install Playwright and
            set <code>BIZFILE_ENABLED=1</code> in <code>.env</code> to enable it. BizFile is a
            JavaScript app behind a WAF, so the live path is best-effort and rate-limited.
          </Msg>
        ) : null}

        <div className="actions">
          <button
            disabled={!!busy || !queue?.total}
            onClick={() =>
              void guard(
                'BizFile verification',
                () => api.bizfile(job.id, bizfileFile ?? undefined),
                'BizFile verification complete',
              ).then((r) => {
                if (!r) return;
                setJob(r);
                setBizfileRows(r.rows);
              })
            }
          >
            {busy === 'BizFile verification' ? <Spinner /> : null}
            {bizfileFile ? 'Verify against upload' : 'Run live lookup'}
          </button>
          {!queue?.total ? (
            <span className="muted" style={{ fontSize: 13 }}>
              No corporate owners in this run — nothing to verify.
            </span>
          ) : null}
        </div>

        {bizfileRows.length ? (
          <div style={{ marginTop: 14 }}>
            <DataGrid
              rows={bizfileRows}
              columns={[
                'verdict',
                'ownerName',
                'uen',
                'entityStatus',
                'bizfileAddress',
                'mailingAddressInSheet',
                'detail',
              ]}
              searchPlaceholder="Search owners, verdicts…"
            />
          </div>
        ) : null}
      </Card>

      {/* ------------------------------------------------------------- Claude */}
      <Card
        title="Claude cross-check"
        aside={
          job.crossCheck ? (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {job.crossCheck.rowsChecked.toLocaleString('en-SG')} rows · {job.crossCheck.model}
            </span>
          ) : null
        }
        hint="Claude reads the finished rows and reports what looks wrong — malformed merged addresses, names that read like institutions, prices that do not fit the neighbourhood, un-mailable owner addresses. It reports only; it never edits the sheet."
      >
        {!health?.anthropicKey ? (
          <Msg kind="warn">
            No API key configured. Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and
            restart the server to enable this step.
          </Msg>
        ) : null}

        {job.crossCheck ? (
          <div className="stats" style={{ marginBottom: 14 }}>
            <StatTile label="Findings" value={job.crossCheck.findings} accent />
            {(['error', 'warning', 'info'] as const).map((k) =>
              severities[k] ? <StatTile key={k} label={k} value={severities[k]} /> : null,
            )}
          </div>
        ) : null}

        <div className="actions">
          <button
            disabled={!!busy || !health?.anthropicKey}
            onClick={() =>
              void guard('Claude cross-check', () => api.crossCheck(job.id, {}), 'Cross-check complete').then(
                (r) => {
                  if (!r) return;
                  setJob(r);
                  setFindings(r.findings);
                },
              )
            }
          >
            {busy === 'Claude cross-check' ? <Spinner /> : null}
            Check all {(job.stats?.recipients ?? 0).toLocaleString('en-SG')} rows
          </button>
          <button
            className="ghost"
            disabled={!!busy || !health?.anthropicKey}
            onClick={() =>
              void guard(
                'Claude cross-check',
                () => api.crossCheck(job.id, { maxRows: 40 }),
                'Sample cross-check complete',
              ).then((r) => {
                if (!r) return;
                setJob(r);
                setFindings(r.findings);
              })
            }
          >
            Sample first 40 rows
          </button>
        </div>

        {job.crossCheck?.errors.length ? (
          <Msg kind="warn">{job.crossCheck.errors.join(' · ')}</Msg>
        ) : null}

        {findings.length ? (
          <div style={{ marginTop: 14 }}>
            <DataGrid
              rows={findings}
              columns={[
                { key: 'severity', label: 'Severity' },
                { key: 'row', label: 'Sheet row' },
                { key: 'field', label: 'Field' },
                { key: 'issue', label: 'Issue' },
                { key: 'suggestion', label: 'Suggested fix' },
              ]}
              searchPlaceholder="Search findings…"
            />
          </div>
        ) : job.crossCheck && job.crossCheck.findings === 0 ? (
          <Msg kind="ok">Claude found nothing wrong with the rows it checked.</Msg>
        ) : null}
      </Card>

      {job.crossCheck || job.bizfile ? (
        <Card title="Where the findings live" flat>
          <SummaryList
            items={[
              ...(job.bizfile ? [{ label: 'BizFile Verification sheet', count: job.bizfile.count }] : []),
              ...(job.crossCheck
                ? [{ label: 'Claude Cross-Check sheet', count: job.crossCheck.findings }]
                : []),
            ]}
          />
          <p className="hint" style={{ marginTop: 10 }}>
            Both are appended to the workbook — re-download it to pick them up.
          </p>
          <a href={api.downloadUrl(job.id)}>
            <button className="secondary" type="button">
              Download updated workbook
            </button>
          </a>
        </Card>
      ) : null}
    </>
  );
}
