/** Workbook reading. SheetJS handles the Google-Sheets exports in the tracker reliably. */
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import { SheetTable } from '../core/mainDatabase.js';
import { headerKey, squash } from '../core/text.js';

export interface WorkbookInfo {
  sheetNames: string[];
  sheets: Record<string, { rows: number; columns: number; headers: string[] }>;
}

function readWorkbook(filePath: string): XLSX.WorkBook {
  return XLSX.read(readFileSync(filePath), { cellDates: true });
}

export function inspectWorkbook(filePath: string): WorkbookInfo {
  const wb = readWorkbook(filePath);
  const sheets: WorkbookInfo['sheets'] = {};
  for (const name of wb.SheetNames) {
    const table = sheetToTable(wb, name);
    sheets[name] = {
      rows: table.rows.length,
      columns: table.headers.length,
      headers: table.headers,
    };
  }
  return { sheetNames: wb.SheetNames, sheets };
}

/**
 * Read one sheet into a header + rows table.
 *
 * `headerRow` is 1-based. When omitted we scan the first 20 rows for the one that looks
 * most like a header — the tracker has sheets (Doorknocking Tracker, Overall Weekly
 * Tracker) whose real header is not row 1.
 */
export function sheetToTable(wb: XLSX.WorkBook, sheetName: string, headerRow?: number): SheetTable {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet not found: ${sheetName}`);
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: true,
  });

  const idx = (headerRow ?? detectHeaderRow(grid)) - 1;
  const headerCells = (grid[idx] ?? []) as unknown[];
  const headers = headerCells.map((h) => squash(h));

  // Trim trailing empty header columns.
  let width = headers.length;
  while (width > 0 && !headers[width - 1]) width--;

  const rows = grid.slice(idx + 1).map((r) => {
    const cells = (r ?? []) as unknown[];
    return Array.from({ length: width }, (_, i) => cells[i] ?? null);
  });

  return { sheetName, headers: headers.slice(0, width), rows };
}

export function readSheet(filePath: string, sheetName?: string, headerRow?: number): SheetTable {
  const wb = readWorkbook(filePath);
  const name = sheetName ?? pickBestSheet(wb);
  return sheetToTable(wb, name, headerRow);
}

/** Row (1-based) that has the most non-empty, non-numeric cells in the first 20 rows. */
function detectHeaderRow(grid: unknown[][]): number {
  let best = 1;
  let bestScore = -1;
  const limit = Math.min(20, grid.length);
  for (let i = 0; i < limit; i++) {
    const cells = (grid[i] ?? []) as unknown[];
    const score = cells.filter(
      (c) => typeof c === 'string' && squash(c).length > 0 && squash(c).length < 60,
    ).length;
    if (score > bestScore) {
      bestScore = score;
      best = i + 1;
    }
  }
  return best;
}

const MAIN_DB_SIGNALS = ['address', 'ownername', 'owneraddress', 'target', 'neighbourhood'];

/** Choose the sheet most likely to be the Main Database. */
export function pickBestSheet(wb: XLSX.WorkBook): string {
  let best = wb.SheetNames[0];
  let bestScore = -1;
  for (const name of wb.SheetNames) {
    const table = sheetToTable(wb, name);
    const keys = new Set(table.headers.map(headerKey));
    const score =
      MAIN_DB_SIGNALS.filter((s) => keys.has(s)).length * 1000 + Math.min(table.rows.length, 999);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

/** Find a sheet by fuzzy name, e.g. "lawyer letter comps" -> "Lawyer Letter Comps Benchmarks". */
export function findSheetByName(filePath: string, needle: string): string | undefined {
  const wb = readWorkbook(filePath);
  const key = headerKey(needle);
  return (
    wb.SheetNames.find((n) => headerKey(n) === key) ??
    wb.SheetNames.find((n) => headerKey(n).includes(key))
  );
}

export function readWorkbookSheets(filePath: string): { wb: XLSX.WorkBook; names: string[] } {
  const wb = readWorkbook(filePath);
  return { wb, names: wb.SheetNames };
}

/** Read a simple two-or-three column suppression list (address / postal / owner name). */
export function readSuppressionList(filePath: string, sheetName?: string) {
  const wb = readWorkbook(filePath);
  const name = sheetName ?? wb.SheetNames[0];
  const table = sheetToTable(wb, name);
  const index = new Map<string, number>();
  table.headers.forEach((h, i) => {
    const k = headerKey(h);
    if (k && !index.has(k)) index.set(k, i);
  });

  const addressCol =
    index.get('propertyaddress') ??
    index.get('shophouseaddress') ??
    index.get('address') ??
    index.get('fulladdress');
  const postalCol = index.get('postalcode') ?? index.get('postal');
  const ownerCol = index.get('owner') ?? index.get('ownername');

  const entries = [];
  for (const cells of table.rows) {
    const address = addressCol === undefined ? '' : squash(cells[addressCol]);
    const postal =
      postalCol === undefined ? '' : squash(cells[postalCol]).replace(/\D/g, '');
    const ownerName = ownerCol === undefined ? '' : squash(cells[ownerCol]);
    if (!address && !postal && !ownerName) continue;
    entries.push({
      address: address || undefined,
      postal: postal || undefined,
      ownerName: ownerName || undefined,
      source: `${name}`,
    });
  }
  return entries;
}
