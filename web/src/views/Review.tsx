import { useCallback, useEffect, useState } from 'react';
import { api, type Funnel as FunnelData, type RecipientDetail } from '../api.js';
import type { JobState } from '../useJob.js';
import {
  Card,
  DataGrid,
  Drawer,
  Empty,
  Funnel,
  KeyValue,
  Msg,
  Pill,
  Spinner,
  StatTile,
  SummaryList,
} from '../ui.jsx';

type Tab = 'rows' | 'funnel' | 'excluded' | 'flags' | 'merges';

const LETTER_COLUMNS = [
  'Registered_Proprietor',
  'Full_Address',
  'Registered_Proprietor_mailing_address',
  'Neighbourhood',
  'Target',
  'minimum_Price',
  'higher_Price',
  'Comp_Address_1',
  'Owner No.',
  'Comments',
];

const POSTCARD_COLUMNS = [
  'Owner Name',
  'Full Address',
  'Owner Address',
  'Neighbourhood',
  'Target',
  'Land Use',
  'Checking',
];

export function ReviewView({ state }: { state: JobState }) {
  const { job, busy, guard } = state;
  const [tab, setTab] = useState<Tab>('rows');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [excluded, setExcluded] = useState<{
    total: number;
    rows: Record<string, unknown>[];
    summary: { label: string; count: number }[];
  } | null>(null);
  const [flags, setFlags] = useState<{
    total: number;
    rows: Record<string, unknown>[];
    summary: { label: string; count: number }[];
  } | null>(null);
  const [merges, setMerges] = useState<{ total: number; rows: Record<string, unknown>[] } | null>(null);
  const [detail, setDetail] = useState<RecipientDetail | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const jobId = job?.id;

  const load = useCallback(async () => {
    if (!jobId) return;
    const [r, f] = await Promise.all([
      api.rows(jobId, 0, 1000).catch(() => null),
      api.funnel(jobId).catch(() => null),
    ]);
    if (r) setRows(r.rows);
    if (f) setFunnel(f);
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function switchTab(next: Tab) {
    setTab(next);
    if (!jobId) return;
    if (next === 'excluded' && !excluded) {
      const r = await guard('Load exclusions', () => api.exclusions(jobId));
      if (r) setExcluded(r);
    }
    if (next === 'flags' && !flags) {
      const r = await guard('Load flags', () => api.flags(jobId));
      if (r) setFlags(r);
    }
    if (next === 'merges' && !merges) {
      const r = await guard('Load merge audit', () => api.audit(jobId));
      if (r) setMerges(r);
    }
  }

  async function openRecipient(index: number) {
    if (!jobId) return;
    setSelected(index);
    const d = await guard('Load recipient', () => api.recipient(jobId, index));
    if (d) setDetail(d);
  }

  if (!job || !job.hasResult || !job.stats) {
    return <Empty>Generate a sheet first — there is nothing to review yet.</Empty>;
  }

  const s = job.stats;
  const isLetter = job.channel === 'lawyer-letter';
  const columns = isLetter ? LETTER_COLUMNS : POSTCARD_COLUMNS;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Review</h1>
          <p className="lede">
            Click any row to see the source rows that merged into it, the merge decisions taken, and
            every flag raised against it.
          </p>
        </div>
        <a href={api.downloadUrl(job.id)}>
          <button type="button">Download workbook</button>
        </a>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <StatTile label="Recipients" value={s.recipients ?? 0} accent detail="letters to send" />
        <StatTile label="Source rows" value={s.sourceRows ?? 0} />
        <StatTile label="After filter" value={s.afterOutreachFilter ?? 0} detail="passed outreach" />
        <StatTile label="Merges" value={s.mergeOperations ?? 0} detail="dedupe decisions" />
        <StatTile label="Excluded" value={s.exclusions ?? 0} detail="all logged" />
        <StatTile label="Review flags" value={s.flags ?? 0} />
      </div>

      {job.warnings.map((w, i) => (
        <Msg kind="warn" key={i}>
          <b>{w.scope}</b> — {w.message}
          {w.count ? ` (${w.count.toLocaleString('en-SG')} rows)` : ''}
          {w.samples?.length ? (
            <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>{w.samples.join(', ')}</div>
          ) : null}
        </Msg>
      ))}

      <div className="tabs">
        <TabButton on={tab === 'rows'} onClick={() => void switchTab('rows')} count={s.recipients}>
          Generated rows
        </TabButton>
        <TabButton on={tab === 'funnel'} onClick={() => void switchTab('funnel')}>
          Where rows went
        </TabButton>
        <TabButton on={tab === 'excluded'} onClick={() => void switchTab('excluded')} count={s.exclusions}>
          Excluded
        </TabButton>
        <TabButton on={tab === 'flags'} onClick={() => void switchTab('flags')} count={s.flags}>
          Flags
        </TabButton>
        <TabButton on={tab === 'merges'} onClick={() => void switchTab('merges')} count={s.mergeOperations}>
          Merge audit
        </TabButton>
      </div>

      {busy?.startsWith('Load') ? (
        <p className="hint">
          <Spinner /> {busy}…
        </p>
      ) : null}

      {tab === 'rows' ? (
        <DataGrid
          rows={rows}
          columns={columns}
          onRowClick={(_row, index) => void openRecipient(index)}
          selectedIndex={selected}
          searchPlaceholder="Search owner, address, neighbourhood…"
          emptyText="No recipients were produced. Check the Excluded tab to see why."
        />
      ) : null}

      {tab === 'funnel' ? (
        funnel ? (
          <>
            <Card title="Row counts at each stage">
              <Funnel stages={funnel.stages} drops={funnel.drops} />
            </Card>
            <div className="grid">
              <Card title="Outreach column breakdown" hint="How the source rows were classified.">
                <SummaryList items={funnel.outreach} />
              </Card>
              {funnel.drops.map((d) => (
                <Card key={d.stage} title={`Dropped at ${d.stage}`} aside={<b>{d.count.toLocaleString('en-SG')}</b>}>
                  <SummaryList items={d.reasons} max={12} />
                </Card>
              ))}
            </div>
          </>
        ) : (
          <Empty>Loading…</Empty>
        )
      ) : null}

      {tab === 'excluded' ? (
        <>
          <Card title="Why rows were dropped" flat>
            <SummaryList items={excluded?.summary ?? []} />
          </Card>
          <DataGrid
            rows={excluded?.rows ?? []}
            columns={['sourceRow', 'address', 'ownerName', 'stage', 'reason', 'detail']}
            searchPlaceholder="Search reasons, owners, addresses…"
            emptyText="Nothing was excluded."
          />
        </>
      ) : null}

      {tab === 'flags' ? (
        <>
          <Card title="Rows a human should look at" flat>
            <SummaryList items={flags?.summary ?? []} />
          </Card>
          <DataGrid
            rows={flags?.rows ?? []}
            columns={['severity', 'sourceRow', 'ownerName', 'address', 'flag', 'detail']}
            searchPlaceholder="Search flags…"
            emptyText="No flags raised."
          />
        </>
      ) : null}

      {tab === 'merges' ? (
        <DataGrid
          rows={merges?.rows ?? []}
          columns={[
            { key: 'stage', label: 'Stage' },
            { key: 'action', label: 'Decision' },
            { key: 'sourceRows', label: 'Source rows' },
            { key: 'before', label: 'Before' },
            { key: 'after', label: 'After' },
          ]}
          searchPlaceholder="Search merge decisions…"
          emptyText="No merges were needed."
        />
      ) : null}

      <RecipientDrawer
        detail={detail}
        onClose={() => {
          setDetail(null);
          setSelected(null);
        }}
        isLetter={isLetter}
      />
    </>
  );
}

function TabButton({
  on,
  onClick,
  count,
  children,
}: {
  on: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button className={on ? 'on' : ''} onClick={onClick}>
      {children}
      {count !== undefined ? <span className="badge">{count.toLocaleString('en-SG')}</span> : null}
    </button>
  );
}

function RecipientDrawer({
  detail,
  onClose,
  isLetter,
}: {
  detail: RecipientDetail | null;
  onClose: () => void;
  isLetter: boolean;
}) {
  if (!detail) return null;
  const g = detail.group;
  const money = (v: unknown) =>
    typeof v === 'number' ? `S$${v.toLocaleString('en-SG')}` : <span className="muted">—</span>;

  return (
    <Drawer
      open
      onClose={onClose}
      title={g.registeredProprietor}
      subtitle={`Sheet row ${detail.index + 2} · built from ${detail.members.length} source row${
        detail.members.length === 1 ? '' : 's'
      }`}
    >
      <Card title="What gets printed" flat>
        <KeyValue
          items={[
            ['Address', g.fullAddress],
            ['Addressed to', g.registeredProprietor],
            ['Mailing address', g.mailingAddress],
            ['Target', g.target],
            ['Neighbourhood', g.neighbourhood],
            ['Land use', g.landUse],
            ['Tenure', g.tenure],
            ...(isLetter
              ? ([
                  ['Price range', <>{money(detail.row.minimum_Price)} — {money(detail.row.higher_Price)}</>],
                  [
                    'Comparable 1',
                    detail.row.Comp_Address_1 ? (
                      <>
                        {String(detail.row.Comp_Address_1)} · {money(detail.row.Comp_1)}
                      </>
                    ) : (
                      ''
                    ),
                  ],
                  [
                    'Comparable 2',
                    detail.row.Comp_Address_2 ? (
                      <>
                        {String(detail.row.Comp_Address_2)} · {money(detail.row.Comp_2)}
                      </>
                    ) : (
                      ''
                    ),
                  ],
                ] as [string, React.ReactNode][])
              : []),
          ]}
        />
      </Card>

      {g.notes.length ? (
        <Card title="Notes on this row" flat>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>
            {g.notes.map((n, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {n}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {detail.merges.length ? (
        <Card title="Merge decisions" flat hint="How the source rows were combined into this one.">
          {detail.merges.map((m, i) => (
            <div className="merge" key={i}>
              <div className="act">
                Stage {m.stage} — {m.action}
              </div>
              <div>
                <span className="before">{m.before.join('  +  ')}</span>
                <span className="arrow">→</span>
                <b>{m.after}</b>
              </div>
            </div>
          ))}
        </Card>
      ) : null}

      {detail.flags.length ? (
        <Card title="Flags" flat>
          {detail.flags.map((f, i) => (
            <p key={i} style={{ margin: '0 0 8px', fontSize: 13.5 }}>
              <Pill value={f.severity} /> <b>{f.flag}</b>
              {f.detail ? <span className="muted"> — {f.detail}</span> : null}
            </p>
          ))}
        </Card>
      ) : null}

      {detail.crossCheck.length ? (
        <Card title="Claude cross-check findings" flat>
          {detail.crossCheck.map((f, i) => (
            <p key={i} style={{ margin: '0 0 10px', fontSize: 13.5 }}>
              <Pill value={f.severity} /> <b>{f.field}</b>
              <br />
              {f.issue}
              <br />
              <span className="muted">Suggested: {f.suggestion}</span>
            </p>
          ))}
        </Card>
      ) : null}

      {detail.bizfile.length ? (
        <Card title="BizFile verification" flat>
          <KeyValue
            items={detail.bizfile.flatMap((v) => [
              ['Verdict', <Pill value={v.verdict} />],
              ['UEN', String(v.uen ?? '')],
              ['Entity status', String(v.entityStatus ?? '')],
              ['Registered address', String(v.bizfileAddress ?? '')],
              ['Detail', String(v.detail ?? '')],
            ] as [string, React.ReactNode][])}
          />
        </Card>
      ) : null}

      <Card title={`Source rows (${detail.members.length})`} flat>
        <DataGrid
          rows={detail.members}
          columns={[
            'sourceRow',
            'ownerSlot',
            'ownerNameRaw',
            'propertyRaw',
            'postal',
            'ownerAddress',
            'isCorporate',
            'notes',
          ]}
          max={20}
          searchPlaceholder="Search source rows…"
        />
      </Card>
    </Drawer>
  );
}
