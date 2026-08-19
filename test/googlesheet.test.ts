/**
 * Google Sheets link parsing and the tab-to-workbook conversion.
 *
 * The URL shapes below are the ones people actually paste. Getting the gid wrong is not a
 * loud failure — it silently reads a different tab, which for a tool that posts letters is
 * the worst kind of wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';
import {
  GoogleSheetAccessError,
  fetchedSheetToXlsx,
  parseSheetUrl,
  serviceAccount,
  REPO_KEY_PATH,
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

/** --------------------------------------------------- the key as .env holds it ---- */

test('a Windows path with a trailing space is read, because that is what gets pasted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-key-'));
  const before = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const file = join(dir, 'propco-sheets-key.json');
    writeFileSync(
      file,
      JSON.stringify({ client_email: 'propco@x.iam.gserviceaccount.com', private_key: pem }),
    );
    assert.ok(file.includes('\\'), 'the temp path should be a Windows path on this machine');

    // loadEnv puts the rest of the line in verbatim: backslashes intact, and any trailing
    // space left behind by copying the path out of Explorer.
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = `${file} `;
    const sa = serviceAccount();
    assert.equal(sa?.client_email, 'propco@x.iam.gserviceaccount.com');
    assert.ok(sa?.private_key.includes('\n'), 'the PEM must keep real newlines');
  } finally {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key pasted inline as one line has its escaped newlines restored', () => {
  const before = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    // A .env value cannot span lines, so a pasted PEM arrives with literal backslash-n.
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: 'propco@x.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n',
    });
    const sa = serviceAccount();
    assert.ok(sa?.private_key.includes('\n'), 'literal \\n must become a real newline');
    assert.ok(!sa?.private_key.includes('\\n'));
  } finally {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = before;
  }
});

test('with nothing configured, the answer depends on what the repo ships', () => {
  const before = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    // Both states are valid and the suite has to pass in either: a key committed to this
    // private repo means clone-and-go, no key means anonymous reads only. Asserting one
    // unconditionally would fail in whichever checkout is not that one.
    if (existsSync(REPO_KEY_PATH)) {
      const sa = serviceAccount();
      assert.ok(sa?.client_email.endsWith('.iam.gserviceaccount.com'));
      assert.ok(sa?.private_key.includes('BEGIN'));
    } else {
      assert.equal(serviceAccount(), undefined);
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '   ';
      assert.equal(serviceAccount(), undefined);
    }
  } finally {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = before;
  }
});

test('an explicit key beats one committed to the repo', () => {
  // So a machine can use its own credentials without editing tracked files.
  const dir = mkdtempSync(join(tmpdir(), 'gs-prec-'));
  const before = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const mine = join(dir, 'mine.json');
    writeFileSync(
      mine,
      JSON.stringify({
        client_email: 'mine@override.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
    );
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = mine;
    assert.equal(serviceAccount()?.client_email, 'mine@override.iam.gserviceaccount.com');
  } finally {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key that is missing, unparseable, or incomplete says which', () => {
  const before = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = join(tmpdir(), 'definitely-not-here.json');
    assert.throws(() => serviceAccount(), /does not exist/);

    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{not json';
    assert.throws(() => serviceAccount(), /not valid JSON/);

    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'a@b.com' });
    assert.throws(() => serviceAccount(), /missing client_email or private_key/);
  } finally {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = before;
  }
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
