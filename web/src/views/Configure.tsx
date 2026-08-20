import { useState } from 'react';
import { api } from '../api.js';
import type { JobState } from '../useJob.js';
import { Card, Check, Field, Msg, Spinner, TemplateLink } from '../ui.jsx';

export type Channel = 'lawyer-letter' | 'postcard';

export interface RunSettings {
  /** Chosen on step 1 before anything is uploaded. null = not yet picked. */
  channel: Channel | null;
  sheetName: string;
  mailDate: string;
  validityDays: number;
  outreachMode: string;
  outreachMatchText: string;
  alwaysExcludeOptOut: boolean;
  maxPropertiesPerOwner: number;
  maxOwnersBeforeCollapse: number;
  maxOwnerNameLength: number;
  removeAgenciesAndDevelopers: boolean;
  groupByOwnerName: boolean;
  includeAuditSheets: boolean;
  deriveMissingPrices: boolean;
  /** Save the finished workbook as soon as the run completes. */
  autoDownload: boolean;
}

export function defaultSettings(sheetName = ''): RunSettings {
  return {
    channel: null,
    sheetName,
    mailDate: new Date().toISOString().slice(0, 10),
    validityDays: 14,
    outreachMode: 'all',
    outreachMatchText: '',
    alwaysExcludeOptOut: true,
    maxPropertiesPerOwner: 5,
    maxOwnersBeforeCollapse: 4,
    maxOwnerNameLength: 120,
    removeAgenciesAndDevelopers: true,
    groupByOwnerName: false,
    includeAuditSheets: true,
    deriveMissingPrices: true,
    autoDownload: true,
  };
}

export function ConfigureView({
  state,
  settings,
  onChange,
  onRan,
}: {
  state: JobState;
  settings: RunSettings;
  onChange: (next: RunSettings) => void;
  onRan: () => void;
}) {
  const { job, busy, guard, setJob } = state;
  const [compsFile, setCompsFile] = useState<File | null>(null);
  const [compsUrl, setCompsUrl] = useState('');
  const [suppressFile, setSuppressFile] = useState<File | null>(null);

  if (!job) return null;
  // Capture the narrowed job so the async closures below keep the non-null type.
  const current = job;

  const set = <K extends keyof RunSettings>(key: K, value: RunSettings[K]) =>
    onChange({ ...settings, [key]: value });

  const isLetter = settings.channel === 'lawyer-letter';

  async function run() {
    if (!settings.channel) return;
    const result = await guard(
      'Generate',
      () =>
        api.run(current.id, {
          ...settings,
          channel: settings.channel as Channel,
          sheetName: settings.sheetName || current.sheetName,
        }),
      'Sheet generated',
    );
    if (!result) return;
    setJob(result);
    // Hand the finished workbook straight to the browser, so the common case needs no
    // second click. The file is still available from Review if this is switched off.
    if (settings.autoDownload) {
      const link = document.createElement('a');
      link.href = api.downloadUrl(current.id);
      link.download = result.outputFileName ?? '';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    onRan();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Configure the run</h1>
          <p className="lede">
            Defaults follow the outreach spec. Every row that gets dropped is logged with a reason
            on the <b>Excluded</b> sheet, and every judgement call on <b>Review Flags</b>, so
            nothing disappears quietly.
          </p>
        </div>
      </div>

      <Card title="Deliverable">
        <div className="grid">
          <Field
            label="Channel"
            hint="Chosen on step 1. Only this deliverable is built — go back to Upload to switch."
          >
            <input
              readOnly
              value={
                isLetter
                  ? 'Lawyer letter — 22 columns, comps and pricing'
                  : 'Postcard — two sheets, no financials'
              }
            />
          </Field>
          <Field label="Sheet to read">
            <select
              value={settings.sheetName || job.sheetName || ''}
              onChange={(e) => set('sheetName', e.target.value)}
            >
              {job.sheetNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Mail date" hint="Drives Mail_Date and, for letters, Valid_Date.">
            <input type="date" value={settings.mailDate} onChange={(e) => set('mailDate', e.target.value)} />
          </Field>
          {isLetter ? (
            <Field label="Offer validity (days)" hint="Valid_Date = Mail_Date + this.">
              <input
                type="number"
                min={1}
                max={365}
                value={settings.validityDays}
                onChange={(e) => set('validityDays', Number(e.target.value))}
              />
            </Field>
          ) : null}
        </div>
      </Card>

      <Card
        title="Who to include"
        hint={
          isLetter
            ? 'Filters on the "Lawyer Letter Outreach" column, which mixes send dates, batch tags and delivery-failure notes.'
            : 'Filters on the "Postcard Outreach Date" column, which mixes send dates and delivery-failure notes.'
        }
      >
        <div className="grid">
          <Field label="Outreach filter">
            <select value={settings.outreachMode} onChange={(e) => set('outreachMode', e.target.value)}>
              <option value="all">Everyone — no filter (default)</option>
              <option value="exclude-contacted">Never contacted only (outreach column blank)</option>
              <option value="only-tagged">Already-tagged rows only</option>
              <option value="match">Rows containing text…</option>
            </select>
          </Field>
          {settings.outreachMode === 'match' ? (
            <Field label="Text to match" hint="Case-insensitive substring, e.g. “Batch 3”.">
              <input
                type="text"
                value={settings.outreachMatchText}
                placeholder="Batch 3"
                onChange={(e) => set('outreachMatchText', e.target.value)}
              />
            </Field>
          ) : null}
        </div>

        <Check
          checked={settings.alwaysExcludeOptOut}
          onChange={(v) => set('alwaysExcludeOptOut', v)}
          label="Always drop opt-outs and do-not-send rows"
          hint="Applies whatever the filter above is set to. Leave this on."
        />

        {settings.outreachMode === 'all' ? (
          <Msg kind="info">
            Every row is kept regardless of what the outreach column says, so an owner who was
            already written to will be written to again. Opt-outs and do-not-send rows are still
            dropped.
            <br />
            <span style={{ fontSize: 12.5 }}>
              This is the default because the tracker's outreach column carries batch tags rather
              than a plain contacted / not-contacted marker — filtering on blanks discarded every
              row. Switch to <b>Never contacted only</b> if your sheet leaves that column empty
              until a letter goes out.
            </span>
          </Msg>
        ) : null}
        {settings.outreachMode === 'exclude-contacted' ? (
          <Msg kind="warn">
            This keeps only rows whose outreach column is <b>blank</b>. If your tracker tags rows
            with a batch name, that is every row dropped — check the funnel on the next step before
            trusting the result.
          </Msg>
        ) : null}
      </Card>

      <Card title="Exclusion and dedupe rules">
        <div className="grid">
          <Field label="Remove owners holding more than" hint="Properties in the working set.">
            <input
              type="number"
              min={1}
              value={settings.maxPropertiesPerOwner}
              onChange={(e) => set('maxPropertiesPerOwner', Number(e.target.value))}
            />
          </Field>
          <Field label="“Owners of ___” above N owners" hint="Counts inline “Total N owners” too.">
            <input
              type="number"
              min={1}
              value={settings.maxOwnersBeforeCollapse}
              onChange={(e) => set('maxOwnersBeforeCollapse', Number(e.target.value))}
            />
          </Field>
          <Field label="Max name length" hint="Longer names collapse to “Owners of ___”.">
            <input
              type="number"
              min={20}
              value={settings.maxOwnerNameLength}
              onChange={(e) => set('maxOwnerNameLength', Number(e.target.value))}
            />
          </Field>
        </div>

        <div style={{ marginTop: 8 }}>
          <Check
            checked={settings.removeAgenciesAndDevelopers}
            onChange={(v) => set('removeAgenciesAndDevelopers', v)}
            label="Remove agencies, associations and large developers"
            hint="Institutions on the avoid-list are only flagged in Comments, never removed — a human decides."
          />
          <Check
            checked={settings.groupByOwnerName}
            onChange={(v) => set('groupByOwnerName', v)}
            label="Never merge co-owners onto one letter"
            hint="Off by default, so co-owners at one address become “A & B” per the spec."
          />
          {isLetter ? (
            <Check
              checked={settings.deriveMissingPrices}
              onChange={(v) => set('deriveMissingPrices', v)}
              label="Derive prices from GFA × neighbourhood psf when no comps row matches"
              hint="Derived rows are marked VERIFY BEFORE SENDING in Comments. Turn off to leave them blank."
            />
          ) : null}
          <Check
            checked={settings.includeAuditSheets}
            onChange={(v) => set('includeAuditSheets', v)}
            label="Include audit subsheets"
            hint={
              settings.channel === 'postcard'
                ? 'Turn off for exactly the two postcard sheets.'
                : 'Exploded owner rows, merge decisions, exclusions, flags, comps used, run summary.'
            }
          />
          <Check
            checked={settings.autoDownload}
            onChange={(v) => set('autoDownload', v)}
            label="Save the workbook as soon as it is generated"
            hint="Downloads without a second click. The file stays available on Review either way."
          />
        </div>
      </Card>

      <Card
        title="Optional inputs"
        hint="Remembered for this job — load once and they apply to every run."
      >
        <div className="grid">
          {/* Comps feed pricing, and only the lawyer letter is priced. Offering them on a
              postcard run would imply they change the output, which they cannot. */}
          {!isLetter ? null : (
          <Field
            label="Comps source"
            hint={`Currently: ${job.compsRows} rows from ${job.compsSource}`}
          >
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => setCompsFile(e.target.files?.[0] ?? null)}
            />
            <button
              className="secondary tiny"
              style={{ marginTop: 6 }}
              disabled={!compsFile || !!busy}
              onClick={() =>
                compsFile &&
                void guard('Comps upload', () => api.uploadComps(job.id, compsFile), 'Comps table loaded').then(
                  (r) => r && setJob(r),
                )
              }
            >
              {busy === 'Comps upload' ? <Spinner /> : null} Load comps table
            </button>
            <div style={{ marginTop: 8 }}>
              <TemplateLink kind="comps" label="Comps benchmark template" />
            </div>

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <span className="hint" style={{ margin: 0 }}>
                Or read the comps workbook live. Every tab is fetched, since the Market Watch
                source keeps one per district:
              </span>
              <input
                type="url"
                style={{ marginTop: 6 }}
                value={compsUrl}
                placeholder="https://docs.google.com/spreadsheets/d/…/edit"
                onChange={(e) => setCompsUrl(e.target.value)}
              />
              <button
                className="secondary tiny"
                style={{ marginTop: 6 }}
                disabled={!compsUrl || !!busy}
                onClick={() =>
                  void guard(
                    'Comps fetch',
                    () => api.compsFromGoogleSheet(job.id, compsUrl),
                    'Comps read from Google Sheets',
                  ).then((r) => r && setJob(r))
                }
              >
                {busy === 'Comps fetch' ? <Spinner /> : null} Fetch comps from Google Sheets
              </button>
              {job.compsGoogleSheet ? (
                <p className="hint" style={{ marginTop: 6 }}>
                  Live from <b>{job.compsGoogleSheet.spreadsheetTitle}</b> —{' '}
                  {job.compsGoogleSheet.tabs} tabs, read at{' '}
                  {new Date(job.compsGoogleSheet.fetchedAt).toLocaleString('en-SG')}
                </p>
              ) : null}
            </div>
          </Field>
          )}

          <Field
            label="Suppression / compset list"
            hint={
              job.suppressionCount
                ? `${job.suppressionCount} entries loaded`
                : 'Addresses or owners to skip. All sheets are read.'
            }
          >
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => setSuppressFile(e.target.files?.[0] ?? null)}
            />
            <button
              className="secondary tiny"
              style={{ marginTop: 6 }}
              disabled={!suppressFile || !!busy}
              onClick={() =>
                suppressFile &&
                void guard(
                  'Suppression upload',
                  () => api.uploadSuppression(job.id, suppressFile),
                  'Suppression list loaded',
                ).then((r) => r && setJob(r))
              }
            >
              {busy === 'Suppression upload' ? <Spinner /> : null} Load suppression list
            </button>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <TemplateLink kind="suppression" label="Do-not-contact template" />
              <TemplateLink kind="institutions" label="Institutions-to-avoid template" />
            </div>
          </Field>
        </div>
      </Card>

      {isLetter ? (
        <Card
          title="How the offer range is set"
          hint="Fixed formula off the two comparables printed in the letter — no meeting, same answer every time."
          flat
        >
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.8 }}>
            <li>
              <b>higher_Price</b> — 1.05 × the <i>higher</i> comparable, to the nearest S$250,000.
            </li>
            <li>
              <b>minimum_Price</b> — 0.80 × the <i>lower</i> comparable, then held inside 1.35× to
              1.60× below the higher price, to the nearest S$250,000.
            </li>
          </ul>
          <p className="hint" style={{ marginTop: 10 }}>
            The clamp is what stops two comparables that are far apart producing a range nobody
            would send. Every row records its own arithmetic in <code>Comments</code>, so any figure
            in the letter can be traced back to the two comps beside it.
          </p>
        </Card>
      ) : null}

      <div className="actions">
        <button onClick={() => void run()} disabled={!!busy}>
          {busy === 'Generate' ? <Spinner /> : null}
          {busy === 'Generate' ? 'Generating…' : `Generate ${isLetter ? 'lawyer letter' : 'postcard'} sheet`}
        </button>
        {job.outputFileName ? (
          <a href={api.downloadUrl(job.id)}>
            <button className="secondary" type="button">
              Download current workbook
            </button>
          </a>
        ) : null}
      </div>
    </>
  );
}
