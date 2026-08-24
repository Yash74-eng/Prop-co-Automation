/** HTTP API behind the wizard UI. Every step is a separate, explicitly-triggered call. */
import { Router } from 'express';
import multer from 'multer';
import { basename, extname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  createJob,
  jobSummary,
  listJobs,
  logStep,
  ensureStorage,
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
import { outreachLabel, parseMainDatabase } from '../core/mainDatabase.js';
import { parseCompsTable } from '../core/comps.js';
import { defaultOptions, runPipeline } from '../core/pipeline.js';
import { findInstitutionsSheetName, loadConfig, parseInstitutionsSheet } from '../core/config.js';
import { buildWorkbook, SHEET_NAMES, writeWorkbook } from '../excel/write.js';
import { annotateWithBizFile, appendSheet } from '../excel/write.js';
import {
  ADDRESS_OVERRIDE_HEADERS,
  BIZFILE_COVERAGE_HEADERS,
  BIZFILE_SHEET_HEADERS,
  collectCorporateOwners,
  coverageRows,
  csvResolver,
  parseBizFileTable,
  parseCorrectedAddresses,
  playwrightResolver,
  verificationsToRows,
} from '../bizfile/resolver.js';
import {
  BizFileBlockedError,
  BizFileWindowClosedError,
  defaultSeleniumOptions,
  seleniumResolver,
} from '../bizfile/selenium.js';
import {
  defaultOpenDataOptions,
  openDataResolver,
  OpenDataUnavailableError,
} from '../bizfile/opendata.js';
import {
  defaultCompSelection,
  MARKET_WATCH_SHEET_URL,
  parseTransactionSheet,
} from '../comps/marketWatch.js';
import { defaultPricing } from '../comps/pricing.js';
import { CLAUDE_SHEET_HEADERS, crossCheck, findingsToRows } from '../verify/claude.js';
import { isCorporateName } from '../core/names.js';
import { formatDate, normKey, parseLooseDate, squash } from '../core/text.js';
import {
  buildTemplate,
  isTemplateKind,
  templateContentType,
  templateFileName,
  templateKinds,
} from '../excel/templates.js';
import {
  fetchAllTabs,
  fetchedSheetToXlsx,
  fetchMainDatabase,
  fetchSheet,
  listTabs,
  parseSheetUrl,
} from '../sheets/google.js';
import type { AddressOverride } from '../core/types.js';
import {
  checkMergeFields,
  generateWordMergeScript,
  runWordMerge,
  wordStatus,
} from '../mailmerge/wordMerge.js';
import { writeFileSync } from 'node:fs';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      // The folder can disappear under a running server — someone clears storage/ to
      // reclaim disk. Recreate it here so an upload heals the problem instead of failing.
      ensureStorage();
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
  }),
  limits: { fileSize: 80 * 1024 * 1024 },
});

export const router = Router();

function fail(res: import('express').Response, error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : String(error);
  res.status(status).json({ error: message });
}

/**
 * The job's source workbook, guaranteed to be on disk.
 *
 * A job lives in memory while its file lives on disk, and the two can part company —
 * `storage/` gets cleared to reclaim space, or a file ages out of the startup prune. The
 * old behaviour was a bare `ENOENT ... \storage\uploads\<uuid>.xlsx` from whichever route
 * touched it first, which reads like a bug in the app rather than a missing file.
 *
 * A job fetched from Google Sheets is reproducible, so re-fetch it and carry on. An
 * uploaded one is not, so say plainly that it has to be uploaded again.
 */
async function sourceFile(job: import('./store.js').Job): Promise<string> {
  if (existsSync(job.sourcePath)) return job.sourcePath;
  ensureStorage();

  const source = job.googleSheet;
  if (source) {
    const sheet = await fetchSheet({ spreadsheetId: source.spreadsheetId, gid: source.gid });
    const path = join(UPLOAD_DIR, `${randomUUID()}.xlsx`);
    await fetchedSheetToXlsx(sheet, path);
    job.sourcePath = path;
    job.sourceTable = undefined;
    job.googleSheet = { ...source, fetchedAt: sheet.fetchedAt, rows: sheet.rows.length };
    logStep(job, 'google-sheet', `Local copy was missing — re-fetched ${sheet.rows.length} rows`);
    return path;
  }

  throw new Error(
    `The uploaded workbook for this job is no longer on disk, so it cannot be read again. ` +
      'This happens when the storage folder is cleared. Upload the file again, or start from ' +
      'a Google Sheets link — those are re-fetched automatically when the local copy goes.',
  );
}

/** The comps spreadsheet, overridable per machine without a rebuild. */
export function compsSheetUrl(): string {
  return squash(process.env.COMPS_SHEET_URL) || MARKET_WATCH_SHEET_URL;
}

/** DD MMM YYYY HH:mm, for a note that says when a live fetch happened. */
function formatDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

/**
 * POST /api/jobs/from-google-sheet — read the tracker live instead of uploading an export.
 *
 * The fetched tab is written to an .xlsx and the job created from that file, so every
 * later step — preview, generate, comps, BizFile, mail merge — behaves identically to an
 * upload. One parsing path for "where the data came from" is worth a temporary file.
 */
router.post('/jobs/from-google-sheet', async (req, res) => {
  try {
    const url = squash(req.body?.url);
    const ref = parseSheetUrl(url);

    // An explicit gid means the operator picked a tab from the list, so honour it. With no
    // pick, go looking for the Main Database rather than trusting the tab that happened to
    // be open when the link was copied.
    const picked = req.body?.gid
      ? {
          sheet: await fetchSheet({ ...ref, gid: String(req.body.gid) }),
          reason: 'read the tab you chose',
          candidates: [] as string[],
        }
      : await fetchMainDatabase(ref);
    const { sheet } = picked;

    if (sheet.rows.length === 0) {
      throw new Error(
        `The tab "${sheet.sheetTitle}" is empty.` +
          (picked.candidates.length
            ? ` Tabs in this spreadsheet: ${picked.candidates.join(', ')}.`
            : ' Check the #gid= on the link — the fragment names the tab you are looking at.'),
      );
    }

    const path = join(UPLOAD_DIR, `${randomUUID()}.xlsx`);
    await fetchedSheetToXlsx(sheet, path);
    const { names } = readWorkbookSheets(path);
    const label = `${sheet.spreadsheetTitle} [${sheet.sheetTitle}]`;
    const job = createJob(path, label, names);
    job.googleSheet = {
      url,
      spreadsheetId: sheet.spreadsheetId,
      spreadsheetTitle: sheet.spreadsheetTitle,
      gid: sheet.gid,
      sheetTitle: sheet.sheetTitle,
      via: sheet.via,
      fetchedAt: sheet.fetchedAt,
      rows: sheet.rows.length,
    };
    // The tab a Google Sheet was fetched from is the Main Database by construction —
    // there is only one tab in the file we just wrote.
    job.sheetName = names[0];
    logStep(
      job,
      'google-sheet',
      `${sheet.rows.length} rows — ${picked.reason} (${sheet.via})`,
    );
    res.json({ ...jobSummary(job), tabChosen: sheet.sheetTitle, reason: picked.reason, candidates: picked.candidates });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * POST /api/jobs/:id/refresh-google-sheet — pull the tab again and rebuild.
 *
 * This is what "live" means for a batch tool: the sheet is re-read on demand and the whole
 * pipeline re-runs, rather than rows being patched in place. Dedupe keys on the mailing
 * address, so a changed address has to go in at the start or the groups end up wrong.
 */
router.post('/jobs/:id/refresh-google-sheet', async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    const source = job.googleSheet;
    if (!source) {
      throw new Error('This job was not created from a Google Sheet, so there is nothing to refresh');
    }

    const sheet = await fetchSheet({ spreadsheetId: source.spreadsheetId, gid: source.gid });
    if (sheet.rows.length === 0) {
      throw new Error(`The tab "${sheet.sheetTitle}" is now empty — refusing to replace the job with nothing`);
    }

    const rowsBefore = source.rows;
    const path = join(UPLOAD_DIR, `${randomUUID()}.xlsx`);
    await fetchedSheetToXlsx(sheet, path);
    const { names } = readWorkbookSheets(path);

    job.sourcePath = path;
    job.sourceFileName = `${sheet.spreadsheetTitle} [${sheet.sheetTitle}]`;
    job.sheetNames = names;
    job.sheetName = names[0];
    job.sourceTable = undefined;
    job.googleSheet = { ...source, fetchedAt: sheet.fetchedAt, rows: sheet.rows.length, via: sheet.via };

    // Verification results describe the rows that were there before. Keeping them would
    // let a verdict from the old fetch sit beside a row from the new one.
    const staleBizfile = !!job.bizfile;
    const staleCrossCheck = !!job.crossCheck;
    job.bizfile = undefined;
    job.crossCheck = undefined;

    let regenerated = false;
    if (job.options && job.result) {
      await regenerate(job, job.options, [
        `Re-fetched from ${job.sourceFileName} at ${formatDateTimeLocal(sheet.fetchedAt)}.`,
      ]);
      regenerated = true;
    }

    logStep(
      job,
      'google-sheet',
      `Re-fetched: ${rowsBefore} rows -> ${sheet.rows.length}` +
        (regenerated ? ', sheet rebuilt' : ', not yet generated'),
    );

    res.json({
      ...jobSummary(job),
      rowsBefore,
      rowsAfter: sheet.rows.length,
      regenerated,
      clearedBizfile: staleBizfile,
      clearedCrossCheck: staleCrossCheck,
    });
  } catch (error) {
    fail(res, error);
  }
});

/** GET /api/google-sheet/tabs?url=... — list the tabs so the right one can be picked. */
router.get('/google-sheet/tabs', async (req, res) => {
  try {
    const ref = parseSheetUrl(squash(req.query.url));
    const { spreadsheetTitle, tabs } = await listTabs(ref);
    res.json({ spreadsheetTitle, tabs, selectedGid: ref.gid ?? null });
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
router.get('/jobs/:id/sheets/:name/preview', async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    const { wb } = readWorkbookSheets(await sourceFile(job));
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

/**
 * POST /api/jobs/:id/comps — upload comps.
 *
 * Two shapes are accepted and told apart automatically, because asking which one you
 * have is a question the file can answer for itself:
 *
 *  - A **transactions sheet** in the Market Watch shape: one tab per district, columns
 *    including District, Price ($) and URA Zoning. Comps are then selected per property
 *    from its own district.
 *  - A **benchmark table**: one pre-computed row per neighbourhood, as before.
 */
router.post('/jobs/:id/comps', upload.single('file'), (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!req.file) throw new Error('No file uploaded');
    res.json(loadComps(job, req.file.path, req.file.originalname, squash(req.body?.sheetName)));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * POST /api/jobs/:id/comps-from-google-sheet — read the comps workbook live.
 *
 * Every tab is fetched, not just the one in the link: the Market Watch source keeps one
 * per district, and taking a single tab would quietly limit which districts can be priced.
 */
router.post('/jobs/:id/comps-from-google-sheet', async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    // Defaults to the Market Watch workbook: it is the same spreadsheet every time, and a
    // mistyped id would be a silent wrong-comps run rather than an error.
    const url = squash(req.body?.url) || compsSheetUrl();
    const ref = parseSheetUrl(url);

    const tabs = await fetchAllTabs(ref);
    const withRows = tabs.filter((t) => t.rows.length > 0);
    if (withRows.length === 0) throw new Error('Every tab in that spreadsheet is empty');

    const path = join(UPLOAD_DIR, `${randomUUID()}.xlsx`);
    await fetchedSheetToXlsx(withRows, path);
    const label = `${withRows[0].spreadsheetTitle} (live, ${withRows.length} tabs)`;
    const summary = loadComps(job, path, label, squash(req.body?.sheetName));

    job.compsGoogleSheet = {
      url,
      spreadsheetId: ref.spreadsheetId,
      spreadsheetTitle: withRows[0].spreadsheetTitle,
      tabs: withRows.length,
      fetchedAt: withRows[0].fetchedAt,
    };
    res.json({ ...summary, ...jobSummary(job) });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Load comps from a workbook on disk, whichever way it arrived.
 *
 * A transactions workbook and a benchmark table are told apart by their columns rather
 * than by how they were supplied, so an upload and a live fetch cannot diverge.
 */
function loadComps(
  job: import('./store.js').Job,
  path: string,
  label: string,
  sheetNameHint?: string,
) {
  const { wb, names } = readWorkbookSheets(path);

  // Try every tab as transactions first; a Market Watch workbook keeps one per district.
  const transactions: import('../comps/marketWatch.js').Transaction[] = [];
  const tabsUsed: string[] = [];
  for (const name of names) {
    const table = sheetToTable(wb, name);
    if (!looksLikeTransactions(table.headers)) continue;
    const rows = parseTransactionSheet(name, table.headers, table.rows);
    if (rows.length > 0) {
      transactions.push(...rows);
      tabsUsed.push(name);
    }
  }

  if (transactions.length > 0) {
    job.transactions = transactions;
    job.comps = [];
    const districts = [...new Set(transactions.map((t) => t.district))].sort((a, b) => a - b);
    job.compsSource =
      `${label} — ${transactions.length} transactions ` +
      `across ${districts.length} districts (${tabsUsed.length} tabs)`;
    logStep(job, 'comps', `Transactions loaded: ${job.compsSource}`);
    return {
      ...jobSummary(job),
      mode: 'transactions' as const,
      transactions: transactions.length,
      districts,
    };
  }

  const sheetName = sheetNameHint || names[0];
  job.transactions = undefined;
  job.comps = parseCompsTable(sheetToTable(wb, sheetName));
  job.compsSource = `${label} [${sheetName}]`;
  logStep(job, 'comps', `Replaced with ${job.comps.length} rows from ${job.compsSource}`);
  return jobSummary(job);
}

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
    const sourcePath = await sourceFile(job);
    const table = readSheet(sourcePath, sheetName || undefined);
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
        // A list of states is what the wizard sends; mode stays for the CLI.
        include: Array.isArray(body.outreachInclude) ? body.outreachInclude : undefined,
        mode: body.outreachMode ?? 'all',
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
      transactions: job.transactions,
      compSelection: defaultCompSelection({
        landOnly: body.compsLandOnly !== false,
        fullCommercialOnly: body.compsFullCommercialOnly !== false,
        recentPool: numberOr(body.compsRecentPool, 12),
        maxAgeMonths: numberOr(body.compsMaxAgeMonths, 36),
      }),
      pricing: defaultPricing({
        method: body.pricingMethod ?? 'figment-band',
        lowerBand: numberOr(body.pricingLowerBand, 0.05),
        upperBand: numberOr(body.pricingUpperBand, 0.1),
        rounding: numberOr(body.derivedRounding, 50_000),
      }),
    });

    // Institutions-to-avoid comes from the uploaded workbook when it carries the sheet,
    // so the tracker stays the source of truth; config/ is only a fallback.
    const config = loadConfig(readInstitutionsFromWorkbook(sourcePath));

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

/**
 * POST /api/jobs/:id/rerun-addresses — re-run everything with corrected addresses.
 *
 * A wrong mailing address cannot be patched into the finished sheet: dedupe and merging
 * key on the address, so correcting one can split or join recipients. The fix has to go in
 * at the start, which is why this re-runs the whole pipeline rather than editing rows.
 *
 * Corrections come from the last BizFile run, from an uploaded export, or both.
 */
router.post('/jobs/:id/rerun-addresses', upload.single('file'), async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.options || !job.result) throw new Error('Generate a sheet before re-running it');

    const overrides: Record<string, AddressOverride> = {};
    const skippedIncomplete: { ownerName: string; address: string }[] = [];
    // ACRA's open data carries street name and postal code but no block number, so an
    // override taken from it can replace a postable address with an unpostable one.
    // Refuse those by default rather than quietly degrading the sheet.
    const allowIncomplete = req.body?.allowIncomplete === 'true';
    // "BLK 123", "BLOCK 5", "No. 12" are all postable; only a bare street name is not.
    const hasBlockNumber = (address: string) => /^\s*(?:BLK|BLOCK|NO\.?)?\s*\d/i.test(address);

    const add = (ownerName: string, address: string, source: string) => {
      const name = squash(ownerName);
      const value = squash(address);
      if (!name || !value) return;
      if (!hasBlockNumber(value) && !allowIncomplete) {
        skippedIncomplete.push({ ownerName: name, address: value });
        return;
      }
      overrides[normKey(name)] = { address: value, source, ownerName: name };
    };

    // Which verdicts to take ACRA's address for. Default is mismatch only: those are the
    // rows where the sheet points at a different building entirely.
    const wanted: string[] = Array.isArray(req.body?.verdicts)
      ? req.body.verdicts
      : squash(req.body?.verdicts)
        ? String(req.body.verdicts).split(',').map((v) => v.trim())
        : ['mismatch'];

    if (req.body?.useBizfile !== 'false' && job.bizfile) {
      for (const v of job.bizfile.verifications) {
        if (!v.bizfileAddress || !wanted.includes(v.verdict)) continue;
        add(v.ownerName, v.bizfileAddress, `BizFile verification (${v.verdict})`);
      }
    }

    // An uploaded export wins over the stored verification — it is the newer statement,
    // and a purchased Business Profile carries block and unit that open data does not.
    let typedCorrections = 0;
    if (req.file) {
      const { wb, names } = readWorkbookSheets(req.file.path);

      // Addresses typed into a "Corrected Address" column. Every sheet is scanned because
      // that column lives on the deliverable tab, which is not necessarily the first one.
      const typed: { ownerName: string; address: string; sheet: string }[] = [];
      for (const name of names) {
        try {
          const table = sheetToTable(wb, name, 1);
          for (const c of parseCorrectedAddresses(table.headers, table.rows)) {
            typed.push({ ...c, sheet: name });
          }
        } catch {
          // A sheet that will not read is simply not a source of corrections.
        }
      }

      // A BizFile / Business Profile export, if that is what was uploaded.
      const table = sheetToTable(wb, squash(req.body?.sheetName) || names[0]);
      const records = parseBizFileTable(table.headers, table.rows);
      if (records.length === 0 && typed.length === 0) {
        throw new Error(
          'Nothing to apply from this upload. Expected either a "Corrected Address" column ' +
            'beside the owner names, or an export with "Entity Name" and "Registered Office Address".',
        );
      }
      for (const r of records) {
        if (!r.registeredAddress) continue;
        add(r.name, r.registeredAddress, `upload (${req.file.originalname})`);
      }

      // Applied last, so a hand-typed address beats both ACRA and the export. Someone
      // looked at this row and decided; that outranks any automatic source.
      for (const c of typed) {
        add(c.ownerName, c.address, `typed into "${c.sheet}"`);
        typedCorrections++;
      }
    }

    const count = Object.keys(overrides).length;
    if (count === 0) {
      if (skippedIncomplete.length > 0) {
        throw new Error(
          `All ${skippedIncomplete.length} corrections were rejected because they have no block number — ` +
            'ACRA open data carries street and postal code only, so using them would replace postable ' +
            'addresses with unpostable ones. Upload a purchased Business Profile export for the full ' +
            'address, or re-send with allowIncomplete=true if you accept the risk.',
        );
      }
      throw new Error(
        'No corrected addresses to apply. Run the BizFile check first, or upload an export with a "Registered Office Address" column.',
      );
    }

    const options = { ...job.options, ownerAddressOverrides: overrides };
    const summary = await regenerate(job, options, [
      `Re-run with ${count} corrected addresses applied before dedupe.`,
    ]);

    logStep(
      job,
      'rerun',
      `${count} corrected addresses offered, ${summary.applied} rows changed -> ${summary.recipients} recipients`,
    );

    res.json({
      ...jobSummary(job),
      offered: count,
      typedCorrections,
      applied: summary.applied,
      skippedIncomplete: skippedIncomplete.length,
      skippedSamples: skippedIncomplete.slice(0, 10),
      recipientsBefore: summary.before,
      recipientsAfter: summary.recipients,
      overrides: (job.result.appliedAddressOverrides ?? []).slice(0, 200),
    });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Re-run the pipeline for a job with the given options and rewrite its workbook.
 * Keeps the BizFile sheets attached, since they are still the evidence for the change.
 */
async function regenerate(
  job: import('./store.js').Job,
  options: import('../core/types.js').PipelineOptions,
  extraNotes: string[],
): Promise<{ applied: number; before: number; recipients: number }> {
  const before =
    job.result?.channel === 'lawyer-letter'
      ? (job.result?.lawyerLetterRows.length ?? 0)
      : (job.result?.postcardRows.length ?? 0);

  const path = await sourceFile(job);
  const table = job.sourceTable ?? readSheet(path, job.sheetName || undefined);
  const db = parseMainDatabase(table);
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
      ...extraNotes,
      'The uploaded workbook was not modified.',
    ],
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const label = result.channel === 'lawyer-letter' ? 'Lawyer-Letter' : 'Postcard';
  job.outputFileName = `PropCo ${label} ${stamp} ${job.id.slice(0, 8)}.xlsx`;
  job.outputPath = join(OUTPUT_DIR, job.outputFileName);
  await writeWorkbook(wb, job.outputPath);

  const applied = result.appliedAddressOverrides ?? [];
  if (applied.length > 0) {
    await appendSheet(
      job.outputPath,
      SHEET_NAMES.addressOverrides,
      ADDRESS_OVERRIDE_HEADERS,
      applied.map((o) => [
        o.ownerName,
        o.sourceRow,
        o.previousAddress,
        o.newAddress,
        o.source,
      ]),
    );
  }
  // Carry the verification evidence onto the new workbook.
  if (job.bizfile) {
    await appendSheet(
      job.outputPath,
      SHEET_NAMES.bizfile,
      BIZFILE_SHEET_HEADERS,
      verificationsToRows(job.bizfile.verifications),
    );
    await appendSheet(
      job.outputPath,
      SHEET_NAMES.bizfileCoverage,
      BIZFILE_COVERAGE_HEADERS,
      coverageRows(job.bizfile.verifications, {
        resolver: job.bizfile.resolver,
        runAt: job.bizfile.runAt,
      }),
    );
    await annotateDeliverable(job, job.bizfile.verifications);
  }

  return {
    applied: applied.length,
    before,
    recipients:
      result.channel === 'lawyer-letter'
        ? result.lawyerLetterRows.length
        : result.postcardRows.length,
  };
}

/**
 * GET /api/templates/:kind — a starter workbook for one step, with the exact headers the
 * matching upload expects plus a worked example.
 */
router.get('/templates/:kind', async (req, res) => {
  try {
    const kind = String(req.params.kind);
    if (!isTemplateKind(kind)) {
      throw new Error(`Unknown template "${kind}". Available: ${templateKinds().join(', ')}`);
    }
    const buffer = await buildTemplate(kind);
    res.setHeader('Content-Type', templateContentType(kind));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${templateFileName(kind)}"`,
    );
    res.send(buffer);
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
      // Words, not internal state names: "Sent, but came back undelivered" instead of
      // "delivery-failed", so the breakdown reads without a decoder.
      outreach: Object.entries(s)
        .filter(([k]) => k.startsWith('outreach_'))
        .map(([k, v]) => ({
          label: outreachLabel(k.replace('outreach_', '')),
          count: v,
        })),
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
    if (job.bizfileRun && !job.bizfileRun.finishedAt) {
      throw new Error(
        `A BizFile run is already in progress (${job.bizfileRun.done} of ${job.bizfileRun.total}). Wait for it to finish.`,
      );
    }
    const queue = buildBizfileQueue(job);
    if (queue.length === 0) throw new Error('No corporate owners to verify in this run');

    let resolve: (q: typeof queue) => Promise<import('../bizfile/types.js').BizFileVerification[]>;
    let resolverName: string;
    // Progress is reported into job.bizfileRun so a minutes-long batch stays visible.
    const onProgress = (done: number, total: number, current: string) => {
      if (job.bizfileRun) Object.assign(job.bizfileRun, { done, total, current });
    };

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
          'Live BizFile lookup is disabled. Either upload a BizFile export, or set BIZFILE_ENABLED=1 in .env.',
        );
      }
      const driver = process.env.BIZFILE_DRIVER ?? 'opendata';

      // ACRA's open-data publication: same registry, no gate, whole queue in one run.
      if (driver === 'opendata') {
        resolve = await openDataResolver(
          defaultOpenDataOptions({
            limit: Math.min(numberOr(req.body?.limit, 1000), 5000),
            timeoutMs: numberOr(process.env.BIZFILE_TIMEOUT_MS, 30_000),
            delayMs: numberOr(process.env.BIZFILE_DELAY_MS, 400),
            onProgress,
          }),
        );
        resolverName = 'ACRA open data (data.gov.sg)';
      } else {
        // Browser scraping of bizfile.gov.sg is capped hard: it is rate-sensitive and
        // reCAPTCHA-gated, so a run is a small sample to check against, not a bulk pull.
        const limit = Math.min(numberOr(req.body?.limit, 10), 25);
        const delayMs = numberOr(process.env.BIZFILE_DELAY_MS, 4000);

        if (driver === 'playwright') {
          resolve = await playwrightResolver({ delayMs, limit });
          resolverName = 'bizfile.gov.sg (Playwright)';
        } else {
          resolve = await seleniumResolver(
            defaultSeleniumOptions({
              timeoutMs: numberOr(process.env.BIZFILE_TIMEOUT_MS, 30_000),
              delayMs,
              limit,
              headful: process.env.BIZFILE_HEADFUL !== '0',
            }),
          );
          resolverName = `bizfile.gov.sg (Selenium, ${limit} max)`;
        }
      }
    }

    // Verifying a full queue takes minutes — longer than a browser holds a request open.
    // Start the work, hand back 202, and let the client poll job.bizfileRun.
    job.bizfileRun = {
      total: queue.length,
      done: 0,
      current: '',
      resolver: resolverName,
      startedAt: new Date(),
    };
    logStep(job, 'bizfile', `started: ${queue.length} owners via ${resolverName}`);

    void (async () => {
      try {
        const verifications = await resolve(queue);
        const runAt = new Date();
        job.bizfile = { verifications, runAt, resolver: resolverName };
        if (job.outputPath && existsSync(job.outputPath)) {
          await appendSheet(
            job.outputPath,
            SHEET_NAMES.bizfile,
            BIZFILE_SHEET_HEADERS,
            verificationsToRows(verifications),
          );
          // A separate sheet stating how much of the queue was actually answered, so the
          // coverage number is not something you have to work out from the verdict list.
          await appendSheet(
            job.outputPath,
            SHEET_NAMES.bizfileCoverage,
            BIZFILE_COVERAGE_HEADERS,
            coverageRows(verifications, {
              resolver: resolverName,
              runAt,
              queueTotal: queue.length,
            }),
          );
          // Put the verdict beside the address it is about, on the sheet being sent.
          // Cross-referencing two tabs by owner name is how a mismatch gets found at the
          // printer instead of at review.
          const inline = await annotateDeliverable(job, verifications);
          if (inline) {
            logStep(
              job,
              'bizfile',
              `${SHEET_NAMES[job.result?.channel === 'lawyer-letter' ? 'lawyerLetter' : 'postcardFinal']}: ` +
                `${inline.matched} of ${inline.annotated} rows carry a verdict inline`,
            );
          }
        }
        logStep(job, 'bizfile', `${verifications.length} owners verified via ${resolverName}`);
        if (job.bizfileRun) job.bizfileRun.finishedAt = new Date();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Nothing is recorded on failure — a partial or gated run would write verdicts
        // that read like real answers.
        if (job.bizfileRun) {
          job.bizfileRun.error = message;
          job.bizfileRun.finishedAt = new Date();
        }
        logStep(job, 'bizfile', `failed: ${message}`);
      }
    })();

    res.status(202).json(jobSummary(job));
  } catch (error) {
    // A blocked scrape is not a normal failure: nothing is recorded, because a partial or
    // gated run would write false "not-found" verdicts onto the audit sheet.
    if (
      error instanceof BizFileBlockedError ||
      error instanceof BizFileWindowClosedError ||
      error instanceof OpenDataUnavailableError
    ) {
      res.status(502).json({ error: error.message, blocked: true });
      return;
    }
    fail(res, error);
  }
});

/** POST /api/jobs/:id/cross-check — Claude reviews the generated rows. */
router.post('/jobs/:id/cross-check', async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result) throw new Error('Nothing generated yet for this job');
    if (job.crossCheckRun && !job.crossCheckRun.finishedAt) {
      throw new Error(
        `A cross-check is already running (${job.crossCheckRun.done} of ${job.crossCheckRun.total} batches).`,
      );
    }

    const channel = job.result.channel;
    const rows = {
      lawyerLetterRows: job.result.lawyerLetterRows,
      postcardRows: job.result.postcardRows,
    };
    const batchSize = numberOr(req.body?.batchSize, 40);
    const maxRows = req.body?.maxRows ? numberOr(req.body.maxRows, 0) : undefined;
    const rowCount = Math.min(
      maxRows ?? Number.POSITIVE_INFINITY,
      channel === 'lawyer-letter' ? rows.lawyerLetterRows.length : rows.postcardRows.length,
    );

    // Remembered on the job so a re-run keeps them and the UI can show what was applied.
    // Capped because they ride in the cached system prefix of every batch.
    const extraInstructions = squash(req.body?.instructions).slice(0, 4000);
    job.crossCheckInstructions = extraInstructions || undefined;

    // A full sheet is dozens of batches and runs for minutes — well past what a browser
    // will hold a request open for. Start the work, answer 202, and let the UI poll.
    job.crossCheckRun = {
      total: Math.max(1, Math.ceil(rowCount / batchSize)),
      done: 0,
      startedAt: new Date(),
    };
    logStep(
      job,
      'cross-check',
      `started: ${rowCount} rows in ${job.crossCheckRun.total} batches` +
        (extraInstructions ? ' with your own instructions added' : ''),
    );

    void (async () => {
      try {
        const result = await crossCheck(channel, rows, {
          batchSize,
          concurrency: numberOr(req.body?.concurrency, 3),
          maxRows,
          extraInstructions,
          onProgress: (done, total) => {
            if (job.crossCheckRun) Object.assign(job.crossCheckRun, { done, total });
          },
        });
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
        if (job.crossCheckRun) job.crossCheckRun.finishedAt = new Date();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.crossCheckRun) {
          job.crossCheckRun.error = message;
          job.crossCheckRun.finishedAt = new Date();
        }
        logStep(job, 'cross-check', `failed: ${message}`);
      }
    })();

    res.status(202).json(jobSummary(job));
  } catch (error) {
    fail(res, error);
  }
});

const mergeUpload = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'data', maxCount: 1 },
]);

/**
 * POST /api/jobs/:id/mailmerge — set up the merge.
 *
 * Takes the .docx template and, optionally, the operator's own edited workbook to merge
 * from. The final sheet is normally corrected by hand after BizFile and the Claude
 * cross-check, so merging from the server's copy would print superseded data.
 */
router.post('/jobs/:id/mailmerge', mergeUpload, (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.result || !job.outputPath) throw new Error('Nothing generated yet for this job');

    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const templateFile = files?.file?.[0];
    const dataFile = files?.data?.[0];
    const templatePath = templateFile?.path ?? job.merge?.templatePath;
    if (!templatePath) throw new Error('Upload the .docx template to merge with');

    const generatedSheet =
      job.result.channel === 'lawyer-letter' ? SHEET_NAMES.lawyerLetter : SHEET_NAMES.postcardFinal;

    // Each call fully defines the setup: an uploaded workbook is the operator's edited
    // copy, no upload means merge from the generated one. Its recipient tab may have been
    // renamed, so fall back to whichever sheet carries the address column.
    const dataPath = dataFile?.path ?? job.outputPath;
    const sheetName = dataFile ? pickMergeSheet(dataFile.path, generatedSheet) : generatedSheet;

    // Validate the template against the headers of the data actually being merged, not
    // against the headers this tool would have written — those can differ once edited.
    const { headers, rows } = readMergeTable(dataPath, sheetName);
    const check = checkMergeFields(templatePath, job.result.channel, headers);

    job.merge = {
      templatePath,
      templateName: templateFile?.originalname ?? job.merge?.templateName ?? 'template.docx',
      dataPath,
      dataName: dataFile?.originalname ?? job.outputFileName ?? 'generated workbook',
      dataIsUpload: !!dataFile,
      sheetName,
      dataRows: rows.length,
      outputDir: join(OUTPUT_DIR, `pdf-${job.id.slice(0, 8)}`),
      check,
      pdfs: job.merge?.pdfs ?? [],
      lastRunAt: job.merge?.lastRunAt,
      lastRunLimit: job.merge?.lastRunLimit,
    };

    logStep(
      job,
      'mailmerge',
      check.ok
        ? `Template fields all present (${check.templateFields.length}) against ${sheetName}`
        : `Template expects fields "${sheetName}" lacks: ${check.missingInSheet.join(', ')}`,
    );
    res.json(jobSummary(job));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * POST /api/jobs/:id/mailmerge/run — drive Word and export PDFs.
 *
 * Returns 202: a full run is one Word document per recipient and takes minutes, far
 * longer than a browser holds a request open. The UI polls `mergeRun` for progress.
 */
router.post('/jobs/:id/mailmerge/run', async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    const merge = job.merge;
    if (!merge) throw new Error('Set up the merge first — upload the template');
    if (job.mergeRun && !job.mergeRun.finishedAt) throw new Error('A merge is already running');
    const word = await wordStatus();
    if (!word.available) {
      throw new Error(
        `${word.reason} You can still download the merge script below and run it on a PC that can.`,
      );
    }

    const limit = Math.max(0, Math.trunc(Number(req.body?.limit ?? 0) || 0));
    const splitPerRecord = req.body?.splitPerRecord !== false;

    // Start clean: a shorter run must not leave PDFs from a longer one behind, or the zip
    // ships records the operator never approved.
    rmSync(merge.outputDir, { recursive: true, force: true });
    mkdirSync(merge.outputDir, { recursive: true });
    merge.pdfs = [];

    const pidPath = join(OUTPUT_DIR, `merge-word-${job.id.slice(0, 8)}.pid`);
    rmSync(pidPath, { force: true });
    const { scriptPath, rows } = writeMergeScript(job.id, merge, { limit, splitPerRecord, pidPath });

    const total = limit > 0 ? Math.min(limit, rows) : rows;
    job.mergeRun = { total, done: 0, limit: limit || undefined, startedAt: new Date() };

    void (async () => {
      try {
        const run = await runWordMerge(scriptPath, { pidPath }, (done) => {
          if (job.mergeRun) job.mergeRun.done = done;
        });
        merge.pdfs = readdirSync(merge.outputDir)
          .filter((n) => n.toLowerCase().endsWith('.pdf'))
          .sort()
          .map((n) => join(merge.outputDir, n));
        merge.lastRunAt = new Date();
        merge.lastRunLimit = limit || undefined;

        if (job.mergeRun) {
          job.mergeRun.done = merge.pdfs.length;
          job.mergeRun.finishedAt = new Date();
        }
        logStep(
          job,
          'mailmerge',
          `${merge.pdfs.length} PDF(s) from ${merge.sheetName}` +
            (limit ? ` (first ${limit} of ${run.available})` : ` (${run.available} records)`),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.mergeRun) {
          job.mergeRun.error = message;
          job.mergeRun.finishedAt = new Date();
        }
        logStep(job, 'mailmerge', `failed: ${message}`);
      }
    })();

    res.status(202).json(jobSummary(job));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * GET /api/jobs/:id/mailmerge/script — the PowerShell script, to run on a PC with Word.
 *
 * Generated on demand rather than left over from a run: this is the escape hatch for a
 * machine that cannot produce PDFs itself, where no run will ever have happened.
 */
router.get('/jobs/:id/mailmerge/script', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    if (!job.merge) throw new Error('Set up the merge first — upload the template');
    const { scriptPath } = writeMergeScript(job.id, job.merge, {
      limit: 0,
      splitPerRecord: true,
    });
    res.download(scriptPath, 'run-mail-merge.ps1');
  } catch (error) {
    fail(res, error, 404);
  }
});

/** GET /api/jobs/:id/mailmerge/pdf/:index — one PDF inline, for the single-record check. */
router.get('/jobs/:id/mailmerge/pdf/:index', (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    const pdfs = job.merge?.pdfs ?? [];
    const index = Number(req.params.index);
    const path = pdfs[index];
    if (!path || !existsSync(path)) throw new Error('No such PDF — run the merge first');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${basename(path)}"`);
    res.sendFile(path);
  } catch (error) {
    fail(res, error, 404);
  }
});

/** GET /api/jobs/:id/mailmerge/pdfs — every PDF from the last run, zipped. */
router.get('/jobs/:id/mailmerge/pdfs', async (req, res) => {
  try {
    const job = requireJob(String(req.params.id));
    const pdfs = (job.merge?.pdfs ?? []).filter((p) => existsSync(p));
    if (pdfs.length === 0) throw new Error('No PDFs yet — run the merge first');

    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (const path of pdfs) zip.file(basename(path), readFileSync(path));
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="propco-letters-${job.id.slice(0, 8)}.zip"`,
    );
    res.send(buffer);
  } catch (error) {
    fail(res, error, 404);
  }
});

/**
 * Add the BizFile verdict columns to whichever sheet this job's channel actually posts:
 * Postcards Final, or the Lawyer Letter sheet. Both carry an owner name and a mailing
 * address, and a wrong address costs the same either way.
 */
async function annotateDeliverable(
  job: import('./store.js').Job,
  verifications: import('../bizfile/types.js').BizFileVerification[],
): Promise<{ annotated: number; matched: number } | undefined> {
  if (!job.outputPath || !job.result) return undefined;
  const letter = job.result.channel === 'lawyer-letter';
  try {
    return await annotateWithBizFile(
      job.outputPath,
      letter ? SHEET_NAMES.lawyerLetter : SHEET_NAMES.postcardFinal,
      letter ? 'Registered_Proprietor' : 'Owner Name',
      letter ? 'Registered_Proprietor_mailing_address' : 'Owner Address',
      verifications,
    );
  } catch (error) {
    // The evidence sheets are already written; failing to decorate the deliverable must
    // not lose the run.
    logStep(
      job,
      'bizfile',
      `could not add verdict columns to the deliverable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Write the merge script and its PDF-name list, and report how many records are in play. */
function writeMergeScript(
  jobId: string,
  merge: NonNullable<import('./store.js').Job['merge']>,
  options: { limit: number; splitPerRecord: boolean; pidPath?: string },
): { scriptPath: string; rows: number } {
  const { headers, rows } = readMergeTable(merge.dataPath, merge.sheetName);
  if (rows.length === 0) throw new Error(`Sheet "${merge.sheetName}" has no rows to merge`);

  const labelsPath = join(OUTPUT_DIR, `merge-labels-${jobId.slice(0, 8)}.txt`);
  writeFileSync(labelsPath, mergeLabels(headers, rows).join('\n'), 'utf8');

  const scriptPath = join(OUTPUT_DIR, `merge-${jobId.slice(0, 8)}.ps1`);
  writeFileSync(
    scriptPath,
    generateWordMergeScript({
      templatePath: merge.templatePath,
      dataPath: merge.dataPath,
      sheetName: merge.sheetName,
      outputDir: merge.outputDir,
      labelsPath,
      pidPath: options.pidPath,
      splitPerRecord: options.splitPerRecord,
      limit: options.limit,
    }),
    'utf8',
  );
  return { scriptPath, rows: rows.length };
}

/** Read a merge data source exactly the way Word's OLEDB driver will: header on row 1. */
function readMergeTable(path: string, sheetName: string) {
  const { wb, names } = readWorkbookSheets(path);
  if (!names.includes(sheetName)) {
    throw new Error(`Sheet "${sheetName}" not found. This file has: ${names.join(', ')}`);
  }
  const table = sheetToTable(wb, sheetName, 1);
  // Word skips nothing, but a sheet exported from Google Sheets carries trailing blanks;
  // dropping them here keeps the label list aligned with the records Word will see.
  const rows = table.rows.filter((cells) => cells.some((c) => squash(c).length > 0));
  return { headers: table.headers, rows };
}

/**
 * Pick the recipient tab out of an uploaded workbook. Prefer the name this tool writes,
 * then any sheet carrying an address column — the operator may have renamed the tab or
 * pasted the rows into a fresh file. Both channels spell it "Full Address" or
 * "Full_Address", which normalise to the same key.
 */
function pickMergeSheet(path: string, preferred: string): string {
  const { wb, names } = readWorkbookSheets(path);
  if (names.includes(preferred)) return preferred;

  for (const name of names) {
    try {
      const keys = sheetToTable(wb, name, 1).headers.map((h) => normKey(h).replace(/[^A-Z0-9]/g, ''));
      if (keys.includes('FULLADDRESS')) return name;
    } catch {
      // A sheet we cannot read is simply not a candidate.
    }
  }
  return names[0];
}

/** Name each PDF after its recipient. Falls back through the columns most likely present. */
function mergeLabels(headers: string[], rows: unknown[][]): string[] {
  const index = (candidates: string[]) => {
    const keys = headers.map((h) => normKey(h).replace(/[^A-Z0-9]/g, ''));
    for (const c of candidates) {
      const i = keys.indexOf(c);
      if (i >= 0) return i;
    }
    return -1;
  };
  const addressCol = index(['FULLADDRESS', 'ADDRESS', 'PROPERTYADDRESS']);
  const ownerCol = index(['REGISTEREDPROPRIETOR', 'OWNERNAME', 'OWNER']);

  return rows.map((cells, i) => {
    const address = addressCol >= 0 ? squash(cells[addressCol]) : '';
    const owner = ownerCol >= 0 ? squash(cells[ownerCol]) : '';
    return address || owner || `record-${i + 1}`;
  });
}

/** Pull the institutions-to-avoid list out of the uploaded workbook, if it has one. */
/**
 * A transactions tab is recognised by the three columns the selection rule needs:
 * which district, what it sold for, and how it is zoned.
 */
function looksLikeTransactions(headers: string[]): boolean {
  const keys = headers.map((h) => normKey(h));
  const has = (pattern: RegExp) => keys.some((k) => pattern.test(k));
  return has(/^DISTRICT$/) && has(/^PRICE/) && has(/URA ZONING|^ZONING/);
}

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
