/**
 * The agreed Figment pricing band.
 *
 * Every expected value below was worked through the Google Sheet formula by hand rather
 * than read back out of this implementation — a test that only asserts what the code
 * already does would pass just as happily on the wrong arithmetic.
 *
 *   higher  = MROUND(1.05*MAX(G,J), 250000)
 *   raw     = FLOOR(0.80*MIN(G,J), 250000)
 *   minimum = MEDIAN(raw, CEILING(higher/1.60, 250000), FLOOR(higher/1.35, 250000))
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figmentBand, defaultPricing, priceFromComps } from '../src/comps/pricing.js';
import type { Transaction } from '../src/comps/marketWatch.js';

const comp = (price: number, address = 'A STREET'): Transaction =>
  ({ address, price, district: 14, sheetName: 'D14' }) as unknown as Transaction;

test('the band is the agreed formula, not an approximation of it', () => {
  // G = 11,000,000  J = 12,000,000
  //   higher  = MROUND(1.05*12,000,000 = 12,600,000)          -> 12,500,000
  //   raw     = FLOOR(0.80*11,000,000 = 8,800,000)            ->  8,750,000
  //   bounds  = CEILING(12,500,000/1.60 = 7,812,500) -> 8,000,000
  //             FLOOR(12,500,000/1.35   = 9,259,259) -> 9,250,000
  //   minimum = MEDIAN(8,750,000, 8,000,000, 9,250,000)       ->  8,750,000  (raw is inside)
  assert.deepEqual(figmentBand([11_000_000, 12_000_000]), {
    minimumPrice: 8_750_000,
    higherPrice: 12_500_000,
  });
});

test('a raw bottom that is too low is pulled up to the 1.60x bound', () => {
  // G = 4,000,000  J = 20,000,000 — a wide pair, so the haircut lands below the band.
  //   higher  = MROUND(21,000,000)                            -> 21,000,000
  //   raw     = FLOOR(3,200,000)                              ->  3,000,000
  //   bounds  = CEILING(21,000,000/1.60 = 13,125,000) -> 13,250,000
  //             FLOOR(21,000,000/1.35   = 15,555,555) -> 15,500,000
  //   minimum = MEDIAN(3,000,000, 13,250,000, 15,500,000)     -> 13,250,000
  const band = figmentBand([4_000_000, 20_000_000]);
  assert.equal(band?.higherPrice, 21_000_000);
  assert.equal(band?.minimumPrice, 13_250_000);
  // The clamp is the point: the raw haircut would have been absurd.
  assert.ok(band!.minimumPrice > 3_000_000);
});

test('a raw bottom that is too high is pulled down to the 1.35x bound', () => {
  // Two near-identical comps, where 0.80x still leaves the range implausibly tight.
  // G = J = 12,000,000
  //   higher  = MROUND(12,600,000)                            -> 12,500,000
  //   raw     = FLOOR(9,600,000)                              ->  9,500,000
  //   bounds  = CEILING(7,812,500) -> 8,000,000
  //             FLOOR(9,259,259)   -> 9,250,000
  //   minimum = MEDIAN(9,500,000, 8,000,000, 9,250,000)       ->  9,250,000
  assert.deepEqual(figmentBand([12_000_000, 12_000_000]), {
    minimumPrice: 9_250_000,
    higherPrice: 12_500_000,
  });
});

test('order of the two comparables does not matter, because the formula uses MAX and MIN', () => {
  assert.deepEqual(figmentBand([12_000_000, 11_000_000]), figmentBand([11_000_000, 12_000_000]));
});

test('one comparable prices the row off itself, the way MAX and MIN skip blank cells', () => {
  // G = 9,000,000, J blank
  //   higher  = MROUND(9,450,000)                             ->  9,500,000
  //   raw     = FLOOR(7,200,000)                              ->  7,000,000
  //   bounds  = CEILING(5,937,500) -> 6,000,000
  //             FLOOR(7,037,037)   -> 7,000,000
  //   minimum = MEDIAN(7,000,000, 6,000,000, 7,000,000)       ->  7,000,000
  assert.deepEqual(figmentBand([9_000_000]), {
    minimumPrice: 7_000_000,
    higherPrice: 9_500_000,
  });
});

test('both figures land on a 250,000 multiple', () => {
  for (const pair of [
    [7_310_000, 8_640_000],
    [15_125_500, 14_009_900],
    [3_100_000, 3_450_000],
  ]) {
    const band = figmentBand(pair)!;
    assert.equal(band.minimumPrice % 250_000, 0, `min off-grid for ${pair}`);
    assert.equal(band.higherPrice % 250_000, 0, `higher off-grid for ${pair}`);
  }
});

test('the minimum is always below the higher price', () => {
  for (let a = 1_000_000; a <= 40_000_000; a += 1_150_000) {
    for (let b = 1_000_000; b <= 40_000_000; b += 3_350_000) {
      const band = figmentBand([a, b])!;
      assert.ok(
        band.minimumPrice < band.higherPrice,
        `inverted for ${a}/${b}: ${band.minimumPrice} >= ${band.higherPrice}`,
      );
    }
  }
});

test('no comparable prices means no price, not a zero', () => {
  assert.equal(figmentBand([]), undefined);
  assert.equal(figmentBand([0, Number.NaN]), undefined);
});

/** ------------------------------------------------------- through the pipeline ---- */

test('figment-band is the default method', () => {
  assert.equal(defaultPricing().method, 'figment-band');
});

test('pricing uses the two comparables the letter prints, not the whole pool', () => {
  // A third comp is in the pool but never reaches the reader, so it must not move the
  // price — otherwise the letter quotes a range it cannot justify from its own comps.
  const withThird = priceFromComps(
    [comp(11_000_000), comp(12_000_000), comp(30_000_000)],
    {},
    defaultPricing(),
  );
  assert.equal(withThird.minimumPrice, 8_750_000);
  assert.equal(withThird.higherPrice, 12_500_000);
});

test('the derivation is written into Comments so the range can be argued', () => {
  const priced = priceFromComps([comp(11_000_000), comp(12_000_000)], {}, defaultPricing());
  assert.match(priced.basis, /1\.05/);
  assert.match(priced.basis, /0\.80/);
  assert.match(priced.basis, /1\.35-1\.60x/);
  assert.match(priced.basis, /S\$250,000/);
});

test('comparables with no price yield no price', () => {
  const priced = priceFromComps(
    [{ address: 'A STREET', district: 14 } as unknown as Transaction],
    {},
    defaultPricing(),
  );
  assert.equal(priced.minimumPrice, undefined);
  assert.equal(priced.higherPrice, undefined);
});
