/** HTTP API behind the wizard UI. Every step is a separate, explicitly-triggered call. */
import { Router } from 'express';
import multer from 'multer';
import { extname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  createJob,
  jobSummary,
  listJobs,
  logStep,
  requireJob,
  OUTPUT_DIR,
  UPLOAD_DIR,
} from './store.js';
import {
  findSheetByName,
  readSheet,
  readSuppressionList,
  readWorkbookSheets,
  sheetToTable,
} from '../excel/read.js';
import { parseMainDatabase } from '../core/mainDatabase.js';
import { parseCompsTable } from '../core/comps.js';
import { defaultOptions, runPipeline } from '../core/pipeline.js';
import { findInstitutionsSheetName, loadConfig, parseInstitutionsSheet } from '../core/config.js';
import { buildWorkbook, SHEET_NAMES, writeWorkbook } from '../excel/write.js';
import { appendSheet } from '../excel/write.js';
import {
  BIZFILE_SHEET_HEADERS,
  collectCorporateOwners,
  csvResolver,
  parseBizFileTable,
  playwrightResolver,
  verificationsToRows,
} from '../bizfile/resolver.js';
import { CLAUDE_SHEET_HEADERS, crossCheck, findingsToRows } from '../verify/claude.js';
import { isCorporateName } from '../core/names.js';
import { parseLooseDate, squash } from '../core/text.js';
import { checkMergeFields, generateWordMergeScript } from '../mailmerge/wordMerge.js';
import { writeFileSync } from 'node:fs';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
  }),
  limits: { fileSize: 80 * 1024 * 1024 },
});

export const router = Router();

function fail(res: import('express').Response, error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : String(error);
  res.status(status).json({ error: message });
}

/** POST /api/jobs — upload the Main Database workbook. */
router.post('/jobs', upload.single('file'), (req, res) => {
  try {
    if (!req.file) throw new Error('No file uploaded');
    const { names } = readWorkbookSheets(req.file.path);
    const job = createJob(req.file.path, req.file.originalname, names);
    logStep(job, 'upload', `${req.file.originalname} — ${names.length} sheets`);

    // Auto-load the comps benchmark table when the upload is the full tracker.
    const compsSheet = findSheetByName(req.file.path, 'lawyer letter comps');
    if (compsSheet) {
      const { wb } = readWorkbookSheets(req.file.path);
      job.comps = parseCompsTable(sheetToTable(wb, compsSheet));
      job.compsSource = `${req.file.originalname} [${compsSheet}]`;
      logStep(job, 'comps', `Loaded ${job.comps.length} rows from "${compsSheet}"`);
    }

    res.json(jobSummary(job));
  } catch (error) {
    fail(res, error);
  }
});

router.get('/jobs', (_req, res) => {
  res.json(listJobs().map(jobSummary));
});

router.get('/jobs/:id', (req, res) => {
  try {
    res.json(jobSummary(requireJob(String(req.params.id))));
  } catch (error) {
    fail(res, error, 404);
  }
});

/** GET /api/jobs/:id/sheets/:name/preview — headers + first rows, for the sheet picker. */
router.get('/jobs/:id/sheets/:name/preview', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    const { wb } = readWorkbookSheets(job.sourcePath);
    const table = sheetToTable(wb, req.params.name);
    const db = parseMainDatabase(table);
    res.json({
      sheetName: table.sheetName,
      headers: table.headers,
      rowCount: table.rows.length,
      sampleRows: table.rows.slice(0, 5),
      mappedFields: Object.keys(db.columnMap),
      missingFields: db.missingFields,
      unmappedHeaders: db.unmappedHeaders,
      parsedRows: db.rows.length,
    });
  } catch (error) {
    fail(res, error);
  }
});

/** POST /api/jobs/:id/comps — upload a replacement comps benchmark table. */
router.post('/jobs/:id/comps', upload.single('file'), (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!req.file) throw new Error('No file uploaded');
    const { wb, names } = readWorkbookSheets(req.file.path);
    const sheetName = squash(req.body?.sheetName) || names[0];
    job.comps = parseCompsTable(sheetToTable(wb, sheetName));
    job.compsSource = `${req.file.originalname} [${sheetName}]`;
    logStep(job, 'comps', `Replaced with ${job.comps.length} rows from ${job.compsSource}`);
    res.json(jobSummary(job));
  } catch (error) {
    fail(res, error);
  }
});

/** POST /api/jobs/:id/suppression — upload a compset / do-not-contact list. */
router.post('/jobs/:id/suppression', upload.single('file'), (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!req.file) throw new Error('No file uploaded');
    const { names } = readWorkbookSheets(req.file.path);
    // Read every sheet — the competitor workbook splits across two.
    const entries = names.flatMap((name) => {
      try {
        return readSuppressionList(req.file!.path, name);
      } catch {
        return [];
      }
    });
    (job as { suppression?: unknown }).suppression = entries;
    job.suppressionCount = entries.length;
    logStep(
      job,
      'suppression',
      `Loaded ${entries.length} entries from ${req.file.originalname} (${names.length} sheets)`,
    );
    res.json(jobSummary(job));
  } catch (error) {
    fail(res, error);
  }
});

/** POST /api/jobs/:id/run — the main generation step. */
router.post('/jobs/:id/run', async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    const body = req.body ?? {};

    const sheetName = squash(body.sheetName) || job.sheetName;
    const table = readSheet(job.sourcePath, sheetName || undefined);
    job.sheetName = table.sheetName;
    job.sourceTable = table;

    const db = parseMainDatabase(table);
    if (db.rows.length === 0) {
      throw new Error(`No data rows found in sheet "${table.sheetName}"`);
    }

    const channel = body.channel === 'postcard' ? 'postcard' : 'lawyer-letter';
    const mailDate = parseLooseDate(body.mailDate) ?? new Date();

    const options = defaultOptions(channel, {
      mailDate,
      validityDays: numberOr(body.validityDays, 14),
      outreachFilter: {
        mode: body.outreachMode ?? 'exclude-contacted',
        matchText: squash(body.outreachMatchText) || undefined,
        alwaysExcludeOptOut: body.alwaysExcludeOptOut !== false,
      },
      maxPropertiesPerOwner: numberOr(body.maxPropertiesPerOwner, 5),
      maxOwnersBeforeCollapse: numberOr(body.maxOwnersBeforeCollapse, 4),
      maxOwnerNameLength: numberOr(body.maxOwnerNameLength, 120),
      removeAgenciesAndDevelopers: body.removeAgenciesAndDevelopers !== false,
      groupByOwnerName: body.groupByOwnerName === true,
      includeAuditSheets: body.includeAuditSheets !== false,
      deriveMissingPrices: body.deriveMissingPrices !== false,
      suppressionList: ((job as { suppression?: unknown[] }).suppression ?? []) as never[],
      comps: job.comps,
    });

    // Institutions-to-avoid comes from the uploaded workbook when it carries the sheet,
    // so the tracker stays the source of truth; config/ is only a fallback.
    const config = loadConfig(readInstitutionsFromWorkbook(job.sourcePath));

    const result = runPipeline(db.rows, options, {
      institutions: config.institutions,
      developerNames: config.developerNames,
      neighbourhoodOverrides: config.neighbourhoodOverrides,
    });
    job.options = options;
    job.result = result;

    const wb = await buildWorkbook({
      result,
      source: table,
      comps: job.comps,
      notes: [
        `Source: ${job.sourceFileName} [${table.sheetName}]`,
        `Comps benchmark: ${job.compsSource}`,
        `Suppression entries: ${job.suppressionCount}`,
        `Institutions to avoid: ${config.sources.institutions}`,
        `Developers list: ${config.sources.developers}`,
        `Neighbourhood overrides: ${config.sources.neighbourhoodOverrides}`,
        'The uploaded workbook was not modified. This file is a new workbook containing the original sheet plus the generated subsheets.',
      ],
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const label = channel === 'lawyer-letter' ? 'Lawyer-Letter' : 'Postcard';
    job.outputFileName = `PropCo ${label} ${stamp} ${job.id.slice(0, 8)}.xlsx`;
    job.outputPath = join(OUTPUT_DIR, job.outputFileName);
    await writeWorkbook(wb, job.outputPath);

    logStep(
      job,
      'run',
      `${channel}: ${db.rows.length} source rows -> ${
        channel === 'lawyer-letter' ? result.lawyerLetterRows.length : result.postcardRows.length
      } recipients`,
    );

    res.json({
      ...jobSummary(job),
      preview:
        channel === 'lawyer-letter'
          ? result.lawyerLetterRows.slice(0, 25)
          : result.postcardRows.slice(0, 25),
      exclusionSummary: summarise(result.exclusions.map((e) => e.reason)),
      flagSummary: summarise(result.flags.map((f) => `${f.severity}: ${f.flag}`)),
    });
  } catch (error) {
    fail(res, error);
  }
});

/** GET /api/jobs/:id/download — the generated workbook. */
router.get('/jobs/:id/download', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.outputPath || !existsSync(job.outputPath)) {
      throw new Error('Nothing generated yet for this job');
    }
    res.download(job.outputPath, job.outputFileName ?? 'propco-output.xlsx');
  } catch (error) {
    fail(res, error, 404);
  }
});

/** GET /api/jobs/:id/rows — full generated rows, for the on-screen table. */
router.get('/jobs/:id/rows', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result) throw new Error('Nothing generated yet for this job');
    const offset = numberOr(req.query.offset, 0);
    const limit = Math.min(numberOr(req.query.limit, 100), 500);
    const rows =
      job.result.channel === 'lawyer-letter' ? job.result.lawyerLetterRows : job.result.postcardRows;
    res.json({
      channel: job.result.channel,
      total: rows.length,
      offset,
      rows: rows.slice(offset, offset + limit),
    });
  } catch (error) {
    fail(res, error);
  }
});

/** GET /api/jobs/:id/exclusions — the audit trail, paginated. */
router.get('/jobs/:id/exclusions', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result) throw new Error('Nothing generated yet for this job');
    const offset = numberOr(req.query.offset, 0);
    const limit = Math.min(numberOr(req.query.limit, 200), 1000);
    res.json({
      total: job.result.exclusions.length,
      rows: job.result.exclusions.slice(offset, offset + limit),
      summary: summarise(job.result.exclusions.map((e) => e.reason)),
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/jobs/:id/flags', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result) throw new Error('Nothing generated yet for this job');
    res.json({
      total: job.result.flags.length,
      rows: job.result.flags.slice(0, 1000),
      summary: summarise(job.result.flags.map((f) => `${f.severity}: ${f.flag}`)),
    });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * GET /api/jobs/:id/funnel — where rows were lost, stage by stage.
 * The pipeline drops thousands of rows; this is what makes that legible.
 */
router.get('/jobs/:id/funnel', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result) throw new Error('Nothing generated yet for this job');
    const s = job.result.stats;

    const byStage = new Map<string, { label: string; count: number; reasons: Map<string, number> }>();
    for (const e of job.result.exclusions) {
      if (!byStage.has(e.stage)) {
        byStage.set(e.stage, { label: e.stage, count: 0, reasons: new Map() });
      }
      const entry = byStage.get(e.stage)!;
      entry.count++;
      entry.reasons.set(e.reason, (entry.reasons.get(e.reason) ?? 0) + 1);
    }

    res.json({
      stages: [
        { key: 'sourceRows', label: 'Source rows', value: s.sourceRows ?? 0 },
        { key: 'afterOutreachFilter', label: 'Passed outreach filter', value: s.afterOutreachFilter ?? 0 },
        { key: 'afterSuppression', label: 'Passed suppression', value: s.afterSuppression ?? 0 },
        { key: 'ownerRowsExploded', label: 'Owner rows', value: s.ownerRowsExploded ?? 0 },
        { key: 'ownerRowsKept', label: 'Owners kept', value: s.ownerRowsKept ?? 0 },
        { key: 'recipients', label: 'Recipients', value: s.recipients ?? 0 },
      ],
      drops: [...byStage.values()].map((entry) => ({
        stage: entry.label,
        count: entry.count,
        reasons: [...entry.reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([label, count]) => ({ label, count })),
      })),
      outreach: Object.entries(s)
        .filter(([k]) => k.startsWith('outreach_'))
        .map(([k, v]) => ({ label: k.replace('outreach_', ''), count: v })),
    });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * GET /api/jobs/:id/recipients/:index — one recipient with the source rows that merged
 * into it and the merge decisions taken. This is the drill-down that makes a merged
 * address checkable without opening the workbook.
 */
router.get('/jobs/:id/recipients/:index', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result) throw new Error('Nothing generated yet for this job');
    const index = Number(req.params.index);
    const group = job.result.groups[index];
    if (!group) throw new Error(`No recipient at index ${index}`);

    const audit = (job.result.dedupeAudit ?? []) as {
      stage: string;
      key: string;
      action: string;
      before: string[];
      after: string;
      sourceRows: number[];
    }[];
    const sourceRows = new Set(group.members.map((m) => m.sourceRow));

    const row =
      job.result.channel === 'lawyer-letter'
        ? job.result.lawyerLetterRows[index]
        : job.result.postcardRows[index];

    res.json({
      index,
      row,
      group: {
        target: group.target,
        neighbourhood: group.neighbourhood,
        landUse: group.landUse,
        tenure: group.tenure,
        address: group.address,
        fullAddress: group.fullAddress,
        registeredProprietor: group.registeredProprietor,
        mailingAddress: group.mailingAddress,
        distinctOwnerNames: group.distinctOwnerNames,
        notes: group.notes,
      },
      members: group.members.map((m) => ({
        sourceRow: m.sourceRow,
        ownerSlot: m.ownerSlot,
        addressId: m.addressId,
        propertyRaw: m.property.raw,
        numbers: m.property.numbers.join(' / '),
        street: m.property.street,
        conservationArea: m.property.conservationArea ?? '',
        postal: m.property.postal,
        ownerNameRaw: m.ownerNameRaw,
        ownerName: m.ownerName,
        ownerAddress: m.ownerAddress,
        isCorporate: m.isCorporate,
        declaredOwnerCount: m.declaredOwnerCount ?? null,
        gfaSqft: m.gfaSqft ?? null,
        benchmarkPsf: m.benchmarkPsf ?? null,
        notes: m.notes,
      })),
      merges: audit
        .filter((a) => a.sourceRows.some((r) => sourceRows.has(r)))
        .map((a) => ({ stage: a.stage, action: a.action, before: a.before, after: a.after })),
      flags: job.result.flags.filter((f) => {
        const rows = String(f.sourceRow).split(',').map((r) => Number(r.trim()));
        return rows.some((r) => sourceRows.has(r));
      }),
      crossCheck:
        job.crossCheck?.result.findings.filter((f) => f.row === index + 2) ?? [],
      bizfile:
        job.bizfile?.verifications.filter(
          (v) => normKeyLite(v.ownerName) === normKeyLite(group.registeredProprietor),
        ) ?? [],
    });
  } catch (error) {
    fail(res, error);
  }
});

/** GET /api/jobs/:id/audit — every merge decision the dedupe engine took. */
router.get('/jobs/:id/audit', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result) throw new Error('Nothing generated yet for this job');
    const audit = (job.result.dedupeAudit ?? []) as unknown[];
    res.json({ total: audit.length, rows: audit.slice(0, 1000) });
  } catch (error) {
    fail(res, error);
  }
});

/** GET /api/jobs/:id/bizfile/queue — corporate owners awaiting verification. */
router.get('/jobs/:id/bizfile/queue', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    const queue = buildBizfileQueue(job);
    res.json({ total: queue.length, rows: queue.slice(0, 500) });
  } catch (error) {
    fail(res, error);
  }
});

/** POST /api/jobs/:id/bizfile — run verification. Explicitly triggered by the user. */
router.post('/jobs/:id/bizfile', upload.single('file'), async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    const queue = buildBizfileQueue(job);
    if (queue.length === 0) throw new Error('No corporate owners to verify in this run');

    let resolve: (q: typeof queue) => Promise<import('../bizfile/types.js').BizFileVerification[]>;
    let resolverName: string;

    if (req.file) {
      const { wb, names } = readWorkbookSheets(req.file.path);
      const table = sheetToTable(wb, squash(req.body?.sheetName) || names[0]);
      const records = parseBizFileTable(table.headers, table.rows);
      if (records.length === 0) {
        throw new Error(
          'No BizFile records found in the upload. Expected columns like "Entity Name", "UEN", "Registered Office Address".',
        );
      }
      resolve = csvResolver(records);
      resolverName = `upload (${records.length} records from ${req.file.originalname})`;
    } else {
      if (process.env.BIZFILE_ENABLED !== '1') {
        throw new Error(
          'Live BizFile lookup is disabled. Either upload a BizFile export, or set BIZFILE_ENABLED=1 in .env after installing Playwright.',
        );
      }
      resolve = await playwrightResolver({
        delayMs: numberOr(process.env.BIZFILE_DELAY_MS, 4000),
        limit: numberOr(req.body?.limit, 100),
      });
      resolverName = 'bizfile.gov.sg (Playwright)';
    }

    const verifications = await resolve(queue);
    job.bizfile = { verifications, runAt: new Date(), resolver: resolverName };

    if (job.outputPath && existsSync(job.outputPath)) {
      await appendSheet(
        job.outputPath,
        SHEET_NAMES.bizfile,
        BIZFILE_SHEET_HEADERS,
        verificationsToRows(verifications),
      );
    }
    logStep(job, 'bizfile', `${verifications.length} owners verified via ${resolverName}`);
    res.json({ ...jobSummary(job), rows: verifications.slice(0, 200) });
  } catch (error) {
    fail(res, error);
  }
});

/** POST /api/jobs/:id/cross-check — Claude reviews the generated rows. */
router.post('/jobs/:id/cross-check', async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result) throw new Error('Nothing generated yet for this job');

    const result = await crossCheck(
      job.result.channel,
      {
        lawyerLetterRows: job.result.lawyerLetterRows,
        postcardRows: job.result.postcardRows,
      },
      {
        batchSize: numberOr(req.body?.batchSize, 40),
        concurrency: numberOr(req.body?.concurrency, 3),
        maxRows: req.body?.maxRows ? numberOr(req.body.maxRows, 0) : undefined,
      },
    );
    job.crossCheck = { result, runAt: new Date() };

    if (job.outputPath && existsSync(job.outputPath)) {
      await appendSheet(
        job.outputPath,
        SHEET_NAMES.claude,
        CLAUDE_SHEET_HEADERS,
        findingsToRows(result),
      );
    }
    logStep(
      job,
      'cross-check',
      `${result.rowsChecked} rows, ${result.findings.length} findings, model ${result.model}`,
    );
    res.json({ ...jobSummary(job), findings: result.findings.slice(0, 300) });
  } catch (error) {
    fail(res, error);
  }
});

/** POST /api/jobs/:id/mailmerge — validate a template and emit the Word merge script. */
router.post('/jobs/:id/mailmerge', upload.single('file'), (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result || !job.outputPath) throw new Error('Nothing generated yet for this job');
    if (!req.file) throw new Error('Upload the .docx template to validate against');

    const check = checkMergeFields(req.file.path, job.result.channel);
    const sheetName =
      job.result.channel === 'lawyer-letter' ? SHEET_NAMES.lawyerLetter : SHEET_NAMES.postcardFinal;
    const outDir = join(OUTPUT_DIR, `pdf-${job.id.slice(0, 8)}`);
    const script = generateWordMergeScript({
      templatePath: req.file.path,
      dataPath: job.outputPath,
      sheetName,
      outputDir: outDir,
      fileNameColumn: job.result.channel === 'lawyer-letter' ? 'Full_Address' : 'Owner Name',
      splitPerRecord: req.body?.splitPerRecord !== 'false',
    });
    const scriptPath = join(OUTPUT_DIR, `merge-${job.id.slice(0, 8)}.ps1`);
    writeFileSync(scriptPath, script, 'utf8');

    logStep(
      job,
      'mailmerge',
      check.ok
        ? `Template fields all present (${check.templateFields.length})`
        : `Template expects fields the sheet lacks: ${check.missingInSheet.join(', ')}`,
    );
    res.json({ check, scriptPath, sheetName, command: `powershell -File "${scriptPath}"` });
  } catch (error) {
    fail(res, error);
  }
});

/** Pull the institutions-to-avoid list out of the uploaded workbook, if it has one. */
function readInstitutionsFromWorkbook(path: string) {
  try {
    const { wb, names } = readWorkbookSheets(path);
    const sheetName = findInstitutionsSheetName(names);
    if (!sheetName) return undefined;
    return parseInstitutionsSheet(sheetToTable(wb, sheetName));
  } catch {
    return undefined;
  }
}

function buildBizfileQueue(job: import('./store.js').Job) {
  if (!job.result) throw new Error('Nothing generated yet for this job');
  const source =
    job.result.channel === 'lawyer-letter'
      ? job.result.lawyerLetterRows.map((r) => ({
          name: r.Registered_Proprietor,
          mailingAddress: r.Registered_Proprietor_mailing_address,
          address: r.Full_Address,
        }))
      : job.result.postcardRows.map((r) => ({
          name: r['Owner Name'],
          mailingAddress: r['Owner Address'],
          address: r['Full Address'],
        }));
  return collectCorporateOwners(source.filter((r) => isCorporateName(r.name)));
}

function summarise(values: string[]): { label: string; count: number }[] {
  const map = new Map<string, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Loose key for matching an owner name across the BizFile results. */
function normKeyLite(value: string): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}
