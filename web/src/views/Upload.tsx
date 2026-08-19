import { useEffect, useState } from 'react';
import { api, type SheetPreview } from '../api.js';
import type { JobState } from '../useJob.js';
import type { Channel, RunSettings } from './Configure.jsx';
import { Card, DataGrid, DropZone, Field, Msg, Spinner, StatTile, TemplateLink } from '../ui.jsx';

/** The two deliverables. Exactly one is built per run — never both. */
const CHANNELS: { key: Channel; title: string; blurb: string }[] = [
  {
    key: 'lawyer-letter',
    title: 'Lawyer letter',
    blurb:
      'One 22-column sheet with indicative pricing and two comparables per owner. Needs a comps benchmark table.',
  },
  {
    key: 'postcard',
    title: 'Postcard',
    blurb:
      'Two sheets — the working sheet plus a name-and-address sheet for the printer. No financials.',
  },
];

export function UploadView({
  state,
  settings,
  onChange,
  onNext,
}: {
  state: JobState;
  settings: RunSettings;
  onChange: (next: RunSettings) => void;
  onNext: () => void;
}) {
  const { job, health, busy, guard, setJob, reset } = state;
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  const [sheetUrl, setSheetUrl] = useState('');
  const [tabs, setTabs] = useState<{
    spreadsheetTitle: string;
    selectedGid: string | null;
    tabs: { gid: string; title: string; rowCount: number }[];
  } | null>(null);
  const [gid, setGid] = useState('');
  const [refreshed, setRefreshed] = useState<{
    rowsBefore: number;
    rowsAfter: number;
    regenerated: boolean;
    clearedBizfile: boolean;
    clearedCrossCheck: boolean;
  } | null>(null);
  const channel = settings.channel;

  async function loadPreview(id: string, sheet: string) {
    const p = await guard('Sheet preview', () => api.sheetPreview(id, sheet));
    if (p) setPreview(p);
  }

  // Pick the sheet that looks like the Main Database as soon as a job appears.
  useEffect(() => {
    if (!job || preview) return;
    const guess =
      job.sheetName ??
      job.sheetNames.find((n) => /main\s*database/i.test(n)) ??
      job.sheetNames[0];
    if (guess) void loadPreview(job.id, guess);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  async function onFile(file: File) {
    const summary = await guard('Upload', () => api.upload(file), `Loaded ${file.name}`);
    if (!summary) return;
    setPreview(null);
    setJob(summary);
  }

  async function onFetchSheet() {
    const summary = await guard(
      'Fetch sheet',
      () => api.fromGoogleSheet(sheetUrl, gid || undefined),
      'Fetched from Google Sheets',
    );
    if (!summary) return;
    setPreview(null);
    setRefreshed(null);
    setJob(summary);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{channel ? 'Upload the Main Database' : 'What are you sending?'}</h1>
          <p className="lede">
            {channel
              ? 'Drop the PropCo Dealflow Tracker, or any export with the major columns. The file you upload is never modified — each run writes a new workbook holding your original sheet verbatim plus the generated subsheets.'
              : 'Pick the deliverable first. Only the one you choose is built — the run never produces both, so the workbook you get out has no unused sheets to sift through.'}
          </p>
        </div>
        {job ? (
          <button className="ghost" onClick={reset}>
            Start over
          </button>
        ) : null}
      </div>

      <Card
        title="Deliverable"
        hint="This drives the columns, the sheets, and whether pricing is calculated."
      >
        <div className="grid">
          {CHANNELS.map((c) => {
            const on = channel === c.key;
            return (
              <button
                key={c.key}
                onClick={() => onChange({ ...settings, channel: c.key })}
                className={on ? '' : 'ghost'}
                style={{
                  textAlign: 'left',
                  display: 'block',
                  padding: '14px 16px',
                  height: 'auto',
                  lineHeight: 1.5,
                }}
              >
                <span style={{ display: 'block', fontWeight: 700, marginBottom: 4 }}>
                  {on ? '● ' : '○ '}
                  {c.title}
                </span>
                <span style={{ display: 'block', fontSize: 12.5, opacity: 0.8 }}>{c.blurb}</span>
              </button>
            );
          })}
        </div>
        {channel ? null : (
          <Msg kind="info">Choose one to continue. You can change it here later.</Msg>
        )}
      </Card>

      {!channel ? null : !job ? (
        <>
          <Card>
            <DropZone
              onFile={onFile}
              accept=".xlsx,.xlsm,.xls,.csv"
              label={busy === 'Upload' ? 'Reading workbook…' : 'Drop the workbook here'}
              hint="Excel or CSV, up to 80 MB. Stays on this machine."
            />
            <p className="hint" style={{ marginTop: 12 }}>
              No tracker to hand? <TemplateLink kind="main-database" label="Main Database template" />{' '}
              — the exact column names, with two worked rows.
            </p>
          </Card>

          <Card
            title="Or read it live from Google Sheets"
            hint="Paste the link to the tab holding the owner rows. Nothing is written back — the sheet is only ever read."
          >
            <Field
              label="Google Sheets link"
              hint="Copy it from the browser bar. The #gid= on the end names the tab you are looking at."
            >
              <input
                type="url"
                value={sheetUrl}
                placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=1663840271"
                onChange={(e) => {
                  setSheetUrl(e.target.value);
                  setTabs(null);
                  setGid('');
                }}
              />
            </Field>

            {tabs ? (
              <Field label={`Tab in "${tabs.spreadsheetTitle}"`} hint="Defaults to the one your link points at.">
                <select value={gid} onChange={(e) => setGid(e.target.value)}>
                  {tabs.tabs.map((t) => (
                    <option key={t.gid} value={t.gid}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <div className="actions">
              <button disabled={!sheetUrl || !!busy} onClick={() => void onFetchSheet()}>
                {busy === 'Fetch sheet' ? <Spinner /> : null}
                Fetch this tab
              </button>
              {health?.googleServiceAccount ? (
                <button
                  className="secondary"
                  disabled={!sheetUrl || !!busy}
                  onClick={() =>
                    void guard('List tabs', () => api.googleSheetTabs(sheetUrl)).then((t) => {
                      if (!t) return;
                      setTabs(t);
                      setGid(t.selectedGid ?? t.tabs[0]?.gid ?? '');
                    })
                  }
                >
                  {busy === 'List tabs' ? <Spinner /> : null}
                  List the tabs
                </button>
              ) : null}
            </div>

            {health?.googleServiceAccount ? (
              <Msg kind="ok">
                Reading as <code>{health.googleServiceAccount}</code>. Share the spreadsheet with
                that address as a <b>Viewer</b> and it can be read while staying private.
              </Msg>
            ) : (
              <Msg kind="warn">
                <b>No Google credentials configured</b>, so only a sheet that is already
                link-shared or published can be read. Figment's tracker holds owner names and
                mailing addresses, so publishing it is not the right fix — set up a read-only
                service account instead:
                <ol style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 12.5, lineHeight: 1.7 }}>
                  <li>
                    At <code>console.cloud.google.com</code>, create a project and enable the{' '}
                    <b>Google Sheets API</b>
                  </li>
                  <li>
                    Create a service account, then <b>Keys → Add key → JSON</b>, and save the file
                  </li>
                  <li>
                    Share the spreadsheet with the service-account address (it ends in{' '}
                    <code>.iam.gserviceaccount.com</code>) as a <b>Viewer</b>
                  </li>
                  <li>
                    Put the file path in <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> in{' '}
                    <code>.env</code> and restart
                  </li>
                </ol>
              </Msg>
            )}
          </Card>
        </>
      ) : (
        <>
          <Card
            title={job.sourceFileName}
            aside={
              <span className="muted" style={{ fontSize: 12.5 }}>
                {job.sheetNames.length} sheets
              </span>
            }
          >
            {job.googleSheet ? (
              <>
                <Msg kind="ok">
                  Live from <b>{job.googleSheet.spreadsheetTitle}</b> —{' '}
                  <b>{job.googleSheet.sheetTitle}</b>, {job.googleSheet.rows.toLocaleString('en-SG')}{' '}
                  rows, read at {new Date(job.googleSheet.fetchedAt).toLocaleString('en-SG')}
                  {job.googleSheet.via === 'anonymous-csv' ? (
                    <>
                      <br />
                      <b>Read without credentials</b>, which means this sheet is currently readable
                      by anyone holding its URL.
                    </>
                  ) : null}
                </Msg>

                {refreshed ? (
                  <Msg kind={refreshed.rowsAfter === refreshed.rowsBefore ? 'info' : 'ok'}>
                    Re-read: <b>{refreshed.rowsBefore.toLocaleString('en-SG')}</b> rows →{' '}
                    <b>{refreshed.rowsAfter.toLocaleString('en-SG')}</b>.{' '}
                    {refreshed.regenerated
                      ? 'The sheet was rebuilt from the new rows.'
                      : 'Nothing generated yet, so nothing to rebuild.'}
                    {refreshed.clearedBizfile || refreshed.clearedCrossCheck ? (
                      <>
                        <br />
                        <span style={{ fontSize: 12.5 }}>
                          The {refreshed.clearedBizfile ? 'BizFile' : ''}
                          {refreshed.clearedBizfile && refreshed.clearedCrossCheck ? ' and ' : ''}
                          {refreshed.clearedCrossCheck ? 'cross-check' : ''} results were cleared —
                          they described the rows that were there before. Run them again.
                        </span>
                      </>
                    ) : null}
                  </Msg>
                ) : null}

                <div className="actions" style={{ marginTop: 0, marginBottom: 14 }}>
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void guard(
                        'Refresh sheet',
                        () => api.refreshGoogleSheet(job.id),
                        'Re-read from Google Sheets',
                      ).then((r) => {
                        if (!r) return;
                        setJob(r);
                        setRefreshed(r);
                        setPreview(null);
                        void loadPreview(r.id, r.sheetName ?? r.sheetNames[0]);
                      })
                    }
                  >
                    {busy === 'Refresh sheet' ? <Spinner /> : null}
                    Re-read the sheet now
                  </button>
                  <a
                    className="button ghost tiny"
                    href={job.googleSheet.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Google Sheets
                  </a>
                </div>
              </>
            ) : null}

            {channel === 'postcard' ? (
              <Msg kind="info">
                Postcards carry no pricing, so no comps benchmark is needed for this run.
              </Msg>
            ) : job.compsRows > 0 ? (
              <Msg kind="ok">
                Comps benchmark auto-loaded — <b>{job.compsRows} rows</b> from {job.compsSource}.
              </Msg>
            ) : (
              <Msg kind="warn">
                No comps benchmark sheet found in this file. Indicative prices will be derived from
                GFA × psf, or left blank. You can upload a comps table on the next step.
              </Msg>
            )}

            <div className="grid" style={{ marginTop: 14 }}>
              <Field label="Sheet to read" hint="The sheet holding the owner rows.">
                <select
                  value={preview?.sheetName ?? ''}
                  onChange={(e) => void loadPreview(job.id, e.target.value)}
                >
                  {job.sheetNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Replace the upload">
                <input
                  type="file"
                  accept=".xlsx,.xlsm,.xls,.csv"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void onFile(file);
                  }}
                />
              </Field>
            </div>
          </Card>

          {busy === 'Sheet preview' ? (
            <Card>
              <p className="hint">
                <Spinner /> Reading the sheet…
              </p>
            </Card>
          ) : null}

          {preview ? (
            <>
              <Card title={`Sheet check — ${preview.sheetName}`}>
                <div className="stats">
                  <StatTile label="Data rows" value={preview.parsedRows} accent />
                  <StatTile label="Columns" value={preview.headers.length} />
                  <StatTile label="Fields mapped" value={preview.mappedFields.length} />
                  <StatTile
                    label="Fields absent"
                    value={preview.missingFields.length}
                    detail={preview.missingFields.length ? 'optional' : 'all present'}
                  />
                </div>

                {preview.parsedRows === 0 ? (
                  <Msg kind="err">
                    No data rows found in this sheet. Pick a different one — the tracker keeps the
                    owner rows on <b>Main Database</b>.
                  </Msg>
                ) : null}

                {preview.missingFields.length ? (
                  <Msg kind="info">
                    Not present in this sheet: <b>{preview.missingFields.join(', ')}</b>. These are
                    optional — anything that depends on them is skipped rather than guessed.
                  </Msg>
                ) : null}

                {preview.unmappedHeaders.length ? (
                  <p className="hint">
                    Columns carried through but not used by the pipeline:{' '}
                    {preview.unmappedHeaders.join(', ')}
                  </p>
                ) : null}
              </Card>

              <Card title="First rows" hint="A sanity check that the header row was detected correctly.">
                <DataGrid
                  rows={preview.sampleRows.map((cells) => {
                    const obj: Record<string, unknown> = {};
                    preview.headers.forEach((h, i) => {
                      if (h) obj[h] = cells[i];
                    });
                    return obj;
                  })}
                  columns={preview.headers.filter(Boolean).slice(0, 12)}
                  max={5}
                  searchPlaceholder="Search the sample…"
                />
              </Card>

              <div className="actions">
                <button onClick={onNext} disabled={preview.parsedRows === 0}>
                  Configure the run →
                </button>
              </div>
            </>
          ) : null}
        </>
      )}
    </>
  );
}
