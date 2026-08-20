/**
 * Figment's live comps source: Squarefoot's "Market Watch for Commercial Shophouses"
 * workbook, one tab per district.
 *
 * Pinned here so the app can offer it without anyone pasting a link — it is the same
 * spreadsheet every time, and a mistyped id is a silent wrong-comps run. Override with
 * COMPS_SHEET_URL in .env if the source ever moves.
 */
export const MARKET_WATCH_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1UeigMbJP-mueP6yAW6urbEYaPWrM75g6fw1HUZ_HXuY/edit';

/**
 * Comparables picked from a transactions sheet, in the "Market Watch for Commercial
 * Shophouses" shape — one tab per postal district, one row per transaction.
 *
 * The rule this implements, as specified:
 *   go to the district of the neighbourhood, take the most recent transactions whose
 *   URA Zoning is fully commercial, and whose Price ($) are close to each other.
 *
 * Three things about the real data drove the design:
 *
 *  1. **Tab layouts differ.** Some district tabs carry a GPR column, some a Street Name
 *     column, some a 5th-storey column; one tab's date header reads "K4". So columns are
 *     matched per tab on a normalised header key rather than by position.
 *
 *  2. **Numbers arrive as text with thousand separators** — "1,498", "6,400,000" — so
 *     every numeric read strips separators before parsing.
 *
 *  3. **Strata units contaminate the recent end.** In District 14 the ten most recent
 *     fully-commercial transactions are dominated by strata units in one project at
 *     S$2.5–2.8M, against S$5.4–18.7M for whole land shophouses. Two strata units are not
 *     a comparable for a whole shophouse, so `Type of Area` is filtered to Land by
 *     default. This is the one judgement call in here that was not specified; it is a
 *     setting, and every rejected row is reported.
 */
import { normKey, squash } from '../core/text.js';
import { districtFromPostalCode } from './districts.js';

export interface Transaction {
  district: number;
  date?: Date;
  address: string;
  projectName?: string;
  propertyType?: string;
  tenure?: string;
  areaSqft?: number;
  /** "Land" or "Strata" as written in the sheet. */
  areaType?: string;
  psf?: number;
  price?: number;
  zoning?: string;
  /** Tab the row came from, for the audit trail. */
  sheetName: string;
}

export interface CompSelectionOptions {
  /** Only rows whose URA Zoning reads as fully commercial. */
  fullCommercialOnly: boolean;
  /** Restrict to whole-property sales; excludes strata units. */
  landOnly: boolean;
  /** How many of the most recent qualifying rows to consider. */
  recentPool: number;
  /** Ignore transactions older than this many months. 0 = no limit. */
  maxAgeMonths: number;
  /** How many comps to output. The letter has room for two. */
  wanted: number;
}

export function defaultCompSelection(
  over: Partial<CompSelectionOptions> = {},
): CompSelectionOptions {
  return {
    fullCommercialOnly: true,
    landOnly: true,
    recentPool: 12,
    maxAgeMonths: 36,
    wanted: 2,
    ...over,
  };
}

export interface CompSelection {
  comps: Transaction[];
  /** Every step taken, so a price can be defended later. */
  notes: string[];
  /** Median price per square foot across the chosen comps. */
  medianPsf?: number;
}

/** "Full Commercial (Dark Blue)" qualifies; the light-blue and red mixes do not. */
export function isFullCommercial(zoning: unknown): boolean {
  const text = squash(zoning).toUpperCase();
  if (!text) return false;
  // Guard against "Residential with Commercial at 1st storey", which contains
  // "commercial" but is not full commercial.
  if (/RESIDENTIAL|LIGHT BLUE|\bRED\b|HOTEL|PURPLE/.test(text)) return false;
  return /FULL\s*COMMERCIAL/.test(text) || /\bCOMMERCIAL\s*\(DARK BLUE\)/.test(text);
}

export function isLandSale(areaType: unknown): boolean {
  return /LAND/i.test(squash(areaType));
}

/** Strip thousand separators and currency noise before parsing. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = squash(value).replace(/[$,\s]/g, '');
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Dates in this sheet read "19 Jun 2026". Excel serials also appear. */
export function parseTransactionDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // Excel serial: days since 30 Dec 1899, read as UTC to avoid a timezone shift.
    return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
  }

  const text = squash(value);
  if (!text) return undefined;

  const dmy = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(text);
  if (dmy) {
    const month = MONTHS[dmy[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) return new Date(Date.UTC(Number(dmy[3]), month, Number(dmy[1])));
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Read transactions out of one tab. Columns are located by normalised header name, so a
 * tab that carries extra columns, or omits GPR, still reads correctly.
 */
export function parseTransactionSheet(
  sheetName: string,
  headers: string[],
  rows: unknown[][],
): Transaction[] {
  const index = new Map<string, number>();
  headers.forEach((h, i) => {
    const key = normKey(h).replace(/\s+/g, ' ').trim();
    if (key && !index.has(key)) index.set(key, i);
  });

  /**
   * Resolve a column by header name.
   *
   * `exclude` matters more than it looks: normKey keeps the dollar sign, so
   * "Price ($psf)" normalises to "PRICE $PSF" and "Price ($)" to "PRICE $". A loose
   * contains-match for "price" therefore hits the psf column first and the parser reads
   * price-per-square-foot as the sale price — every comparable silently wrong by three
   * orders of magnitude.
   */
  const col = (names: string[], exclude?: RegExp): number | undefined => {
    const wanted = names.map((n) => normKey(n).replace(/\s+/g, ' ').trim());
    for (const want of wanted) {
      const hit = index.get(want);
      if (hit !== undefined) return hit;
    }
    // Contains fallback — headers in this sheet carry stray line breaks and spacing.
    for (const want of wanted) {
      for (const [key, i] of index) {
        if (exclude && exclude.test(key)) continue;
        if (key.includes(want)) return i;
      }
    }
    return undefined;
  };

  // One tab's date header reads "K4" rather than "Date"; fall back to the first column.
  const dateCol = col(['date']) ?? 0;
  const districtCol = col(['district']);
  const addressCol = col(['address']);
  const projectCol = col(['project name']);
  const typeCol = col(['property type'], /TYPE OF AREA/);
  const tenureCol = col(['tenure']);
  const areaCol = col(['area (sq ft)', 'area sq ft'], /TYPE OF AREA/);
  const areaTypeCol = col(['type of area']);
  const psfCol = col(['price ($psf)', 'price $psf', 'psf']);
  // Never let the price fall through to the psf column.
  const priceCol = col(['price ($)', 'price $'], /PSF/);
  const zoningCol = col(['ura zoning', 'zoning']);

  const out: Transaction[] = [];
  for (const cells of rows) {
    const at = (c?: number) => (c === undefined ? undefined : cells[c]);

    const address = squash(at(addressCol));
    const district = toNumber(at(districtCol));
    if (!address || district === undefined) continue;

    // "Price ($psf)" also matches a loose "price" lookup, so guard against reading the
    // psf column as the price when the sheet lacks a distinct Price ($) column.
    const price = priceCol === psfCol ? undefined : toNumber(at(priceCol));

    out.push({
      district,
      date: parseTransactionDate(at(dateCol)),
      address,
      projectName: squash(at(projectCol)) || undefined,
      propertyType: squash(at(typeCol)) || undefined,
      tenure: squash(at(tenureCol)) || undefined,
      areaSqft: toNumber(at(areaCol)),
      areaType: squash(at(areaTypeCol)) || undefined,
      psf: toNumber(at(psfCol)),
      price,
      zoning: squash(at(zoningCol)) || undefined,
      sheetName,
    });
  }
  return out;
}

/** Median of a numeric list. */
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The tightest run of `wanted` prices in a sorted list — the concrete reading of
 * "prices that are close to each other". Sorting by price and taking the narrowest
 * consecutive window is the smallest-spread subset, and ties break toward the more
 * recent pair because the pool is already recency-ordered.
 */
function tightestCluster(pool: Transaction[], wanted: number): Transaction[] {
  const priced = pool.filter((t) => typeof t.price === 'number');
  if (priced.length <= wanted) return priced;

  const byPrice = [...priced].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
  let best = byPrice.slice(0, wanted);
  let bestSpread = Infinity;

  for (let i = 0; i + wanted <= byPrice.length; i++) {
    const window = byPrice.slice(i, i + wanted);
    const low = window[0].price ?? 0;
    const high = window[window.length - 1].price ?? 0;
    // Relative spread, so a tight pair of cheap units does not always beat a tight pair
    // of expensive ones purely on absolute dollars.
    const spread = low > 0 ? (high - low) / low : Infinity;
    if (spread < bestSpread) {
      bestSpread = spread;
      best = window;
    }
  }
  // Present them most-recent-first, which is how they read on the letter.
  return best.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}

/**
 * Pick comparables for one property.
 *
 * `asOf` is passed in rather than read from the clock so a run is reproducible: the same
 * workbook and the same mail date always select the same comps.
 */
export function selectComps(
  transactions: Transaction[],
  subject: { district?: number; postalCode?: unknown },
  options: CompSelectionOptions,
  asOf: Date,
): CompSelection {
  const notes: string[] = [];
  const district = subject.district ?? districtFromPostalCode(subject.postalCode);

  if (!district) {
    return { comps: [], notes: ['No district — the property has no usable postal code'] };
  }

  let pool = transactions.filter((t) => t.district === district);
  notes.push(`District ${district}: ${pool.length} transactions`);
  if (pool.length === 0) return { comps: [], notes };

  if (options.fullCommercialOnly) {
    const before = pool.length;
    pool = pool.filter((t) => isFullCommercial(t.zoning));
    notes.push(`Full Commercial only: ${pool.length} of ${before}`);
  }

  if (options.landOnly) {
    const before = pool.length;
    pool = pool.filter((t) => isLandSale(t.areaType));
    notes.push(
      `Land sales only (strata excluded): ${pool.length} of ${before}`,
    );
  }

  pool = pool.filter((t) => typeof t.price === 'number' && (t.price ?? 0) > 0);

  if (options.maxAgeMonths > 0) {
    const cutoff = new Date(asOf);
    cutoff.setMonth(cutoff.getMonth() - options.maxAgeMonths);
    const before = pool.length;
    pool = pool.filter((t) => t.date && t.date >= cutoff);
    notes.push(`Within ${options.maxAgeMonths} months: ${pool.length} of ${before}`);
  }

  if (pool.length === 0) {
    notes.push('Nothing left after filtering — no comparable found');
    return { comps: [], notes };
  }

  // Most recent first, then narrow to the pool the cluster is chosen from.
  pool.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  const recent = pool.slice(0, options.recentPool);
  notes.push(`Considered the ${recent.length} most recent`);

  const comps = tightestCluster(recent, options.wanted);
  if (comps.length > 0) {
    const prices = comps.map((c) => c.price ?? 0);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    notes.push(
      `Closest ${comps.length} by price: ${low.toLocaleString('en-SG')}–${high.toLocaleString('en-SG')}` +
        (low > 0 ? ` (${(((high - low) / low) * 100).toFixed(1)}% apart)` : ''),
    );
  }

  return {
    comps,
    notes,
    medianPsf: median(comps.map((c) => c.psf).filter((p): p is number => typeof p === 'number')),
  };
}
