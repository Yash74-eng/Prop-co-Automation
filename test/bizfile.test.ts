/**
 * Tests for the BizFile record extraction and address verdicts.
 *
 * The extractor is regex-over-rendered-text (see src/bizfile/selenium.ts for why), so
 * these cases pin the behaviour that matters: pull the fields when they are there,
 * return undefined rather than a half-record when they are not, and never turn a
 * blocked/empty page into something that looks like a real lookup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecord } from '../src/bizfile/selenium.js';
import { coverageRows, verifyAddress } from '../src/bizfile/resolver.js';
import type { BizFileVerification, BizFileVerdict } from '../src/bizfile/types.js';

const RESULT_CARD = [
  'ACME HOLDINGS PTE. LTD.',
  'UEN: 201234567M',
  'Entity Status: LIVE COMPANY',
  'Registered Office Address: 12 ANN SIANG ROAD SINGAPORE 069692',
].join('\n');

test('extracts name, UEN, status and address from a result card', () => {
  const rec = extractRecord('ACME HOLDINGS PTE LTD', RESULT_CARD);
  assert.ok(rec);
  assert.equal(rec.uen, '201234567M');
  assert.match(rec.status ?? '', /LIVE/i);
  assert.match(rec.registeredAddress ?? '', /ANN SIANG ROAD/i);
  assert.match(rec.registeredAddress ?? '', /069692/);
  assert.equal(rec.source, 'bizfile-scrape');
});

test('the empty-results placeholder yields no record', () => {
  const empty = 'No matching results found\nCheck your search for typos or try another keyword';
  assert.equal(extractRecord('ACME HOLDINGS PTE LTD', empty), undefined);
});

test('a CloudFront block page yields no record', () => {
  const blocked = '403 ERROR\nThe request could not be satisfied.\nRequest blocked.';
  assert.equal(extractRecord('ACME HOLDINGS PTE LTD', blocked), undefined);
});

test('filter chrome alone is not mistaken for a record', () => {
  const chrome = 'Filters\nKeyword match type\nName containing\nIssuance agency\nApply filters';
  assert.equal(extractRecord('ACME HOLDINGS PTE LTD', chrome), undefined);
});

test('falls back to the queried name when no name line is recoverable', () => {
  const rec = extractRecord('ACME HOLDINGS PTE LTD', 'UEN: 201234567M');
  assert.ok(rec);
  assert.equal(rec.name, 'UEN: 201234567M');
  assert.equal(rec.uen, '201234567M');
});

test('a missing record verifies as not-found, never as a match', () => {
  const v = verifyAddress(
    {
      ownerName: 'ACME HOLDINGS PTE LTD',
      mailingAddresses: ['12 ANN SIANG ROAD SINGAPORE 069692'],
      propertyAddresses: [],
    },
    undefined,
  );
  assert.equal(v.verdict, 'not-found');
});

test('same postal code with a different unit is the same building', () => {
  const v = verifyAddress(
    {
      ownerName: 'ACME HOLDINGS PTE LTD',
      mailingAddresses: ['12 ANN SIANG ROAD #03-01 SINGAPORE 069692'],
      propertyAddresses: [],
    },
    extractRecord('ACME HOLDINGS PTE LTD', RESULT_CARD),
  );
  assert.equal(v.verdict, 'match-building');
});

test('a struck-off entity is flagged do-not-send regardless of address', () => {
  const struck = RESULT_CARD.replace('LIVE COMPANY', 'STRUCK OFF');
  const v = verifyAddress(
    {
      ownerName: 'ACME HOLDINGS PTE LTD',
      mailingAddresses: ['12 ANN SIANG ROAD SINGAPORE 069692'],
      propertyAddresses: [],
    },
    extractRecord('ACME HOLDINGS PTE LTD', struck),
  );
  assert.equal(v.verdict, 'entity-inactive');
});

/** ---------------------------------------------------- coverage sheet ---- */

const verification = (verdict: BizFileVerdict): BizFileVerification => ({
  ownerName: 'X PTE LTD',
  mailingAddressInSheet: '',
  propertyAddresses: '',
  verdict,
  detail: '',
});

const cell = (rows: unknown[][], measure: string) =>
  rows.find((r) => String(r[0] ?? '').startsWith(measure));

test('coverage separates the queue from the sample actually verified', () => {
  const items = [
    ...Array(20).fill(null).map(() => verification('match-building')),
    ...Array(16).fill(null).map(() => verification('mismatch')),
    ...Array(3).fill(null).map(() => verification('lookup-failed')),
    verification('entity-inactive'),
  ];
  const rows = coverageRows(items, {
    resolver: 'ACRA open data (data.gov.sg)',
    runAt: new Date('2026-08-14T10:30:00'),
    queueTotal: 379,
  });

  // The queue line reports the queue, not the sample — the earlier version claimed 100%
  // of 379 while only 40 had been checked.
  const queue = cell(rows, 'Corporate owners in the queue');
  assert.equal(queue?.[1], 379);
  assert.match(String(queue?.[2]), /10\.6% verified/);

  const verified = cell(rows, 'Owners verified in this run');
  assert.equal(verified?.[1], 40);
  assert.match(String(verified?.[3]), /capped sample/i);
});

test('coverage counts a failed lookup separately from no record found', () => {
  const items = [
    verification('match'),
    verification('not-found'),
    verification('lookup-failed'),
    verification('lookup-failed'),
  ];
  const rows = coverageRows(items, { resolver: 'test', runAt: new Date() });

  assert.equal(cell(rows, 'No ACRA record found')?.[1], 1);
  assert.equal(cell(rows, 'Could not be checked')?.[1], 2);
  assert.match(String(cell(rows, 'Could not be checked')?.[3]), /NOT a statement about ACRA/);
});

test('coverage reports the run time as readable text, not an Excel serial', () => {
  const rows = coverageRows([verification('match')], {
    resolver: 'test',
    runAt: new Date('2026-08-14T09:05:00'),
  });
  const runAt = cell(rows, 'Run at');
  assert.equal(typeof runAt?.[1], 'string');
  assert.match(String(runAt?.[1]), /14 Aug 2026 09:05/);
});

test('coverage survives an empty verification list without dividing by zero', () => {
  const rows = coverageRows([], { resolver: 'test', runAt: new Date(), queueTotal: 0 });
  assert.ok(rows.length > 0);
  assert.equal(cell(rows, 'Owners verified in this run')?.[1], 0);
});

test('a different postal code is a mismatch, not a match', () => {
  const v = verifyAddress(
    {
      ownerName: 'ACME HOLDINGS PTE LTD',
      mailingAddresses: ['99 NEIL ROAD SINGAPORE 088888'],
      propertyAddresses: [],
    },
    extractRecord('ACME HOLDINGS PTE LTD', RESULT_CARD),
  );
  assert.equal(v.verdict, 'mismatch');
});
