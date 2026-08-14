/** Shared UI primitives. Presentational only — no API calls, no job state. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/* ------------------------------------------------------------------ toasts -- */

interface Toast {
  id: number;
  kind: 'ok' | 'err' | 'info';
  title: string;
  message?: string;
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { ...t, id }]);
    // Errors linger longer — they usually need reading.
    const ttl = t.kind === 'err' ? 9000 : 4500;
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), ttl);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast ${t.kind}`} key={t.id} onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}>
            <div className="t">{t.title}</div>
            {t.message ? <div className="m">{t.message}</div> : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------- theme -- */

export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('propco.theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('propco.theme', theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

/* ------------------------------------------------------------------- atoms -- */

export function Card({
  title,
  aside,
  hint,
  children,
  flat,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  flat?: boolean;
}) {
  return (
    <section className={`card${flat ? ' flat' : ''}`}>
      {title || aside ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {aside}
        </div>
      ) : null}
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className="field">{label}</label>
      {children}
      {hint ? <p className="hint" style={{ margin: '4px 0 0', fontSize: 11.5 }}>{hint}</p> : null}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

export function Msg({ kind, children }: { kind: 'err' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  return <div className={`msg ${kind}`}>{children}</div>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * Download link for a starter workbook. Every step that accepts an upload offers one, so
 * nobody has to guess the column names — the template carries the exact headers.
 */
export function TemplateLink({ kind, label }: { kind: string; label: string }) {
  return (
    <a className="template-link" href={`/api/templates/${kind}`} download>
      ↓ {label}
    </a>
  );
}

export function Pill({ value }: { value: unknown }) {
  const text = String(value ?? '');
  return <span className={`pill ${text.toLowerCase().replace(/\s+/g, '-')}`}>{text}</span>;
}

export function StatTile({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: number | string;
  detail?: string;
  accent?: boolean;
}) {
  return (
    <div className={`stat${accent ? ' accent' : ''}`}>
      <div className="k">{label}</div>
      <div className="v">{typeof value === 'number' ? value.toLocaleString('en-SG') : value}</div>
      {detail ? <div className="d">{detail}</div> : null}
    </div>
  );
}

export function SummaryList({ items, max = 40 }: { items: { label: string; count: number }[]; max?: number }) {
  if (items.length === 0) return <p className="hint">None.</p>;
  return (
    <ul className="summary-list">
      {items.slice(0, max).map((item) => (
        <li key={item.label}>
          <span>{item.label}</span>
          <b>{item.count.toLocaleString('en-SG')}</b>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ funnel -- */

export function Funnel({
  stages,
  drops,
}: {
  stages: { key: string; label: string; value: number }[];
  drops?: { stage: string; count: number }[];
}) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="funnel">
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1].value : null;
        const lost = prev !== null ? prev - s.value : 0;
        return (
          <div key={s.key}>
            <div className="funnel-row">
              <span>{s.label}</span>
              <div className="funnel-track">
                <div className="funnel-fill" style={{ width: `${(s.value / max) * 100}%` }} />
              </div>
              <span className="n">
                {s.value.toLocaleString('en-SG')}
                {prev !== null && prev > 0 ? <small>{Math.round((s.value / prev) * 100)}% kept</small> : null}
              </span>
            </div>
            {lost > 0 ? (
              <div className="funnel-row">
                <span />
                <span className="funnel-drop">− {lost.toLocaleString('en-SG')} dropped at this stage</span>
              </div>
            ) : null}
          </div>
        );
      })}
      {drops?.length ? (
        <p className="hint" style={{ marginTop: 8 }}>
          Every dropped row is on the <b>Excluded</b> sheet with its reason.
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- data grid -- */

const WRAP_COLUMNS = new Set([
  'Comments', 'Duplicate Owner / Owner Addresses', 'Full_Address', 'Full Address',
  'Registered_Proprietor_mailing_address', 'Owner Address', 'Checking', 'detail', 'Detail',
  'issue', 'suggestion', 'reason', 'address', 'Property Addresses', 'bizfileAddress',
  'mailingAddressInSheet', 'propertyRaw', 'ownerAddress', 'action', 'before', 'after', 'notes',
  'Registered_Proprietor', 'Owner Name', 'ownerName', 'ownerNameRaw',
]);
const SEVERITY_COLUMNS = new Set(['severity', 'Severity', 'verdict', 'Verdict']);
const MONEY_COLUMNS = new Set(['minimum_Price', 'higher_Price', 'Comp_1', 'Comp_2']);

export interface GridColumn {
  key: string;
  label?: string;
}

export function DataGrid({
  rows,
  columns,
  max = 400,
  onRowClick,
  selectedIndex,
  emptyText = 'Nothing to show.',
  searchPlaceholder = 'Search all columns…',
  toolbarExtra,
}: {
  rows: Record<string, unknown>[];
  columns?: (string | GridColumn)[];
  max?: number;
  onRowClick?: (row: Record<string, unknown>, index: number) => void;
  selectedIndex?: number | null;
  emptyText?: string;
  searchPlaceholder?: string;
  toolbarExtra?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const cols: GridColumn[] = useMemo(() => {
    const source = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
    return source.map((c) => (typeof c === 'string' ? { key: c } : c));
  }, [columns, rows]);

  const filtered = useMemo(() => {
    const withIndex = rows.map((row, index) => ({ row, index }));
    const q = query.trim().toLowerCase();
    const matched = q
      ? withIndex.filter(({ row }) =>
          cols.some((c) => String(row[c.key] ?? '').toLowerCase().includes(q)),
        )
      : withIndex;
    if (!sort) return matched;
    const { key, dir } = sort;
    return [...matched].sort((a, b) => {
      const av = a.row[key];
      const bv = b.row[key];
      if (av === bv) return 0;
      if (av === null || av === undefined || av === '') return 1;
      if (bv === null || bv === undefined || bv === '') return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, cols, query, sort]);

  if (rows.length === 0) return <Empty>{emptyText}</Empty>;

  const shown = filtered.slice(0, max);

  return (
    <>
      <div className="grid-toolbar">
        <input
          type="search"
          value={query}
          placeholder={searchPlaceholder}
          onChange={(e) => setQuery(e.target.value)}
        />
        {toolbarExtra}
        <span className="spacer" />
        <span className="count">
          {query || sort ? `${filtered.length.toLocaleString('en-SG')} of ` : ''}
          {rows.length.toLocaleString('en-SG')} rows
          {shown.length < filtered.length ? ` · showing first ${shown.length.toLocaleString('en-SG')}` : ''}
        </span>
        {sort ? (
          <button className="ghost tiny" onClick={() => setSort(null)}>
            Clear sort
          </button>
        ) : null}
      </div>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 44 }}>#</th>
              {cols.map((c) => (
                <th
                  key={c.key}
                  className={WRAP_COLUMNS.has(c.key) ? 'wrap' : undefined}
                  onClick={() =>
                    setSort((prev) =>
                      prev?.key === c.key
                        ? { key: c.key, dir: prev.dir === 1 ? -1 : 1 }
                        : { key: c.key, dir: 1 },
                    )
                  }
                  title="Click to sort"
                >
                  {c.label ?? c.key}
                  {sort?.key === c.key ? <span className="sort">{sort.dir === 1 ? '▲' : '▼'}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ row, index }) => (
              <tr
                key={index}
                className={`${onRowClick ? 'clickable' : ''}${selectedIndex === index ? ' sel' : ''}`}
                onClick={onRowClick ? () => onRowClick(row, index) : undefined}
              >
                <td className="idx">{index + 1}</td>
                {cols.map((c) => (
                  <td key={c.key} className={WRAP_COLUMNS.has(c.key) ? 'wrap' : undefined}>
                    {renderCell(row[c.key], c.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 ? <Empty>No rows match “{query}”.</Empty> : null}
      {shown.length < filtered.length ? (
        <p className="hint" style={{ marginTop: 8 }}>
          Showing the first {shown.length.toLocaleString('en-SG')} matching rows. Narrow the search, or
          use the downloaded workbook for the full set.
        </p>
      ) : null}
    </>
  );
}

function renderCell(value: unknown, column: string): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (SEVERITY_COLUMNS.has(column)) return <Pill value={value} />;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (MONEY_COLUMNS.has(column) && typeof value === 'number') {
    return <span className="tnum">S${value.toLocaleString('en-SG')}</span>;
  }
  if (typeof value === 'number') return <span className="tnum">{value.toLocaleString('en-SG')}</span>;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDate(value);
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/* ------------------------------------------------------------------ drawer -- */

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div>
            <h2 style={{ margin: 0 }}>{title}</h2>
            {subtitle ? <p className="hint" style={{ margin: '3px 0 0' }}>{subtitle}</p> : null}
          </div>
          <button className="ghost tiny" onClick={onClose}>
            Close ✕
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v === '' || v === null || v === undefined ? <span className="muted">—</span> : v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------------------------------------------- dropzone -- */

export function DropZone({
  onFile,
  accept,
  label,
  hint,
}: {
  onFile: (file: File) => void;
  accept: string;
  label: string;
  hint?: string;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <div className="big">{label}</div>
      {hint ? <p className="hint" style={{ marginBottom: 12 }}>{hint}</p> : null}
      <button className="secondary" onClick={() => inputRef.current?.click()}>
        Choose file
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ format -- */

export function formatDate(value: string | Date | undefined | null): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return String(value);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mmm = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    d.getUTCMonth()
  ];
  return `${dd} ${mmm} ${d.getUTCFullYear()}`;
}

export function formatTime(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-SG', { hour12: false });
}
