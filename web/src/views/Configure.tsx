import { useState } from 'react';
import { api } from '../api.js';
import type { JobState } from '../useJob.js';
import { Card, Check, Field, Msg, Spinner } from '../ui.jsx';

export type Channel = 'lawyer-letter' | 'postcard';

export interface RunSettings {
  channel: Channel;
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
}

export function defaultSettings(sheetName = ''): RunSettings {
  return {
    channel: 'lawyer-letter',
    sheetName,
    mailDate: new Date().toISOString().slice(0, 10),
    validityDays: 14,
    outreachMode: 'exclude-contacted',
    outreachMatchText: '',
    alwaysExcludeOptOut: true,
    maxPropertiesPerOwner: 5,
    maxOwnersBeforeCollapse: 4,
    maxOwnerNameLength: 120,
    removeAgenciesAndDevelopers: true,
    groupByOwnerName: false,
    includeAuditSheets: true,
    deriveMissingPrices: true,
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
  const [suppressFile, setSuppressFile] = useState<File | null>(null);

  if (!job) return null;
  // Capture the narrowed job so the async closures below keep the non-null type.
  const current = job;

  const set = <K extends keyof RunSettings>(key: K, value: RunSettings[K]) =>
    onChange({ ...settings, [key]: value });

  const isLetter = settings.channel === 'lawyer-letter';

  async function run() {
    const result = await guard(
      'Generate',
      () => api.run(current.id, { ...settings, sheetName: settings.sheetName || current.sheetName }),
      'Sheet generated',
    );
    if (!result) return;
    setJob(result);
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
          <Field label="Channel">
            <select value={settings.channel} onChange={(e) => set('channel', e.target.value as Channel)}>
              <option value="lawyer-letter">Lawyer letter — 22 columns, comps and pricing</option>
              <option value="postcard">Postcard — two sheets, no financials</option>
            </select>
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
              <option value="exclude-contacted">Never contacted only (blank) — recommended</option>
              <option value="only-tagged">Already-tagged rows only</option>
              <option value="match">Rows containing text…</option>
              <option value="all">No filter — everyone</option>
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
          <Msg kind="warn">
            No filter means already-contacted owners are included again. Use this only when you
            intend to re-contact.
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
        </div>
      </Card>

      <Card
        title="Optional inputs"
        hint="Both are remembered for this job — load once and they apply to every run."
      >
        <div className="grid">
          <Field
            label="Comps benchmark override"
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
          </Field>

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
          </Field>
        </div>
      </Card>

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
