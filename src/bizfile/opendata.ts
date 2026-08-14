/**
 * ACRA registered-address lookups via Singapore's open data API.
 *
 * This is the resolver to use. It reads the same registry as BizFile's own search, from
 * ACRA's monthly open-data publication on data.gov.sg — dataset
 * `d_3f960c10fed6145404ca7b821f263b87`, "Entities Registered with ACRA", 2.1M rows,
 * Open Data Licence (free for commercial use). No login, no reCAPTCHA, no per-lookup
 * fee, no scraping, and it does not break when the BizFile front end changes.
 *
 * Fields available per entity:
 *   uen · entity_name · uen_status_desc · entity_type_desc · uen_issue_date
 *   reg_street_name · reg_postal_code
 *
 * ## The one limitation that matters
 *
 * The dataset carries **street name and postal code only** — no block number and no unit.
 * So a full-string address match can never fire, and verdicts land on `match-building`
 * (postal code agrees) or `mismatch`. That is the right signal for posting a letter — a
 * matching 6-digit code is the same building — but do not expect `match`, and do not read
 * the absence of `match` as a problem. `verifyAddress` treats postal code as decisive for
 * exactly this reason.
 *
 * Names are matched exactly first, because the registry is punctuation-sensitive:
 * `DBS BANK LTD.` resolves, `DBS BANK LTD` returns nothing. Variants are tried in order,
 * then a full-text search whose candidates are re-scored locally on a normalised key.
 */
import { BizFileRecord, BizFileVerification, CorporateOwnerQuery } from './types.js';
import { verifyAddress } from './resolver.js';
import { normKey, squash, upper } from '../core/text.js';

const DATASTORE = 'https://data.gov.sg/api/action/datastore_search';
export const ACRA_RESOURCE_ID = 'd_3f960c10fed6145404ca7b821f263b87';
export const ACRA_DATASET_URL = `https://data.gov.sg/datasets/${ACRA_RESOURCE_ID}/view`;

export interface OpenDataResolverOptions {
  /** Hard cap on lookups in one run. */
  limit: number;
  /** Milliseconds between requests. It is a free public API — stay polite. */
  delayMs: number;
  /** Per-request timeout. */
  timeoutMs: number;
  onProgress?: (done: number, total: number, current: string) => void;
}

export function defaultOpenDataOptions(
  over: Partial<OpenDataResolverOptions> = {},
): OpenDataResolverOptions {
  // 400ms keeps a several-hundred-name batch under the throttle in practice.
  return { limit: 1000, delayMs: 400, timeoutMs: 30_000, ...over };
}

interface AcraRow {
  uen?: string;
  entity_name?: string;
  uen_status_desc?: string;
  entity_type_desc?: string;
  reg_street_name?: string;
  reg_postal_code?: string;
}

/**
 * Name spellings to try against an exact-match filter, most likely first.
 * ACRA stores "PTE. LTD." with stops; sheets usually don't.
 */
export function nameVariants(raw: string): string[] {
  const name = upper(squash(raw)).replace(/\s+/g, ' ').trim();
  if (!name) return [];
  const out = new Set<string>([name]);

  // Punctuated <-> unpunctuated forms of the common suffixes.
  const punctuated = name
    .replace(/\bPTE\.?\s+LTD\.?$/i, 'PTE. LTD.')
    .replace(/\bPTE\.?$/i, 'PTE.')
    .replace(/\bLTD\.?$/i, 'LTD.')
    .replace(/\bLLP\.?$/i, 'LLP')
    .replace(/\bCO\.?\s+LTD\.?$/i, 'CO. LTD.');
  out.add(punctuated);

  const bare = name.replace(/\./g, '');
  out.add(bare);
  out.add(bare.replace(/\bPTE LTD$/i, 'PTE. LTD.'));
  out.add(`${bare}.`);

  return [...out].filter(Boolean);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with retry. data.gov.sg throttles bursts of distinct queries with HTTP 429, so a
 * batch of several hundred names will hit it; back off and retry rather than treating a
 * throttled request as an answer.
 */
async function fetchJson(url: string, timeoutMs: number, attempts = 4): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      // 600ms, 1.8s, 5.4s — enough to clear a burst limit without stalling a batch.
      await sleep(600 * 3 ** (attempt - 1));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
        lastError = new Error(`data.gov.sg returned HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`data.gov.sg returned HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('data.gov.sg request failed');
}

async function exactLookup(name: string, timeoutMs: number): Promise<AcraRow | undefined> {
  const filters = encodeURIComponent(JSON.stringify({ entity_name: name }));
  const json = await fetchJson(
    `${DATASTORE}?resource_id=${ACRA_RESOURCE_ID}&filters=${filters}&limit=5`,
    timeoutMs,
  );
  const rows: AcraRow[] = json?.result?.records ?? [];
  if (rows.length <= 1) return rows[0];
  // Several entities share a name across agencies — prefer a live ACRA one.
  return rows.find((r) => !isInactiveStatus(r.uen_status_desc)) ?? rows[0];
}

/**
 * Full-text fallback. `q` is an OR match over tokens and returns a great deal of noise,
 * so candidates are only accepted when their normalised name equals the query's.
 */
async function searchLookup(name: string, timeoutMs: number): Promise<AcraRow | undefined> {
  const json = await fetchJson(
    `${DATASTORE}?resource_id=${ACRA_RESOURCE_ID}&q=${encodeURIComponent(name)}&limit=100`,
    timeoutMs,
  );
  const rows: AcraRow[] = json?.result?.records ?? [];
  const want = normKey(name);
  const exact = rows.filter((r) => normKey(r.entity_name ?? '') === want);
  if (exact.length > 0) {
    return exact.find((r) => !isInactiveStatus(r.uen_status_desc)) ?? exact[0];
  }
  return undefined;
}

export function isInactiveStatus(status?: string): boolean {
  return /STRUCK|DISSOLV|CEASED|WOUND|CANCELLED|DEREGIST|EXPIRED|WITHDRAWN/i.test(status ?? '');
}

/** Shape an ACRA row into the record the verdict logic expects. */
export function toRecord(row: AcraRow | undefined, fallbackName: string): BizFileRecord | undefined {
  if (!row) return undefined;
  const street = squash(row.reg_street_name);
  const postal = squash(row.reg_postal_code);
  // Format so verifyAddress's 6-digit postal regex finds the code.
  const address = street || postal ? squash(`${street} SINGAPORE ${postal}`) : undefined;
  return {
    name: squash(row.entity_name) || fallbackName,
    uen: squash(row.uen) || undefined,
    status: squash(row.uen_status_desc) || undefined,
    entityType: squash(row.entity_type_desc) || undefined,
    registeredAddress: address,
    source: 'acra-opendata',
  };
}

/** Look one entity up, trying exact variants before the noisy full-text search. */
export async function lookupEntity(
  name: string,
  timeoutMs = 30_000,
): Promise<BizFileRecord | undefined> {
  for (const variant of nameVariants(name)) {
    const row = await exactLookup(variant, timeoutMs);
    if (row) return toRecord(row, name);
  }
  const viaSearch = await searchLookup(name, timeoutMs);
  return toRecord(viaSearch, name);
}

/** Fraction of lookups that may fail before the whole run is treated as unusable. */
const FAILURE_ABORT_RATIO = 0.25;

export class OpenDataUnavailableError extends Error {
  constructor(failed: number, total: number, sample: string) {
    super(
      `${failed} of ${total} ACRA lookups failed (throttled or unreachable), so the report would be ` +
        'mostly blanks that read like "no record at ACRA". Nothing was written. Try again with a ' +
        `larger BIZFILE_DELAY_MS, or download the dataset for a local run. Last error: ${sample}`,
    );
    this.name = 'OpenDataUnavailableError';
  }
}

export async function openDataResolver(options: OpenDataResolverOptions) {
  return async (queries: CorporateOwnerQuery[]): Promise<BizFileVerification[]> => {
    const todo = queries.slice(0, options.limit);
    const out: BizFileVerification[] = [];
    // Owners repeat across properties; never pay for the same name twice.
    const cache = new Map<string, BizFileRecord | undefined>();
    let failed = 0;
    let lastError = 'none';

    for (let i = 0; i < todo.length; i++) {
      const query = todo[i];
      options.onProgress?.(i, todo.length, query.ownerName);

      const key = normKey(query.ownerName);
      let record: BizFileRecord | undefined;
      let lookupFailed = false;

      if (cache.has(key)) {
        record = cache.get(key);
      } else {
        try {
          record = await lookupEntity(query.ownerName, options.timeoutMs);
          cache.set(key, record);
        } catch (error) {
          // Do NOT fall through to not-found: an unchecked owner must say so.
          lookupFailed = true;
          failed++;
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      if (lookupFailed) {
        out.push({
          ownerName: query.ownerName,
          mailingAddressInSheet: query.mailingAddresses.join(' | '),
          propertyAddresses: query.propertyAddresses.join('; '),
          verdict: 'lookup-failed',
          detail: `ACRA lookup did not complete (${lastError}) — this owner was NOT checked`,
        });
      } else {
        out.push(verifyAddress(query, record));
      }

      if (i < todo.length - 1 && options.delayMs > 0) await sleep(options.delayMs);
    }

    if (todo.length > 0 && failed / todo.length > FAILURE_ABORT_RATIO) {
      throw new OpenDataUnavailableError(failed, todo.length, lastError);
    }
    options.onProgress?.(todo.length, todo.length, 'done');
    return out;
  };
}
