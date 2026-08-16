/**
 * Templates have to survive a round trip through the app that consumes them, or they are
 * worse than no template at all — the first Main Database template invented header names
 * like "Owner 1 Name", parsed cleanly, and produced zero recipients.
 *
 * So: every spreadsheet template is parsed by the same reader the upload uses, and every
 * Word template is run through the same merge-field validator step 5 uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTemplate,
  isDocxTemplate,
  templateFileName,
  templateKinds,
} from '../src/excel/templates.js';
import { parseMainDatabase } from '../src/core/mainDatabase.js';
import { readWorkbookSheets, sheetToTable } from '../src/excel/read.js';
import { parseBizFileTable } from '../src/bizfile/resolver.js';
import { parseInstitutionsSheet, findInstitutionsSheetName } from '../src/core/config.js';
import { listMergeFields, checkMergeFields } from '../src/mailmerge/wordMerge.js';

const dir = mkdtempSync(join(tmpdir(), 'propco-templates-'));

async function writeTemplate(kind: string): Promise<string> {
  const buffer = await buildTemplate(kind as never);
  const path = join(dir, templateFileName(kind as never));
  writeFileSync(path, buffer);
  return path;
}

test('every advertised template builds and is a non-trivial file', async () => {
  for (const kind of templateKinds()) {
    const buffer = await buildTemplate(kind);
    assert.ok(buffer.length > 500, `${kind} produced only ${buffer.length} bytes`);
  }
});

test('the Main Database template parses into usable rows', async () => {
  const path = await writeTemplate('main-database');
  const { wb } = readWorkbookSheets(path);
  const db = parseMainDatabase(sheetToTable(wb, 'Main Database'));

  assert.ok(db.rows.length >= 2, 'expected the example rows to parse');
  // The bug that shipped once: headers parsed, but no owner was found on any row.
  const withOwners = db.rows.filter((r) => r.owners.some((o) => o.name && o.address));
  assert.equal(withOwners.length, db.rows.length, 'every example row must carry a usable owner');
  assert.ok(db.rows[0].address, 'address must map');
  assert.ok(db.rows[0].neighbourhood, 'neighbourhood must map');
});

test('the second owner slot in the template is recognised', async () => {
  const path = await writeTemplate('main-database');
  const { wb } = readWorkbookSheets(path);
  const db = parseMainDatabase(sheetToTable(wb, 'Main Database'));
  const multi = db.rows.find((r) => r.owners.filter((o) => o.name).length > 1);
  assert.ok(multi, 'the co-owner example row should yield two owners');
});

test('the BizFile template parses with the resolver that consumes it', async () => {
  const path = await writeTemplate('bizfile');
  const { wb } = readWorkbookSheets(path);
  const table = sheetToTable(wb, 'BizFile Export');
  const records = parseBizFileTable(table.headers, table.rows);

  assert.ok(records.length >= 2);
  assert.ok(records[0].uen, 'UEN must map');
  assert.ok(records[0].registeredAddress, 'registered address must map');
  assert.ok(records[0].status, 'status must map');
});

test('BizFile template addresses carry a block number, as corrections require', async () => {
  const path = await writeTemplate('bizfile');
  const { wb } = readWorkbookSheets(path);
  const table = sheetToTable(wb, 'BizFile Export');
  for (const r of parseBizFileTable(table.headers, table.rows)) {
    assert.match(
      r.registeredAddress ?? '',
      /^\d/,
      `"${r.registeredAddress}" would be rejected by the re-run as incomplete`,
    );
  }
});

test('the institutions template is found and parsed by name', async () => {
  const path = await writeTemplate('institutions');
  const { wb, names } = readWorkbookSheets(path);
  const sheetName = findInstitutionsSheetName(names);
  assert.ok(sheetName, 'the sheet name must match the institutions/avoid pattern');
  const entries = parseInstitutionsSheet(sheetToTable(wb, sheetName));
  assert.ok(entries.length >= 3);
  assert.ok(entries[0].name);
  assert.ok(entries[0].status);
});

/** ------------------------------------------------------- Word templates ---- */

test('every Word template is a readable .docx with merge fields in it', async () => {
  for (const kind of templateKinds().filter(isDocxTemplate)) {
    const path = await writeTemplate(kind);
    const fields = listMergeFields(path);
    assert.ok(fields.length > 0, `${kind} has no merge fields`);
  }
});

test('the letter template validates against the lawyer-letter sheet', async () => {
  const path = await writeTemplate('letter-docx');
  const check = checkMergeFields(path, 'lawyer-letter');
  assert.deepEqual(
    check.missingInSheet,
    [],
    `these fields would merge blank: ${check.missingInSheet.join(', ')}`,
  );
  assert.ok(check.templateFields.includes('Registered_Proprietor'));
  assert.ok(check.templateFields.includes('minimum_Price'));
});

test('the envelope template validates against the lawyer-letter sheet', async () => {
  const path = await writeTemplate('envelope-docx');
  const check = checkMergeFields(path, 'lawyer-letter');
  assert.deepEqual(check.missingInSheet, []);
  assert.ok(check.templateFields.includes('Registered_Proprietor_mailing_address'));
});

test('the postcard template validates against the postcard sheet', async () => {
  const path = await writeTemplate('postcard-docx');
  const check = checkMergeFields(path, 'postcard');
  assert.deepEqual(
    check.missingInSheet,
    [],
    `these fields would merge blank: ${check.missingInSheet.join(', ')}`,
  );
  assert.ok(check.templateFields.includes('Owner Name'));
});

test('the postcard template is NOT valid for the letter channel', async () => {
  // Uploading the wrong channel's template is an easy mistake; step 5 must catch it.
  const path = await writeTemplate('postcard-docx');
  const check = checkMergeFields(path, 'lawyer-letter');
  assert.ok(
    check.missingInSheet.length > 0,
    'the postcard template should not silently pass as a lawyer letter',
  );
});
