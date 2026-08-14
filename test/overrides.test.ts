/**
 * Address overrides feed in before dedupe, which is the whole point: merging keys on the
 * mailing address, so a correction applied to the finished sheet would leave the groups
 * wrong. These tests pin that the correction changes grouping, not just the printed cell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultOptions, runPipeline } from '../src/core/pipeline.js';
import { normKey } from '../src/core/text.js';
import type { SourceRow } from '../src/core/types.js';

function row(over: Partial<SourceRow>): SourceRow {
  return {
    sourceRow: 2,
    address: '91 CIRCULAR ROAD SINGAPORE 049442',
    postalCode: '049442',
    target: 'Yes',
    neighbourhood: 'Boat Quay',
    landUse: 'Shophouse',
    tenure: 'Freehold',
    owners: [],
    ...over,
  } as SourceRow;
}

const OPTS = () =>
  defaultOptions('postcard', {
    mailDate: new Date('2026-09-01T00:00:00Z'),
    includeAuditSheets: false,
    removeAgenciesAndDevelopers: false,
  });

test('with no overrides the sheet address is used unchanged', () => {
  const result = runPipeline(
    [
      row({
        owners: [{ slot: 1, name: 'ACME HOLDINGS PTE. LTD.', address: '12 ANN SIANG ROAD SINGAPORE 069692' }],
      }),
    ],
    OPTS(),
    {},
  );
  assert.equal(result.postcardRows.length, 1);
  assert.match(String(result.postcardRows[0]['Owner Address']), /ANN SIANG/);
  assert.equal((result.appliedAddressOverrides ?? []).length, 0);
});

test('a corrected address replaces the sheet address and is recorded', () => {
  const options = OPTS();
  options.ownerAddressOverrides = {
    [normKey('ACME HOLDINGS PTE. LTD.')]: {
      address: '5 NEIL ROAD SINGAPORE 088808',
      source: 'BizFile verification (mismatch)',
      ownerName: 'ACME HOLDINGS PTE. LTD.',
    },
  };

  const result = runPipeline(
    [
      row({
        owners: [{ slot: 1, name: 'ACME HOLDINGS PTE. LTD.', address: '12 ANN SIANG ROAD SINGAPORE 069692' }],
      }),
    ],
    options,
    {},
  );

  assert.match(String(result.postcardRows[0]['Owner Address']), /NEIL ROAD/);
  const applied = result.appliedAddressOverrides ?? [];
  assert.equal(applied.length, 1);
  assert.match(applied[0].previousAddress, /ANN SIANG/);
  assert.match(applied[0].newAddress, /NEIL ROAD/);
  assert.match(applied[0].source, /BizFile/);
});

test('an override matching the existing address changes nothing and is not logged', () => {
  const options = OPTS();
  options.ownerAddressOverrides = {
    [normKey('ACME HOLDINGS PTE. LTD.')]: {
      address: '12 ANN SIANG ROAD SINGAPORE 069692',
      source: 'upload',
      ownerName: 'ACME HOLDINGS PTE. LTD.',
    },
  };
  const result = runPipeline(
    [
      row({
        owners: [{ slot: 1, name: 'ACME HOLDINGS PTE. LTD.', address: '12 ANN SIANG ROAD SINGAPORE 069692' }],
      }),
    ],
    options,
    {},
  );
  assert.equal((result.appliedAddressOverrides ?? []).length, 0);
});

test('correcting an address re-groups recipients, not just the printed cell', () => {
  // Two properties, same owner, addresses that do not match — so they start apart.
  const rows = [
    row({
      sourceRow: 2,
      address: '91 CIRCULAR ROAD SINGAPORE 049442',
      postalCode: '049442',
      owners: [{ slot: 1, name: 'ACME HOLDINGS PTE. LTD.', address: '12 ANN SIANG ROAD SINGAPORE 069692' }],
    }),
    row({
      sourceRow: 3,
      address: '93 CIRCULAR ROAD SINGAPORE 049443',
      postalCode: '049443',
      owners: [{ slot: 1, name: 'ACME HOLDINGS PTE. LTD.', address: '99 WRONG ROAD SINGAPORE 111111' }],
    }),
  ];

  const before = runPipeline(rows, OPTS(), {});

  const options = OPTS();
  options.ownerAddressOverrides = {
    [normKey('ACME HOLDINGS PTE. LTD.')]: {
      address: '12 ANN SIANG ROAD SINGAPORE 069692',
      source: 'BizFile verification (mismatch)',
      ownerName: 'ACME HOLDINGS PTE. LTD.',
    },
  };
  const after = runPipeline(rows, options, {});

  // Both rows now share one owner at one address, so they merge into a single recipient.
  assert.ok(
    after.postcardRows.length < before.postcardRows.length,
    `expected fewer recipients after correction, got ${before.postcardRows.length} -> ${after.postcardRows.length}`,
  );
  assert.equal(after.postcardRows.length, 1);
  assert.equal((after.appliedAddressOverrides ?? []).length, 1);
});
