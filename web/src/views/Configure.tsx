import { useState } from 'react';
import { api } from '../api.js';
import type { JobState } from '../useJob.js';
import { Card, Check, Field, Msg, Spinner, TemplateLink } from '../ui.jsx';

/**
 * The outreach states a row can be in, in words. Mirrors OUTREACH_STATES on the server;
 * the wizard sends the ticked list and the server filters on exactly that.
 */
const OUTREACH_STATES = [
  {
    status: 'blank',
    label: 'Not contacted yet',
    detail: 'The outreach column is empty — nothing has gone out to this owner.',
    sendable: true,
  },
  {
    status: 'delivery-failed',
    label: 'Sent, but came back undelivered',
    detail:
      'A send date with a failure note, e.g. "27 Jun 2025 - Delivery Failed". The address was wrong, so these are worth re-sending once it is corrected.',
    sendable: true,
  },
  {
    status: 'batch-tag',
    label: 'Tagged for a batch, not yet sent',
    detail: 'A batch name rather than a date, e.g. "Batch 3".',
    sendable: true,
  },
  {
    status: 'sent-date',
    label: 'Already sent',
    detail: 'A clean send date with no failure note. Including these re-contacts the owner.',
    sendable: true,
  },
  {
    status: 'other',
    label: 'Something else in the column',
    detail: 'Text that is neither a date, a batch tag, nor a known status.',
    sendable: true,
  },
];

/** The ways the offer range can be derived. Labels say what happens, not the method name. */
const PRICING_METHODS = [
  {
    value: 'figment-band',
    label: 'Agreed formula — off the two comps in the letter (recommended)',
    detail:
      'The top of the range is 5% over the better comparable. The bottom starts at a 20% ' +
      'haircut off the weaker one, then is held so the range never implies a discount outside ' +
      '1.35× to 1.60× of the top. Everything lands on a S$250,000 multiple.',
  },
  {
    value: 'comps-range',
    label: 'The comps exactly — lowest comp to highest comp',
    detail:
      'No uplift and no haircut: the range is what the two comparables actually sold for. ' +
      'Easiest to defend, but it leaves no negotiating room.',
  },
  {
    value: 'comps-median-band',
    label: 'Median comp price, then −5% / +10%',
    detail:
      'Takes the middle comparable price and puts a fixed band either side. Ignores how far ' +
      'apart the comps are, so two distant comps still give a narrow range.',
  },
  {
    value: 'comps-psf-band',
    label: 'Median comp psf × this property’s GFA, then −5% / +10%',
    detail:
      'The only method that adjusts for the size of the property being written about. Needs a ' +
      'GFA on the row; without one it falls back to the median comp price and says so in Comments.',
  },
  {
    value: 'manual',
    label: 'Leave both blank — price by hand',
    detail:
      'The letter merges with empty price cells, for a person to fill in before sending.',
  },
];

export type Channel = 'lawyer-letter' | 'postcard';

export interface RunSettings {
  /** Chosen on step 1 before anything is uploaded. null = not yet picked. */
  channel: Channel | null;
  sheetName: string;
  mailDate: string;
  validityDays: number;
  /** Outreach states to keep. Empty means nothing is kept, which the UI blocks. */
  outreachInclude: string[];
  /** Which formula derives minimum_Price and higher_Price. */
  pricingMethod: string;
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
    // Every state a letter could reasonably go to. Opt-outs are excluded separately, so
    // they are not on this list at all.
    outreachInclude: OUTREACH_STATES.filter((s) => s.sendable).map((s) => s.status),
    pricingMethod: 'figment-band',
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
  const { job, health, busy, guard, setJob } = state;
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
        <p className="hint" style={{ marginTop: 0 }}>
          Tick the rows you want to post to. Every state your sheet can hold is listed, so what
          you see is what gets included — no mode to decode.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {OUTREACH_STATES.filter((s) => s.sendable).map((s) => (
            <Check
              key={s.status}
              checked={settings.outreachInclude.includes(s.status)}
              onChange={(on) =>
                set(
                  'outreachInclude',
                  on
                    ? [...settings.outreachInclude, s.status]
                    : settings.outreachInclude.filter((x) => x !== s.status),
                )
              }
              label={s.label}
              hint={s.detail}
            />
          ))}
        </div>

        <div className="actions" style={{ marginTop: 8 }}>
          <button
            className="ghost tiny"
            onClick={() =>
              set('outreachInclude', OUTREACH_STATES.filter((s) => s.sendable).map((s) => s.status))
            }
          >
            Select all
          </button>
          <button className="ghost tiny" onClick={() => set('outreachInclude', ['blank'])}>
            Only not-contacted
          </button>
          <button
            className="ghost tiny"
            onClick={() => set('outreachInclude', ['delivery-failed'])}
          >
            Only returned undelivered
          </button>
        </div>

        <Check
          checked={settings.alwaysExcludeOptOut}
          onChange={(v) => set('alwaysExcludeOptOut', v)}
          label="Never post to owners who opted out or are marked do-not-send"
          hint="Applies whatever is ticked above. Leave this on."
        />

        {settings.outreachInclude.length === 0 ? (
          <Msg kind="err">
            Nothing is ticked, so no rows would be kept and the run would produce an empty sheet.
            Tick at least one.
          </Msg>
        ) : settings.outreachInclude.includes('sent-date') ? (
          <Msg kind="info">
            <b>Already sent</b> is included, so owners who have had a clean send will be written to
            again. Untick it if this run is only for people who have not heard from you.
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
                Or read the live comps workbook — every district tab, in one go. No link needed:
                it is always the same spreadsheet.
              </span>
              <button
                style={{ marginTop: 8 }}
                disabled={!!busy}
                onClick={() =>
                  void guard(
                    'Comps fetch',
                    () => api.compsFromGoogleSheet(job.id, compsUrl || undefined),
                    'Comps read from Google Sheets',
                  ).then((r) => r && setJob(r))
                }
              >
                {busy === 'Comps fetch' ? <Spinner /> : null} Fetch live comps (Market Watch)
              </button>
              <details style={{ marginTop: 10 }}>
                <summary className="hint" style={{ cursor: 'pointer' }}>
                  Use a different comps spreadsheet
                </summary>
                <input
                  type="url"
                  style={{ marginTop: 6 }}
                  value={compsUrl}
                  placeholder={health?.compsSheetUrl ?? 'https://docs.google.com/spreadsheets/d/…'}
                  onChange={(e) => setCompsUrl(e.target.value)}
                />
                <p className="hint" style={{ marginTop: 4 }}>
                  Leave empty to use the default. Anything here must be shared with the same
                  service account.
                </p>
              </details>
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
          title="How minimum_Price and higher_Price are worked out"
          hint="Same inputs always give the same range, so any figure in a letter can be defended."
        >
          <Field label="Pricing method">
            <select
              value={settings.pricingMethod}
              onChange={(e) => set('pricingMethod', e.target.value)}
            >
              {PRICING_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>

          <Msg kind="info">
            {PRICING_METHODS.find((m) => m.value === settings.pricingMethod)?.detail}
          </Msg>

          {settings.pricingMethod === 'figment-band' ? (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13.5, lineHeight: 1.8 }}>
              <li>
                <b>higher_Price</b> — 1.05 × the <i>higher</i> comparable, to the nearest
                S$250,000.
              </li>
              <li>
                <b>minimum_Price</b> — 0.80 × the <i>lower</i> comparable, then held inside 1.35×
                to 1.60× below the higher price, to the nearest S$250,000.
              </li>
            </ul>
          ) : null}

          <p className="hint" style={{ marginTop: 10 }}>
            Whichever you pick, every row records its own arithmetic in <code>Comments</code>, so a
            figure in the letter can be traced back to the two comps printed beside it.
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
