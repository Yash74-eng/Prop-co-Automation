/**
 * Vocabulary bridges between the Main Database and the Lawyer Letter Comps Benchmarks sheet.
 *
 * The two sheets use different words for the same thing:
 *   Main DB land use "Full Commercial (Dark Blue)"  ->  comps "Fully Commercial"
 *   Main DB tenure   "LEASEHOLD 999 Years (10/08/1831)" -> comps "FH / 999 years"
 *   Main DB nbhd     "D1 - Raffles Place, Cecil, ..."   -> comps "D1"
 *
 * The land-use and tenure rules mirror the tracker's own Benchmark formula
 * (LET/REGEXMATCH in 'Main Database'!AK), so derived psf and comps agree.
 */
import { normKey, upper } from './text.js';

/** Benchmark category codes used by the Neighbourhood Benchmarks lookup table (column M). */
export type BenchmarkCategory = 'FC' | 'MU' | 'LB' | 'RED' | 'TEAL' | '?';

/** Land-use labels used by the Lawyer Letter Comps Benchmarks sheet. */
export type CompsLandUse =
  | 'Fully Commercial'
  | 'Mixed Use'
  | 'Commercial / Institution'
  | 'Residential / Institution';

/** Tenure labels used by the Lawyer Letter Comps Benchmarks sheet. */
export type CompsTenure = 'FH / 999 years' | '99 years';

/**
 * Normalise a Main Database tenure string.
 * Mirrors the tracker formula: a "99 Years" lease is LH 99; 999/9999/FH/Freehold are FH.
 */
export function normaliseTenure(raw: unknown): { benchmark: 'FH' | 'LH 99' | 'UNKNOWN'; comps?: CompsTenure } {
  const text = upper(raw);
  if (!text) return { benchmark: 'UNKNOWN' };

  const yearMatch = text.match(/(\d+)\s*YEAR/);
  const years = yearMatch ? yearMatch[1] : '';

  if (years === '99') return { benchmark: 'LH 99', comps: '99 years' };
  if (years === '999' || years === '9999') return { benchmark: 'FH', comps: 'FH / 999 years' };
  if (/FREEHOLD|\bFH\b/.test(text)) return { benchmark: 'FH', comps: 'FH / 999 years' };
  if (/9999/.test(text)) return { benchmark: 'FH', comps: 'FH / 999 years' };
  if (/999/.test(text)) return { benchmark: 'FH', comps: 'FH / 999 years' };
  if (/\b99\b/.test(text)) return { benchmark: 'LH 99', comps: '99 years' };
  return { benchmark: 'UNKNOWN' };
}

/** Map a Main Database land use to the Neighbourhood Benchmarks category code. */
export function benchmarkCategory(landUse: unknown): BenchmarkCategory {
  const text = upper(landUse);
  if (!text) return '?';
  if (/FULL\s+COMMERCIAL/.test(text)) return 'FC';
  if (/MIXED|COMMERCIAL AND RESIDENTIAL|COMMERCIAL & RESIDENTIAL|RESIDENTIAL WITH COMMERCIAL|1ST STOREY/.test(text)) {
    return 'MU';
  }
  if (/TEAL|INSTITUTION/.test(text)) return 'TEAL';
  return '?';
}

/** Map a Main Database land use to the comps-sheet vocabulary. */
export function compsLandUse(landUse: unknown): CompsLandUse | undefined {
  const text = upper(landUse);
  if (!text || text === '#N/A') return undefined;
  if (/FULL\s+COMMERCIAL/.test(text)) return 'Fully Commercial';
  if (/RESIDENTIAL\s*\/\s*INSTITUTION/.test(text)) return 'Residential / Institution';
  if (/COMMERCIAL\s*\/\s*INSTITUTION/.test(text)) return 'Commercial / Institution';
  if (/MIXED|COMMERCIAL AND RESIDENTIAL|COMMERCIAL & RESIDENTIAL|RESIDENTIAL WITH COMMERCIAL|1ST STOREY/.test(text)) {
    return 'Mixed Use';
  }
  return undefined;
}

/**
 * Main Database neighbourhood -> Lawyer Letter Comps Benchmarks neighbourhood.
 *
 * Only mappings we can defend are listed. Anything absent produces a "no comps benchmark"
 * flag rather than a wrong comparable — a letter quoting the wrong street is worse than
 * a letter with the comps left blank.
 *
 * Deliberately NOT mapped:
 *   "Upper Serangoon" -> comps "Serangoon". The comps "Serangoon" row uses 563 Serangoon
 *   Road / 403 Jalan Besar, i.e. the Serangoon Road (Little India) cluster, not Upper
 *   Serangoon out by Yio Chu Kang.
 */
export const NEIGHBOURHOOD_TO_COMPS: Record<string, string> = {
  'balestier': 'Balestier',
  'changi road': 'Changi Road',
  'east coast road': 'East Coast',
  'geylang': 'Geylang',
  'geylang (lorong)': 'Geylang (Lorong)',
  'sims avenue': 'Geylang / Sims Avenue',
  'guillemard road': 'Geylang / Sims Avenue',
  'jalan besar': 'Jalan Besar',
  'joo chiat': 'Joo Chiat',
  'lavender street': 'Lavender',
  'tanjong katong': 'Tanjong Katong',
  "d1 - raffles place, cecil, marina, people's park": 'D1',
  'd2 - anson, tanjong pagar': 'D2',
  'kampong glam': 'Kampong Glam',
  'rochor / bugis': 'Kampong Glam',
  'little india': 'Little India',
};

/** Look up the comps neighbourhood for a Main Database neighbourhood. */
export function compsNeighbourhood(
  neighbourhood: unknown,
  overrides: Record<string, string> = {},
): string | undefined {
  const raw = String(neighbourhood ?? '').trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const table = { ...NEIGHBOURHOOD_TO_COMPS, ...lowerKeys(overrides) };
  if (table[lower]) return table[lower];

  // Fall back to a normalised-key match so "Kampong glam" and "Kampong Glam " both hit.
  const key = normKey(raw);
  for (const [k, v] of Object.entries(table)) {
    if (normKey(k) === key) return v;
  }
  return undefined;
}

function lowerKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Neighbourhood name used for the Neighbourhood Benchmarks psf lookup.
 * The tracker's own formula rewrites "Jalan Besar" before matching.
 */
export function benchmarkNeighbourhood(neighbourhood: unknown): string {
  const raw = String(neighbourhood ?? '').trim();
  if (raw === 'Jalan Besar') return 'Jalan Besar / Serangoon Road';
  return raw;
}

/** Composite key into the Neighbourhood Benchmarks table (column M), e.g. "FC|FH|Little India". */
export function benchmarkKey(landUse: unknown, tenure: unknown, neighbourhood: unknown): string {
  const cat = benchmarkCategory(landUse);
  const ten = normaliseTenure(tenure).benchmark;
  return `${cat}|${ten === 'UNKNOWN' ? String(tenure ?? '') : ten}|${benchmarkNeighbourhood(neighbourhood)}`;
}
