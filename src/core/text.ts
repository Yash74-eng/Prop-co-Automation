/** Small text helpers shared across the pipeline. Kept dependency-free so they are easy to unit test. */

/** Collapse whitespace (including the newlines that come out of Google Sheets) and trim. */
export function squash(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/** Uppercase + whitespace-squashed, for comparisons. */
export function upper(value: unknown): string {
  return squash(value).toUpperCase();
}

/** Key used for equality checks: uppercase, punctuation stripped, whitespace collapsed. */
export function normKey(value: unknown): string {
  return upper(value)
    .replace(/[.,'"`’‘“”()\[\]{}]/g, '')
    .replace(/[-–—/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Header key: lowercase alphanumerics only, so "Owner No." and "owner_no" collide. */
export function headerKey(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (value instanceof Date) return false;
  if (typeof value === 'number') return false;
  return squash(value) === '';
}

/** Sort helper that orders "2" before "10" and "27A" after "27". */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const as = a.match(re) ?? [];
  const bs = b.match(re) ?? [];
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else {
      const d = x.localeCompare(y);
      if (d !== 0) return d;
    }
  }
  return 0;
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Stable de-duplication by a derived key, keeping first occurrence. */
export function uniqBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * Parse the date shapes that appear in the tracker: real Date cells, Excel serials,
 * "27 Jun 2025", "27 Jun 2025 - Delivery Failed", "2025-06-26T15:59:35.000Z".
 * Returns undefined when no date is present.
 */
export function parseLooseDate(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value;

  if (typeof value === 'number') {
    // Excel serial: days since 1899-12-30 (Excel's leap-year bug baked in).
    if (value > 20000 && value < 80000) {
      return new Date(Math.round((value - 25569) * 86400 * 1000));
    }
    return undefined;
  }

  const text = squash(value);
  if (!text) return undefined;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return isNaN(d.getTime()) ? undefined : d;
  }

  // "27 Jun 2025", "1 January 2026", optionally followed by " - something"
  const dmy = text.match(
    /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/,
  );
  if (dmy) {
    const month = MONTHS[dmy[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const d = new Date(Date.UTC(Number(dmy[3]), month, Number(dmy[1])));
      return isNaN(d.getTime()) ? undefined : d;
    }
  }

  // "27/06/2025" or "27-06-2025" (day first, as used in Singapore)
  const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (numeric) {
    const d = new Date(Date.UTC(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1])));
    return isNaN(d.getTime()) ? undefined : d;
  }

  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** DD MMM YYYY, the Figment house date format. */
export function formatDate(date: Date | undefined): string {
  if (!date || isNaN(date.getTime())) return '';
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mmm = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    date.getUTCMonth()
  ];
  return `${dd} ${mmm} ${date.getUTCFullYear()}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400 * 1000);
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value === null || value === undefined) return undefined;
  const text = squash(value).replace(/[$,\s]/g, '').replace(/^S\$/i, '');
  if (!text || text === '-' || text.toUpperCase() === 'N/A') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}
