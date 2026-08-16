/** Reproduce the Claude cross-check error in isolation, with two synthetic rows. */
import { crossCheck } from '../src/verify/claude.js';

const rows = {
  lawyerLetterRows: [
    {
      Comments: '',
      'Owner No.': '',
      Target: 'Yes',
      Address: '91 CIRCULAR ROAD',
      Full_Address: '91 CIRCULAR ROAD SINGAPORE 049442',
      Neighbourhood: 'Boat Quay',
      'Land Use': 'Shophouse',
      Mail_Date: new Date('2026-09-01'),
      Valid_Date: new Date('2026-09-15'),
      Registered_Proprietor: 'EXAMPLE HOLDINGS PTE. LTD.',
      Registered_Proprietor_mailing_address: '12 ANN SIANG ROAD SINGAPORE 069692',
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
    },
    {
      // Deliberately broken: inverted prices, no postal code, institution owner.
      Comments: '',
      'Owner No.': '',
      Target: 'Yes',
      Address: '20 UPPER CROSS STREET',
      Full_Address: '20 UPPER CROSS STREET CONSERVATION AREA',
      Neighbourhood: 'Chinatown',
      'Land Use': 'Shophouse',
      Mail_Date: new Date('2026-09-01'),
      Valid_Date: new Date('2026-08-01'),
      Registered_Proprietor: 'HOUSING AND DEVELOPMENT BOARD',
      Registered_Proprietor_mailing_address: 'STRATA LOT',
      'Duplicate Owner / Owner Addresses': 'unique',
      minimum_Price: 15000000,
      higher_Price: 9000000,
      Comp_Address_1: '',
      Comp_1: '',
      Comp_1_Date: '',
      Comp_Address_2: '',
      Comp_2: '',
      Comp_2_Date: '',
      Status: '',
      'Date Responded': '',
    },
  ],
  postcardRows: [],
};

console.log('model:', process.env.ANTHROPIC_MODEL ?? '(default)');
console.log('key present:', !!process.env.ANTHROPIC_API_KEY);

const result = await crossCheck('lawyer-letter', rows, { batchSize: 40 });

console.log('\nbatches:', result.batches, ' rowsChecked:', result.rowsChecked);
console.log('tokens in/out/cache:', result.inputTokens, result.outputTokens, result.cacheReadTokens);
console.log('\nERRORS:');
if (result.errors.length === 0) console.log('  (none)');
for (const e of result.errors) console.log('  ' + e);
console.log('\nFINDINGS:', result.findings.length);
for (const f of result.findings.slice(0, 8)) {
  console.log(`  [${f.severity}] row ${f.row} ${f.field}: ${f.issue}`);
}
