/**
 * Scrubbing addresses and owner names, and the corrected-address loop over BizFile.
 *
 * The junk below is the real thing: a trademark mark pasted off a company website, a
 * zero-width space from a Google Docs paste, a BOM from a CSV round-trip. The invisible
 * ones matter most — they defeat postal-code matching and name comparison without
 * appearing on screen, so nobody knows why two identical values stopped merging.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrintable, parseAddress } from '../src/core/address.js';
import { parseCorrectedAddresses } from '../src/bizfile/resolver.js';
import { defaultOptions, runPipeline } from '../src/core/pipeline.js';
import type { SourceRow } from '../src/core/types.js';

test('trademark and copyright marks are removed and named', () => {
  const out = cleanPrintable('SOMEWHERE™ BUILDING, 12 CLUB STREET SINGAPORE 069413');
  assert.equal(out.text, 'SOMEWHERE BUILDING, 12 CLUB STREET SINGAPORE 069413');
  assert.deepEqual(out.removed, ['trademark or copyright mark']);

  for (const mark of ['®', '©', '℗', '℠']) {
    assert.equal(cleanPrintable(`ACME${mark} TOWER`).text, 'ACME TOWER');
  }
});

test('typed-out (TM) and (R) are removed only where they trail a word', () => {
  assert.equal(cleanPrintable('ACME(TM) TOWER').text, 'ACME TOWER');
  assert.equal(cleanPrintable('ACME (R) TOWER').text, 'ACME TOWER');
  // A standalone parenthetical is left alone — it can be a real part of an address.
  assert.equal(cleanPrintable('12 CLUB STREET (REAR) SINGAPORE 069413').text,
    '12 CLUB STREET (REAR) SINGAPORE 069413');
});

test('invisible characters are removed, which is why they are worth chasing', () => {
  // A zero-width space between the street and SINGAPORE.
  const raw = '12 CLUB STREET​ SINGAPORE 069413';
  const out = cleanPrintable(raw);
  assert.equal(out.text, '12 CLUB STREET SINGAPORE 069413');
  assert.deepEqual(out.removed, ['zero-width or direction-control character']);

  // A BOM, as arrives in the first cell of a CSV.
  assert.equal(cleanPrintable('﻿12 CLUB STREET').text, '12 CLUB STREET');
});

test('a zero-width space no longer costs the address its postal code', () => {
  const dirty = parseAddress('12 CLUB STREET​ SINGAPORE 069413');
  assert.equal(dirty.postal, '069413');
  assert.equal(dirty.street, 'CLUB STREET');
  assert.equal(dirty.unparsed, false);
  assert.deepEqual(dirty.scrubbed, ['zero-width or direction-control character']);
});

test('two copies of one address that differ only in junk now parse identically', () => {
  const a = parseAddress('27 CLUB STREET SINGAPORE 069413');
  const b = parseAddress('27 CLUB STREET™ SINGAPORE 069413');
  assert.equal(a.postal, b.postal);
  assert.equal(a.street, b.street);
  assert.deepEqual(a.numbers, b.numbers);
  // ... and the second one says why it changed, so the fix is visible.
  assert.ok((b.scrubbed ?? []).length > 0);
});

test('emoji and footnote markers go; real punctuation stays', () => {
  assert.equal(cleanPrintable('12 CLUB STREET 🏠').text, '12 CLUB STREET');
  assert.equal(cleanPrintable('12 CLUB STREET¹').text, '12 CLUB STREET');
  // The characters addresses actually need must survive untouched.
  const real = '27 / 29 CLUB STREET #03-01 SINGAPORE 069413 / 14';
  assert.equal(cleanPrintable(real).text, real);
  assert.deepEqual(cleanPrintable(real).removed, []);
});

test('curly quotes and odd dashes are normalised, not deleted', () => {
  assert.equal(cleanPrintable('12 ST JOHN’S ROAD').text, "12 ST JOHN'S ROAD");
  assert.equal(cleanPrintable('12 CLUB STREET – REAR').text, '12 CLUB STREET - REAR');
});

test('a clean address reports nothing removed, so the flag stays meaningful', () => {
  const out = cleanPrintable('91 CIRCULAR ROAD SINGAPORE 049442');
  assert.equal(out.text, '91 CIRCULAR ROAD SINGAPORE 049442');
  assert.deepEqual(out.removed, []);
  assert.equal(parseAddress('91 CIRCULAR ROAD SINGAPORE 049442').scrubbed, undefined);
});

/** ------------------------------------------------------- through the pipeline ---- */

const sourceRow = (over: Partial<SourceRow> = {}): SourceRow =>
  ({
    sourceRow: 2,
    addressId: 'A1',
    address: '91 CIRCULAR ROAD SINGAPORE 049442',
    target: 'Yes',
    neighbourhood: 'Boat Quay',
    landUse: 'Shophouse',
    tenure: 'Freehold',
    owners: [{ slot: 1, name: 'ACME PTE LTD', address: '12 ANN SIANG ROAD SINGAPORE 069692' }],
    ...over,
  }) as unknown as SourceRow;

test('a trademark in an owner name is scrubbed and flagged, not printed', () => {
  const result = runPipeline(
    [
      sourceRow({
        owners: [
          { slot: 1, name: 'SOMEWHERE™ PTE LTD', address: '12 ANN SIANG ROAD SINGAPORE 069692' },
        ],
      }),
    ],
    defaultOptions('postcard', { outreachFilter: { mode: 'all', alwaysExcludeOptOut: false } }),
  );

  assert.equal(result.postcardRows.length, 1);
  assert.equal(result.postcardRows[0]['Owner Name'], 'SOMEWHERE PTE LTD');
  const flag = result.flags.find((f) => /Owner name contained characters/.test(f.flag));
  assert.ok(flag, 'the change must be flagged, not applied silently');
  assert.match(flag!.detail ?? '', /trademark/);
});

test('a trademark in a mailing address is scrubbed and flagged', () => {
  const result = runPipeline(
    [
      sourceRow({
        owners: [
          { slot: 1, name: 'ACME PTE LTD', address: 'ANN SIANG® HOUSE, 12 ANN SIANG ROAD SINGAPORE 069692' },
        ],
      }),
    ],
    defaultOptions('postcard', { outreachFilter: { mode: 'all', alwaysExcludeOptOut: false } }),
  );

  assert.equal(
    result.postcardRows[0]['Owner Address'],
    'ANN SIANG HOUSE, 12 ANN SIANG ROAD SINGAPORE 069692',
  );
  assert.ok(result.flags.some((f) => /Mailing address contained characters/.test(f.flag)));
});

test('two owners differing only by junk merge into one recipient', () => {
  // This is the cost of not scrubbing: the mailing address is a dedupe key, so an
  // invisible character in one copy sends the same owner two postcards.
  const result = runPipeline(
    [
      sourceRow({ sourceRow: 2, addressId: 'A1' }),
      sourceRow({
        sourceRow: 3,
        addressId: 'A1',
        owners: [
          { slot: 1, name: 'ACME PTE LTD', address: '12 ANN SIANG ROAD​ SINGAPORE 069692' },
        ],
      }),
    ],
    defaultOptions('postcard', { outreachFilter: { mode: 'all', alwaysExcludeOptOut: false } }),
  );
  assert.equal(result.postcardRows.length, 1, 'the invisible character must not split the owner');
});

test('a clean row produces no scrub flags at all', () => {
  const result = runPipeline(
    [sourceRow()],
    defaultOptions('postcard', { outreachFilter: { mode: 'all', alwaysExcludeOptOut: false } }),
  );
  assert.equal(
    result.flags.filter((f) => /contained characters that cannot be printed/.test(f.flag)).length,
    0,
  );
});

/** ------------------------------------------- corrected addresses off the sheet ---- */

test('a typed Corrected Address is read off the deliverable sheet', () => {
  const headers = [
    'Owner Name',
    'Owner Address',
    'BizFile Verdict',
    'BizFile Registered Address',
    'Corrected Address',
  ];
  const rows = [
    ['ACME PTE LTD', '1 OLD ROAD SINGAPORE 111111', 'mismatch', 'NEW ROAD SINGAPORE 222222',
      '12 NEW ROAD #04-01 SINGAPORE 222222'],
    // Verified fine, nothing typed — must not become an override.
    ['BETA PTE LTD', '2 GOOD ROAD SINGAPORE 333333', 'match', '2 GOOD ROAD SINGAPORE 333333', ''],
  ];
  assert.deepEqual(parseCorrectedAddresses(headers, rows), [
    { ownerName: 'ACME PTE LTD', address: '12 NEW ROAD #04-01 SINGAPORE 222222' },
  ]);
});

test('the lawyer-letter column names work too', () => {
  const found = parseCorrectedAddresses(
    ['Registered_Proprietor', 'Registered_Proprietor_mailing_address', 'Corrected Address'],
    [['ACME PTE LTD', '1 OLD ROAD SINGAPORE 111111', '12 NEW ROAD SINGAPORE 222222']],
  );
  assert.deepEqual(found, [
    { ownerName: 'ACME PTE LTD', address: '12 NEW ROAD SINGAPORE 222222' },
  ]);
});

test('a sheet with no Corrected Address column yields nothing, not a guess', () => {
  assert.deepEqual(
    parseCorrectedAddresses(['Owner Name', 'Owner Address'], [['ACME PTE LTD', '1 OLD ROAD']]),
    [],
  );
});
