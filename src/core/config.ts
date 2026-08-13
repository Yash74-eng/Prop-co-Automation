/**
 * Runtime configuration for the lists that are confidential or change often.
 *
 * Nothing Figment-specific is hardcoded in this repository. The institutions-to-avoid
 * list is competitive intelligence and the developer list is a business judgement, so
 * both are loaded at runtime from:
 *
 *   1. the uploaded workbook's own "Institutions to Avoid" sheet — the source of truth,
 *      so the tool never runs against a stale copy;
 *   2. a git-ignored JSON file under `config/`, as an override or for when the sheet
 *      is not present in the upload.
 *
 * Both are optional. With neither, the tool still runs — it simply flags nothing as an
 * institution, which the run summary reports so the omission is visible.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { headerKey, squash } from './text.js';
import { DEVELOPER_NAMES, type InstitutionEntry } from './names.js';
import type { SheetTable } from './mainDatabase.js';

export const CONFIG_DIR = resolve(process.env.CONFIG_DIR ?? 'config');

export interface LoadedConfig {
  institutions: InstitutionEntry[];
  developerNames: string[];
  neighbourhoodOverrides: Record<string, string>;
  /** Where each list came from, for the run summary. */
  sources: Record<string, string>;
}

/** Read an "Institutions to Avoid" style sheet: Institutions | Status | Remarks. */
export function parseInstitutionsSheet(table: SheetTable): InstitutionEntry[] {
  const index = new Map<string, number>();
  table.headers.forEach((h, i) => {
    const k = headerKey(h);
    if (k && !index.has(k)) index.set(k, i);
  });
  const nameCol =
    index.get('institutions') ?? index.get('institution') ?? index.get('name') ?? 0;
  const statusCol = index.get('status');
  const remarksCol = index.get('remarks') ?? index.get('remark');

  const out: InstitutionEntry[] = [];
  for (const cells of table.rows) {
    const name = squash(cells[nameCol]);
    if (!name) continue;
    out.push({
      name,
      status: statusCol === undefined ? 'Institution' : squash(cells[statusCol]) || 'Institution',
      remarks: remarksCol === undefined ? undefined : squash(cells[remarksCol]) || undefined,
    });
  }
  return out;
}

function readJsonIfPresent<T>(fileName: string): { value?: T; path: string } {
  const path = resolve(CONFIG_DIR, fileName);
  if (!existsSync(path)) return { path };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as T, path };
  } catch {
    return { path };
  }
}

/**
 * Assemble the config for a run. `institutionsFromWorkbook` is whatever was found in the
 * uploaded file; it wins over the JSON file so the tracker stays the source of truth.
 */
export function loadConfig(institutionsFromWorkbook?: InstitutionEntry[]): LoadedConfig {
  const sources: Record<string, string> = {};

  const institutionsFile = readJsonIfPresent<InstitutionEntry[]>('institutions-to-avoid.json');
  let institutions: InstitutionEntry[] = [];
  if (institutionsFromWorkbook?.length) {
    institutions = institutionsFromWorkbook;
    sources.institutions = `uploaded workbook (${institutions.length} entries)`;
  } else if (institutionsFile.value?.length) {
    institutions = institutionsFile.value;
    sources.institutions = `${institutionsFile.path} (${institutions.length} entries)`;
  } else {
    sources.institutions =
      'none — no "Institutions to Avoid" sheet in the upload and no config/institutions-to-avoid.json';
  }

  const developersFile = readJsonIfPresent<string[]>('developers.json');
  const developerNames = developersFile.value?.length ? developersFile.value : DEVELOPER_NAMES;
  sources.developers = developersFile.value?.length
    ? `${developersFile.path} (${developerNames.length} names)`
    : `built-in list (${developerNames.length} names)`;

  const neighbourhoodFile = readJsonIfPresent<Record<string, string>>('neighbourhood-map.json');
  const neighbourhoodOverrides = neighbourhoodFile.value ?? {};
  sources.neighbourhoodOverrides = neighbourhoodFile.value
    ? `${neighbourhoodFile.path} (${Object.keys(neighbourhoodOverrides).length} overrides)`
    : 'built-in mapping only';

  return { institutions, developerNames, neighbourhoodOverrides, sources };
}

/** Sheet names that look like an institutions-to-avoid list. */
export function findInstitutionsSheetName(sheetNames: string[]): string | undefined {
  return sheetNames.find((n) => /institution/i.test(n) && /avoid/i.test(n))
    ?? sheetNames.find((n) => /institutions?\s*to\s*avoid/i.test(n));
}
