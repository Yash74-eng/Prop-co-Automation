/**
 * Job store. One job = one uploaded workbook and everything generated from it.
 *
 * State lives in memory with the files on disk under STORAGE_DIR, which is enough for a
 * single-operator desktop tool and keeps confidential owner data out of any database.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompsRecord, PipelineOptions, PipelineResult } from '../core/types.js';
import { SheetTable } from '../core/mainDatabase.js';
import { BizFileVerification } from '../bizfile/types.js';
import { CrossCheckResult } from '../verify/claude.js';

export const STORAGE_DIR = resolve(process.env.STORAGE_DIR ?? 'storage');
export const UPLOAD_DIR = join(STORAGE_DIR, 'uploads');
export const OUTPUT_DIR = join(STORAGE_DIR, 'outputs');

for (const dir of [STORAGE_DIR, UPLOAD_DIR, OUTPUT_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface Job {
  id: string;
  createdAt: Date;
  /** Uploaded workbook. */
  sourcePath: string;
  sourceFileName: string;
  /** Sheet chosen as the Main Database. */
  sheetName?: string;
  sheetNames: string[];
  /** Parsed source table, kept so the output can preserve the original verbatim. */
  sourceTable?: SheetTable;
  comps: CompsRecord[];
  compsSource: string;
  /**
   * Where the source rows came from, when they were pulled live rather than uploaded.
   * Kept so the same tab can be re-fetched without asking for the link again.
   */
  googleSheet?: {
    url: string;
    spreadsheetId: string;
    spreadsheetTitle: string;
    gid?: string;
    sheetTitle: string;
    via: 'service-account' | 'anonymous-csv';
    fetchedAt: Date;
    rows: number;
  };
  /** The live comps workbook, when comps were fetched rather than uploaded. */
  compsGoogleSheet?: {
    url: string;
    spreadsheetId: string;
    spreadsheetTitle: string;
    tabs: number;
    fetchedAt: Date;
  };
  suppressionCount: number;
  /** Transactions from a Market Watch style upload, when one was supplied. */
  transactions?: import('../comps/marketWatch.js').Transaction[];
  options?: PipelineOptions;
  result?: PipelineResult & { dedupeAudit?: unknown[] };
  outputPath?: string;
  outputFileName?: string;
  bizfile?: { verifications: BizFileVerification[]; runAt: Date; resolver: string };
  /**
   * Progress of an in-flight BizFile run. A full queue takes minutes, which is far longer
   * than a browser will hold a request open, so the route starts the work and returns; the
   * UI polls this.
   */
  bizfileRun?: {
    total: number;
    done: number;
    current: string;
    resolver: string;
    startedAt: Date;
    finishedAt?: Date;
    error?: string;
  };
  crossCheck?: { result: CrossCheckResult; runAt: Date };
  /**
   * The operator's own cross-check instructions, kept between runs so a second pass does
   * not silently revert to the built-in rules only.
   */
  crossCheckInstructions?: string;
  /**
   * Progress of an in-flight Claude cross-check. A full sheet is dozens of batches and
   * takes minutes — longer than a browser holds a request open — so the route starts the
   * work and returns; the UI polls this.
   */
  crossCheckRun?: {
    total: number;
    done: number;
    startedAt: Date;
    finishedAt?: Date;
    error?: string;
  };
  /**
   * The merge setup, kept on the job so the template and the chosen data source survive
   * between "validate", "test one" and "run all". Re-uploading the same two files three
   * times to do one job is the friction this removes.
   */
  merge?: {
    templatePath: string;
    templateName: string;
    /** Data source in use — the generated workbook, or an edited copy the operator uploaded. */
    dataPath: string;
    dataName: string;
    dataIsUpload: boolean;
    sheetName: string;
    /** Records that sheet holds — what "run all" will actually produce. */
    dataRows: number;
    outputDir: string;
    check: import('../mailmerge/wordMerge.js').MergeFieldCheck;
    /** PDFs on disk from the last completed run, newest run wins. */
    pdfs: string[];
    lastRunAt?: Date;
    /** Record cap of the last run — 1 means it was a single-record proof. */
    lastRunLimit?: number;
  };
  mergeRun?: {
    total: number;
    done: number;
    limit?: number;
    startedAt: Date;
    finishedAt?: Date;
    error?: string;
  };
  log: { at: Date; step: string; message: string }[];
}

const jobs = new Map<string, Job>();

export function createJob(sourcePath: string, sourceFileName: string, sheetNames: string[]): Job {
  const job: Job = {
    id: randomUUID(),
    createdAt: new Date(),
    sourcePath,
    sourceFileName,
    sheetNames,
    comps: [],
    compsSource: 'none',
    suppressionCount: 0,
    log: [],
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function requireJob(id: string): Job {
  const job = jobs.get(id);
  if (!job) throw new Error(`Job not found: ${id}`);
  return job;
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function logStep(job: Job, step: string, message: string): void {
  job.log.push({ at: new Date(), step, message });
  // Keep the log bounded so a long session cannot grow without limit.
  if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
}

/** Public view of a job — never leaks absolute paths to the browser. */
export function jobSummary(job: Job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    sourceFileName: job.sourceFileName,
    sheetName: job.sheetName,
    sheetNames: job.sheetNames,
    compsRows: job.comps.length,
    compsSource: job.compsSource,
    googleSheet: job.googleSheet ?? null,
    compsGoogleSheet: job.compsGoogleSheet ?? null,
    suppressionCount: job.suppressionCount,
    hasResult: !!job.result,
    outputFileName: job.outputFileName,
    stats: job.result?.stats ?? null,
    warnings: job.result?.warnings ?? [],
    channel: job.result?.channel ?? null,
    bizfile: job.bizfile
      ? {
          runAt: job.bizfile.runAt,
          resolver: job.bizfile.resolver,
          count: job.bizfile.verifications.length,
          verdicts: countBy(job.bizfile.verifications.map((v) => v.verdict)),
        }
      : null,
    bizfileRun: job.bizfileRun
      ? {
          ...job.bizfileRun,
          running: !job.bizfileRun.finishedAt,
        }
      : null,
    crossCheckRun: job.crossCheckRun
      ? {
          ...job.crossCheckRun,
          running: !job.crossCheckRun.finishedAt,
        }
      : null,
    merge: job.merge
      ? {
          templateName: job.merge.templateName,
          dataName: job.merge.dataName,
          dataIsUpload: job.merge.dataIsUpload,
          sheetName: job.merge.sheetName,
          dataRows: job.merge.dataRows,
          check: job.merge.check,
          pdfCount: job.merge.pdfs.length,
          pdfNames: job.merge.pdfs.slice(0, 12).map((p) => p.split(/[\\/]/).pop() ?? p),
          lastRunAt: job.merge.lastRunAt,
          lastRunLimit: job.merge.lastRunLimit,
        }
      : null,
    mergeRun: job.mergeRun
      ? {
          ...job.mergeRun,
          running: !job.mergeRun.finishedAt,
        }
      : null,
    crossCheckInstructions: job.crossCheckInstructions ?? '',
    crossCheck: job.crossCheck
      ? {
          runAt: job.crossCheck.runAt,
          rowsChecked: job.crossCheck.result.rowsChecked,
          model: job.crossCheck.result.model,
          findings: job.crossCheck.result.findings.length,
          severities: countBy(job.crossCheck.result.findings.map((f) => f.severity)),
          errors: job.crossCheck.result.errors,
        }
      : null,
    log: job.log.slice(-40),
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Delete upload/output files older than the given age. Called on startup. */
export function pruneStorage(maxAgeHours = 72): number {
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  let removed = 0;
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path, { force: true });
          removed++;
        }
      } catch {
        // A file that vanished between readdir and stat is not an error.
      }
    }
  }
  return removed;
}
