/**
 * Comp selection from the Market Watch transactions sheet.
 *
 * The District 14 rows below are copied from the real sheet, including the strata cluster
 * that makes a naive "two most recent" wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultCompSelection,
  isFullCommercial,
  isLandSale,
  parseTransactionDate,
  parseTransactionSheet,
  selectComps,
  toNumber,
  type Transaction,
} from '../src/comps/marketWatch.js';
import { districtFromPostalCode, districtLabel } from '../src/comps/districts.js';
import { defaultPricing, priceFromComps } from '../src/comps/pricing.js';

/** ------------------------------------------------------------ districts ---- */

test('Changi Road postal sector 41 resolves to District 14, as specified', () => {
  assert.equal(districtFromPostalCode('419123'), 14);
  assert.equal(districtLabel(14), 'D14 — Geylang, Eunos');
});

test('district is read from the sectors either side of a boundary', () => {
  assert.equal(districtFromPostalCode('049442'), 1); // Boat Quay
  assert.equal(districtFromPostalCode('069692'), 1); // Ann Siang
  assert.equal(districtFromPostalCode('088808'), 2); // Neil Road
  assert.equal(districtFromPostalCode('428000'), 15); // Katong
  assert.equal(districtFromPostalCode('389000'), 14);
});

test('a postal code that lost its leading zero in Excel still resolves', () => {
  assert.equal(districtFromPostalCode(49442), 1);
  assert.equal(districtFromPostalCode('49442'), 1);
});

test('a postal code embedded in an address is found', () => {
  assert.equal(districtFromPostalCode('91 CIRCULAR ROAD SINGAPORE 049442'), 1);
});

test('an unusable postal code returns undefined rather than a guess', () => {
  assert.equal(districtFromPostalCode(''), undefined);
  assert.equal(districtFromPostalCode('abc'), undefined);
  assert.equal(districtFromPostalCode('749999'), undefined); // sector 74 is unassigned
});

/** ----------------------------------------------------------- field reads ---- */

test('thousand separators are stripped from prices and areas', () => {
  assert.equal(toNumber('6,400,000'), 6_400_000);
  assert.equal(toNumber('1,498'), 1498);
  assert.equal(toNumber(' 4,271 '), 4271);
  assert.equal(toNumber(''), undefined);
  assert.equal(toNumber('N/A'), undefined);
});

test('the sheet date format parses, keeping the calendar day', () => {
  const d = parseTransactionDate('19 Jun 2026');
  assert.ok(d);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 5);
  assert.equal(d.getUTCDate(), 19);
});

test('only fully commercial zoning qualifies', () => {
  assert.equal(isFullCommercial('Full Commercial (Dark Blue)'), true);
  assert.equal(isFullCommercial('Commercial and Residential (Light Blue)'), false);
  assert.equal(isFullCommercial('Residential with Commercial at 1st storey (Red)'), false);
  assert.equal(isFullCommercial('Hotel (Purple) Others'), false);
  assert.equal(isFullCommercial(''), false);
});

test('land and strata sales are told apart', () => {
  assert.equal(isLandSale('Land'), true);
  assert.equal(isLandSale('Strata'), false);
});

/** ------------------------------------------------ header-driven parsing ---- */

test('a tab is parsed by header name, not column position', () => {
  // This tab carries GPR, which several district tabs omit.
  const headers = [
    'Date', 'District', 'Project Name', 'Address', 'Property Type', 'Tenure',
    'Area (sq ft)', 'Type of Area', 'Price ($psf)', 'Price ($)', 'No. of Floors',
    'GPR', 'URA Zoning ',
  ];
  const rows = [
    ['5 Mar 2026', '1', 'TELOK AYER CONSERVATION AREA', '30 Stanley Street', 'Shop House',
     'Freehold', '1,691', 'Land', '9,272', '15,680,000', '2.5', 'N/A',
     'Full Commercial (Dark Blue)'],
  ];
  const [t] = parseTransactionSheet('District 1', headers, rows);
  assert.equal(t.district, 1);
  assert.equal(t.address, '30 Stanley Street');
  assert.equal(t.areaSqft, 1691);
  assert.equal(t.psf, 9272);
  assert.equal(t.price, 15_680_000);
  assert.equal(t.areaType, 'Land');
  assert.match(t.zoning ?? '', /Full Commercial/);
});

test('a tab whose date header is mislabelled still yields the date', () => {
  // One real tab's first header reads "K4" instead of "Date".
  const headers = ['K4', 'District', 'Address', 'Type of Area', 'Price ($)', 'URA Zoning '];
  const rows = [['6 Feb 2025', '14', '635 Geylang Road', 'Land', '5,950,000', 'Full Commercial (Dark Blue)']];
  const [t] = parseTransactionSheet('District 14', headers, rows);
  assert.ok(t.date, 'date should fall back to the first column');
  assert.equal(t.date?.getUTCFullYear(), 2025);
});

/** -------------------------------------------------- selection, real data ---- */

const D14_HEADERS = [
  'Date', 'District', 'Project Name', 'Address', 'Property Type', 'Tenure',
  'Area (sq ft)', 'Type of Area', 'Price ($psf)', 'Price ($)', 'No. of Floors', 'URA Zoning ',
];

// Copied from the District 14 tab of the real sheet.
const D14_ROWS: unknown[][] = [
  ['19 Jun 2026', '14', 'GEYLANG CONSERVATION AREA', '271, 271A Geylang Road', 'Shop House', 'Freehold', '1,498', 'Land', '4,271', '6,400,000', '2', 'Full Commercial (Dark Blue)'],
  ['6 Feb 2025', '14', 'GEYLANG CONSERVATION AREA', '635 Geylang Road', 'Shop House', 'Freehold', '1,323', 'Land', '4,498', '5,950,000', '2.0', 'Full Commercial (Dark Blue)'],
  ['3 Oct 2024', '14', 'N.A.', '233,233A,233B Geylang Road', 'Shop House', 'Freehold', '2,566', 'Land', '5,689', '14,600,000', '3.0', 'Full Commercial (Dark Blue)'],
  ['9 Sep 2024', '14', 'N.A.', '291 Geylang Road', 'Shop House', 'Freehold', '1,925', 'Land', '4,572', '8,800,000', '2.0', 'Full Commercial (Dark Blue)'],
  ['10 Jun 2024', '14', 'GEYLANG CONSERVATION AREA', '547 Geylang Road', 'Shop House', 'Freehold', '1,378', 'Land', '4,355', '6,000,000', '2.0', 'Full Commercial (Dark Blue)'],
  // The strata cluster — same project, all far cheaper than a whole shophouse.
  ['13 May 2024', '14', 'THE ARIZON', '538 Geylang Road #01-05', 'Shop House', 'Freehold', '797', 'Strata', '3,159', '2,516,180', '', 'Full Commercial (Dark Blue)'],
  ['13 May 2024', '14', 'THE ARIZON', '538 Geylang Road #01-06', 'Shop House', 'Freehold', '915', 'Strata', '3,103', '2,839,000', '', 'Full Commercial (Dark Blue)'],
  ['13 May 2024', '14', 'THE ARIZON', '538 Geylang Road #01-07', 'Shop House', 'Freehold', '904', 'Strata', '3,106', '2,808,000', '', 'Full Commercial (Dark Blue)'],
  // Not fully commercial — must never be chosen.
  ['26 Dec 2025', '14', 'N.A.', '54,54A,54B Changi Road', 'Shop House', 'Freehold', '1,537', 'Land', '3,513', '5,400,000', '3', 'Commercial and Residential (Light Blue)'],
  ['29 Sep 2023', '14', 'N.A.', '366 Changi Road', 'Shop House', 'Freehold', '1,636', 'Strata', '2,433', '3,980,000', '2.0', 'Residential with Commercial at 1st storey (Red)'],
];

const d14 = () => parseTransactionSheet('District 14', D14_HEADERS, D14_ROWS);
const AS_OF = new Date('2026-09-01T00:00:00Z');

test('a Changi Road property draws its comps from District 14', () => {
  const result = selectComps(
    d14(),
    { postalCode: '419123' },
    defaultCompSelection(),
    AS_OF,
  );
  assert.equal(result.comps.length, 2);
  assert.ok(result.notes.some((n) => n.includes('District 14')));
});

test('mixed-use and residential-with-commercial rows are never selected', () => {
  const result = selectComps(d14(), { postalCode: '419123' }, defaultCompSelection(), AS_OF);
  for (const c of result.comps) {
    assert.ok(isFullCommercial(c.zoning), `${c.address} is not fully commercial`);
  }
  assert.ok(!result.comps.some((c) => /Changi Road/.test(c.address)));
});

test('strata units are excluded, so a whole shophouse is not compared to a unit', () => {
  const result = selectComps(d14(), { postalCode: '419123' }, defaultCompSelection(), AS_OF);
  for (const c of result.comps) {
    assert.equal(c.areaType, 'Land', `${c.address} is a ${c.areaType} sale`);
  }
  assert.ok(!result.comps.some((c) => c.projectName === 'THE ARIZON'));
});

test('turning the land filter off puts strata back in the candidate pool', () => {
  const on = selectComps(d14(), { postalCode: '419123' }, defaultCompSelection(), AS_OF);
  const off = selectComps(
    d14(),
    { postalCode: '419123' },
    defaultCompSelection({ landOnly: false }),
    AS_OF,
  );

  assert.ok(on.notes.some((n) => /strata excluded/i.test(n)));
  assert.ok(!off.notes.some((n) => /strata excluded/i.test(n)));

  // More rows survive filtering once strata are allowed.
  const considered = (notes: string[]) =>
    Number(/Considered the (\d+)/.exec(notes.join(' '))?.[1] ?? 0);
  assert.ok(
    considered(off.notes) > considered(on.notes),
    `expected a bigger pool with strata allowed: ${considered(on.notes)} -> ${considered(off.notes)}`,
  );
});

test('with strata allowed, the tightest pair here is still the land pair', () => {
  // Not a guarantee of the rule, a property of this data: 5.95M/6.00M are 0.84% apart,
  // tighter than the closest strata pair at 1.1%. Recorded so a future change that flips
  // this is noticed rather than shipped quietly.
  const off = selectComps(
    d14(),
    { postalCode: '419123' },
    defaultCompSelection({ landOnly: false }),
    AS_OF,
  );
  assert.ok(off.comps.every((c) => c.areaType === 'Land'), off.comps.map((c) => c.address).join(' | '));
});

test('prices are read from Price ($), never from Price ($psf)', () => {
  // The bug this pins: a loose header match read 4,271 psf as the sale price.
  const rows = d14();
  const jun = rows.find((r) => r.address.startsWith('271'));
  assert.ok(jun);
  assert.equal(jun.price, 6_400_000, 'price column');
  assert.equal(jun.psf, 4_271, 'psf column');
  assert.equal(jun.areaSqft, 1_498, 'area column');
});

test('the chosen pair is the closest on price, not simply the two most recent', () => {
  const result = selectComps(d14(), { postalCode: '419123' }, defaultCompSelection(), AS_OF);
  const prices = result.comps.map((c) => c.price ?? 0).sort((a, b) => a - b);

  // Every comp must be a real sale price, not a psf figure.
  for (const p of prices) assert.ok(p > 1_000_000, `${p} looks like a psf figure, not a price`);

  // 6.40M / 6.00M / 5.95M are the tight ones; 14.6M and 8.8M are the outliers.
  assert.ok(
    !result.comps.some((c) => (c.price ?? 0) >= 8_000_000),
    `picked an outlier: ${result.comps.map((c) => c.address).join(' | ')}`,
  );
  const spread = (prices[1] - prices[0]) / prices[0];
  assert.ok(spread < 0.1, `pair is ${(spread * 100).toFixed(1)}% apart, expected under 10%`);
});

test('an age limit drops transactions that are too old', () => {
  const result = selectComps(
    d14(),
    { postalCode: '419123' },
    defaultCompSelection({ maxAgeMonths: 6 }),
    AS_OF,
  );
  // Only the Jun 2026 sale falls inside six months of Sep 2026.
  assert.ok(result.comps.length <= 1);
});

test('a property with no usable postal code yields no comps and says why', () => {
  const result = selectComps(d14(), { postalCode: '' }, defaultCompSelection(), AS_OF);
  assert.equal(result.comps.length, 0);
  assert.match(result.notes.join(' '), /no usable postal code/i);
});

test('a district with no transactions yields no comps rather than borrowing another', () => {
  const result = selectComps(d14(), { postalCode: '728000' }, defaultCompSelection(), AS_OF);
  assert.equal(result.comps.length, 0);
});

/** ------------------------------------------------------------- pricing ---- */

const twoComps = (): Transaction[] =>
  selectComps(d14(), { postalCode: '419123' }, defaultCompSelection(), AS_OF).comps;

test('psf band prices off the subject GFA and states its working', () => {
  const priced = priceFromComps(twoComps(), { gfaSqft: 1500 }, defaultPricing());
  assert.ok(priced.minimumPrice && priced.higherPrice);
  assert.ok(priced.minimumPrice < priced.higherPrice);
  assert.match(priced.basis, /psf/);
  assert.match(priced.basis, /1,500 sqft/);
});

test('a missing GFA falls back to the median price rather than losing the row', () => {
  const priced = priceFromComps(twoComps(), {}, defaultPricing());
  assert.ok(priced.minimumPrice && priced.higherPrice);
  assert.match(priced.basis, /no GFA/i);
});

test('the range method reports the comps exactly, low to high', () => {
  const comps = twoComps();
  const priced = priceFromComps(comps, { gfaSqft: 1500 }, defaultPricing({ method: 'comps-range', rounding: 0 }));
  const prices = comps.map((c) => c.price ?? 0);
  assert.equal(priced.minimumPrice, Math.min(...prices));
  assert.equal(priced.higherPrice, Math.max(...prices));
});

test('manual pricing produces nothing at all, on purpose', () => {
  const priced = priceFromComps(twoComps(), { gfaSqft: 1500 }, defaultPricing({ method: 'manual' }));
  assert.equal(priced.minimumPrice, undefined);
  assert.equal(priced.higherPrice, undefined);
});

test('no comparables means no price, never an invented one', () => {
  const priced = priceFromComps([], { gfaSqft: 1500 }, defaultPricing());
  assert.equal(priced.minimumPrice, undefined);
  assert.equal(priced.higherPrice, undefined);
  assert.match(priced.basis, /No comparables/i);
});
