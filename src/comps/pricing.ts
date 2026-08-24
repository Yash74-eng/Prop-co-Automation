/**
 * Turning comparables into the two numbers that go in the letter.
 *
 * The previous team set `minimum_Price` and `higher_Price` by discussion, which makes the
 * offer hard to defend and impossible to reproduce. `figment-band` is the agreed formula
 * that replaces that meeting; it is the default, and it reads the same two comparables
 * that get printed in the letter, so the letter and the arithmetic can never disagree.
 *
 * The other methods are kept for comparison — nothing here is a valuation opinion, and
 * every row carries its derivation in Comments for a human to accept or override.
 */
import { Transaction } from './marketWatch.js';

export type PricingMethod =
  /** The agreed Figment band off the two printed comparables. */
  | 'figment-band'
  /** Median comp $psf x subject GFA, then a band either side. */
  | 'comps-psf-band'
  /** The comps' own price range, low comp to high comp, untouched. */
  | 'comps-range'
  /** Median comp price, then a band either side. */
  | 'comps-median-band'
  /** Produce nothing; a human fills the two cells in. */
  | 'manual';

export interface PricingOptions {
  method: PricingMethod;
  /** Fraction below the anchor for minimum_Price, e.g. 0.05 = 5% below. */
  lowerBand: number;
  /** Fraction above the anchor for higher_Price, e.g. 0.10 = 10% above. */
  upperBand: number;
  /** Round both figures to this increment. Not used by `figment-band`, which sets its own. */
  rounding: number;
  /** `figment-band` only: multiplier on the higher comparable. Default 1.05. */
  topUplift?: number;
  /** `figment-band` only: multiplier on the lower comparable. Default 0.80. */
  bottomHaircut?: number;
}

export function defaultPricing(over: Partial<PricingOptions> = {}): PricingOptions {
  return {
    method: 'figment-band',
    lowerBand: 0.05,
    upperBand: 0.1,
    rounding: 50_000,
    topUplift: DEFAULT_BAND_MULTIPLIERS.topUplift,
    bottomHaircut: DEFAULT_BAND_MULTIPLIERS.bottomHaircut,
    ...over,
  };
}

export interface PricedRange {
  minimumPrice?: number;
  higherPrice?: number;
  /** How the two numbers were reached, for the Comments column. */
  basis: string;
}

const roundTo = (value: number, increment: number) =>
  increment > 0 ? Math.round(value / increment) * increment : Math.round(value);

const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/* ------------------------------------------------------------------ figment-band -- */

/**
 * The agreed formula, as supplied for the Google Sheet:
 *
 *   higher_Price  = MROUND(1.05*MAX($G2,$J2), 250000)
 *   minimum_Price = LET(
 *     ceil, MROUND(1.05*MAX($G2,$J2), 250000),
 *     raw,  FLOOR(0.80*MIN($G2,$J2), 250000),
 *     MEDIAN(raw, CEILING(ceil/1.60, 250000), FLOOR(ceil/1.35, 250000)))
 *
 * G and J are the two comparable prices — the same two the letter prints as Comp_1 and
 * Comp_2. In words: the top of the range is 5% over the better comparable; the bottom
 * starts at a 20% haircut off the weaker one and is then clamped so the range never
 * implies a discount outside 1.35x-1.60x of the top. MEDIAN of the raw figure and the two
 * bounds is what does the clamping — it returns `raw` when it already sits inside the
 * band, and the nearer bound when it does not.
 *
 * Everything lands on a 250,000 multiple because that is the granularity the offer is
 * actually negotiated at.
 */
const BAND = {
  step: 250_000,
  /** Top of the range, over the better comparable. Settable per run. */
  topUplift: 1.05,
  /** Opening haircut off the weaker comparable. Settable per run. */
  bottomHaircut: 0.8,
  /** The bottom may never be further below the top than this ... */
  spreadWide: 1.6,
  /** ... nor closer to it than this. */
  spreadTight: 1.35,
};

/** The two multipliers the operator can change. The rest of the band is fixed. */
export interface BandMultipliers {
  /** Applied to the higher comparable to set the top. Default 1.05. */
  topUplift?: number;
  /** Applied to the lower comparable to open the bottom. Default 0.80. */
  bottomHaircut?: number;
}

export const DEFAULT_BAND_MULTIPLIERS = {
  topUplift: BAND.topUplift,
  bottomHaircut: BAND.bottomHaircut,
} as const;

/**
 * A multiplier the operator typed, or the default.
 *
 * Zero, negative and non-numeric all fall back rather than producing a range of nothing —
 * an empty box in the UI must not silently price every letter at 0.
 */
const multiplier = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const mround = (v: number, f: number) => Math.round(v / f) * f;
const floorTo = (v: number, f: number) => Math.floor(v / f) * f;
const ceilTo = (v: number, f: number) => Math.ceil(v / f) * f;
const mid3 = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y)[1];

export interface FigmentBand {
  minimumPrice: number;
  higherPrice: number;
}

/**
 * Apply the agreed formula to the comparable prices. Blank comparables are ignored the
 * way MAX and MIN ignore blank cells, so one comparable prices the row off itself.
 */
export function figmentBand(
  compPrices: number[],
  over: BandMultipliers = {},
): FigmentBand | undefined {
  const prices = compPrices.filter((p) => typeof p === 'number' && Number.isFinite(p) && p > 0);
  if (prices.length === 0) return undefined;

  const topUplift = multiplier(over.topUplift, BAND.topUplift);
  const bottomHaircut = multiplier(over.bottomHaircut, BAND.bottomHaircut);

  const higherPrice = mround(topUplift * Math.max(...prices), BAND.step);
  const raw = floorTo(bottomHaircut * Math.min(...prices), BAND.step);
  // The clamp is what keeps minimum below higher whatever multipliers are chosen: both
  // bounds are derived from the top, so a haircut of 1.5 still lands inside the band.
  const minimumPrice = mid3(
    raw,
    ceilTo(higherPrice / BAND.spreadWide, BAND.step),
    floorTo(higherPrice / BAND.spreadTight, BAND.step),
  );
  return { minimumPrice, higherPrice };
}

/**
 * Price a property from its comparables.
 *
 * Returns blanks rather than a guess when the inputs cannot support a number — a blank
 * cell is obviously incomplete, where an invented figure is not.
 */
export function priceFromComps(
  comps: Transaction[],
  subject: { gfaSqft?: number },
  options: PricingOptions,
): PricedRange {
  if (options.method === 'manual') {
    return { basis: 'Left blank — priced by hand' };
  }
  if (comps.length === 0) {
    return { basis: 'No comparables found, so no indicative price' };
  }

  const prices = comps.map((c) => c.price).filter((p): p is number => typeof p === 'number');
  const psfs = comps.map((c) => c.psf).filter((p): p is number => typeof p === 'number');

  if (options.method === 'figment-band') {
    // Only the comparables the letter actually prints. Pricing off a comp the reader
    // cannot see would make the range unarguable in exactly the wrong way.
    const printed = comps.slice(0, 2).map((c) => c.price).filter((p): p is number => typeof p === 'number');
    const top = multiplier(options.topUplift, BAND.topUplift);
    const bottom = multiplier(options.bottomHaircut, BAND.bottomHaircut);
    const band = figmentBand(printed, { topUplift: top, bottomHaircut: bottom });
    if (!band) return { basis: 'Comparables carry no prices' };
    const money = (n: number) => `S$${n.toLocaleString('en-SG')}`;
    return {
      minimumPrice: band.minimumPrice,
      higherPrice: band.higherPrice,
      // The multipliers actually used, not the defaults: a row priced with a changed
      // uplift has to say so, or the Comments column stops being an audit trail.
      basis:
        `Priced off ${printed.length === 1 ? 'the comparable' : 'both comparables'} ` +
        `(${printed.map(money).join(', ')}): top = ${top.toFixed(2)} x highest, ` +
        `bottom = ${bottom.toFixed(2)} x lowest held within ` +
        `${BAND.spreadTight.toFixed(2)}-${BAND.spreadWide.toFixed(2)}x of the top, ` +
        `all to the nearest ${money(BAND.step)}`,
    };
  }

  if (options.method === 'comps-range') {
    if (prices.length === 0) return { basis: 'Comparables carry no prices' };
    return {
      minimumPrice: roundTo(Math.min(...prices), options.rounding),
      higherPrice: roundTo(Math.max(...prices), options.rounding),
      basis: `Range of the ${prices.length} closest comparables`,
    };
  }

  if (options.method === 'comps-psf-band') {
    const medianPsf = median(psfs);
    if (medianPsf === undefined || !subject.gfaSqft) {
      // Fall through to the price-based band rather than returning nothing: a missing
      // GFA is common in the tracker and should not cost the row its price.
      const medianPrice = median(prices);
      if (medianPrice === undefined) return { basis: 'Comparables carry no prices' };
      return {
        minimumPrice: roundTo(medianPrice * (1 - options.lowerBand), options.rounding),
        higherPrice: roundTo(medianPrice * (1 + options.upperBand), options.rounding),
        basis:
          `Median comparable price ${Math.round(medianPrice).toLocaleString('en-SG')} ` +
          `-${(options.lowerBand * 100).toFixed(0)}% / +${(options.upperBand * 100).toFixed(0)}% ` +
          '(no GFA on this property, so psf could not be used)',
      };
    }
    const anchor = medianPsf * subject.gfaSqft;
    return {
      minimumPrice: roundTo(anchor * (1 - options.lowerBand), options.rounding),
      higherPrice: roundTo(anchor * (1 + options.upperBand), options.rounding),
      basis:
        `Median comparable ${Math.round(medianPsf).toLocaleString('en-SG')} psf ` +
        `x ${subject.gfaSqft.toLocaleString('en-SG')} sqft, ` +
        `-${(options.lowerBand * 100).toFixed(0)}% / +${(options.upperBand * 100).toFixed(0)}%`,
    };
  }

  // comps-median-band
  const medianPrice = median(prices);
  if (medianPrice === undefined) return { basis: 'Comparables carry no prices' };
  return {
    minimumPrice: roundTo(medianPrice * (1 - options.lowerBand), options.rounding),
    higherPrice: roundTo(medianPrice * (1 + options.upperBand), options.rounding),
    basis:
      `Median comparable price ${Math.round(medianPrice).toLocaleString('en-SG')} ` +
      `-${(options.lowerBand * 100).toFixed(0)}% / +${(options.upperBand * 100).toFixed(0)}%`,
  };
}
