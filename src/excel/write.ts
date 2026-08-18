/**
 * Output workbook assembly.
 *
 * The uploaded file is never modified. Each run writes a NEW workbook containing the
 * original sheet verbatim ("Source (Original)") plus the generated subsheets, which is
 * how "preserve the original and add subsheets in the same workbook" is honoured safely.
 */
import ExcelJS from 'exceljs';
import { DedupeAuditEntry } from '../core/dedupe.js';
import { LAWYER_LETTER_HEADERS, POSTCARD_HEADERS } from '../core/pipeline.js';
import { CompsRecord, PipelineResult } from '../core/types.js';
import { formatDate, normKey, squash } from '../core/text.js';
import { SheetTable } from '../core/mainDatabase.js';

export const SHEET_NAMES = {
  source: 'Source (Original)',
  lawyerLetter: 'Lawyer Letter',
  postcard: 'Postcard',
  postcardFinal: 'Postcards Final',
  ownerRows: 'Owner Rows (Exploded)',
  dedupeAudit: 'Dedupe Audit',
  excluded: 'Excluded',
  flags: 'Review Flags',
  comps: 'Comps Benchmark Used',
  bizfile: 'BizFile Verification',
  bizfileCoverage: 'BizFile Coverage',
  addressOverrides: 'Address Overrides',
  claude: 'Claude Cross-Check',
  runSummary: 'Run Summary',
} as const;

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1F2937' },
};

const CURRENCY_FORMAT = '"S$"#,##0';
const DATE_FORMAT = 'dd mmm yyyy';

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 28;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function autoWidth(sheet: ExcelJS.Worksheet, max = 60): void {
  sheet.columns.forEach((column) => {
    let width = 10;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const text = cell.value instanceof Date ? 'dd mmm yyyy' : String(cell.value ?? '');
      const longest = text.split('\n').reduce((m, line) => Math.max(m, line.length), 0);
      width = Math.max(width, Math.min(longest + 2, max));
    });
    column.width = width;
  });
}

function addTable(
  wb: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: unknown[][],
): ExcelJS.Worksheet {
  // Excel caps sheet names at 31 chars and forbids : \ / ? * [ ]
  const safe = name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
  const sheet = wb.addWorksheet(safe);
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  styleHeader(sheet);
  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: Math.max(headers.length, 1) },
    };
  }
  autoWidth(sheet);
  return sheet;
}

export interface BuildWorkbookInput {
  result: PipelineResult & { dedupeAudit?: DedupeAuditEntry[] };
  /** The uploaded sheet, copied verbatim into "Source (Original)". */
  source?: SheetTable;
  /** The comps benchmark table actually used for this run. */
  comps?: CompsRecord[];
  /** Free-text notes shown on the Run Summary sheet. */
  notes?: string[];
}

export async function buildWorkbook(input: BuildWorkbookInput): Promise<ExcelJS.Workbook> {
  const { result } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Figment PropCo Automation';
  wb.created = new Date();

  // 1. The deliverable sheet(s) first — this is what the mail merge points at.
  if (result.channel === 'lawyer-letter') {
    addLawyerLetterSheet(wb, result);
  } else {
    addPostcardSheets(wb, result);
  }

  // 2. Original input, preserved verbatim.
  if (input.source) {
    addTable(
      wb,
      SHEET_NAMES.source,
      input.source.headers,
      input.source.rows.map((r) => r.map(cellValue)),
    );
  }

  // 3. Audit trail.
  if (result.options.includeAuditSheets) {
    addOwnerRowsSheet(wb, result);
    addDedupeAuditSheet(wb, result.dedupeAudit ?? []);
    addExclusionsSheet(wb, result);
    addFlagsSheet(wb, result);
    if (input.comps?.length) addCompsSheet(wb, input.comps);
    addRunSummarySheet(wb, result, input.notes ?? []);
  }

  return wb;
}

function addLawyerLetterSheet(wb: ExcelJS.Workbook, result: PipelineResult): ExcelJS.Worksheet {
  const headers = LAWYER_LETTER_HEADERS as unknown as string[];
  const sheet = wb.addWorksheet(SHEET_NAMES.lawyerLetter);
  sheet.addRow(headers);

  result.lawyerLetterRows.forEach((row) => {
    sheet.addRow(headers.map((h) => cellValue((row as unknown as Record<string, unknown>)[h])));
  });

  styleHeader(sheet);

  // Column I (Valid_Date) keeps the tracker's live "=H2+14" formula, but with a cached
  // result written alongside it. Word's mail merge reads the workbook over OLEDB, which
  // does not evaluate formulas — without the cached value «Valid_Date» merges blank.
  const validityDays = result.options.validityDays;
  result.lawyerLetterRows.forEach((row, i) => {
    const r = i + 2;
    sheet.getCell(r, 9).value = {
      formula: `H${r}+${validityDays}`,
      result: anchorDate(row.Valid_Date),
      date1904: false,
    } as ExcelJS.CellFormulaValue;
  });

  // Number and date formats for the merge fields the Word template formats itself.
  applyFormat(sheet, ['H', 'I', 'Q', 'T'], DATE_FORMAT, result.lawyerLetterRows.length);
  applyFormat(sheet, ['M', 'N', 'P', 'S'], CURRENCY_FORMAT, result.lawyerLetterRows.length);

  // Comments column wraps — it carries the review notes.
  sheet.getColumn(1).alignment = { wrapText: true, vertical: 'top' };
  sheet.getColumn(1).width = 46;
  sheet.getColumn(12).alignment = { wrapText: true, vertical: 'top' };
  sheet.getColumn(12).width = 46;

  autoWidth(sheet, 48);
  sheet.getColumn(1).width = 46;
  sheet.getColumn(12).width = 46;

  if (result.lawyerLetterRows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  }
  return sheet;
}

function applyFormat(
  sheet: ExcelJS.Worksheet,
  columns: string[],
  format: string,
  rowCount: number,
): void {
  for (const col of columns) {
    for (let r = 2; r <= rowCount + 1; r++) {
      sheet.getCell(`${col}${r}`).numFmt = format;
    }
  }
}

function addPostcardSheets(wb: ExcelJS.Workbook, result: PipelineResult): void {
  const headers = POSTCARD_HEADERS as unknown as string[];
  addTable(
    wb,
    SHEET_NAMES.postcard,
    headers,
    result.postcardRows.map((row) =>
      headers.map((h) => cellValue((row as unknown as Record<string, unknown>)[h])),
    ),
  );

  // "Postcards Final" — exactly the two columns the mail merge needs.
  addTable(
    wb,
    SHEET_NAMES.postcardFinal,
    ['Owner Name', 'Owner Address'],
    result.postcardRows.map((row) => [row['Owner Name'], row['Owner Address']]),
  );
}

function addOwnerRowsSheet(wb: ExcelJS.Workbook, result: PipelineResult): void {
  const headers = [
    'Source Row',
    'Address ID',
    'Target',
    'Neighbourhood',
    'Land Use',
    'Tenure',
    'Property (raw)',
    'House Numbers',
    'Street',
    'Conservation Area',
    'Postal',
    'Owner Slot',
    'Owner Name (raw)',
    'Owner Name (cleaned)',
    'Owner Address',
    'Corporate?',
    'GFA (sqft)',
    'Benchmark psf',
    'Notes',
  ];
  addTable(
    wb,
    SHEET_NAMES.ownerRows,
    headers,
    result.ownerRows.map((r) => [
      r.sourceRow,
      r.addressId ?? '',
      r.target,
      r.neighbourhood,
      r.landUse,
      r.tenure,
      r.property.raw,
      r.property.numbers.join(' / '),
      r.property.street,
      r.property.conservationArea ?? '',
      r.property.postal,
      r.ownerSlot,
      r.ownerNameRaw,
      r.ownerName,
      r.ownerAddress,
      r.isCorporate ? 'Yes' : 'No',
      r.gfaSqft ?? '',
      r.benchmarkPsf ?? '',
      r.notes.join(' | '),
    ]),
  );
}

function addDedupeAuditSheet(wb: ExcelJS.Workbook, audit: DedupeAuditEntry[]): void {
  addTable(
    wb,
    SHEET_NAMES.dedupeAudit,
    ['Stage', 'Action', 'Source Rows', 'Before', 'After', 'Group Key'],
    audit.map((a) => [
      a.stage === 'A' ? 'A — merge co-owners' : 'B — merge properties',
      a.action,
      a.sourceRows.join(', '),
      a.before.join('\n'),
      a.after,
      a.key,
    ]),
  );
}

function addExclusionsSheet(wb: ExcelJS.Workbook, result: PipelineResult): void {
  addTable(
    wb,
    SHEET_NAMES.excluded,
    ['Source Row', 'Address ID', 'Address', 'Owner Name', 'Stage', 'Reason', 'Detail'],
    result.exclusions.map((e) => [
      e.sourceRow,
      e.addressId ?? '',
      e.address ?? '',
      e.ownerName ?? '',
      e.stage,
      e.reason,
      e.detail ?? '',
    ]),
  );
}

function addFlagsSheet(wb: ExcelJS.Workbook, result: PipelineResult): void {
  const sheet = addTable(
    wb,
    SHEET_NAMES.flags,
    ['Severity', 'Source Row', 'Address', 'Owner Name', 'Flag', 'Detail'],
    result.flags.map((f) => [f.severity, f.sourceRow, f.address ?? '', f.ownerName ?? '', f.flag, f.detail ?? '']),
  );
  // Colour-code severity so the errors are obvious at a glance.
  for (let r = 2; r <= result.flags.length + 1; r++) {
    const severity = result.flags[r - 2].severity;
    const argb = severity === 'error' ? 'FFFECACA' : severity === 'warn' ? 'FFFEF3C7' : 'FFE0F2FE';
    sheet.getCell(r, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  }
}

function addCompsSheet(wb: ExcelJS.Workbook, comps: CompsRecord[]): void {
  const sheet = addTable(
    wb,
    SHEET_NAMES.comps,
    [
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
    ],
    comps.map((c) => [
      c.neighbourhood,
      c.landUse,
      c.tenure,
      c.minimumPrice ?? '',
      c.higherPrice ?? '',
      c.compAddress1 ?? '',
      c.comp1 ?? '',
      c.comp1Date ?? '',
      c.compAddress2 ?? '',
      c.comp2 ?? '',
      c.comp2Date ?? '',
    ]),
  );
  applyFormat(sheet, ['D', 'E', 'G', 'J'], CURRENCY_FORMAT, comps.length);
  applyFormat(sheet, ['H', 'K'], DATE_FORMAT, comps.length);
}

function addRunSummarySheet(
  wb: ExcelJS.Workbook,
  result: PipelineResult,
  notes: string[],
): void {
  const rows: unknown[][] = [];
  rows.push(['Channel', result.channel]);
  rows.push(['Generated', formatDate(new Date())]);
  rows.push(['Mail date', formatDate(result.options.mailDate)]);
  rows.push(['Validity (days)', result.options.validityDays]);
  rows.push(['Outreach filter', result.options.outreachFilter.mode]);
  if (result.options.outreachFilter.matchText) {
    rows.push(['Outreach filter text', result.options.outreachFilter.matchText]);
  }
  rows.push(['Exclude opt-outs', result.options.outreachFilter.alwaysExcludeOptOut ? 'Yes' : 'No']);
  rows.push(['Max properties per owner', result.options.maxPropertiesPerOwner]);
  rows.push(['Collapse above N owners', result.options.maxOwnersBeforeCollapse]);
  rows.push(['Remove agencies / developers', result.options.removeAgenciesAndDevelopers ? 'Yes' : 'No']);
  rows.push(['Derive missing prices from psf', result.options.deriveMissingPrices ? 'Yes' : 'No']);
  rows.push([]);
  rows.push(['— Counts —', '']);
  for (const [k, v] of Object.entries(result.stats)) rows.push([k, v]);
  rows.push([]);
  rows.push(['— Warnings —', '']);
  for (const w of result.warnings) {
    rows.push([w.scope, `${w.message}${w.count ? ` (${w.count})` : ''}`]);
    if (w.samples?.length) rows.push(['', w.samples.join(', ')]);
  }
  if (notes.length) {
    rows.push([]);
    rows.push(['— Notes —', '']);
    for (const n of notes) rows.push(['', n]);
  }
  const sheet = addTable(wb, SHEET_NAMES.runSummary, ['Setting', 'Value'], rows);
  sheet.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  sheet.getColumn(2).width = 90;
}

/** Append or replace a sheet on an existing workbook file (used by the later steps). */
export async function appendSheet(
  workbookPath: string,
  sheetName: string,
  headers: string[],
  rows: unknown[][],
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath);
  const existing = wb.getWorksheet(sheetName);
  if (existing) wb.removeWorksheet(existing.id);
  addTable(wb, sheetName, headers, rows);
  await wb.xlsx.writeFile(workbookPath);
  return wb;
}

/** Columns the BizFile pass adds to a deliverable sheet, in order. */
export const BIZFILE_INLINE_HEADERS = [
  'BizFile Verdict',
  'BizFile Registered Address',
  'Corrected Address',
];

/**
 * Put the BizFile result next to the address it is about, on the sheet being sent.
 *
 * The BizFile Verification sheet already holds every verdict, but reading it means
 * cross-referencing owner names between two tabs — so in practice a mismatch gets found
 * at the printer instead of at review. These three columns sit on the deliverable itself:
 * the verdict, what ACRA actually has, and an empty column to type the address to use.
 *
 * `Corrected Address` is deliberately blank rather than pre-filled with ACRA's address.
 * Pre-filling would turn "ACRA disagrees" into "the tool already decided", and the whole
 * point of the column is that a human looks. Whatever is typed there is picked up by the
 * Address Overrides path when the workbook is uploaded back.
 *
 * Any `Corrected Address` values already in the sheet are preserved — a second BizFile
 * run must not discard corrections typed after the first one.
 */
export async function annotateWithBizFile(
  workbookPath: string,
  sheetName: string,
  ownerColumn: string,
  addressColumn: string,
  verifications: {
    ownerName: string;
    mailingAddressInSheet: string;
    bizfileAddress?: string;
    verdict: string;
    detail: string;
  }[],
): Promise<{ annotated: number; matched: number }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath);
  const sheet = wb.getWorksheet(sheetName);
  if (!sheet) return { annotated: 0, matched: 0 };

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = squash(cell.value);
  });

  // Letters and digits only, so "Registered_Proprietor" and "Registered Proprietor" agree.
  const key = (h: string) => normKey(h).replace(/[^A-Z0-9]/g, '');
  const indexOfHeader = (name: string) => headers.findIndex((h) => key(h ?? '') === key(name));
  const ownerCol = indexOfHeader(ownerColumn);
  const addressCol = indexOfHeader(addressColumn);
  if (ownerCol < 0 || addressCol < 0) return { annotated: 0, matched: 0 };

  // Index the verdicts by owner + address, then by owner alone. One owner can appear on
  // several rows with different mailing addresses, so the exact pair has to win.
  const byPair = new Map<string, (typeof verifications)[number]>();
  const byOwner = new Map<string, (typeof verifications)[number]>();
  for (const v of verifications) {
    const owner = normKey(v.ownerName);
    byPair.set(`${owner}||${normKey(v.mailingAddressInSheet)}`, v);
    if (!byOwner.has(owner)) byOwner.set(owner, v);
  }

  // Reuse the existing columns if this is a re-run, otherwise append them.
  const cols = BIZFILE_INLINE_HEADERS.map((name) => {
    const found = indexOfHeader(name);
    return found >= 0 ? found : headers.push(name) - 1;
  });
  BIZFILE_INLINE_HEADERS.forEach((name, i) => {
    headerRow.getCell(cols[i] + 1).value = name;
  });

  let matched = 0;
  let annotated = 0;
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const owner = normKey(squash(row.getCell(ownerCol + 1).value));
    if (!owner) continue;
    const address = normKey(squash(row.getCell(addressCol + 1).value));
    const hit = byPair.get(`${owner}||${address}`) ?? byOwner.get(owner);
    annotated++;
    if (!hit) {
      // Say so rather than leaving it blank: an empty verdict cell reads as "fine".
      row.getCell(cols[0] + 1).value = 'not checked';
      row.getCell(cols[1] + 1).value = '';
      continue;
    }
    matched++;
    row.getCell(cols[0] + 1).value = hit.verdict;
    row.getCell(cols[1] + 1).value = hit.bizfileAddress ?? '';
    // Never overwrite a correction someone already typed.
    const corrected = row.getCell(cols[2] + 1);
    if (squash(corrected.value) === '') corrected.value = '';
  }

  styleHeader(sheet);
  highlightVerdicts(sheet, cols[0] + 1);
  autoWidth(sheet);
  await wb.xlsx.writeFile(workbookPath);
  return { annotated, matched };
}

/** Colour the verdicts that must not be posted, so they cannot be scrolled past. */
function highlightVerdicts(sheet: ExcelJS.Worksheet, column: number): void {
  const RED = 'FFFCE4E4';
  const AMBER = 'FFFFF4D6';
  for (let r = 2; r <= sheet.rowCount; r++) {
    const cell = sheet.getRow(r).getCell(column);
    const verdict = squash(cell.value).toLowerCase();
    const fill =
      verdict === 'mismatch' || verdict === 'entity-inactive'
        ? RED
        : verdict === 'not-found' || verdict === 'lookup-failed' || verdict === 'not checked'
          ? AMBER
          : undefined;
    if (fill) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    }
  }
}

/**
 * Excel stores a date as a serial number with no timezone. ExcelJS converts a JS Date
 * using the machine's offset, so a date at midnight UTC can land on the previous day in
 * a UTC+8 locale — "01 Sep 2026" becomes "31 Aug 2026" on the letter. Anchoring the
 * time to noon UTC keeps the calendar day stable for any offset within ±12 hours.
 */
export function anchorDate(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0, 0),
  );
}

function cellValue(value: unknown): string | number | Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : anchorDate(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value);
  // Keep intentional newlines (owner cells) but drop the carriage returns Excel dislikes.
  return text.replace(/\r/g, '');
}

export async function writeWorkbook(wb: ExcelJS.Workbook, filePath: string): Promise<void> {
  await wb.xlsx.writeFile(filePath);
}

export { squash };
