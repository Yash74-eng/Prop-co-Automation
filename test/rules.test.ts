/**
 * Unit tests for the dedupe and cleaning rules, using the exact examples from the
 * outreach spec plus the edge cases found in the real tracker.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeAddresses,
  mergeHouseNumbers,
  mergePostalCodes,
  parseAddress,
  isStrataPlaceholder,
  looksOverseas,
  mailingAddressKey,
} from '../src/core/address.js';
import {
  classifyName,
  collapseToOwnersOf,
  distinctOwnerNames,
  isCorporateName,
  isStrataPlaceholderName,
  joinOwnerNames,
  looksLikeMultipleNames,
  parseOwnerCountPrefix,
  splitCoOwners,
  stripAlias,
} from '../src/core/names.js';
import { benchmarkKey, compsLandUse, compsNeighbourhood, normaliseTenure } from '../src/core/vocab.js';
import { findInstitutionsSheetName, parseInstitutionsSheet } from '../src/core/config.js';
import { classifyOutreach } from '../src/core/mainDatabase.js';
import { buildOwnerNoColumn, dedupe } from '../src/core/dedupe.js';
import { CompsIndex, lookupComps } from '../src/core/comps.js';
import { addDays, formatDate, parseLooseDate } from '../src/core/text.js';
import type { OwnerRow } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

test('parses a conservation-area address into number, street and postal', () => {
  const a = parseAddress('91 CIRCULAR ROAD BOAT QUAY CONSERVATION AREA SINGAPORE 049442');
  assert.deepEqual(a.numbers, ['91']);
  assert.equal(a.street, 'CIRCULAR ROAD');
  assert.equal(a.conservationArea, 'BOAT QUAY');
  assert.equal(a.postal, '049442');
  assert.equal(a.unparsed, false);
});

test('parses an address where the street repeats the conservation area name', () => {
  const a = parseAddress('155 TELOK AYER STREET TELOK AYER CONSERVATION AREA SINGAPORE 068611');
  assert.equal(a.street, 'TELOK AYER STREET');
  assert.equal(a.conservationArea, 'TELOK AYER');
});

test('parses a Malay street name with no street-type token', () => {
  const a = parseAddress('133 JALAN BESAR LITTLE INDIA CONSERVATION AREA SINGAPORE 208851');
  assert.equal(a.street, 'JALAN BESAR');
  assert.equal(a.conservationArea, 'LITTLE INDIA');
});

test('parses a slash-named conservation area', () => {
  const a = parseAddress('255 JALAN BESAR PETAIN ROAD/TYRWHITT ROAD CONSERVATION AREA SINGAPORE 208928');
  assert.equal(a.street, 'JALAN BESAR');
  assert.equal(a.conservationArea, 'PETAIN ROAD/TYRWHITT ROAD');
});

test('parses multiple house numbers and letter suffixes', () => {
  assert.deepEqual(parseAddress('72, 74 DESKER ROAD SINGAPORE 209604').numbers, ['72', '74']);
  assert.deepEqual(parseAddress('27A TEO HONG ROAD SINGAPORE 088334').numbers, ['27A']);
});

test('parses an address with no conservation area', () => {
  const a = parseAddress('612 SERANGOON ROAD SINGAPORE 218217');
  assert.equal(a.street, 'SERANGOON ROAD');
  assert.equal(a.conservationArea, undefined);
  assert.equal(a.postal, '218217');
});

// ---------------------------------------------------------------------------
// Postal / house number merge rules (spec examples verbatim)
// ---------------------------------------------------------------------------

test('spec: postal codes on one street collapse to first-full + last-two', () => {
  assert.equal(mergePostalCodes(['111100', '111101', '111102']), '111100 / 01 / 02');
});

test('spec: 069413 + 069414 collapses to "069413 / 14"', () => {
  assert.equal(mergePostalCodes(['069413', '069414']), '069413 / 14');
});

test('identical postal codes collapse to one', () => {
  assert.equal(mergePostalCodes(['088335', '088335']), '088335');
});

test('postal codes with different prefixes are kept in full', () => {
  assert.equal(mergePostalCodes(['199799', '189265']), '189265 / 199799');
});

test('house numbers merge with " / " in natural order', () => {
  assert.equal(mergeHouseNumbers(['29', '27']), '27 / 29');
  assert.equal(mergeHouseNumbers(['10', '2']), '2 / 10');
  assert.equal(mergeHouseNumbers(['29B', '29A']), '29A / 29B');
});

test('spec: same street merges numbers and postal codes', () => {
  const merged = mergeAddresses([
    parseAddress('27 CLUB STREET SINGAPORE 069413'),
    parseAddress('29 CLUB STREET SINGAPORE 069414'),
  ]);
  assert.equal(merged.address, '27 / 29 CLUB STREET');
  assert.equal(merged.fullAddress, '27 / 29 CLUB STREET SINGAPORE 069413 / 14');
  assert.equal(merged.multiStreet, false);
});

test('spec: different streets are joined with "; "', () => {
  const merged = mergeAddresses([
    parseAddress('103 ARAB STREET SINGAPORE 199799'),
    parseAddress('72 HAJI LANE SINGAPORE 189265'),
  ]);
  assert.equal(
    merged.fullAddress,
    '103 ARAB STREET SINGAPORE 199799; 72 HAJI LANE SINGAPORE 189265',
  );
  assert.equal(merged.multiStreet, true);
});

test('conservation-area text is stripped from the merged address', () => {
  const merged = mergeAddresses([
    parseAddress('28 DICKSON ROAD LITTLE INDIA CONSERVATION AREA SINGAPORE 209511'),
    parseAddress('30 DICKSON ROAD LITTLE INDIA CONSERVATION AREA SINGAPORE 209512'),
  ]);
  assert.equal(merged.fullAddress, '28 / 30 DICKSON ROAD SINGAPORE 209511 / 12');
  assert.ok(!merged.fullAddress.includes('CONSERVATION'));
});

// ---------------------------------------------------------------------------
// Owner mailing addresses
// ---------------------------------------------------------------------------

test('strata placeholder mailing addresses are detected', () => {
  assert.equal(
    isStrataPlaceholder(
      'The addresses of the registered proprietors of the strata\nlots as shown on the subsidiary certificates of title issued',
    ),
    true,
  );
  assert.equal(isStrataPlaceholder('53 PAYA LEBAR CRESCENT SINGAPORE 536126'), false);
});

test('addresses with no Singapore postal code are flagged as overseas', () => {
  assert.equal(looksOverseas('8 MARKET STREET KUALA LUMPUR'), true);
  assert.equal(looksOverseas('53 PAYA LEBAR CRESCENT SINGAPORE 536126'), false);
});

test('mailing address keys ignore formatting differences', () => {
  assert.equal(
    mailingAddressKey('3 TEMASEK AVENUE #33-02, SINGAPORE 039190'),
    mailingAddressKey('3 Temasek Avenue #33-02 Singapore 039190'),
  );
});

// ---------------------------------------------------------------------------
// Owner names
// ---------------------------------------------------------------------------

test('spec: bracketed alias is removed from a personal name', () => {
  assert.equal(stripAlias('ANNIE TAN SWEE LAN (ANNIE CHEN RUILAN)').cleaned, 'ANNIE TAN SWEE LAN');
  assert.equal(stripAlias('LIM SEOW PENG (LIN XIAOPING)').cleaned, 'LIM SEOW PENG');
});

test('newline "Alias :" form is removed', () => {
  const r = stripAlias('CHOW TZE TIEN\nAlias :CHEW AH KEW');
  assert.equal(r.cleaned, 'CHOW TZE TIEN');
  assert.equal(r.alias, 'CHEW AH KEW');
});

test('company brackets are NOT treated as aliases', () => {
  assert.equal(stripAlias('KWANG JOO (PRIVATE) LIMITED').cleaned, 'KWANG JOO (PRIVATE) LIMITED');
  assert.equal(stripAlias('CANDID ELECTRIC (S) PTE. LTD.').cleaned, 'CANDID ELECTRIC (S) PTE. LTD.');
  assert.equal(stripAlias('M & A (02) PTE. LTD.').cleaned, 'M & A (02) PTE. LTD.');
});

test('corporate detection', () => {
  assert.equal(isCorporateName('EWIS DEVELOPMENT PTE LTD'), true);
  assert.equal(isCorporateName('NANYANG REALTY (PRIVATE) LIMITED'), true);
  assert.equal(isCorporateName('MALAYAN BANKING BERHAD'), true);
  assert.equal(isCorporateName('LOKE WAN THO'), false);
  assert.equal(isCorporateName('GOH ENG SIE'), false);
});

test('spec: co-owners at the same address join with "&"', () => {
  assert.equal(joinOwnerNames(['JANE XIA', 'LONG GAN']), 'JANE XIA & LONG GAN');
});

test('a cell that already contains "&" does not duplicate when merged', () => {
  // The tracker holds the same couple both ways; joining must not produce
  // "GOH ENG SIE & ONG SEW LAN & GOH ENG SIE & ONG SEW LAN".
  assert.equal(
    joinOwnerNames(['GOH ENG SIE & ONG SEW LAN', 'GOH ENG SIE', 'ONG SEW LAN']),
    'GOH ENG SIE & ONG SEW LAN',
  );
});

test('company ampersands are never split', () => {
  assert.deepEqual(splitCoOwners('SMITH & SONS REALTY (PRIVATE) LIMITED'), [
    'SMITH & SONS REALTY (PRIVATE) LIMITED',
  ]);
  assert.deepEqual(splitCoOwners('M & A (02) PTE. LTD.'), ['M & A (02) PTE. LTD.']);
});

test('owner names dedupe case-insensitively', () => {
  assert.deepEqual(distinctOwnerNames(['GOH ENG SIE', 'Goh Eng Sie']), ['GOH ENG SIE']);
});

test('commas in personal names are not treated as separate owners', () => {
  assert.equal(looksLikeMultipleNames('WANG, SHIQI'), false);
  assert.equal(looksLikeMultipleNames('TAN BOON SIANG, FRANCIS'), false);
  assert.equal(looksLikeMultipleNames('LIN, HUI-MING'), false);
});

test('genuine multi-name cells are flagged', () => {
  assert.equal(
    looksLikeMultipleNames(
      'SYED ABU BAKAR BIN ALI REDHA ALSAGOFF, AHMAD JAMAL ALSAGOFF, SYED MOHAMAD ANIS ALSAGOFF',
    ),
    true,
  );
  assert.equal(looksLikeMultipleNames('ONG SIN TIONG,\nONG SIN BENG'), true);
});

test('"Total N owners" prefix yields the owner count', () => {
  const a = parseOwnerCountPrefix('Total 18 owners: LIANG TEW NGOH, LIANG TIEW PENG');
  assert.equal(a.declaredCount, 18);
  assert.equal(a.rest, 'LIANG TEW NGOH, LIANG TIEW PENG');

  const b = parseOwnerCountPrefix('TOTAL 6 OWNERS; 5TH+ OWNERS: HOON KEE KIONG');
  assert.equal(b.declaredCount, 6);
  assert.equal(b.rest, 'HOON KEE KIONG');
});

test('strata placeholder owner names are detected', () => {
  assert.equal(
    isStrataPlaceholderName('ALL THE REGISTERED PROPRIETORS OF ALL THE STRATA LOTS COMPRISED IN THE LAND'),
    true,
  );
  // The tracker's own "SUBSIDARY" typo must match too.
  assert.equal(isStrataPlaceholderName('ALL SUBSIDARY PROPRIETORS OF ALL THE STRATA LOTS'), true);
  assert.equal(isStrataPlaceholderName('LOKE WAN THO'), false);
});

test('agencies and associations are marked for removal', () => {
  assert.ok(classifyName('MUSLIMIN TRUST FUND ASSOCIATION').agencyMatch);
  assert.ok(classifyName('THE NGEE ANN KONGSI').agencyMatch);
  assert.ok(classifyName('SINGAPORE HOKIEN HUAY KUAN').agencyMatch);
  assert.equal(classifyName('LOKE WAN THO').agencyMatch, undefined);
});

test('a person whose name contains a developer name is NOT removed', () => {
  // "TIONG SENG" is a developer, but "LEE TIONG SENG" is a person.
  assert.equal(classifyName('LEE TIONG SENG').developerMatch, undefined);
  assert.equal(classifyName('PEK TIONG SENG FOUNDATION').developerMatch, undefined);
  assert.ok(classifyName('TIONG SENG CONTRACTORS PTE LTD').developerMatch);
});

test('institutions to avoid are matched from the supplied list, and only flagged', () => {
  // The real list is confidential and lives outside this repository — it comes from the
  // uploaded workbook's own sheet or config/institutions-to-avoid.json at runtime. This
  // test exercises the matching, using placeholder entries.
  const institutions = [
    { name: 'EXAMPLE INSTITUTION LIMITED', status: 'Institution' },
    { name: 'EXAMPLE COMPETITOR PTE. LTD.', status: 'Competitor', remarks: 'why' },
  ];

  const a = classifyName('EXAMPLE INSTITUTION LIMITED', { institutions });
  assert.equal(a.institutionMatch?.status, 'Institution');
  // Flagging must never imply removal.
  assert.equal(a.agencyMatch, undefined);
  assert.equal(a.developerMatch, undefined);

  // Punctuation and casing differences still match.
  const b = classifyName('Example Competitor Pte Ltd', { institutions });
  assert.equal(b.institutionMatch?.status, 'Competitor');
  assert.equal(b.institutionMatch?.remarks, 'why');

  const c = classifyName('SOME OTHER COMPANY PTE LTD', { institutions });
  assert.equal(c.institutionMatch, undefined);
});

test('no institutions list means nothing is flagged as an institution', () => {
  assert.equal(classifyName('EXAMPLE INSTITUTION LIMITED').institutionMatch, undefined);
});

test('institutions parse out of an "Institutions to Avoid" sheet', () => {
  const parsed = parseInstitutionsSheet({
    sheetName: 'Institutions to Avoid',
    headers: ['Institutions', 'Status', 'Remarks'],
    rows: [
      ['EXAMPLE COMPETITOR PTE. LTD.', 'Competitor', 'placeholder note'],
      ['EXAMPLE INSTITUTION LIMITED', 'Institution', null],
      [null, null, null],
    ],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].status, 'Competitor');
  assert.equal(parsed[0].remarks, 'placeholder note');
  assert.equal(parsed[1].remarks, undefined);
});

test('a sheet with an institutions list is discovered by name', () => {
  // Real tracker sheets carry a maintainer suffix, e.g. "Institutions to Avoid (XX) ",
  // so discovery is by pattern rather than an exact title.
  assert.equal(
    findInstitutionsSheetName(['Main Database', 'Institutions to Avoid (XX) ', 'Lead Scoring']),
    'Institutions to Avoid (XX) ',
  );
  assert.equal(
    findInstitutionsSheetName(['Main Database', 'Institutions To Avoid']),
    'Institutions To Avoid',
  );
  assert.equal(findInstitutionsSheetName(['Main Database', 'Lead Scoring']), undefined);
});

test('spec: too many owners collapses to "Owners of ___"', () => {
  assert.equal(collapseToOwnersOf('27 / 29 CLUB STREET'), 'Owners of 27 / 29 CLUB STREET');
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test('tenure normalises to the comps vocabulary', () => {
  assert.equal(normaliseTenure('FH').comps, 'FH / 999 years');
  assert.equal(normaliseTenure('FH (with conditions)').comps, 'FH / 999 years');
  assert.equal(normaliseTenure('LEASEHOLD 999 Years (10/08/1831)').comps, 'FH / 999 years');
  assert.equal(normaliseTenure('LEASEHOLD 99 Years (22/09/1988)').comps, '99 years');
  assert.equal(normaliseTenure('999 FROM 1959').comps, 'FH / 999 years');
  assert.equal(normaliseTenure('').comps, undefined);
});

test('land use maps to the comps vocabulary', () => {
  assert.equal(compsLandUse('Full Commercial (Dark Blue)'), 'Fully Commercial');
  assert.equal(compsLandUse('Residential with Commercial at 1st storey (Red)'), 'Mixed Use');
  assert.equal(compsLandUse('Commercial and Residential (Light Blue)'), 'Mixed Use');
  assert.equal(compsLandUse('Commercial / Institution'), 'Commercial / Institution');
  assert.equal(compsLandUse('Residential / Institution'), 'Residential / Institution');
  assert.equal(compsLandUse('#N/A'), undefined);
});

test('neighbourhood maps to the comps vocabulary', () => {
  assert.equal(compsNeighbourhood("D1 - Raffles Place, Cecil, Marina, People's Park"), 'D1');
  assert.equal(compsNeighbourhood('D2 - Anson, Tanjong Pagar'), 'D2');
  assert.equal(compsNeighbourhood('Kampong glam'), 'Kampong Glam');
  assert.equal(compsNeighbourhood('Sims Avenue'), 'Geylang / Sims Avenue');
  // Deliberately unmapped — the comps "Serangoon" row is the Serangoon Road cluster.
  assert.equal(compsNeighbourhood('Upper Serangoon'), undefined);
  assert.equal(compsNeighbourhood('Macpherson'), undefined);
});

test('benchmark key matches the tracker formula', () => {
  assert.equal(
    benchmarkKey('Full Commercial (Dark Blue)', 'LEASEHOLD 999 Years (10/08/1831)', "D1 - Raffles Place, Cecil, Marina, People's Park"),
    "FC|FH|D1 - Raffles Place, Cecil, Marina, People's Park",
  );
  // The tracker rewrites "Jalan Besar" before looking up the psf table.
  assert.equal(
    benchmarkKey('Full Commercial (Dark Blue)', 'FH', 'Jalan Besar'),
    'FC|FH|Jalan Besar / Serangoon Road',
  );
});

// ---------------------------------------------------------------------------
// Outreach classification
// ---------------------------------------------------------------------------

test('outreach values classify correctly', () => {
  assert.equal(classifyOutreach(null).status, 'blank');
  assert.equal(classifyOutreach('').status, 'blank');
  assert.equal(classifyOutreach(new Date('2026-01-27')).status, 'sent-date');
  assert.equal(classifyOutreach('Batch 1 Target').status, 'batch-tag');
  assert.equal(classifyOutreach('11 Mar 2026 - delivery failed').status, 'delivery-failed');
  assert.equal(classifyOutreach('28 Jan 2026 - No such person').status, 'delivery-failed');
  assert.equal(classifyOutreach('Batch 1 Target - OPT OUT').status, 'opt-out');
  assert.equal(classifyOutreach('Do not send - rejected').status, 'opt-out');
  assert.equal(classifyOutreach('Do not send').status, 'do-not-send');
  assert.equal(classifyOutreach('28 Jan 2026 - 2').status, 'sent-date');
});

// ---------------------------------------------------------------------------
// Dedupe engine
// ---------------------------------------------------------------------------

function ownerRow(overrides: Partial<OwnerRow> & { address: string; owner: string; mail: string }): OwnerRow {
  const property = parseAddress(overrides.address);
  return {
    sourceRow: overrides.sourceRow ?? 2,
    ownerSlot: overrides.ownerSlot ?? 1,
    target: overrides.target ?? 'A/B',
    neighbourhood: overrides.neighbourhood ?? 'Little India',
    landUse: overrides.landUse ?? 'Full Commercial (Dark Blue)',
    tenure: overrides.tenure ?? 'FH',
    ownerName: overrides.owner,
    ownerNameRaw: overrides.owner,
    ownerAddress: overrides.mail,
    ownerAddressRaw: overrides.mail,
    property,
    isCorporate: isCorporateName(overrides.owner),
    declaredOwnerCount: overrides.declaredOwnerCount,
    notes: [],
  };
}

const DEDUPE_OPTIONS = {
  maxOwnersBeforeCollapse: 4,
  maxOwnerNameLength: 120,
  groupByOwnerName: false,
};

test('stage A: co-owners of one property at one mailing address become one recipient', () => {
  const { groups } = dedupe(
    [
      ownerRow({ address: '27 CLUB STREET SINGAPORE 069413', owner: 'JANE XIA', mail: '5 ORCHARD ROAD SINGAPORE 238888' }),
      ownerRow({ address: '27 CLUB STREET SINGAPORE 069413', owner: 'LONG GAN', mail: '5 ORCHARD ROAD SINGAPORE 238888', ownerSlot: 2 }),
    ],
    DEDUPE_OPTIONS,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].registeredProprietor, 'JANE XIA & LONG GAN');
});

test('spec: same property, different mailing addresses stay separate', () => {
  const { groups } = dedupe(
    [
      ownerRow({ address: '27 CLUB STREET SINGAPORE 069413', owner: 'OWNER A', mail: '1 A ROAD SINGAPORE 100001' }),
      ownerRow({ address: '27 CLUB STREET SINGAPORE 069413', owner: 'OWNER B', mail: '2 B ROAD SINGAPORE 200002', ownerSlot: 2 }),
    ],
    DEDUPE_OPTIONS,
  );
  assert.equal(groups.length, 2);
});

test('stage B: one owner\'s properties on one street merge into a single letter', () => {
  const { groups } = dedupe(
    [
      ownerRow({ address: '27 CLUB STREET SINGAPORE 069413', owner: 'JANE XIA', mail: '5 ORCHARD ROAD SINGAPORE 238888' }),
      ownerRow({ address: '29 CLUB STREET SINGAPORE 069414', owner: 'JANE XIA', mail: '5 ORCHARD ROAD SINGAPORE 238888', sourceRow: 3 }),
    ],
    DEDUPE_OPTIONS,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].fullAddress, '27 / 29 CLUB STREET SINGAPORE 069413 / 14');
});

test('spec: different Target keeps recipients separate even for the same owner', () => {
  const { groups } = dedupe(
    [
      ownerRow({ address: '27 CLUB STREET SINGAPORE 069413', owner: 'JANE XIA', mail: '5 ORCHARD ROAD SINGAPORE 238888', target: 'Target A' }),
      ownerRow({ address: '29 CLUB STREET SINGAPORE 069414', owner: 'JANE XIA', mail: '5 ORCHARD ROAD SINGAPORE 238888', target: 'Target B', sourceRow: 3 }),
    ],
    DEDUPE_OPTIONS,
  );
  assert.equal(groups.length, 2);
});

test('spec: different Neighbourhood keeps recipients separate even for the same owner', () => {
  const { groups } = dedupe(
    [
      ownerRow({ address: '27 CLUB STREET SINGAPORE 069413', owner: 'JANE XIA', mail: '5 ORCHARD ROAD SINGAPORE 238888', neighbourhood: 'Little India' }),
      ownerRow({ address: '29 CLUB STREET SINGAPORE 069414', owner: 'JANE XIA', mail: '5 ORCHARD ROAD SINGAPORE 238888', neighbourhood: 'Joo Chiat', sourceRow: 3 }),
    ],
    DEDUPE_OPTIONS,
  );
  assert.equal(groups.length, 2);
});

test('two different companies sharing a corporate-secretary address stay separate', () => {
  const mail = '63 CHULIA STREET #08-03/04 SINGAPORE 049514';
  const { groups } = dedupe(
    [
      ownerRow({ address: '27 CLUB STREET SINGAPORE 069413', owner: 'ALPHA HOLDINGS PTE LTD', mail }),
      ownerRow({ address: '90 AMOY STREET SINGAPORE 069909', owner: 'BETA HOLDINGS PTE LTD', mail, sourceRow: 3 }),
    ],
    DEDUPE_OPTIONS,
  );
  assert.equal(groups.length, 2, 'unrelated companies must not be merged onto one letter');
});

test('more than four owners collapses to "Owners of ___"', () => {
  const rows = ['A ONE', 'B TWO', 'C THREE', 'D FOUR', 'E FIVE'].map((owner, i) =>
    ownerRow({
      address: '27 CLUB STREET SINGAPORE 069413',
      owner,
      mail: '5 ORCHARD ROAD SINGAPORE 238888',
      ownerSlot: i + 1,
    }),
  );
  const { groups } = dedupe(rows, DEDUPE_OPTIONS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].registeredProprietor, 'Owners of 27 CLUB STREET');
});

test('a declared owner count above the limit also collapses', () => {
  const { groups } = dedupe(
    [
      ownerRow({
        address: '27 CLUB STREET SINGAPORE 069413',
        owner: 'LIANG TEW NGOH',
        mail: '5 ORCHARD ROAD SINGAPORE 238888',
        declaredOwnerCount: 18,
      }),
    ],
    DEDUPE_OPTIONS,
  );
  assert.equal(groups[0].registeredProprietor, 'Owners of 27 CLUB STREET');
});

// ---------------------------------------------------------------------------
// Owner No. column
// ---------------------------------------------------------------------------

test('Owner No. reports "unique" when nothing repeats', () => {
  const out = buildOwnerNoColumn([
    { registeredProprietor: 'JANE XIA', mailingAddress: '5 ORCHARD ROAD SINGAPORE 238888' },
  ]);
  assert.equal(out[0], 'unique, unique');
});

test('Owner No. counts a repeated name across rows', () => {
  const out = buildOwnerNoColumn([
    { registeredProprietor: 'JANE XIA', mailingAddress: '1 A ROAD SINGAPORE 100001' },
    { registeredProprietor: 'JANE XIA', mailingAddress: '2 B ROAD SINGAPORE 200002' },
  ]);
  assert.equal(out[0], 'JANE XIA (2), unique');
  assert.equal(out[1], 'JANE XIA (2), unique');
});

// ---------------------------------------------------------------------------
// Comps
// ---------------------------------------------------------------------------

const COMPS = new CompsIndex([
  {
    neighbourhood: 'D1',
    landUse: 'Fully Commercial',
    tenure: 'FH / 999 years',
    minimumPrice: 12_000_000,
    higherPrice: 14_000_000,
    compAddress1: '42 Club Street',
    comp1: 13_200_000,
    compAddress2: '176 Telok Ayer Street',
    comp2: 14_800_000,
  },
]);

test('comps lookup translates the Main Database vocabulary', () => {
  const r = lookupComps(
    COMPS,
    {
      neighbourhood: "D1 - Raffles Place, Cecil, Marina, People's Park",
      landUse: 'Full Commercial (Dark Blue)',
      tenure: 'LEASEHOLD 999 Years (10/08/1831)',
    },
    { deriveMissingPrices: false, derivedHigherMultiplier: 1.125, derivedRounding: 250_000 },
  );
  assert.equal(r.source, 'comps-benchmark');
  assert.equal(r.minimumPrice, 12_000_000);
  assert.equal(r.record?.compAddress1, '42 Club Street');
});

test('prices are derived from GFA x psf when no comps row matches', () => {
  const r = lookupComps(
    COMPS,
    { neighbourhood: 'Macpherson', landUse: 'Full Commercial (Dark Blue)', tenure: 'FH', gfaSqft: 2000, benchmarkPsf: 2000 },
    { deriveMissingPrices: true, derivedHigherMultiplier: 1.125, derivedRounding: 250_000 },
  );
  assert.equal(r.source, 'derived-from-psf');
  assert.equal(r.minimumPrice, 4_000_000);
  assert.equal(r.higherPrice, 4_500_000);
  assert.ok(r.notes.some((n) => n.includes('VERIFY BEFORE SENDING')));
});

test('no price at all when derivation is off and nothing matches', () => {
  const r = lookupComps(
    COMPS,
    { neighbourhood: 'Macpherson', landUse: 'Full Commercial (Dark Blue)', tenure: 'FH' },
    { deriveMissingPrices: false, derivedHigherMultiplier: 1.125, derivedRounding: 250_000 },
  );
  assert.equal(r.source, 'none');
  assert.equal(r.minimumPrice, undefined);
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('Valid_Date is Mail_Date + 14 days', () => {
  const mail = new Date(Date.UTC(2026, 7, 20));
  assert.equal(formatDate(addDays(mail, 14)), '03 Sep 2026');
});

test('loose date parsing handles the tracker formats', () => {
  assert.equal(formatDate(parseLooseDate('27 Jun 2025')), '27 Jun 2025');
  assert.equal(formatDate(parseLooseDate('2025-06-26T15:59:35.000Z')), '26 Jun 2025');
  assert.equal(formatDate(parseLooseDate('11 Mar 2026 - delivery failed')), '11 Mar 2026');
  assert.equal(parseLooseDate('Batch 1 Target'), undefined);
});
