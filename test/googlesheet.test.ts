/**
 * Google Sheets link parsing and the tab-to-workbook conversion.
 *
 * The URL shapes below are the ones people actually paste. Getting the gid wrong is not a
 * loud failure — it silently reads a different tab, which for a tool that posts letters is
 * the worst kind of wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';
import {
  GoogleSheetAccessError,
  fetchedSheetToXlsx,
  parseSheetUrl,
  type FetchedSheet,
} from '../src/sheets/google.js';

const ID = '1UeigMbJP-mueP6yAW6urbEYaPWrM75g6fw1HUZ_HXuY';

test('the tab id is read from the fragment, which is what the browser shows', () => {
  assert.deepEqual(
    parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1663840271#gid=1663840271`),
    { spreadsheetId: ID, gid: '1663840271' },
  );
});

test('every shape of link people paste resolves to the same spreadsheet', () => {
  const shapes = [
    `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
    `https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`,
    `https://docs.google.com/spreadsheets/d/${ID}`,
    `  https://docs.google.com/spreadsheets/d/${ID}/view#gid=42  `,
    ID,
  ];
  for (const s of shapes) {
    assert.equal(parseSheetUrl(s).spreadsheetId, ID, `failed for ${s}`);
  }
});

test('no gid means "the first tab", not a guessed one', () => {
  assert.equal(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit`).gid, undefined);
});

test('a link that is not a spreadsheet is refused with something actionable', () => {
  for (const bad of ['', '   ', 'https://example.com/thing', 'not a link']) {
    assert.throws(() => parseSheetUrl(bad), GoogleSheetAccessError);
  }
  // A Docs link is a plausible mistake and must not be read as a spreadsheet id.
  assert.throws(
    () => parseSheetUrl('https://docs.google.com/document/d/1abcdefghijklmnopqrstuvwx/edit'),
    GoogleSheetAccessError,
  );
});

/** ---------------------------------------------------- tab -> workbook on disk ---- */

const tab = (over: Partial<FetchedSheet> = {}): FetchedSheet => ({
  spreadsheetId: ID,
  spreadsheetTitle: 'Market Watch',
  sheetTitle: 'D14',
  gid: '1663840271',
  headers: ['Address', 'Owner Name', 'Owner Address'],
  rows: [['91 CIRCULAR ROAD SINGAPORE 049442', 'ACME PTE LTD', '12 ANN SIANG ROAD SINGAPORE 069692']],
  via: 'service-account',
  fetchedAt: new Date('2026-08-19T10:00:00Z'),
  ...over,
});

test('a fetched tab becomes a workbook the existing reader can parse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-'));
  try {
    const path = join(dir, 'fetched.xlsx');
    await fetchedSheetToXlsx(tab(), path);
    const wb = XLSX.readFile(path);
    assert.deepEqual(wb.SheetNames, ['D14']);
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.D14, { header: 1 });
    assert.deepEqual(grid[0], ['Address', 'Owner Name', 'Owner Address']);
    assert.equal(grid[1]?.[1], 'ACME PTE LTD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('numbers survive as numbers, so prices stay priceable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-'));
  try {
    const path = join(dir, 'nums.xlsx');
    await fetchedSheetToXlsx(
      tab({ headers: ['Address', 'Price ($)'], rows: [['1 A ROAD', 11_000_000]] }),
      path,
    );
    const wb = XLSX.readFile(path);
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.D14, { header: 1, raw: true });
    assert.equal(typeof grid[1]?.[1], 'number');
    assert.equal(grid[1]?.[1], 11_000_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tab names that collide once truncated to 31 chars do not lose a tab', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-'));
  try {
    const path = join(dir, 'many.xlsx');
    // Excel caps at 31 characters, so these two Google tabs would become the same name and
    // appending the second one would throw, losing the whole fetch.
    await fetchedSheetToXlsx(
      [
        tab({ sheetTitle: 'District 14 Transactions Detail A' }),
        tab({ sheetTitle: 'District 14 Transactions Detail B' }),
      ],
      path,
    );
    const wb = XLSX.readFile(path);
    assert.equal(wb.SheetNames.length, 2, 'both tabs must survive');
    assert.equal(new Set(wb.SheetNames).size, 2);
    for (const n of wb.SheetNames) assert.ok(n.length <= 31, `"${n}" is too long for Excel`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tab name with characters Excel forbids is made safe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-'));
  try {
    const path = join(dir, 'unsafe.xlsx');
    await fetchedSheetToXlsx(tab({ sheetTitle: 'D14 / Geylang [2026]' }), path);
    const wb = XLSX.readFile(path);
    assert.equal(wb.SheetNames[0], 'D14 - Geylang -2026-');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
