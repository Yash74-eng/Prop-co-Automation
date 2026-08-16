/**
 * Exercise the cross-check prompt against rows that MUST NOT be flagged (corporate
 * owners, co-owners joined with "&", collapsed merges) and rows that MUST be flagged
 * (broken addresses, institutions, inverted prices).
 *
 * False positives are the failure mode that matters here: a reviewer who sees noise
 * stops reading the sheet.
 */
import { crossCheck } from '../src/verify/claude.js';

const base = {
  Comments: '',
  'Owner No.': '',
  Target: 'Yes',
  Address: '',
  Neighbourhood: 'Boat Quay',
  'Land Use': 'Shophouse',
  Mail_Date: new Date('2026-09-01'),
  Valid_Date: new Date('2026-09-15'),
  'Duplicate Owner / Owner Addresses': 'unique',
  minimum_Price: 11000000,
  higher_Price: 12500000,
  Comp_Address_1: '88 CIRCULAR ROAD',
  Comp_1: 10800000,
  Comp_1_Date: new Date('2026-02-14'),
  Comp_Address_2: '92 CIRCULAR ROAD',
  Comp_2: 11400000,
  Comp_2_Date: new Date('2025-11-30'),
  Status: '',
  'Date Responded': '',
};

// row numbers are index+2 in the record builder
const CLEAN = [
  // 2 — plain corporate owner
  { ...base, Full_Address: '91 CIRCULAR ROAD SINGAPORE 049442',
    Registered_Proprietor: 'SANE ASIA PTE. LTD.',
    Registered_Proprietor_mailing_address: '253 LORONG 4 GEYLANG #08-13 SINGAPORE 399295' },
  // 3 — co-owners joined with &
  { ...base, Full_Address: '20 UPPER CROSS STREET SINGAPORE 058329',
    Registered_Proprietor: 'TAN AH KOW & LIM BEE HOON',
    Registered_Proprietor_mailing_address: '5 NEIL ROAD SINGAPORE 088808' },
  // 4 — merged house numbers + collapsed postal codes
  { ...base, Full_Address: '27 / 29 CLUB STREET SINGAPORE 069413 / 14',
    Registered_Proprietor: 'ACME HOLDINGS PTE LTD & BETA VENTURES PRIVATE LIMITED',
    Registered_Proprietor_mailing_address: '12 ANN SIANG ROAD #03-01 SINGAPORE 069692' },
  // 5 — collapsed owner count + letter-suffixed house numbers.
  // Keep the address inside the row's stated Neighbourhood (Boat Quay): an address in a
  // different district is a real finding, and mixing that in would mask a false positive.
  { ...base, Full_Address: '77, 77A CIRCULAR ROAD SINGAPORE 049433',
    Registered_Proprietor: 'Owners of 77 CIRCULAR ROAD',
    Registered_Proprietor_mailing_address: '77A CIRCULAR ROAD #02-01 SINGAPORE 049433' },
];

const DIRTY = [
  // 6 — no postal code, leftover conservation-area text, boilerplate mailing address
  { ...base, Full_Address: '20 UPPER CROSS STREET CONSERVATION AREA',
    Registered_Proprietor: 'HOUSING AND DEVELOPMENT BOARD',
    Registered_Proprietor_mailing_address: 'STRATA LOT' },
  // 7 — street with no house number, inverted prices
  { ...base, Full_Address: 'TEMASEK BOULEVARD SINGAPORE 038988',
    Registered_Proprietor: 'REAL COMPANY PTE. LTD.',
    Registered_Proprietor_mailing_address: 'TEMASEK BOULEVARD SINGAPORE 038988',
    minimum_Price: 15000000, higher_Price: 9000000 },
];

const rows = { lawyerLetterRows: [...CLEAN, ...DIRTY], postcardRows: [] };
const CLEAN_ROWS = new Set([2, 3, 4, 5]);

const result = await crossCheck('lawyer-letter', rows, { batchSize: 40 });
if (result.errors.length) {
  console.log('ERRORS:', result.errors.join(' | '));
  process.exit(1);
}

const falsePositives = result.findings.filter((f) => CLEAN_ROWS.has(f.row));
const realFindings = result.findings.filter((f) => !CLEAN_ROWS.has(f.row));

console.log(`rows checked: ${result.rowsChecked}   findings: ${result.findings.length}\n`);

console.log('MUST NOT be flagged (corporate owners, co-owners, merges):');
if (falsePositives.length === 0) {
  console.log('  none flagged — correct\n');
} else {
  for (const f of falsePositives) {
    console.log(`  !! row ${f.row} ${f.field}: ${f.issue}`);
  }
  console.log('');
}

console.log('SHOULD be flagged (broken addresses, institution, inverted prices):');
for (const f of realFindings) {
  console.log(`  [${f.severity}] row ${f.row} ${f.field}: ${f.issue}`);
}

const rowsCaught = new Set(realFindings.map((f) => f.row));
const missed = [6, 7].filter((r) => !rowsCaught.has(r));
console.log(
  `\nfalse positives: ${falsePositives.length}   broken rows missed: ${missed.length ? missed.join(', ') : 'none'}`,
);
process.exit(falsePositives.length === 0 && missed.length === 0 ? 0 : 1);
