import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { JobState } from '../useJob.js';
import {
  Card,
  DataGrid,
  Empty,
  Field,
  Msg,
  Pill,
  Spinner,
  StatTile,
  SummaryList,
  TemplateLink,
} from '../ui.jsx';

export function VerifyView({ state }: { state: JobState }) {
  const { job, health, busy, guard, setJob } = state;
  const [queue, setQueue] = useState<{ total: number } | null>(null);
  const [bizfileRows, setBizfileRows] = useState<Record<string, unknown>[]>([]);
  const [findings, setFindings] = useState<Record<string, unknown>[]>([]);
  const [bizfileFile, setBizfileFile] = useState<File | null>(null);
  const [rerunFile, setRerunFile] = useState<File | null>(null);
  const [rerun, setRerun] = useState<{
    offered: number;
    typedCorrections?: number;
    applied: number;
    skippedIncomplete: number;
    recipientsBefore: number;
    recipientsAfter: number;
  } | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);

  const jobId = job?.id;
  useEffect(() => {
    if (!jobId) return;
    api.bizfileQueue(jobId).then(setQueue).catch(() => setQueue(null));
  }, [jobId]);

  if (!job || !job.hasResult) {
    return <Empty>Generate a sheet first — there is nothing to verify yet.</Empty>;
  }

  const severities = job.crossCheck?.severities ?? {};
  const run = job.bizfileRun;
  const ccRun = job.crossCheckRun;

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
            hint="Excel or CSV. Leave empty to look up ACRA open data instead."
          >
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => setBizfileFile(e.target.files?.[0] ?? null)}
            />
            <div style={{ marginTop: 8 }}>
              <TemplateLink kind="bizfile" label="BizFile export template" />
            </div>
          </Field>
        </div>

        {!health?.bizfileEnabled && !bizfileFile ? (
          <Msg kind="info">
            The live lookup is disabled on this machine. Upload an export, or set{' '}
            <code>BIZFILE_ENABLED=1</code> in <code>.env</code> to use ACRA's open data.
          </Msg>
        ) : null}

        {run?.running ? (
          <Msg kind="info">
            <b>
              Checking {run.done.toLocaleString('en-SG')} of {run.total.toLocaleString('en-SG')}
            </b>{' '}
            against {run.resolver}. This runs on the server and takes a few minutes for a full
            queue — you can leave this page and come back.
            {run.current ? (
              <>
                <br />
                <span className="muted">now: {run.current}</span>
              </>
            ) : null}
          </Msg>
        ) : null}

        {run?.error ? (
          <Msg kind="err">
            <b>Verification did not complete, and nothing was written.</b>
            <br />
            {run.error}
          </Msg>
        ) : null}

        {job.bizfile?.verdicts['lookup-failed'] ? (
          <Msg kind="warn">
            <b>{job.bizfile.verdicts['lookup-failed']} owners could not be checked</b> — those rows
            read <code>lookup-failed</code>, not <code>not-found</code>. Re-run to retry just those,
            or raise <code>BIZFILE_DELAY_MS</code> if ACRA is throttling.
          </Msg>
        ) : null}

        <div className="actions">
          <button
            disabled={!!busy || !queue?.total || run?.running}
            onClick={() =>
              void guard('BizFile verification', () =>
                api.bizfile(job.id, bizfileFile ?? undefined),
              ).then((r) => {
                // The server answers 202 and keeps working; useJob polls from here.
                if (!r) return;
                setJob(r);
                setBizfileRows(r.rows ?? []);
              })
            }
          >
            {busy === 'BizFile verification' || run?.running ? <Spinner /> : null}
            {run?.running
              ? `Checking ${run.done} / ${run.total}…`
              : bizfileFile
                ? 'Verify against upload'
                : 'Run live lookup'}
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

      {/* ------------------------------------------- re-run with corrected addresses */}
      {job.bizfile ? (
        <Card
          title="Rebuild with corrected addresses"
          hint={
            <>
              A wrong mailing address cannot be patched into the finished sheet — merging keys
              on the address, so correcting one can split or join recipients. This applies the
              corrections and runs the whole pipeline again from the source.
            </>
          }
        >
          <div className="stats" style={{ marginBottom: 14 }}>
            <StatTile
              label="Addresses ACRA disputes"
              value={job.bizfile.verdicts['mismatch'] ?? 0}
              detail="verdict: mismatch"
              accent
            />
            <StatTile
              label="Confirmed, left alone"
              value={
                (job.bizfile.verdicts['match'] ?? 0) + (job.bizfile.verdicts['match-building'] ?? 0)
              }
              detail="no change needed"
            />
          </div>

          <Msg kind="warn">
            ACRA's open data carries <b>street and postal code only</b> — no block number. A
            correction without a block number is <b>rejected automatically</b>, because replacing
            "58 Sungei Kadut Street 1 … 729361" with "Temasek Boulevard … 038988" would produce a
            letter that cannot be delivered. For full addresses, upload a purchased Business
            Profile export below; it takes priority over the open-data record.
          </Msg>

          <Msg kind="info">
            <b>Fix them on the sheet itself.</b> Every verified row on{' '}
            <b>{job.channel === 'lawyer-letter' ? 'Lawyer Letter' : 'Postcards Final'}</b> now
            carries three extra columns: <code>BizFile Verdict</code>,{' '}
            <code>BizFile Registered Address</code>, and an empty <code>Corrected Address</code>.
            Mismatches and inactive entities are shaded red.
            <br />
            <span style={{ fontSize: 12.5 }}>
              Download the workbook, type the address you want into <code>Corrected Address</code>,
              and upload the same file below. A typed address beats both ACRA and any export — a
              person looked at that row and decided.
            </span>
          </Msg>

          <div className="grid">
            <Field
              label="Corrected workbook, or an updated BizFile export"
              hint="Reads your typed Corrected Address column from any sheet, and an export's Registered Office Address."
            >
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setRerunFile(e.target.files?.[0] ?? null)}
              />
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <a className="button secondary tiny" href={api.downloadUrl(job.id)}>
                  Download the workbook to edit
                </a>
                <TemplateLink kind="bizfile" label="BizFile export template" />
              </div>
            </Field>
          </div>

          {rerun ? (
            <Msg kind="ok">
              <b>
                {rerun.applied} rows updated from {rerun.offered} corrections
                {rerun.typedCorrections ? ` (${rerun.typedCorrections} typed by hand)` : ''}.
              </b>{' '}
              Recipients went from {rerun.recipientsBefore.toLocaleString('en-SG')} to{' '}
              {rerun.recipientsAfter.toLocaleString('en-SG')} — merging changes when an address
              does. The rebuilt workbook has an <b>Address Overrides</b> sheet listing every
              change.
              {rerun.skippedIncomplete ? (
                <>
                  <br />
                  {rerun.skippedIncomplete} corrections were rejected for having no block number.
                </>
              ) : null}
            </Msg>
          ) : null}

          <div className="actions">
            <button
              disabled={!!busy || !(job.bizfile.verdicts['mismatch'] ?? 0) && !rerunFile}
              onClick={() =>
                void guard(
                  'Rebuild',
                  () => api.rerunAddresses(job.id, { file: rerunFile ?? undefined }),
                  'Rebuilt with corrected addresses',
                ).then((r) => {
                  if (!r) return;
                  setJob(r);
                  setRerun(r);
                })
              }
            >
              {busy === 'Rebuild' ? <Spinner /> : null} Apply corrections and rebuild
            </button>
            <a className="button secondary" href={api.downloadUrl(job.id)} download>
              Download workbook
            </a>
          </div>
        </Card>
      ) : null}

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

        {ccRun?.running ? (
          <Msg kind="info">
            <b>
              Checked {ccRun.done} of {ccRun.total} batches.
            </b>{' '}
            This runs on the server and takes a few minutes for a full sheet — you can leave
            this page and come back.
          </Msg>
        ) : null}

        {ccRun?.error ? (
          <Msg kind="err">
            <b>The cross-check did not finish.</b>
            <br />
            {ccRun.error}
          </Msg>
        ) : null}

        <Field
          label="Your own instructions for this check — optional"
          hint="Added on top of the built-in rules. Use it to ask for a check they miss, or to stop one you keep disagreeing with."
        >
          <textarea
            rows={5}
            value={instructions ?? job.crossCheckInstructions ?? ''}
            placeholder={
              'e.g.\n' +
              'Flag any mailing address that is a shopping-centre unit — those get returned.\n' +
              'Do not flag prices above S$40m; we do write those.\n' +
              'Check that Neighbourhood matches the postal district of Full_Address.'
            }
            onChange={(e) => setInstructions(e.target.value)}
            style={{
              width: '100%',
              font: 'inherit',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 7,
              border: '1px solid var(--line)',
              background: 'var(--panel-alt)',
              color: 'var(--ink)',
              resize: 'vertical',
            }}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            These win over the built-in rules wherever the two disagree, and they are written
            onto the <b>Claude Cross-Check</b> sheet so a later reader can see why a row was or
            was not flagged.
          </p>
        </Field>

        <div className="actions">
          <button
            disabled={!!busy || !health?.anthropicKey || ccRun?.running}
            onClick={() =>
              // The server answers 202 and keeps working; useJob polls from here.
              void guard('Claude cross-check', () =>
                api.crossCheck(job.id, { instructions: instructions ?? job.crossCheckInstructions }),
              ).then((r) => {
                if (!r) return;
                setJob(r);
                setFindings(r.findings ?? []);
              })
            }
          >
            {busy === 'Claude cross-check' || ccRun?.running ? <Spinner /> : null}
            {ccRun?.running
              ? `Checking ${ccRun.done} / ${ccRun.total} batches…`
              : `Check all ${(job.stats?.recipients ?? 0).toLocaleString('en-SG')} rows`}
          </button>
          <button
            className="ghost"
            disabled={!!busy || !health?.anthropicKey || ccRun?.running}
            onClick={() =>
              void guard('Claude cross-check', () =>
                api.crossCheck(job.id, {
                  maxRows: 40,
                  instructions: instructions ?? job.crossCheckInstructions,
                }),
              ).then((r) => {
                if (!r) return;
                setJob(r);
                setFindings(r.findings ?? []);
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
