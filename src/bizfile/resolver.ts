/**
 * BizFile registered-address verification (step 6 of the outreach spec).
 *
 * For every corporate owner (PTE / LTD / LLP / ...) we want ACRA's registered office
 * address so it can be cross-checked against the mailing address in the sheet.
 *
 * Two resolvers, both optional and both user-triggered — nothing here runs during a
 * normal pipeline run:
 *
 *   1. `playwrightResolver` drives https://www.bizfile.gov.sg/buy-info/search/results
 *      in a headless browser. BizFile is a JavaScript app behind a WAF, so this is
 *      best-effort: it is rate-limited, it can break when the site changes, and it is
 *      off unless BIZFILE_ENABLED=1.
 *   2. `csvResolver` reads a CSV/XLSX the user exported or pasted from BizFile. This is
 *      the reliable path and the one to prefer for a real batch.
 *
 * Whichever resolver is used, the output is the same shape and lands on its own
 * "BizFile Verification" sheet with a match verdict per row.
 */
import { CorporateOwnerQuery, BizFileRecord, BizFileVerification } from './types.js';
import { mailingAddressKey } from '../core/address.js';
import { normKey, squash, upper } from '../core/text.js';

export const BIZFILE_SEARCH_URL = 'https://www.bizfile.gov.sg/buy-info/search/results';

export interface ResolverOptions {
  /** Milliseconds between searches. Keep this polite — it is a .gov.sg service. */
  delayMs: number;
  /** Hard cap on how many names to look up in one run. */
  limit: number;
  /** Called after each name so the UI can show progress. */
  onProgress?: (done: number, total: number, current: string) => void;
}

/** Collect the corporate owners worth verifying from a set of letter/postcard rows. */
export function collectCorporateOwners(
  rows: { name: string; mailingAddress: string; address?: string }[],
): CorporateOwnerQuery[] {
  const byKey = new Map<string, CorporateOwnerQuery>();
  for (const row of rows) {
    const name = squash(row.name);
    if (!name) continue;
    const key = normKey(name);
    if (!byKey.has(key)) {
      byKey.set(key, {
        ownerName: name,
        mailingAddresses: [],
        propertyAddresses: [],
      });
    }
    const entry = byKey.get(key)!;
    const mail = squash(row.mailingAddress);
    if (mail && !entry.mailingAddresses.includes(mail)) entry.mailingAddresses.push(mail);
    const prop = squash(row.address);
    if (prop && !entry.propertyAddresses.includes(prop)) entry.propertyAddresses.push(prop);
  }
  return [...byKey.values()];
}

/**
 * Compare a BizFile registered address to the mailing address we hold.
 * Postal code is the decisive signal — a matching 6-digit code with a different unit
 * number is still the right building, which is what matters for a letter.
 */
export function verifyAddress(
  query: CorporateOwnerQuery,
  record: BizFileRecord | undefined,
): BizFileVerification {
  const base: BizFileVerification = {
    ownerName: query.ownerName,
    mailingAddressInSheet: query.mailingAddresses.join(' | '),
    propertyAddresses: query.propertyAddresses.join('; '),
    uen: record?.uen,
    entityStatus: record?.status,
    bizfileName: record?.name,
    bizfileAddress: record?.registeredAddress,
    verdict: 'not-found',
    detail: 'No BizFile record supplied for this name',
  };
  if (!record) return base;

  const sheetPostals = new Set(
    query.mailingAddresses.flatMap((a) => [...upper(a).matchAll(/\b(\d{6})\b/g)].map((m) => m[1])),
  );
  const bizPostals = [...upper(record.registeredAddress ?? '').matchAll(/\b(\d{6})\b/g)].map(
    (m) => m[1],
  );

  const nameMatches = normKey(record.name ?? '') === normKey(query.ownerName);
  const postalMatch = bizPostals.some((p) => sheetPostals.has(p));
  const exactMatch = query.mailingAddresses.some(
    (a) => mailingAddressKey(a) === mailingAddressKey(record.registeredAddress ?? ''),
  );

  if (record.status && /STRUCK|DISSOLV|CEASED|WOUND|CANCELLED/i.test(record.status)) {
    return {
      ...base,
      verdict: 'entity-inactive',
      detail: `BizFile status "${record.status}" — do not send; confirm current owner`,
    };
  }
  if (exactMatch) {
    return { ...base, verdict: 'match', detail: 'Registered address matches the sheet exactly' };
  }
  if (postalMatch) {
    return {
      ...base,
      verdict: 'match-building',
      detail: 'Same postal code, different unit / formatting — same building',
    };
  }
  if (bizPostals.length === 0) {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: 'BizFile record has no postal code to compare',
    };
  }
  return {
    ...base,
    verdict: 'mismatch',
    detail: nameMatches
      ? 'Name matches but the registered address differs — update the sheet before sending'
      : 'Address differs and the name is not an exact match — confirm this is the right entity',
  };
}

/**
 * Parse BizFile records out of a user-supplied table (CSV or XLSX already read into rows).
 * Accepts the common export headings; anything unmatched is ignored.
 */
export function parseBizFileTable(headers: string[], rows: unknown[][]): BizFileRecord[] {
  const index = new Map<string, number>();
  headers.forEach((h, i) => {
    const k = normKey(h).replace(/\s/g, '');
    if (k && !index.has(k)) index.set(k, i);
  });
  const col = (...names: string[]) => {
    for (const n of names) {
      const hit = index.get(normKey(n).replace(/\s/g, ''));
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const nameCol = col('entity name', 'name', 'company name', 'business name');
  const uenCol = col('uen', 'uen no', 'acra uen no', 'registration no');
  const addrCol = col(
    'registered office address',
    'registered address',
    'address',
    'entity address',
    'owner address',
  );
  const statusCol = col('entity status', 'status', 'uen status');
  const typeCol = col('entity type', 'type');

  const out: BizFileRecord[] = [];
  for (const cells of rows) {
    const at = (c?: number) => (c === undefined ? '' : squash(cells[c]));
    const name = at(nameCol);
    if (!name) continue;
    out.push({
      name,
      uen: at(uenCol) || undefined,
      registeredAddress: at(addrCol) || undefined,
      status: at(statusCol) || undefined,
      entityType: at(typeCol) || undefined,
      source: 'upload',
    });
  }
  return out;
}

/** Match uploaded BizFile records to queries by normalised name. */
export function csvResolver(records: BizFileRecord[]) {
  const byKey = new Map<string, BizFileRecord>();
  for (const r of records) {
    const k = normKey(r.name);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }
  return async (queries: CorporateOwnerQuery[]): Promise<BizFileVerification[]> =>
    queries.map((q) => {
      const key = normKey(q.ownerName);
      let record = byKey.get(key);
      if (!record) {
        // Fall back to a containment match — BizFile often returns
        // "ACME HOLDINGS PTE. LTD." for a sheet value of "ACME HOLDINGS PTE LTD".
        for (const [k, r] of byKey) {
          if (k.includes(key) || key.includes(k)) {
            record = r;
            break;
          }
        }
      }
      return verifyAddress(q, record);
    });
}

/**
 * Headless-browser resolver. Requires `npm i playwright && npx playwright install chromium`
 * and BIZFILE_ENABLED=1. Returns 'not-found' rows rather than throwing when the site
 * layout changes, so one bad selector never kills a batch.
 */
export async function playwrightResolver(options: ResolverOptions) {
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'Playwright is not installed. Run: npm i playwright && npx playwright install chromium',
    );
  }

  return async (queries: CorporateOwnerQuery[]): Promise<BizFileVerification[]> => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      locale: 'en-SG',
    });
    const page = await context.newPage();
    const results: BizFileVerification[] = [];
    const todo = queries.slice(0, options.limit);

    try {
      for (let i = 0; i < todo.length; i++) {
        const query = todo[i];
        options.onProgress?.(i, todo.length, query.ownerName);
        let record: BizFileRecord | undefined;
        try {
          record = await searchOne(page, query.ownerName);
        } catch {
          record = undefined;
        }
        results.push(verifyAddress(query, record));
        if (i < todo.length - 1) await page.waitForTimeout(options.delayMs);
      }
    } finally {
      await browser.close();
    }
    return results;
  };
}

async function searchOne(
  page: import('playwright').Page,
  name: string,
): Promise<BizFileRecord | undefined> {
  const url = `${BIZFILE_SEARCH_URL}?keyword=${encodeURIComponent(name)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  // BizFile renders results client-side; wait for text rather than a brittle selector.
  await page.waitForTimeout(3_500);

  // Passed as a string so this file needs no DOM lib in tsconfig.
  const text = (await page.evaluate('document.body.innerText')) as string;
  if (!text || /no results|no record/i.test(text)) return undefined;

  const uen = text.match(/\b(\d{8,9}[A-Z]|[A-Z]\d{2}[A-Z]{2}\d{4}[A-Z]|\d{4}\d{5}[A-Z])\b/)?.[1];
  const status = text.match(/\b(LIVE(?: COMPANY)?|STRUCK OFF|DISSOLVED|CEASED REGISTRATION|IN LIQUIDATION|CANCELLED)\b/i)?.[1];
  const address = text.match(/\b\d+[A-Z]?\s+[A-Z0-9'.\-# /]+SINGAPORE\s+\d{6}\b/i)?.[0];

  if (!uen && !address) return undefined;
  return {
    name,
    uen,
    status,
    registeredAddress: address ? squash(address) : undefined,
    source: 'bizfile-scrape',
  };
}

export const BIZFILE_SHEET_HEADERS = [
  'Owner Name',
  'Mailing Address (sheet)',
  'Property Addresses',
  'BizFile Name',
  'UEN',
  'Entity Status',
  'BizFile Registered Address',
  'Verdict',
  'Detail',
];

export function verificationsToRows(items: BizFileVerification[]): unknown[][] {
  return items.map((v) => [
    v.ownerName,
    v.mailingAddressInSheet,
    v.propertyAddresses,
    v.bizfileName ?? '',
    v.uen ?? '',
    v.entityStatus ?? '',
    v.bizfileAddress ?? '',
    v.verdict,
    v.detail,
  ]);
}
