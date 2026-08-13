/**
 * Round-trip tests for the generated workbook: build it, read it back with a different
 * library, and assert the things a mail merge depends on.
 *
 * These caught two real bugs during development:
 *   1. Valid_Date was written as a bare formula with no cached value. Word's mail merge
 *      reads the workbook over OLEDB and does not evaluate formulas, so «Valid_Date»
 *      merged blank.
 *   2. Dates written at midnight UTC landed on the previous calendar day in a UTC+8
 *      locale, so a 1 September mail date printed as 31 August.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

import { buildWorkbook, SHEET_NAMES, writeWorkbook } from '../src/excel/write.js';
import { defaultOptions, runPipeline } from '../src/core/pipeline.js';
import { parseMainDatabase, type SheetTable } from '../src/core/mainDatabase.js';
import type { CompsRecord } from '../src/core/types.js';
import { formatDate } from '../src/core/text.js';

const HEADERS = [
  'Address ID',
  'Address',
  'Postal Code',
  'Target',
  'Owner Name',
  'Owner Address',
  '2nd Owner Name',
  '2nd Owner Address',
  'Tenure',
  'Land Area (SqM)',
  'No. of floors',
  'GFA',
  'Land Use',
  'Lawyer Letter Outreach',
  'Postcard Outreach Date',
  'Neighbourhood',
  'Benchmark',
];

function row(values: Partial<Record<string, unknown>>): unknown[] {
  return HEADERS.map((h) => values[h] ?? null);
}

const SOURCE: SheetTable = {
  sheetName: 'Main Database',
  headers: HEADERS,
  rows: [
    row({
      'Address ID': 'D1 069413',
      Address: '27 CLUB STREET TELOK AYER CONSERVATION AREA SINGAPORE 069413',
      'Postal Code': '069413',
      Target: 'A/B',
      'Owner Name': 'JANE XIA',
      'Owner Address': '5 ORCHARD ROAD SINGAPORE 238888',
      '2nd Owner Name': 'LONG GAN',
      '2nd Owner Address': '5 ORCHARD ROAD SINGAPORE 238888',
      Tenure: 'FH',
      'Land Area (SqM)': 100,
      'No. of floors': 2,
      GFA: 2152.78,
      'Land Use': 'Full Commercial (Dark Blue)',
      Neighbourhood: "D1 - Raffles Place, Cecil, Marina, People's Park",
      Benchmark: 4271.73,
    }),
    row({
      'Address ID': 'D1 069414',
      Address: '29 CLUB STREET TELOK AYER CONSERVATION AREA SINGAPORE 069414',
      'Postal Code': '069414',
      Target: 'A/B',
      'Owner Name': 'JANE XIA',
      'Owner Address': '5 ORCHARD ROAD SINGAPORE 238888',
      Tenure: 'FH',
      'Land Area (SqM)': 100,
      'No. of floors': 2,
      GFA: 2152.78,
      'Land Use': 'Full Commercial (Dark Blue)',
      Neighbourhood: "D1 - Raffles Place, Cecil, Marina, People's Park",
      Benchmark: 4271.73,
    }),
  ],
};

const COMPS: CompsRecord[] = [
  {
    neighbourhood: 'D1',
    landUse: 'Fully Commercial',
    tenure: 'FH / 999 years',
    minimumPrice: 12_000_000,
    higherPrice: 14_000_000,
    compAddress1: '42 Club Street',
    comp1: 13_200_000,
    comp1Date: new Date(Date.UTC(2024, 7, 13)),
    compAddress2: '176 Telok Ayer Street',
    comp2: 14_800_000,
    comp2Date: new Date(Date.UTC(2025, 0, 26)),
  },
];

const MAIL_DATE = new Date(Date.UTC(2026, 8, 1)); // 01 Sep 2026

async function generate(channel: 'lawyer-letter' | 'postcard') {
  const db = parseMainDatabase(SOURCE);
  const result = runPipeline(
    db.rows,
    defaultOptions(channel, { mailDate: MAIL_DATE, comps: COMPS }),
  );
  const wb = await buildWorkbook({ result, source: SOURCE, comps: COMPS });
  const dir = mkdtempSync(join(tmpdir(), 'propco-test-'));
  const path = join(dir, `${channel}.xlsx`);
  await writeWorkbook(wb, path);
  const readBack = XLSX.read(readFileSync(path), { cellDates: true });
  return { result, path, dir, wb: readBack };
}

function sheetRows(wb: XLSX.WorkBook, name: string): unknown[][] {
  const ws = wb.Sheets[name];
  assert.ok(ws, `sheet "${name}" is missing`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
}

test('lawyer letter workbook has the deliverable and audit sheets', async () => {
  const { wb, dir } = await generate('lawyer-letter');
  try {
    assert.ok(wb.SheetNames.includes(SHEET_NAMES.lawyerLetter));
    assert.ok(wb.SheetNames.includes(SHEET_NAMES.source), 'the original sheet must be preserved');
    assert.ok(wb.SheetNames.includes(SHEET_NAMES.ownerRows));
    assert.ok(wb.SheetNames.includes(SHEET_NAMES.dedupeAudit));
    assert.ok(wb.SheetNames.includes(SHEET_NAMES.excluded));
    assert.ok(wb.SheetNames.includes(SHEET_NAMES.flags));
    assert.ok(wb.SheetNames.includes(SHEET_NAMES.comps));
    assert.ok(wb.SheetNames.includes(SHEET_NAMES.runSummary));
    // The deliverable sheet must be first so the mail merge picks it up by default.
    assert.equal(wb.SheetNames[0], SHEET_NAMES.lawyerLetter);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lawyer letter headers are exactly the merge-field names, in order', async () => {
  const { wb, dir } = await generate('lawyer-letter');
  try {
    const rows = sheetRows(wb, SHEET_NAMES.lawyerLetter);
    assert.deepEqual(rows[0], [
      'Comments',
      'Owner No.',
      'Target',
      'Address',
      'Full_Address',
      'Neighbourhood',
      'Land Use',
      'Mail_Date',
      'Valid_Date',
      'Registered_Proprietor',
      'Registered_Proprietor_mailing_address',
      'Duplicate Owner / Owner Addresses',
      'minimum_Price',
      'higher_Price',
      'Comp_Address_1',
      'Comp_1',
      'Comp_1_Date',
      'Comp_Address_2',
      'Comp_2',
      'Comp_2_Date',
      'Status',
      'Date Responded',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the two properties merge into one letter with the spec address format', async () => {
  const { wb, dir } = await generate('lawyer-letter');
  try {
    const rows = sheetRows(wb, SHEET_NAMES.lawyerLetter);
    assert.equal(rows.length, 2, 'one header row plus one recipient');
    const data = rows[1] as unknown[];
    assert.equal(data[3], '27 / 29 CLUB STREET');
    assert.equal(data[4], '27 / 29 CLUB STREET SINGAPORE 069413 / 14');
    assert.equal(data[9], 'JANE XIA & LONG GAN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Valid_Date has a cached value so the mail merge is not blank', async () => {
  const { wb, dir } = await generate('lawyer-letter');
  try {
    const rows = sheetRows(wb, SHEET_NAMES.lawyerLetter);
    const data = rows[1] as unknown[];
    const mailDate = data[7];
    const validDate = data[8];
    assert.ok(mailDate instanceof Date, 'Mail_Date must be a date value');
    assert.ok(
      validDate instanceof Date,
      'Valid_Date must carry a cached value — a bare formula merges blank over OLEDB',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dates keep their calendar day regardless of the machine timezone', async () => {
  const { wb, dir } = await generate('lawyer-letter');
  try {
    const rows = sheetRows(wb, SHEET_NAMES.lawyerLetter);
    const data = rows[1] as unknown[];
    assert.equal(formatDate(data[7] as Date), '01 Sep 2026', 'Mail_Date');
    assert.equal(formatDate(data[8] as Date), '15 Sep 2026', 'Valid_Date = Mail_Date + 14');
    assert.equal(formatDate(data[16] as Date), '13 Aug 2024', 'Comp_1_Date');
    assert.equal(formatDate(data[19] as Date), '26 Jan 2025', 'Comp_2_Date');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('comps prices come through as numbers', async () => {
  const { wb, dir } = await generate('lawyer-letter');
  try {
    const data = sheetRows(wb, SHEET_NAMES.lawyerLetter)[1] as unknown[];
    assert.equal(data[12], 12_000_000);
    assert.equal(data[13], 14_000_000);
    assert.equal(data[14], '42 Club Street');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('postcard workbook has both required sheets with the right columns', async () => {
  const { wb, dir } = await generate('postcard');
  try {
    assert.equal(wb.SheetNames[0], SHEET_NAMES.postcard);
    assert.equal(wb.SheetNames[1], SHEET_NAMES.postcardFinal);

    const postcard = sheetRows(wb, SHEET_NAMES.postcard);
    assert.deepEqual(postcard[0], [
      'Target',
      'Address',
      'Full Address',
      'Neighbourhood',
      'Land Use',
      'Owner Name',
      'Owner Address',
      'Checking',
      'Contact Name',
      'Contact Number',
      'Status',
      'Updated Date',
    ]);

    const final = sheetRows(wb, SHEET_NAMES.postcardFinal);
    assert.deepEqual(final[0], ['Owner Name', 'Owner Address']);
    assert.equal((final[1] as unknown[])[0], 'JANE XIA & LONG GAN');
    assert.equal((final[1] as unknown[])[1], '5 ORCHARD ROAD SINGAPORE 238888');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the original source sheet is copied verbatim', async () => {
  const { wb, dir } = await generate('lawyer-letter');
  try {
    const rows = sheetRows(wb, SHEET_NAMES.source);
    assert.deepEqual(rows[0], HEADERS);
    assert.equal(rows.length, SOURCE.rows.length + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit sheets can be switched off for a two-sheet postcard deliverable', async () => {
  const db = parseMainDatabase(SOURCE);
  const result = runPipeline(
    db.rows,
    defaultOptions('postcard', { mailDate: MAIL_DATE, includeAuditSheets: false }),
  );
  const wb = await buildWorkbook({ result });
  assert.deepEqual(wb.worksheets.map((w) => w.name), [
    SHEET_NAMES.postcard,
    SHEET_NAMES.postcardFinal,
  ]);
});
