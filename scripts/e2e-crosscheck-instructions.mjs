/**
 * Do the operator's own instructions actually change what Claude reports?
 *
 * Two directions, both against live Claude, on the same rows:
 *   - "stop flagging X" must silence a finding the built-in rules produce.
 *   - "also check Y" must produce a finding the built-in rules do not.
 *
 * Asserting only that the call succeeds would pass on instructions that were ignored,
 * which is the failure mode worth catching.
 */
import { readFileSync } from 'node:fs';

// This calls Claude directly rather than through the server, so it has to load .env itself.
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // No .env — rely on the ambient environment.
}

const { crossCheck } = await import('../src/verify/claude.js');

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
  minimum_Price: 11_000_000,
  higher_Price: 12_500_000,
  Comp_Address_1: '88 CIRCULAR ROAD',
  Comp_1: 10_800_000,
  Comp_1_Date: new Date('2026-02-14'),
  Comp_Address_2: '92 CIRCULAR ROAD',
  Comp_2: 11_400_000,
  Comp_2_Date: new Date('2025-11-30'),
  Status: '',
  'Date Responded': '',
};

// row 2 — a statutory board, which rule 2 flags on its own.
// row 3 — perfectly clean, except its mailing address is a shopping-centre unit.
const rows = {
  lawyerLetterRows: [
    {
      ...base,
      Full_Address: '20 UPPER CROSS STREET SINGAPORE 058329',
      Registered_Proprietor: 'HOUSING AND DEVELOPMENT BOARD',
      Registered_Proprietor_mailing_address: '480 LORONG 6 TOA PAYOH SINGAPORE 310480',
    },
    {
      ...base,
      Full_Address: '91 CIRCULAR ROAD SINGAPORE 049442',
      Registered_Proprietor: 'SANE ASIA PTE. LTD.',
      Registered_Proprietor_mailing_address: '2 ORCHARD TURN #04-15 ION ORCHARD SINGAPORE 238801',
    },
  ],
  postcardRows: [],
};

const run = async (label, extraInstructions) => {
  const r = await crossCheck('lawyer-letter', rows, { batchSize: 40, extraInstructions });
  if (r.errors.length) throw new Error(r.errors.join(' | '));
  console.log(`\n${label}`);
  if (r.findings.length === 0) console.log('   (no findings)');
  for (const f of r.findings) console.log(`   [${f.severity}] row ${f.row} ${f.field}: ${f.issue}`);
  return r.findings;
};

const baseline = await run('1. built-in rules only');
const flaggedBoardByDefault = baseline.some((f) => f.row === 2);
const flaggedMallByDefault = baseline.some((f) => f.row === 3);

const silenced = await run(
  '2. + "do not flag statutory boards"',
  'Do not flag statutory boards, town councils or management corporations. We have a ' +
    'separate process for those and the findings are noise to us.',
);
const boardSilenced = !silenced.some((f) => f.row === 2);

const added = await run(
  '3. + "flag shopping-centre mailing addresses"',
  'Flag any Registered_Proprietor_mailing_address that is a unit inside a shopping centre ' +
    'or mall (for example ION Orchard, Suntec City, Plaza Singapura). Post to those is ' +
    'returned to us undelivered.',
);
const mallCaught = added.some((f) => f.row === 3);

console.log('\n--- results ---');
console.log(`statutory board flagged by default : ${flaggedBoardByDefault}`);
console.log(`  ... silenced by instruction      : ${boardSilenced}`);
console.log(`mall address flagged by default    : ${flaggedMallByDefault}`);
console.log(`  ... caught by instruction        : ${mallCaught}`);

const pass = flaggedBoardByDefault && boardSilenced && !flaggedMallByDefault && mallCaught;
console.log(
  pass
    ? '\n>> custom instructions work in both directions'
    : '\n!! instructions did not take effect as specified',
);
// exitCode rather than exit(): the SDK's keep-alive sockets are still closing.
process.exitCode = pass ? 0 : 1;
