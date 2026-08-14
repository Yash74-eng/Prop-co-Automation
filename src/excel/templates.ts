/**
 * Starter workbooks for each step.
 *
 * Every upload the app accepts is matched on a normalised header key, so what people
 * actually need is the column names spelled correctly — not prose describing them. These
 * templates carry the exact headers plus one worked example row, so the shape is obvious
 * and the file can be filled in and uploaded straight back.
 *
 * Example rows use invented addresses and companies. Nothing here is Figment data.
 */
import * as XLSX from 'xlsx';

export type TemplateKind = 'main-database' | 'comps' | 'suppression' | 'bizfile' | 'merge-fields';

interface Template {
  fileName: string;
  /** Sheet name matters: the app looks for "Main Database" and the comps sheet by name. */
  sheetName: string;
  headers: string[];
  examples: unknown[][];
  /** Shown on a second sheet so the template explains itself. */
  notes: string[];
}

const TEMPLATES: Record<TemplateKind, Template> = {
  'main-database': {
    fileName: 'PropCo Template - Main Database.xlsx',
    sheetName: 'Main Database',
    // These header names are matched by the parser on a normalised key. They are not
    // decorative: "Owner 1 Name" does not map, "Owner Name" does.
    headers: [
      'Address ID',
      'Address',
      'Postal Code',
      'Target',
      'Neighbourhood',
      'Land Use',
      'Tenure',
      'GFA',
      'Benchmark',
      'Lawyer Letter Outreach',
      'Postcard Outreach Date',
      'Owner Name',
      'Owner Address',
      '2nd Owner Name',
      '2nd Owner Address',
      'Contact Person',
      'Contact No or Email',
    ],
    examples: [
      [
        'D1 049442',
        '91 CIRCULAR ROAD SINGAPORE 049442',
        '049442',
        'Yes',
        'Boat Quay',
        'Shophouse',
        '99-year',
        3200,
        3400,
        '',
        '',
        'EXAMPLE HOLDINGS PTE. LTD.',
        '12 ANN SIANG ROAD #03-01 SINGAPORE 069692',
        '',
        '',
        '',
        '',
      ],
      [
        'D2 058329',
        '20 UPPER CROSS STREET SINGAPORE 058329',
        '058329',
        'Yes',
        'Chinatown',
        'Shophouse',
        'Freehold',
        2750,
        4100,
        'Batch 3',
        '',
        'TAN AH KOW',
        '5 NEIL ROAD SINGAPORE 088808',
        'LIM BEE HOON',
        '5 NEIL ROAD SINGAPORE 088808',
        '',
        '',
      ],
    ],
    notes: [
      'Address, Target, Neighbourhood and Land Use are required; so is at least one',
      '  Owner Name with an Owner Address, or the row has nobody to write to.',
      'Further owner slots are named "2nd Owner Name" / "2nd Owner Address" through to 5th.',
      '  The names matter — "Owner 2 Name" will not be recognised.',
      'Headers are matched on a normalised key, so casing and trailing spaces do not matter.',
      'Leave "Lawyer Letter Outreach" blank for owners not yet contacted. A date, a batch tag',
      '  ("Batch 3") or a delivery-failure note all mean "already contacted" and are filtered out',
      '  by the default exclude-contacted setting.',
      'Anything reading as an opt-out or do-not-send is always dropped, whatever the filter.',
      'Extra columns are carried through untouched — the pipeline ignores what it does not use.',
    ],
  },

  comps: {
    fileName: 'PropCo Template - Comps Benchmarks.xlsx',
    sheetName: 'Lawyer Letter Comps Benchmarks',
    headers: [
      'Neighbourhood',
      'Land Use',
      'Tenure',
      'minimum_Price',
      'higher_Price',
      'Comp_Address_1',
      'Comp_1',
      'Comp_1_Date',
      'Comp_Address_2',
      'Comp_2',
      'Comp_2_Date',
      'Benchmark PSF',
    ],
    examples: [
      [
        'Boat Quay',
        'Shophouse',
        '99-year',
        11000000,
        12500000,
        '88 CIRCULAR ROAD',
        10800000,
        '2026-02-14',
        '92 CIRCULAR ROAD',
        11400000,
        '2025-11-30',
        3400,
      ],
      [
        'Chinatown',
        'Shophouse',
        'Freehold',
        13500000,
        15200000,
        '18 UPPER CROSS STREET',
        13200000,
        '2026-01-20',
        '24 UPPER CROSS STREET',
        14100000,
        '2025-09-05',
        4100,
      ],
    ],
    notes: [
      'Used for the lawyer letter only. Postcards carry no pricing, so this is not needed for them.',
      'Prices must be numbers, not text — "S$11,000,000" will not be read as a number.',
      'A row is matched on Neighbourhood + Land Use + Tenure.',
      'When no row matches, prices are derived from GFA x Benchmark PSF and clearly flagged',
      '  on the Review Flags sheet. Turn that off in Configure if you would rather leave blanks.',
      'Dates can be written any common way — 14 Feb 2026, 2026-02-14, 14/02/2026 all read fine.',
    ],
  },

  suppression: {
    fileName: 'PropCo Template - Do Not Contact.xlsx',
    sheetName: 'Do Not Contact',
    headers: ['Address', 'Postal Code', 'Owner Name', 'Reason'],
    examples: [
      ['31 KEONG SAIK ROAD SINGAPORE 089140', '089140', '', 'Compset — competitor operator'],
      ['', '069692', '', 'Already in negotiation'],
      ['', '', 'EXAMPLE HOLDINGS PTE. LTD.', 'Asked not to be contacted again'],
    ],
    notes: [
      'Any one column is enough per row — address, postal code, or owner name.',
      'Postal code is the most reliable match; addresses are compared on a normalised key.',
      'Every sheet in the uploaded file is read, so you can keep several lists in one workbook.',
      'Suppressed rows are not silently dropped — each appears on the Excluded sheet with',
      '  its reason, so you can prove why someone was left out.',
    ],
  },

  bizfile: {
    fileName: 'PropCo Template - BizFile Export.xlsx',
    sheetName: 'BizFile Export',
    headers: [
      'Entity Name',
      'UEN',
      'Entity Status',
      'Registered Office Address',
      'Entity Type',
    ],
    examples: [
      [
        'EXAMPLE HOLDINGS PTE. LTD.',
        '201234567M',
        'Live Company',
        '12 ANN SIANG ROAD #03-01 SINGAPORE 069692',
        'Local Company',
      ],
      [
        'SECOND EXAMPLE PTE. LTD.',
        '198765432K',
        'Struck Off',
        '5 NEIL ROAD #02-00 SINGAPORE 088808',
        'Local Company',
      ],
    ],
    notes: [
      'Use this when you have purchased Business Profiles and want the full registered address,',
      '  including block and unit. ACRA open data carries street and postal code only.',
      'Entity Name must match the owner name on the sheet closely — matching falls back to a',
      '  containment check, so "ACME HOLDINGS PTE LTD" finds "ACME HOLDINGS PTE. LTD.".',
      'Entity Status drives the do-not-send verdict. Struck Off, Dissolved, Deregistered,',
      '  Cancelled and Expired are all treated as inactive.',
      'Upload on step 4 to verify, or on the re-run panel to correct addresses and rebuild.',
    ],
  },

  'merge-fields': {
    fileName: 'PropCo Template - Mail Merge Fields.xlsx',
    sheetName: 'Merge Fields',
    headers: ['Merge field', 'Example value', 'Notes'],
    examples: [
      ['Registered_Proprietor', 'EXAMPLE HOLDINGS PTE. LTD.', 'Owner name, already merged and cleaned'],
      ['Registered_Proprietor_mailing_address', '12 ANN SIANG ROAD #03-01 SINGAPORE 069692', 'Where the letter is posted'],
      ['Full_Address', '91 CIRCULAR ROAD SINGAPORE 049442', 'The property, used as the PDF file name'],
      ['Address', '91 CIRCULAR ROAD', 'Property address without the postal code'],
      ['Neighbourhood', 'Boat Quay', ''],
      ['Mail_Date', '01 Sep 2026', 'Set in Configure'],
      ['Valid_Date', '15 Sep 2026', 'Mail_Date plus the validity days'],
      ['minimum_Price', 11000000, 'Number — format it in Word, not here'],
      ['higher_Price', 12500000, 'Number'],
      ['Comp_Address_1', '88 CIRCULAR ROAD', ''],
      ['Comp_1', 10800000, 'Number'],
      ['Comp_1_Date', '14 Feb 2026', ''],
      ['Comp_Address_2', '92 CIRCULAR ROAD', ''],
      ['Comp_2', 11400000, 'Number'],
      ['Comp_2_Date', '30 Nov 2025', ''],
    ],
    notes: [
      'These are the field names to insert in your Word .docx as merge fields.',
      'Spelling must match exactly, including underscores and capitals.',
      'In Word: Insert > Quick Parts > Field > MergeField, then type the name.',
      'Step 5 validates your .docx against the generated sheet and names any field that',
      '  will not resolve, before you produce hundreds of PDFs.',
      'Postcards use a different, shorter set — Owner Name and Owner Address.',
    ],
  },
};

export function templateKinds(): TemplateKind[] {
  return Object.keys(TEMPLATES) as TemplateKind[];
}

export function isTemplateKind(value: string): value is TemplateKind {
  return value in TEMPLATES;
}

export function templateFileName(kind: TemplateKind): string {
  return TEMPLATES[kind].fileName;
}

/** Build the template as an xlsx buffer, ready to stream to the browser. */
export function buildTemplate(kind: TemplateKind): Buffer {
  const t = TEMPLATES[kind];
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([t.headers, ...t.examples]),
    t.sheetName,
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['How to use this template'],
      [],
      ...t.notes.map((n) => [n]),
      [],
      ['Delete the example rows before uploading.'],
    ]),
    'How to use',
  );

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
