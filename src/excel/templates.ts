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

export type TemplateKind =
  | 'main-database'
  | 'comps'
  | 'suppression'
  | 'bizfile'
  | 'institutions'
  | 'merge-fields'
  | 'letter-docx'
  | 'envelope-docx'
  | 'postcard-docx';

/** Word templates are built as real .docx files, not spreadsheets. */
const DOCX_KINDS = new Set<TemplateKind>(['letter-docx', 'envelope-docx', 'postcard-docx']);

export function isDocxTemplate(kind: TemplateKind): boolean {
  return DOCX_KINDS.has(kind);
}

interface Template {
  fileName: string;
  /** Sheet name matters: the app looks for "Main Database" and the comps sheet by name. */
  sheetName: string;
  headers: string[];
  examples: unknown[][];
  /** Shown on a second sheet so the template explains itself. */
  notes: string[];
  /** Further sheets appended verbatim, e.g. the postcard field list. */
  extraSheets?: { name: string; rows: unknown[][] }[];
}

/** Spreadsheet templates only; the Word ones live in DOCX_TEMPLATES below. */
const TEMPLATES: Record<string, Template> = {
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

  transactions: {
    fileName: 'PropCo Template - Comps Transactions.xlsx',
    sheetName: 'Transactions',
    headers: [
      'Date',
      'District',
      'Project Name',
      'Address',
      'Property Type',
      'Tenure',
      'Area (sq ft)',
      'Type of Area',
      'Price ($psf)',
      'Price ($)',
      'No. of Floors',
      'URA Zoning',
    ],
    examples: [
      ['19 Jun 2026', 14, 'GEYLANG CONSERVATION AREA', '271, 271A Geylang Road', 'Shop House', 'Freehold', 1498, 'Land', 4271, 6400000, 2, 'Full Commercial (Dark Blue)'],
      ['6 Feb 2025', 14, 'GEYLANG CONSERVATION AREA', '635 Geylang Road', 'Shop House', 'Freehold', 1323, 'Land', 4498, 5950000, 2, 'Full Commercial (Dark Blue)'],
      ['10 Jun 2024', 14, 'GEYLANG CONSERVATION AREA', '547 Geylang Road', 'Shop House', 'Freehold', 1378, 'Land', 4355, 6000000, 2, 'Full Commercial (Dark Blue)'],
      ['5 Mar 2026', 1, 'TELOK AYER CONSERVATION AREA', '30 Stanley Street', 'Shop House', 'Freehold', 1691, 'Land', 9272, 15680000, 2.5, 'Full Commercial (Dark Blue)'],
    ],
    notes: [
      'This replaces the pre-computed benchmark table. Upload it on step 2 and comps are',
      '  chosen per property from that property\'s own district.',
      '',
      'How a comp is chosen:',
      '  1. The property\'s district comes from its postal code.',
      '  2. Only rows whose URA Zoning reads Full Commercial are eligible. Light-blue',
      '     mixed use and red residential-with-commercial-at-1st-storey are excluded.',
      '  3. By default only Land sales count, not Strata units — a unit is not a',
      '     comparable for a whole shophouse. Turn this off on step 2 if you disagree.',
      '  4. Among the most recent qualifying sales, the pair closest on price is used.',
      '',
      'Required columns: District, Price ($), URA Zoning. Without all three a tab is',
      '  treated as a benchmark table instead.',
      'Keep Price ($) and Price ($psf) as separate columns — they are not interchangeable.',
      'Dates can be written 19 Jun 2026, 2026-06-19, or as real Excel dates.',
      '',
      'You may keep one tab per district, as the Market Watch sheet does. Every tab that',
      '  has the required columns is read, so the District column is what matters, not the',
      '  tab name.',
    ],
  },

  institutions: {
    fileName: 'PropCo Template - Institutions to Avoid.xlsx',
    // The sheet name is matched on /institution/ + /avoid/, so keep both words.
    sheetName: 'Institutions to Avoid',
    headers: ['Institutions', 'Status', 'Remarks'],
    examples: [
      ['HOUSING AND DEVELOPMENT BOARD', 'Statutory board', 'Never a private-treaty seller'],
      ['SINGAPORE LAND AUTHORITY', 'Statutory board', ''],
      ['EXAMPLE TEMPLE ASSOCIATION', 'Institution', 'Clan association — approach in person'],
    ],
    notes: [
      'Owners matching these names are FLAGGED, not removed. The Comments column says so,',
      '  and a human decides whether to write to them.',
      'Put this sheet inside your tracker workbook and it is picked up automatically —',
      '  the sheet name must contain both "institution" and "avoid".',
      'Only the first column is required. Status defaults to "Institution" when blank.',
      'Matching is on a normalised name, so punctuation and casing do not matter.',
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
      'The second sheet lists the postcard fields, which are a different, shorter set.',
      'Rather than build a document from scratch, download the ready-made Word templates:',
      '  the letter, the envelope and the postcard all come with these fields already in.',
    ],
    extraSheets: [
      {
        name: 'Postcard Fields',
        rows: [
          ['Merge field', 'Example value', 'Notes'],
          ['Owner Name', 'EXAMPLE HOLDINGS PTE. LTD.', 'Used as the PDF file name'],
          ['Owner Address', '12 ANN SIANG ROAD #03-01 SINGAPORE 069692', 'Where it is posted'],
          ['Full Address', '91 CIRCULAR ROAD SINGAPORE 049442', 'The property'],
          ['Address', '91 CIRCULAR ROAD', 'Property address without the postal code'],
          ['Neighbourhood', 'Boat Quay', ''],
          ['Contact Name', '', 'Blank unless the tracker carries one'],
          ['Contact Number', '', ''],
          ['Updated Date', '01 Sep 2026', 'The mail date'],
        ],
      },
    ],
  },
};

/**
 * Word templates, built as real .docx files with MERGEFIELD codes already placed.
 *
 * These exist because "here are the field names, now build a Word document" is the step
 * most likely to go wrong: a field typed as plain text rather than inserted as a merge
 * field looks identical on screen and merges as literal text. Starting from a document
 * where the fields are already correct removes that whole class of mistake — and step 5
 * validates whatever you upload anyway.
 */
interface DocxTemplate {
  fileName: string;
  title: string;
  /** Paragraphs; `{{Field_Name}}` becomes a real MERGEFIELD. */
  body: string[];
}

const DOCX_TEMPLATES: Record<string, DocxTemplate> = {
  'letter-docx': {
    fileName: 'PropCo Template - Lawyer Letter.docx',
    title: 'Lawyer letter',
    body: [
      '[ YOUR FIRM LETTERHEAD ]',
      '',
      '{{Mail_Date}}',
      '',
      '{{Registered_Proprietor}}',
      '{{Registered_Proprietor_mailing_address}}',
      '',
      'Dear Sir or Madam',
      '',
      'RE: {{Full_Address}}',
      '',
      'We act for a client who wishes to purchase the property at {{Full_Address}} in {{Neighbourhood}}.',
      '',
      'Our client is prepared to offer between S${{minimum_Price}} and S${{higher_Price}} for the property, subject to contract and to inspection.',
      '',
      'By way of reference, we note the following recent transactions in the immediate area:',
      '',
      '{{Comp_Address_1}} — S${{Comp_1}} on {{Comp_1_Date}}',
      '{{Comp_Address_2}} — S${{Comp_2}} on {{Comp_2_Date}}',
      '',
      'This offer remains open until {{Valid_Date}}. Should you wish to discuss it, please contact the undersigned.',
      '',
      'Yours faithfully',
      '',
      '',
      '[ NAME ]',
      '[ FIRM ]',
    ],
  },
  'envelope-docx': {
    fileName: 'PropCo Template - Envelope.docx',
    title: 'Envelope',
    body: [
      '[ RETURN ADDRESS ]',
      '',
      '',
      '',
      '',
      '                    {{Registered_Proprietor}}',
      '                    {{Registered_Proprietor_mailing_address}}',
      '',
      '',
      '[ Set the page size to your envelope under Layout > Size before merging. ]',
    ],
  },
  'postcard-docx': {
    fileName: 'PropCo Template - Postcard.docx',
    title: 'Postcard',
    body: [
      '[ POSTCARD FRONT — your artwork goes here ]',
      '',
      '',
      '[ REVERSE ]',
      '',
      'Dear {{Owner Name}}',
      '',
      'We are interested in acquiring {{Full Address}} in {{Neighbourhood}} and would welcome a conversation, with no obligation.',
      '',
      '[ YOUR CONTACT DETAILS ]',
      '',
      '',
      'Addressee:',
      '{{Owner Name}}',
      '{{Owner Address}}',
      '',
      '[ Set the page size to your postcard under Layout > Size before merging. ]',
    ],
  },
};

export function templateKinds(): TemplateKind[] {
  return [...(Object.keys(TEMPLATES) as TemplateKind[]), ...(Object.keys(DOCX_TEMPLATES) as TemplateKind[])];
}

export function isTemplateKind(value: string): value is TemplateKind {
  return value in TEMPLATES || value in DOCX_TEMPLATES;
}

export function templateFileName(kind: TemplateKind): string {
  return isDocxTemplate(kind) ? DOCX_TEMPLATES[kind].fileName : TEMPLATES[kind].fileName;
}

export function templateContentType(kind: TemplateKind): string {
  return isDocxTemplate(kind)
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

/** Build the template, as .docx for the Word ones and .xlsx for the rest. */
export async function buildTemplate(kind: TemplateKind): Promise<Buffer> {
  return isDocxTemplate(kind) ? buildDocx(DOCX_TEMPLATES[kind]) : buildXlsx(TEMPLATES[kind]);
}

function buildXlsx(t: Template): Buffer {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([t.headers, ...t.examples]),
    t.sheetName,
  );
  for (const extra of t.extraSheets ?? []) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(extra.rows), extra.name);
  }
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

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * One paragraph. `{{Field}}` segments become MERGEFIELD runs, which is what Word treats
 * as a real merge field and what `listMergeFields` reads back out.
 */
function paragraph(text: string): string {
  const runs: string[] = [];
  const pattern = /\{\{([^}]+)\}\}/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) runs.push(textRun(text.slice(last, match.index)));
    runs.push(mergeFieldRun(match[1].trim()));
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push(textRun(text.slice(last)));
  if (runs.length === 0) runs.push(textRun(''));

  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${runs.join('')}</w:p>`;
}

function textRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

/**
 * Picture switches for the fields that are not text.
 *
 * Without one, Word prints whatever the data source hands over: an Excel date arrives
 * through OLEDB as "9/1/2026 12:00:00 PM" and a price as "11000000". Both are wrong on a
 * letter and neither is visible in a merge-field name check — the field resolves, it just
 * resolves ugly. The switch has to live in the template, so it belongs here.
 */
const FIELD_FORMAT: Record<string, string> = {
  // Figment writes dates as DD MMM YYYY.
  Mail_Date: '\\@ "dd MMM yyyy"',
  Valid_Date: '\\@ "dd MMM yyyy"',
  Comp_1_Date: '\\@ "dd MMM yyyy"',
  Comp_2_Date: '\\@ "dd MMM yyyy"',
  'Updated Date': '\\@ "dd MMM yyyy"',
  'Date Responded': '\\@ "dd MMM yyyy"',
  // Prices are always whole dollars; the S$ is typed in the template beside the field.
  minimum_Price: '\\# "#,##0"',
  higher_Price: '\\# "#,##0"',
  Comp_1: '\\# "#,##0"',
  Comp_2: '\\# "#,##0"',
};

/**
 * A complete simple field, which Word shows as «Field_Name» and merges properly.
 * The name is always quoted — Word requires it for names containing spaces, such as the
 * postcard sheet's "Owner Name", and tolerates it for the rest.
 */
function mergeFieldRun(name: string): string {
  // The switch carries its own quotes, which have to survive as an XML attribute value.
  const format = FIELD_FORMAT[name];
  const instr = ` MERGEFIELD &quot;${xmlEscape(name)}&quot; ${format ? `${xmlEscape(format)} ` : ''}\\* MERGEFORMAT `;
  return (
    `<w:fldSimple w:instr="${instr}">` +
    `<w:r><w:t>«${xmlEscape(name)}»</w:t></w:r>` +
    `</w:fldSimple>`
  );
}

async function buildDocx(t: DocxTemplate): Promise<Buffer> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );

  // Full paths, and createFolders:false below — a zero-length directory entry stops the
  // reader in wordMerge.ts, which treats zero sizes as "sizes are in a data descriptor".
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  const body = t.body.map(paragraph).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`,
  );

  // Drop the implicit directory entries JSZip adds for "_rels/" and "word/". Word does
  // not need them, and a zero-length entry is exactly the shape that trips naive zip
  // readers — including this repo's own, until it was taught to skip them.
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path].dir) delete zip.files[path];
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
