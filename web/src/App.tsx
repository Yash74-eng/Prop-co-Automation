import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type JobSummary, type RunResponse, type SheetPreview } from './api.js';
import { Busy, Check, DataTable, Field, formatDate, Msg, Panel, Stats, SummaryList } from './components.js';

type Channel = 'lawyer-letter' | 'postcard';
type Tab = 'rows' | 'exclusions' | 'flags' | 'bizfile' | 'crosscheck';

const LAWYER_LETTER_COLUMNS = [
  'Target',
  'Address',
  'Full_Address',
  'Neighbourhood',
  'Land Use',
  'Registered_Proprietor',
  'Registered_Proprietor_mailing_address',
  'minimum_Price',
  'higher_Price',
  'Comp_Address_1',
  'Comp_Address_2',
  'Owner No.',
  'Comments',
];

const POSTCARD_COLUMNS = [
  'Target',
  'Address',
  'Full Address',
  'Neighbourhood',
  'Land Use',
  'Owner Name',
  'Owner Address',
  'Checking',
];

const STAT_LABELS: [string, string][] = [
  ['sourceRows', 'Source rows'],
  ['afterOutreachFilter', 'After outreach filter'],
  ['afterSuppression', 'After suppression'],
  ['ownerRowsExploded', 'Owner rows'],
  ['ownerRowsKept', 'Owners kept'],
  ['recipients', 'Recipients'],
  ['mergeOperations', 'Merges'],
  ['exclusions', 'Excluded'],
  ['flags', 'Review flags'],
];

export function App() {
  const [health, setHealth] = useState<{ anthropicKey: boolean; bizfileEnabled: boolean; model: string } | null>(null);
  const [job, setJob] = useState<JobSummary | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [channel, setChannel] = useState<Channel>('lawyer-letter');
  const [sheetName, setSheetName] = useState('');
  const [mailDate, setMailDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [validityDays, setValidityDays] = useState(14);
  const [outreachMode, setOutreachMode] = useState('exclude-contacted');
  const [outreachMatchText, setOutreachMatchText] = useState('');
  const [alwaysExcludeOptOut, setAlwaysExcludeOptOut] = useState(true);
  const [maxPropertiesPerOwner, setMaxPropertiesPerOwner] = useState(5);
  const [maxOwnersBeforeCollapse, setMaxOwnersBeforeCollapse] = useState(4);
  const [removeAgencies, setRemoveAgencies] = useState(true);
  const [groupByOwnerName, setGroupByOwnerName] = useState(false);
  const [includeAuditSheets, setIncludeAuditSheets] = useState(true);
  const [deriveMissingPrices, setDeriveMissingPrices] = useState(true);

  const [tab, setTab] = useState<Tab>('rows');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [exclusions, setExclusions] = useState<{ total: number; rows: Record<string, unknown>[]; summary: { label: string; count: number }[] } | null>(null);
  const [flags, setFlags] = useState<{ total: number; rows: Record<string, unknown>[]; summary: { label: string; count: number }[] } | null>(null);
  const [bizfileQueue, setBizfileQueue] = useState<{ total: number } | null>(null);
  const [bizfileRows, setBizfileRows] = useState<Record<string, unknown>[]>([]);
  const [findings, setFindings] = useState<Record<string, unknown>[]>([]);
  const [mergeCheck, setMergeCheck] = useState<Awaited<ReturnType<typeof api.mailmerge>> | null>(null);

  const compsRef = useRef<HTMLInputElement>(null);
  const suppressRef = useRef<HTMLInputElement>(null);
  const bizfileRef = useRef<HTMLInputElement>(null);
  const templateRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    setBusy(label);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function onUpload(file: File) {
    const summary = await guard('upload', () => api.upload(file));
    if (!summary) return;
    setJob(summary);
    setRun(null);
    setRows([]);
    setExclusions(null);
    setFlags(null);
    setBizfileRows([]);
    setFindings([]);
    setMergeCheck(null);

    // Prefer a sheet that looks like the Main Database.
    const guess =
      summary.sheetNames.find((n) => /main\s*database/i.test(n)) ?? summary.sheetNames[0] ?? '';
    setSheetName(guess);
    if (guess) {
      const p = await guard('preview', () => api.sheetPreview(summary.id, guess));
      if (p) setPreview(p);
    }
  }

  async function onSheetChange(name: string) {
    setSheetName(name);
    if (!job || !name) return;
    const p = await guard('preview', () => api.sheetPreview(job.id, name));
    if (p) setPreview(p);
  }

  async function onRun() {
    if (!job) return;
    const result = await guard('run', () =>
      api.run(job.id, {
        channel,
        sheetName,
        mailDate,
        validityDays,
        outreachMode,
        outreachMatchText,
        alwaysExcludeOptOut,
        maxPropertiesPerOwner,
        maxOwnersBeforeCollapse,
        removeAgenciesAndDevelopers: removeAgencies,
        groupByOwnerName,
        includeAuditSheets,
        deriveMissingPrices,
      }),
    );
    if (!result) return;
    setJob(result);
    setRun(result);
    setTab('rows');
    const r = await api.rows(job.id, 0, 200).catch(() => null);
    if (r) setRows(r.rows);
    const q = await api.bizfileQueue(job.id).catch(() => null);
    if (q) setBizfileQueue(q);
  }

  async function loadTab(next: Tab) {
    setTab(next);
    if (!job) return;
    if (next === 'exclusions' && !exclusions) {
      const r = await guard('exclusions', () => api.exclusions(job.id));
      if (r) setExclusions(r);
    }
    if (next === 'flags' && !flags) {
      const r = await guard('flags', () => api.flags(job.id));
      if (r) setFlags(r);
    }
  }

  const stepState = useMemo(() => {
    const steps = [
      { key: 'upload', label: '1 · Upload', done: !!job },
      { key: 'configure', label: '2 · Configure', done: !!run },
      { key: 'review', label: '3 · Review', done: !!run },
      { key: 'bizfile', label: '4 · BizFile', done: !!job?.bizfile },
      { key: 'crosscheck', label: '5 · Claude check', done: !!job?.crossCheck },
      { key: 'merge', label: '6 · Mail merge', done: !!mergeCheck },
    ];
    const activeIndex = steps.findIndex((s) => !s.done);
    return steps.map((s, i) => ({
      ...s,
      active: i === activeIndex,
    }));
  }, [job, run, mergeCheck]);

  const columns = channel === 'lawyer-letter' ? LAWYER_LETTER_COLUMNS : POSTCARD_COLUMNS;

  return (
    <div className="shell">
      <header className="top">
        <h1>PropCo Outreach Automation</h1>
        <span className="sub">
          Lawyer letters &amp; postcards from the Main Database — dedupe, comps, verification, mail-merge sheet
        </span>
      </header>

      <div className="steps">
        {stepState.map((s) => (
          <span key={s.key} className={`step-chip${s.done ? ' done' : ''}${s.active ? ' active' : ''}`}>
            {s.label}
          </span>
        ))}
      </div>

      {error ? <Msg kind="err">{error}</Msg> : null}

      <Panel
        num={1}
        title="Upload the Main Database"
        hint="The uploaded workbook is never modified. Everything is written to a new file containing your original sheet plus the generated subsheets."
      >
        <input
          type="file"
          accept=".xlsx,.xlsm,.xls,.csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onUpload(file);
          }}
        />
        {job ? (
          <>
            <Msg kind="ok">
              <b>{job.sourceFileName}</b> — {job.sheetNames.length} sheets.
              {job.compsRows > 0
                ? ` Comps benchmark auto-loaded: ${job.compsRows} rows from ${job.compsSource}.`
                : ' No comps benchmark found in this file — upload one below if you want indicative prices.'}
            </Msg>
            <div className="grid">
              <Field label="Sheet to read">
                <select value={sheetName} onChange={(e) => void onSheetChange(e.target.value)}>
                  {job.sheetNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Outreach channel">
                <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
                  <option value="lawyer-letter">Lawyer letter</option>
                  <option value="postcard">Postcard</option>
                </select>
              </Field>
            </div>
            {preview ? (
              <p className="hint" style={{ marginTop: 12 }}>
                <b>{preview.parsedRows.toLocaleString('en-SG')}</b> data rows ·{' '}
                <b>{preview.mappedFields.length}</b> fields mapped
                {preview.missingFields.length ? (
                  <>
                    {' '}· <span style={{ color: 'var(--warn)' }}>
                      not present: {preview.missingFields.join(', ')}
                    </span>
                  </>
                ) : null}
              </p>
            ) : null}
          </>
        ) : null}
      </Panel>

      {job ? (
        <Panel
          num={2}
          title="Configure the run"
          hint="Defaults follow the outreach spec. Every exclusion is logged with a reason on the Excluded sheet, so nothing disappears silently."
        >
          <div className="grid">
            <Field label="Mail date">
              <input type="date" value={mailDate} onChange={(e) => setMailDate(e.target.value)} />
            </Field>
            {channel === 'lawyer-letter' ? (
              <Field label="Validity (days after mail date)">
                <input
                  type="number"
                  min={1}
                  value={validityDays}
                  onChange={(e) => setValidityDays(Number(e.target.value))}
                />
              </Field>
            ) : null}
            <Field
              label={
                channel === 'lawyer-letter'
                  ? 'Filter on "Lawyer Letter Outreach"'
                  : 'Filter on "Postcard Outreach Date"'
              }
            >
              <select value={outreachMode} onChange={(e) => setOutreachMode(e.target.value)}>
                <option value="exclude-contacted">Only never-contacted (blank) — recommended</option>
                <option value="only-tagged">Only already-tagged rows</option>
                <option value="match">Rows containing text…</option>
                <option value="all">No filter</option>
              </select>
            </Field>
            {outreachMode === 'match' ? (
              <Field label="Text to match">
                <input
                  type="text"
                  placeholder="e.g. Batch 3"
                  value={outreachMatchText}
                  onChange={(e) => setOutreachMatchText(e.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Remove owners holding more than">
              <input
                type="number"
                min={1}
                value={maxPropertiesPerOwner}
                onChange={(e) => setMaxPropertiesPerOwner(Number(e.target.value))}
              />
            </Field>
            <Field label='"Owners of ___" above N owners'>
              <input
                type="number"
                min={1}
                value={maxOwnersBeforeCollapse}
                onChange={(e) => setMaxOwnersBeforeCollapse(Number(e.target.value))}
              />
            </Field>
          </div>

          <div style={{ marginTop: 14 }}>
            <Check
              checked={alwaysExcludeOptOut}
              onChange={setAlwaysExcludeOptOut}
              label="Always drop opt-outs and do-not-send rows"
              hint="Applies regardless of the filter above."
            />
            <Check
              checked={removeAgencies}
              onChange={setRemoveAgencies}
              label="Remove agencies, associations and large developers"
              hint="Institutions on the avoid-list are only flagged in Comments, never removed."
            />
            <Check
              checked={groupByOwnerName}
              onChange={setGroupByOwnerName}
              label="Never merge co-owners onto one letter"
              hint="Off by default so co-owners at one address become 'A & B' per the spec."
            />
            {channel === 'lawyer-letter' ? (
              <Check
                checked={deriveMissingPrices}
                onChange={setDeriveMissingPrices}
                label="Derive prices from GFA × neighbourhood psf when no comps row matches"
                hint="Derived rows are flagged 'VERIFY BEFORE SENDING' in Comments."
              />
            ) : null}
            <Check
              checked={includeAuditSheets}
              onChange={setIncludeAuditSheets}
              label="Include audit subsheets"
              hint="Uncheck for only the deliverable sheets."
            />
          </div>

          <div className="grid" style={{ marginTop: 16 }}>
            <Field label="Replace comps benchmark (optional)">
              <input ref={compsRef} type="file" accept=".xlsx,.xls,.csv" />
              <button
                className="secondary"
                style={{ marginTop: 6 }}
                disabled={!!busy}
                onClick={() => {
                  const file = compsRef.current?.files?.[0];
                  if (!file) return setError('Choose a comps benchmark file first');
                  void guard('comps', () => api.uploadComps(job.id, file)).then((r) => r && setJob(r));
                }}
              >
                {busy === 'comps' ? <Busy>Loading…</Busy> : 'Load comps table'}
              </button>
            </Field>
            <Field label="Suppression / compset list (optional)">
              <input ref={suppressRef} type="file" accept=".xlsx,.xls,.csv" />
              <button
                className="secondary"
                style={{ marginTop: 6 }}
                disabled={!!busy}
                onClick={() => {
                  const file = suppressRef.current?.files?.[0];
                  if (!file) return setError('Choose a suppression list first');
                  void guard('suppress', () => api.uploadSuppression(job.id, file)).then(
                    (r) => r && setJob(r),
                  );
                }}
              >
                {busy === 'suppress' ? <Busy>Loading…</Busy> : 'Load suppression list'}
              </button>
              {job.suppressionCount > 0 ? (
                <p className="hint" style={{ marginTop: 6 }}>
                  {job.suppressionCount} entries loaded.
                </p>
              ) : null}
            </Field>
          </div>

          <div className="actions">
            <button onClick={() => void onRun()} disabled={!!busy}>
              {busy === 'run' ? <Busy>Generating…</Busy> : 'Generate sheet'}
            </button>
            {job.outputFileName ? (
              <a href={api.downloadUrl(job.id)}>
                <button className="secondary" type="button">
                  Download {job.outputFileName}
                </button>
              </a>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {run && job ? (
        <Panel num={3} title="Review the result">
          {job.stats ? <Stats stats={job.stats} keys={STAT_LABELS} /> : null}

          {job.warnings.map((w, i) => (
            <Msg kind="warn" key={i}>
              <b>{w.scope}</b> — {w.message}
              {w.count ? ` (${w.count})` : ''}
              {w.samples?.length ? (
                <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                  {w.samples.join(', ')}
                </div>
              ) : null}
            </Msg>
          ))}

          <div className="tabs">
            <button className={tab === 'rows' ? 'on' : ''} onClick={() => void loadTab('rows')}>
              Generated rows ({(job.stats?.recipients ?? 0).toLocaleString('en-SG')})
            </button>
            <button className={tab === 'exclusions' ? 'on' : ''} onClick={() => void loadTab('exclusions')}>
              Excluded ({(job.stats?.exclusions ?? 0).toLocaleString('en-SG')})
            </button>
            <button className={tab === 'flags' ? 'on' : ''} onClick={() => void loadTab('flags')}>
              Review flags ({(job.stats?.flags ?? 0).toLocaleString('en-SG')})
            </button>
            <button className={tab === 'bizfile' ? 'on' : ''} onClick={() => void loadTab('bizfile')}>
              BizFile {job.bizfile ? `(${job.bizfile.count})` : bizfileQueue ? `(${bizfileQueue.total} queued)` : ''}
            </button>
            <button className={tab === 'crosscheck' ? 'on' : ''} onClick={() => void loadTab('crosscheck')}>
              Claude check {job.crossCheck ? `(${job.crossCheck.findings})` : ''}
            </button>
          </div>

          {tab === 'rows' ? <DataTable rows={rows} columns={columns} /> : null}

          {tab === 'exclusions' ? (
            <>
              <h3>Why rows were dropped</h3>
              <SummaryList items={exclusions?.summary ?? run.exclusionSummary} />
              <div style={{ marginTop: 14 }}>
                <DataTable
                  rows={exclusions?.rows ?? []}
                  columns={['sourceRow', 'address', 'ownerName', 'stage', 'reason', 'detail']}
                />
              </div>
            </>
          ) : null}

          {tab === 'flags' ? (
            <>
              <h3>Rows a human should look at</h3>
              <SummaryList items={flags?.summary ?? run.flagSummary} />
              <div style={{ marginTop: 14 }}>
                <DataTable
                  rows={flags?.rows ?? []}
                  columns={['severity', 'sourceRow', 'address', 'ownerName', 'flag', 'detail']}
                />
              </div>
            </>
          ) : null}

          {tab === 'bizfile' ? (
            <>
              <h3>Verify corporate owners against BizFile</h3>
              <p className="hint">
                {bizfileQueue?.total ?? 0} corporate owners in this run. The reliable path is to search
                them on{' '}
                <a href="https://www.bizfile.gov.sg/buy-info/search/results" target="_blank" rel="noreferrer">
                  bizfile.gov.sg
                </a>{' '}
                and upload the export — columns like <code>Entity Name</code>, <code>UEN</code>,{' '}
                <code>Registered Office Address</code> are picked up automatically. Live scraping is
                {health?.bizfileEnabled ? ' enabled' : ' disabled'} on this machine.
              </p>
              <div className="grid">
                <Field label="BizFile export (recommended)">
                  <input ref={bizfileRef} type="file" accept=".xlsx,.xls,.csv" />
                </Field>
              </div>
              <div className="actions">
                <button
                  disabled={!!busy}
                  onClick={() => {
                    const file = bizfileRef.current?.files?.[0];
                    void guard('bizfile', () => api.bizfile(job.id, file)).then((r) => {
                      if (!r) return;
                      setJob(r);
                      setBizfileRows(r.rows);
                    });
                  }}
                >
                  {busy === 'bizfile' ? <Busy>Verifying…</Busy> : 'Run verification'}
                </button>
                {job.bizfile ? (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Last run {formatDate(job.bizfile.runAt)} via {job.bizfile.resolver} —{' '}
                    {Object.entries(job.bizfile.verdicts)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(', ')}
                  </span>
                ) : null}
              </div>
              <div style={{ marginTop: 14 }}>
                <DataTable
                  rows={bizfileRows}
                  columns={['ownerName', 'verdict', 'uen', 'entityStatus', 'bizfileAddress', 'mailingAddressInSheet', 'detail']}
                />
              </div>
            </>
          ) : null}

          {tab === 'crosscheck' ? (
            <>
              <h3>Cross-verify the finished sheet with Claude</h3>
              <p className="hint">
                Claude reads the generated rows and reports anything that looks wrong — malformed
                merged addresses, names that read like institutions, prices that do not fit the
                neighbourhood. It reports only; it never edits the sheet.
                {health?.anthropicKey
                  ? ` Model: ${health.model}.`
                  : ' Set ANTHROPIC_API_KEY in .env to enable this step.'}
              </p>
              <div className="actions">
                <button
                  disabled={!!busy || !health?.anthropicKey}
                  onClick={() =>
                    void guard('crosscheck', () => api.crossCheck(job.id, {})).then((r) => {
                      if (!r) return;
                      setJob(r);
                      setFindings(r.findings);
                    })
                  }
                >
                  {busy === 'crosscheck' ? <Busy>Checking…</Busy> : 'Run Claude cross-check'}
                </button>
                <button
                  className="ghost"
                  disabled={!!busy || !health?.anthropicKey}
                  onClick={() =>
                    void guard('crosscheck', () => api.crossCheck(job.id, { maxRows: 40 })).then((r) => {
                      if (!r) return;
                      setJob(r);
                      setFindings(r.findings);
                    })
                  }
                >
                  Check first 40 rows only
                </button>
                {job.crossCheck ? (
                  <span className="muted" style={{ fontSize: 13 }}>
                    {job.crossCheck.rowsChecked} rows via {job.crossCheck.model} —{' '}
                    {Object.entries(job.crossCheck.severities)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(', ') || 'no findings'}
                  </span>
                ) : null}
              </div>
              {job.crossCheck?.errors.length ? (
                <Msg kind="warn">{job.crossCheck.errors.join(' · ')}</Msg>
              ) : null}
              <div style={{ marginTop: 14 }}>
                <DataTable rows={findings} columns={['severity', 'row', 'field', 'issue', 'suggestion']} />
              </div>
            </>
          ) : null}
        </Panel>
      ) : null}

      {run && job ? (
        <Panel
          num={6}
          title="Mail merge"
          hint="Validate a Word template against the generated sheet, then run the emitted PowerShell script to export PDFs through the installed Word."
        >
          <div className="grid">
            <Field label="Word template (.docx)">
              <input ref={templateRef} type="file" accept=".docx" />
            </Field>
          </div>
          <div className="actions">
            <button
              className="secondary"
              disabled={!!busy}
              onClick={() => {
                const file = templateRef.current?.files?.[0];
                if (!file) return setError('Choose a .docx template first');
                void guard('merge', () => api.mailmerge(job.id, file, true)).then(
                  (r) => r && setMergeCheck(r),
                );
              }}
            >
              {busy === 'merge' ? <Busy>Checking…</Busy> : 'Validate template & build merge script'}
            </button>
          </div>
          {mergeCheck ? (
            <>
              {mergeCheck.check.ok ? (
                <Msg kind="ok">
                  All {mergeCheck.check.templateFields.length} template merge fields have a matching
                  column in the <b>{mergeCheck.sheetName}</b> sheet.
                </Msg>
              ) : (
                <Msg kind="err">
                  The template expects fields the sheet does not provide (these would merge blank):{' '}
                  <b>{mergeCheck.check.missingInSheet.join(', ')}</b>
                </Msg>
              )}
              <p className="hint">
                Template fields found: {mergeCheck.check.templateFields.join(', ') || '(none)'}
              </p>
              <p className="hint">
                Run the merge with: <code>powershell -File "{mergeCheck.scriptPath}"</code>
              </p>
            </>
          ) : null}
        </Panel>
      ) : null}

      {job?.log.length ? (
        <Panel num="·" title="Activity">
          <div className="log">
            {job.log.map((l, i) => (
              <div key={i}>
                {new Date(l.at).toLocaleTimeString('en-SG')} [{l.step}] {l.message}
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
