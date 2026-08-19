/**
 * Reading a tab of a Google Sheet as a table, so the tracker can be pulled live instead
 * of exported and re-uploaded.
 *
 * Two ways in, because they fail for different reasons:
 *
 *  1. A service account. The only option for a sheet that stays private: Google issues a
 *     key, the sheet is shared with that account's address as a Viewer, and the server
 *     mints its own token. No browser, no consent screen, nothing to re-authorise.
 *
 *  2. Anonymous CSV export, for a sheet that is already link-shared or published. Zero
 *     setup, but it means anyone holding the URL can read the sheet — which for owner
 *     names and mailing addresses is a decision to take deliberately, not by default.
 *
 * The JWT is signed with node:crypto rather than pulling in googleapis, which would add
 * tens of megabytes to a tool that needs one read-only call.
 */
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export interface SheetRef {
  spreadsheetId: string;
  /** Tab id from the URL fragment. Undefined means "whichever tab is first". */
  gid?: string;
}

export class GoogleSheetAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleSheetAccessError';
  }
}

/**
 * Pull the spreadsheet id and tab id out of any of the shapes people paste: the full
 * edit URL, a `#gid=` fragment, a `?gid=` query, or a bare id.
 */
export function parseSheetUrl(input: string): SheetRef {
  const text = String(input ?? '').trim();
  if (!text) throw new GoogleSheetAccessError('No Google Sheets link given');

  const byPath = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(text);
  const id = byPath?.[1] ?? (/^[a-zA-Z0-9-_]{20,}$/.test(text) ? text : undefined);
  if (!id) {
    throw new GoogleSheetAccessError(
      'That does not look like a Google Sheets link. Paste the URL from the browser bar, ' +
        'which looks like https://docs.google.com/spreadsheets/d/<id>/edit#gid=<tab>',
    );
  }
  const gid = /[#&?]gid=(\d+)/.exec(text)?.[1];
  return { spreadsheetId: id, gid };
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * A key committed to the repo. Only tenable because this repository is private: anyone with
 * read access to it has read access to the spreadsheet, and the key remains in git history
 * after any later deletion. Rotating means a new key in Google plus a commit here.
 */
export const REPO_KEY_PATH = 'secrets/google-service-account.json';

/**
 * The configured service account, if there is one. Three sources, in order:
 *
 *  1. `GOOGLE_SERVICE_ACCOUNT_JSON` — a path to the key file Google downloads, or the JSON
 *     itself, since a .env value cannot span lines. First so one machine can use its own
 *     key without touching the repo.
 *  2. A key committed at `secrets/google-service-account.json`. Needs no configuration at
 *     all: clone and it works.
 *  3. Nothing, which means only a link-shared or published sheet can be read.
 */
export function serviceAccount(): ServiceAccountKey | undefined {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const text = raw
    ? readPlainKey(raw)
    : existsSync(REPO_KEY_PATH)
      ? readFileSync(REPO_KEY_PATH, 'utf8')
      : undefined;
  if (!text) return undefined;

  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(text) as Partial<ServiceAccountKey>;
  } catch {
    throw new GoogleSheetAccessError(
      'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Use the key file Google downloaded, unedited.',
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new GoogleSheetAccessError(
      'The service-account key is missing client_email or private_key.',
    );
  }
  return {
    client_email: parsed.client_email,
    // A key pasted into .env on one line carries literal \n instead of newlines.
    private_key: parsed.private_key.replace(/\\n/g, '\n'),
  };
}

function readPlainKey(raw: string): string {
  if (raw.startsWith('{')) return raw;
  if (!existsSync(raw)) {
    throw new GoogleSheetAccessError(
      `GOOGLE_SERVICE_ACCOUNT_JSON points at "${raw}", which does not exist.`,
    );
  }
  return readFileSync(raw, 'utf8');
}

const b64url = (value: string) => Buffer.from(value).toString('base64url');

/** Exchange a signed JWT for a read-only access token. */
async function accessToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    b64url(
      JSON.stringify({
        iss: key.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    ),
  ].join('.');

  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  } catch (error) {
    throw new GoogleSheetAccessError(
      `Could not sign with the service-account private key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new GoogleSheetAccessError(
      `Google refused the service-account key: ${
        body.error_description ?? body.error ?? `HTTP ${response.status}`
      }`,
    );
  }
  return body.access_token;
}

export interface FetchedSheet {
  spreadsheetId: string;
  spreadsheetTitle: string;
  /** The tab actually read. */
  sheetTitle: string;
  gid?: string;
  headers: string[];
  rows: unknown[][];
  /** Which route got the data, for the audit trail. */
  via: 'service-account' | 'anonymous-csv';
  fetchedAt: Date;
}

/** One tab, for the picker. */
export interface SheetTab {
  gid: string;
  title: string;
  rowCount: number;
}

async function api<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const message = detail.error?.message ?? `HTTP ${response.status}`;
    if (response.status === 403 || response.status === 404) {
      throw new GoogleSheetAccessError(
        `${message}\n\nThe service account can reach Google but not this spreadsheet. ` +
          'Share the sheet with the service-account address as a Viewer.',
      );
    }
    throw new GoogleSheetAccessError(message);
  }
  return (await response.json()) as T;
}

interface SheetsMeta {
  properties?: { title?: string };
  sheets?: {
    properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number } };
  }[];
}

const metaUrl = (id: string) =>
  `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}` +
  '?fields=properties.title,sheets.properties';

/** List the tabs. Service account only — the CSV route cannot enumerate. */
export async function listTabs(
  ref: SheetRef,
): Promise<{ spreadsheetTitle: string; tabs: SheetTab[] }> {
  const key = serviceAccount();
  if (!key) {
    throw new GoogleSheetAccessError(
      'Listing tabs needs a service account. Set GOOGLE_SERVICE_ACCOUNT_JSON, or paste a ' +
        'link that already includes #gid= for the tab you want.',
    );
  }
  const meta = await api<SheetsMeta>(metaUrl(ref.spreadsheetId), await accessToken(key));
  return {
    spreadsheetTitle: meta.properties?.title ?? 'Untitled',
    tabs: (meta.sheets ?? []).map((s) => ({
      gid: String(s.properties?.sheetId ?? ''),
      title: s.properties?.title ?? '',
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    })),
  };
}

/**
 * Read one tab. Uses the service account when one is configured, otherwise the anonymous
 * CSV export — and reports which, because success through the anonymous route means the
 * sheet is readable by anyone holding the link.
 */
export async function fetchSheet(ref: SheetRef): Promise<FetchedSheet> {
  // A broken key is reported, never silently downgraded to anonymous: quietly reading a
  // stale public copy instead of the private original is the wrong kind of resilient.
  const key = serviceAccount();
  return key ? fetchViaApi(ref, key) : fetchViaCsv(ref);
}

async function fetchViaApi(ref: SheetRef, key: ServiceAccountKey): Promise<FetchedSheet> {
  const token = await accessToken(key);
  const meta = await api<SheetsMeta>(metaUrl(ref.spreadsheetId), token);
  const tabs = meta.sheets ?? [];
  const wanted = ref.gid ? tabs.find((s) => String(s.properties?.sheetId) === ref.gid) : tabs[0];
  if (!wanted?.properties?.title) {
    throw new GoogleSheetAccessError(
      `No tab with gid=${ref.gid} in this spreadsheet. It has: ` +
        tabs.map((s) => `${s.properties?.title} (gid=${s.properties?.sheetId})`).join(', '),
    );
  }
  const sheetTitle = wanted.properties.title;

  // UNFORMATTED_VALUE keeps numbers as numbers and dates as serials rather than handing
  // back display text — "S$11,000,000" is not a number the pipeline can price with, and
  // parseLooseDate already reads Excel serials.
  const values = await api<{ values?: unknown[][] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(ref.spreadsheetId)}` +
      `/values/${encodeURIComponent(sheetTitle)}` +
      '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER',
    token,
  );

  const grid = values.values ?? [];
  return {
    spreadsheetId: ref.spreadsheetId,
    spreadsheetTitle: meta.properties?.title ?? 'Untitled',
    sheetTitle,
    gid: ref.gid ?? String(wanted.properties.sheetId ?? ''),
    headers: (grid[0] ?? []).map((c) => String(c ?? '')),
    rows: grid.slice(1),
    via: 'service-account',
    fetchedAt: new Date(),
  };
}

/** What to do when a sheet cannot be read anonymously. Shown verbatim in the UI. */
export const SERVICE_ACCOUNT_SETUP = [
  'Set up a service account so the tool can read it while the sheet stays private:',
  '  1. console.cloud.google.com — create a project, then enable the Google Sheets API',
  '  2. Create a service account, then Keys — Add key — JSON, and save the file',
  '  3. Share this spreadsheet with the service-account address (it ends in',
  '     .iam.gserviceaccount.com) as a Viewer',
  '  4. Put the file path in GOOGLE_SERVICE_ACCOUNT_JSON in .env and restart',
  '',
  'The alternative — File, Share, "anyone with the link can view" — also works, but it ' +
    'makes owner names and mailing addresses readable by anyone holding the URL.',
].join('\n');

async function fetchViaCsv(ref: SheetRef): Promise<FetchedSheet> {
  const url =
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(ref.spreadsheetId)}/export` +
    `?format=csv${ref.gid ? `&gid=${encodeURIComponent(ref.gid)}` : ''}`;

  const response = await fetch(url, { redirect: 'follow' });
  const text = await response.text();

  // A private sheet answers with a sign-in page: an HTML body, often under a 401.
  const looksLikeLoginPage = /<!DOCTYPE html/i.test(text.slice(0, 200));
  if (!response.ok || looksLikeLoginPage) {
    throw new GoogleSheetAccessError(
      `This sheet is not readable without credentials (HTTP ${response.status}).\n\n` +
        SERVICE_ACCOUNT_SETUP,
    );
  }

  // Let the xlsx reader parse the CSV: quoted fields, embedded commas and newlines.
  const XLSX = (await import('xlsx')).default;
  const wb = XLSX.read(text, { type: 'string', raw: false });
  const first = wb.SheetNames[0];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[first], {
    header: 1,
    defval: null,
    blankrows: true,
  });

  return {
    spreadsheetId: ref.spreadsheetId,
    spreadsheetTitle: 'Google Sheet',
    sheetTitle: first,
    gid: ref.gid,
    headers: (grid[0] ?? []).map((c) => String(c ?? '')),
    rows: grid.slice(1),
    via: 'anonymous-csv',
    fetchedAt: new Date(),
  };
}

/**
 * Every tab in the spreadsheet, in one call each.
 *
 * The comps source keeps one tab per district, so "fetch the comps" means fetching all of
 * them — picking one would silently limit which districts can be priced.
 */
export async function fetchAllTabs(ref: SheetRef): Promise<FetchedSheet[]> {
  const key = serviceAccount();
  if (!key) {
    throw new GoogleSheetAccessError(
      `Reading every tab needs a service account.\n\n${SERVICE_ACCOUNT_SETUP}`,
    );
  }
  const token = await accessToken(key);
  const meta = await api<SheetsMeta>(metaUrl(ref.spreadsheetId), token);
  const spreadsheetTitle = meta.properties?.title ?? 'Untitled';
  const titles = (meta.sheets ?? [])
    .map((s) => ({ title: s.properties?.title ?? '', gid: String(s.properties?.sheetId ?? '') }))
    .filter((t) => t.title);

  // batchGet, so a 30-tab workbook is one request rather than thirty.
  const query = titles
    .map((t) => `ranges=${encodeURIComponent(t.title)}`)
    .join('&');
  const batch = await api<{ valueRanges?: { values?: unknown[][] }[] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(ref.spreadsheetId)}` +
      `/values:batchGet?${query}` +
      '&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER',
    token,
  );

  const fetchedAt = new Date();
  return titles.map((t, i) => {
    const grid = batch.valueRanges?.[i]?.values ?? [];
    return {
      spreadsheetId: ref.spreadsheetId,
      spreadsheetTitle,
      sheetTitle: t.title,
      gid: t.gid,
      headers: (grid[0] ?? []).map((c) => String(c ?? '')),
      rows: grid.slice(1),
      via: 'service-account' as const,
      fetchedAt,
    };
  });
}

/**
 * Write fetched tabs to an .xlsx so every later step behaves exactly as it does for an
 * uploaded workbook. Keeping one code path for "where the data came from" is worth the
 * temporary file — the alternative is a second parsing route to keep in step forever.
 */
export async function fetchedSheetToXlsx(
  sheets: FetchedSheet | FetchedSheet[],
  path: string,
): Promise<void> {
  const XLSX = (await import('xlsx')).default;
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();

  for (const sheet of Array.isArray(sheets) ? sheets : [sheets]) {
    // Excel caps tab names at 31 characters and forbids : \ / ? * [ ]
    let name = (sheet.sheetTitle || 'Sheet1').replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
    // Two Google tabs can collide once truncated to 31 characters; adding a sheet under a
    // name already present would throw and lose the whole fetch.
    if (used.has(name)) {
      for (let n = 2; used.has(name); n++) name = `${name.slice(0, 28)}~${n}`;
    }
    used.add(name);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows]), name);
  }

  if (wb.SheetNames.length === 0) throw new GoogleSheetAccessError('Nothing was fetched to write');
  XLSX.writeFile(wb, path);
}
