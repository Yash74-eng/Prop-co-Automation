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
  suppressionCount: number;
  options?: PipelineOptions;
  result?: PipelineResult & { dedupeAudit?: unknown[] };
  outputPath?: string;
  outputFileName?: string;
  bizfile?: { verifications: BizFileVerification[]; runAt: Date; resolver: string };
  crossCheck?: { result: CrossCheckResult; runAt: Date };
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
