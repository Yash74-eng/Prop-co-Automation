/**
 * Turning comparables into the two numbers that go in the letter.
 *
 * The previous team set `minimum_Price` and `higher_Price` by discussion, which makes the
 * offer hard to defend and impossible to reproduce. These are formulas over the selected
 * comparables instead, so the same workbook and the same settings always produce the same
 * range, and the Comments column can state how it was derived.
 *
 * NOTE: which formula Figment wants is still an open commercial decision — see the
 * options below. `comps-psf-band` is the default because it is the one that adjusts for
 * the subject property's own size; nothing here is a valuation opinion, and every row
 * still carries the derivation for a human to accept or override.
 */
import { Transaction } from './marketWatch.js';

export type PricingMethod =
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
  /** Round both figures to this increment. */
  rounding: number;
}

export function defaultPricing(over: Partial<PricingOptions> = {}): PricingOptions {
  return {
    method: 'comps-psf-band',
    lowerBand: 0.05,
    upperBand: 0.1,
    rounding: 50_000,
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
