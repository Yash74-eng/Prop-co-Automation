import type { ReactNode } from 'react';

export function Panel({
  num,
  title,
  hint,
  children,
}: {
  num: number | string;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <h2>
        <span className="num">{num}</span>
        {title}
      </h2>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="field">{label}</label>
      {children}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

export function Stats({ stats, keys }: { stats: Record<string, number>; keys: [string, string][] }) {
  return (
    <div className="stats">
      {keys
        .filter(([key]) => stats[key] !== undefined)
        .map(([key, label]) => (
          <div className="stat" key={key}>
            <div className="k">{label}</div>
            <div className="v">{stats[key].toLocaleString('en-SG')}</div>
          </div>
        ))}
    </div>
  );
}

export function SummaryList({ items }: { items: { label: string; count: number }[] }) {
  if (items.length === 0) return <p className="muted">None.</p>;
  return (
    <ul className="summary-list">
      {items.map((item) => (
        <li key={item.label}>
          <span>{item.label}</span>
          <b>{item.count.toLocaleString('en-SG')}</b>
        </li>
      ))}
    </ul>
  );
}

const WRAP_COLUMNS = new Set([
  'Comments',
  'Duplicate Owner / Owner Addresses',
  'Full_Address',
  'Full Address',
  'Registered_Proprietor_mailing_address',
  'Owner Address',
  'Checking',
  'detail',
  'Detail',
  'issue',
  'suggestion',
  'reason',
  'address',
  'Property Addresses',
  'BizFile Registered Address',
  'Mailing Address (sheet)',
]);

export function DataTable({
  rows,
  columns,
  max = 200,
}: {
  rows: Record<string, unknown>[];
  columns?: string[];
  max?: number;
}) {
  if (rows.length === 0) return <p className="muted">Nothing to show.</p>;
  const cols = columns ?? Object.keys(rows[0]);
  const shown = rows.slice(0, max);
  return (
    <>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} className={WRAP_COLUMNS.has(c) ? 'wrap' : undefined}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className={WRAP_COLUMNS.has(c) ? 'wrap' : undefined}>
                    {renderCell(row[c], c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length ? (
        <p className="hint" style={{ marginTop: 8 }}>
          Showing {shown.length.toLocaleString('en-SG')} of {rows.length.toLocaleString('en-SG')} rows.
          The full set is in the downloaded workbook.
        </p>
      ) : null}
    </>
  );
}

const SEVERITY_COLUMNS = new Set(['severity', 'Severity', 'verdict', 'Verdict']);
const MONEY_COLUMNS = new Set(['minimum_Price', 'higher_Price', 'Comp_1', 'Comp_2']);

function renderCell(value: unknown, column: string): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (SEVERITY_COLUMNS.has(column)) {
    const text = String(value);
    return <span className={`pill ${text}`}>{text}</span>;
  }
  if (MONEY_COLUMNS.has(column) && typeof value === 'number') {
    return `S$${value.toLocaleString('en-SG')}`;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return formatDate(value);
  }
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function formatDate(value: string | Date | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return String(value);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mmm = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    d.getUTCMonth()
  ];
  return `${dd} ${mmm} ${d.getUTCFullYear()}`;
}

export function Msg({ kind, children }: { kind: 'err' | 'ok' | 'warn'; children: ReactNode }) {
  return <div className={`msg ${kind}`}>{children}</div>;
}

export function Busy({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="spinner" />
      {children}
    </>
  );
}
