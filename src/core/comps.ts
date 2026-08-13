/**
 * Comparables and indicative pricing for the lawyer letter.
 *
 * Primary source: the "Lawyer Letter Comps Benchmarks" table, keyed by
 * (Neighbourhood, Land Use, Tenure) — the same three columns the tracker uses.
 * The user can upload a replacement table in the same shape.
 *
 * Fallback (optional): GFA x neighbourhood psf, mirroring the tracker's Benchmark column.
 * GFA in the Main Database is in SQUARE FEET (land area sqm x 10.7639 x floors), and the
 * benchmark is psf of GFA, so the product is a value in dollars.
 */
import { CompsRecord } from './types.js';
import { normKey, parseLooseDate, squash, toNumber } from './text.js';
import { compsLandUse, compsNeighbourhood, normaliseTenure } from './vocab.js';
import { SheetTable } from './mainDatabase.js';
import { headerKey } from './text.js';

export const COMPS_HEADERS = [
  'Neighbourhood',
  'Land Use',
  'Tenure',
  'minimum_Price',
  'higher_Price',
  'Comp_Address_1',
  'Comp_1',
  'Comp_1_Date',
  'Comp_Address_2',
  'Comp_2',
  'Comp_2_Date',
] as const;

/** Read a comps benchmark table from a sheet with the headers above. */
export function parseCompsTable(table: SheetTable): CompsRecord[] {
  const index = new Map<string, number>();
  table.headers.forEach((h, i) => {
    const k = headerKey(h);
    if (k && !index.has(k)) index.set(k, i);
  });
  const col = (name: string) => index.get(headerKey(name));

  const out: CompsRecord[] = [];
  for (const cells of table.rows) {
    const at = (name: string) => {
      const c = col(name);
      return c === undefined ? undefined : cells[c];
    };
    const neighbourhood = squash(at('Neighbourhood'));
    const landUse = squash(at('Land Use'));
    const tenure = squash(at('Tenure'));
    if (!neighbourhood && !landUse && !tenure) continue;
    out.push({
      neighbourhood,
      landUse,
      tenure,
      minimumPrice: toNumber(at('minimum_Price')),
      higherPrice: toNumber(at('higher_Price')),
      compAddress1: squash(at('Comp_Address_1')) || undefined,
      comp1: toNumber(at('Comp_1')),
      comp1Date: parseLooseDate(at('Comp_1_Date')),
      compAddress2: squash(at('Comp_Address_2')) || undefined,
      comp2: toNumber(at('Comp_2')),
      comp2Date: parseLooseDate(at('Comp_2_Date')),
    });
  }
  return out;
}

function compsKey(neighbourhood: string, landUse: string, tenure: string): string {
  return [normKey(neighbourhood), normKey(landUse), normKey(tenure)].join('|');
}

export class CompsIndex {
  private readonly map = new Map<string, CompsRecord>();
  readonly records: CompsRecord[];

  constructor(records: CompsRecord[]) {
    this.records = records;
    for (const r of records) {
      const k = compsKey(r.neighbourhood, r.landUse, r.tenure);
      if (!this.map.has(k)) this.map.set(k, r);
    }
  }

  /** Look up by the comps-sheet vocabulary (already translated). */
  lookupExact(neighbourhood: string, landUse: string, tenure: string): CompsRecord | undefined {
    return this.map.get(compsKey(neighbourhood, landUse, tenure));
  }
}

export interface CompsLookupInput {
  neighbourhood?: string;
  landUse?: string;
  tenure?: string;
  gfaSqft?: number;
  benchmarkPsf?: number;
}

export interface CompsLookupResult {
  record?: CompsRecord;
  minimumPrice?: number;
  higherPrice?: number;
  /** Where the prices came from. */
  source: 'comps-benchmark' | 'derived-from-psf' | 'none';
  /** Human-readable reasons, surfaced in Comments and the review sheet. */
  notes: string[];
  /** Translated keys, so the audit sheet can show what was matched on. */
  resolved: { neighbourhood?: string; landUse?: string; tenure?: string };
}

export interface CompsOptions {
  deriveMissingPrices: boolean;
  derivedHigherMultiplier: number;
  derivedRounding: number;
  /** Extra Main-DB-neighbourhood -> comps-neighbourhood overrides from config. */
  neighbourhoodOverrides?: Record<string, string>;
}

export function lookupComps(
  index: CompsIndex,
  input: CompsLookupInput,
  options: CompsOptions,
): CompsLookupResult {
  const notes: string[] = [];
  const nbhd = compsNeighbourhood(input.neighbourhood, options.neighbourhoodOverrides);
  const use = compsLandUse(input.landUse);
  const ten = normaliseTenure(input.tenure).comps;

  const resolved = { neighbourhood: nbhd, landUse: use, tenure: ten };

  if (!nbhd) notes.push(`No comps neighbourhood mapping for "${input.neighbourhood ?? ''}"`);
  if (!use) notes.push(`No comps land-use mapping for "${input.landUse ?? ''}"`);
  if (!ten) notes.push(`No comps tenure mapping for "${input.tenure ?? ''}"`);

  if (nbhd && use && ten) {
    const record = index.lookupExact(nbhd, use, ten);
    if (record) {
      return {
        record,
        minimumPrice: record.minimumPrice,
        higherPrice: record.higherPrice,
        source: 'comps-benchmark',
        notes,
        resolved,
      };
    }
    notes.push(`No comps benchmark row for ${nbhd} / ${use} / ${ten}`);
  }

  if (options.deriveMissingPrices && input.gfaSqft && input.benchmarkPsf) {
    const raw = input.gfaSqft * input.benchmarkPsf;
    const min = roundTo(raw, options.derivedRounding);
    const high = roundTo(raw * options.derivedHigherMultiplier, options.derivedRounding);
    notes.push(
      `Prices derived from GFA ${Math.round(input.gfaSqft).toLocaleString('en-SG')} sqft x psf ${Math.round(
        input.benchmarkPsf,
      ).toLocaleString('en-SG')} — no comps benchmark row. VERIFY BEFORE SENDING.`,
    );
    return { minimumPrice: min, higherPrice: high, source: 'derived-from-psf', notes, resolved };
  }

  return { source: 'none', notes, resolved };
}

function roundTo(value: number, increment: number): number {
  if (!increment || increment <= 0) return Math.round(value);
  return Math.round(value / increment) * increment;
}
