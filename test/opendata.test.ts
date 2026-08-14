/**
 * Tests for the ACRA open-data resolver's pure parts.
 *
 * No network here — name-variant generation, row shaping and status classification are
 * where the real bugs live. The one that mattered in practice: ACRA writes "Deregistered",
 * which the original inactive-status pattern did not catch, so a dead entity read as
 * mailable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameVariants, toRecord, isInactiveStatus } from '../src/bizfile/opendata.js';
import { verifyAddress } from '../src/bizfile/resolver.js';

test('an unpunctuated sheet name also tries the punctuated ACRA spelling', () => {
  const v = nameVariants('CHIN HING PROPERTIES PTE LTD');
  assert.ok(v.includes('CHIN HING PROPERTIES PTE LTD'));
  assert.ok(v.includes('CHIN HING PROPERTIES PTE. LTD.'));
});

test('a punctuated sheet name also tries the bare spelling', () => {
  const v = nameVariants('SANE ASIA PTE. LTD.');
  assert.ok(v.includes('SANE ASIA PTE. LTD.'));
  assert.ok(v.includes('SANE ASIA PTE LTD'));
});

test('bracketed forms are preserved rather than mangled', () => {
  const v = nameVariants('KENSON ENTERPRISE (PTE) LTD');
  assert.ok(v.includes('KENSON ENTERPRISE (PTE) LTD'));
});

test('variants are unique and never blank', () => {
  const v = nameVariants('  acme   holdings pte ltd  ');
  assert.equal(new Set(v).size, v.length);
  assert.ok(v.every((n) => n.length > 0));
  assert.ok(v.every((n) => n === n.toUpperCase()));
});

test('an empty name yields no variants to look up', () => {
  assert.deepEqual(nameVariants('   '), []);
});

test('ACRA statuses that mean inactive are all recognised', () => {
  for (const s of ['Deregistered', 'Struck Off', 'Dissolved', 'Cancelled', 'Expired']) {
    assert.equal(isInactiveStatus(s), true, `${s} should be inactive`);
  }
  assert.equal(isInactiveStatus('Registered'), false);
  assert.equal(isInactiveStatus('Live Company'), false);
  assert.equal(isInactiveStatus(undefined), false);
});

test('a row is shaped so the postal code is findable in the address', () => {
  const rec = toRecord(
    {
      uen: '198305986H',
      entity_name: 'CHIN HING PROPERTIES PTE LTD',
      uen_status_desc: 'Registered',
      reg_street_name: 'NORTH BRIDGE ROAD',
      reg_postal_code: '198778',
    },
    'CHIN HING PROPERTIES PTE LTD',
  );
  assert.ok(rec);
  assert.equal(rec.source, 'acra-opendata');
  assert.match(rec.registeredAddress ?? '', /NORTH BRIDGE ROAD/);
  assert.match(rec.registeredAddress ?? '', /\b198778\b/);
});

test('a missing row shapes to undefined, not an empty record', () => {
  assert.equal(toRecord(undefined, 'ANYTHING PTE LTD'), undefined);
});

test('a deregistered entity is flagged do-not-send even when the postal code agrees', () => {
  const rec = toRecord(
    {
      uen: '195700059H',
      entity_name: 'LUCKY DEVELOPMENT PRIVATE LIMITED',
      uen_status_desc: 'Deregistered',
      reg_street_name: 'PHILLIP STREET',
      reg_postal_code: '048695',
    },
    'LUCKY DEVELOPMENT PRIVATE LIMITED',
  );
  const v = verifyAddress(
    {
      ownerName: 'LUCKY DEVELOPMENT PRIVATE LIMITED',
      mailingAddresses: ['10 PHILLIP STREET #05-01 SINGAPORE 048695'],
      propertyAddresses: [],
    },
    rec,
  );
  assert.equal(v.verdict, 'entity-inactive');
});

test('street-and-postal-only data still yields match-building, not mismatch', () => {
  const rec = toRecord(
    {
      uen: '201610515D',
      entity_name: 'SANE ASIA PTE. LTD.',
      uen_status_desc: 'Registered',
      reg_street_name: 'LORONG 4 GEYLANG',
      reg_postal_code: '399295',
    },
    'SANE ASIA PTE. LTD.',
  );
  const v = verifyAddress(
    {
      ownerName: 'SANE ASIA PTE. LTD.',
      mailingAddresses: ['253 LORONG 4 GEYLANG #08-13 SINGAPORE 399295'],
      propertyAddresses: [],
    },
    rec,
  );
  assert.equal(v.verdict, 'match-building');
});
