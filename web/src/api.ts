/** Thin client for the local API. Every call surfaces the server's error message. */

export interface JobSummary {
  id: string;
  createdAt: string;
  sourceFileName: string;
  sheetName?: string;
  sheetNames: string[];
  compsRows: number;
  compsSource: string;
  /** Set when the rows were pulled live from a Google Sheet rather than uploaded. */
  googleSheet: {
    url: string;
    spreadsheetId: string;
    spreadsheetTitle: string;
    gid?: string;
    sheetTitle: string;
    via: 'service-account' | 'anonymous-csv';
    fetchedAt: string;
    rows: number;
  } | null;
  /** Set when comps were pulled live rather than uploaded. */
  compsGoogleSheet: {
    url: string;
    spreadsheetTitle: string;
    tabs: number;
    fetchedAt: string;
  } | null;
  suppressionCount: number;
  hasResult: boolean;
  outputFileName?: string;
  stats: Record<string, number> | null;
  warnings: { scope: string; message: string; count?: number; samples?: string[] }[];
  channel: 'lawyer-letter' | 'postcard' | null;
  bizfile: { runAt: string; resolver: string; count: number; verdicts: Record<string, number> } | null;
  /** Progress of an in-flight Claude cross-check; a full sheet takes minutes. */
  crossCheckRun: {
    total: number;
    done: number;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    running: boolean;
  } | null;
  /** Progress of an in-flight BizFile run; a full queue takes minutes. */
  bizfileRun: {
    total: number;
    done: number;
    current: string;
    resolver: string;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    running: boolean;
  } | null;
  crossCheck: {
    runAt: string;
    rowsChecked: number;
    model: string;
    findings: number;
    severities: Record<string, number>;
    errors: string[];
  } | null;
  /** The operator's own cross-check instructions, remembered between runs. */
  crossCheckInstructions: string;
  /** The merge setup: which template, which sheet, and what the last run produced. */
  merge: {
    templateName: string;
    dataName: string;
    dataIsUpload: boolean;
    sheetName: string;
    dataRows: number;
    check: MergeFieldCheck;
    pdfCount: number;
    pdfNames: string[];
    lastRunAt?: string;
    lastRunLimit?: number;
  } | null;
  /** Progress of an in-flight merge; one Word document per recipient takes minutes. */
  mergeRun: {
    total: number;
    done: number;
    limit?: number;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    running: boolean;
  } | null;
  log: { at: string; step: string; message: string }[];
}

export interface RunResponse extends JobSummary {
  preview: Record<string, unknown>[];
  exclusionSummary: { label: string; count: number }[];
  flagSummary: { label: string; count: number }[];
}

export interface SheetPreview {
  sheetName: string;
  headers: string[];
  rowCount: number;
  sampleRows: unknown[][];
  mappedFields: string[];
  missingFields: string[];
  unmappedHeaders: string[];
  parsedRows: number;
}

export interface Funnel {
  stages: { key: string; label: string; value: number }[];
  drops: { stage: string; count: number; reasons: { label: string; count: number }[] }[];
  outreach: { label: string; count: number }[];
}

export interface RecipientDetail {
  index: number;
  row: Record<string, unknown>;
  group: {
    target: string;
    neighbourhood: string;
    landUse: string;
    tenure: string;
    address: string;
    fullAddress: string;
    registeredProprietor: string;
    mailingAddress: string;
    distinctOwnerNames: string[];
    notes: string[];
  };
  members: Record<string, unknown>[];
  merges: { stage: string; action: string; before: string[]; after: string }[];
  flags: { severity: string; flag: string; detail?: string; sourceRow: string | number }[];
  crossCheck: { severity: string; field: string; issue: string; suggestion: string }[];
  bizfile: Record<string, unknown>[];
}

export interface Health {
  ok: boolean;
  anthropicKey: boolean;
  bizfileEnabled: boolean;
  model: string;
  /** False means this machine cannot render PDFs — no Word, unactivated Office, or not Windows. */
  wordAvailable: boolean;
  wordReason: string | null;
  /** Service-account address, or null when a private Google Sheet cannot be read. */
  googleServiceAccount: string | null;
  /** The comps workbook, so it never has to be pasted. */
  compsSheetUrl: string;
}

export interface MergeFieldCheck {
  templateFields: string[];
  sheetHeaders: string[];
  missingInSheet: string[];
  unusedInTemplate: string[];
  ok: boolean;
}

async function handle<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text.slice(0, 400) || `HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

function form(entries: Record<string, string | File | undefined>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) fd.append(k, v);
  }
  return fd;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  health: () => fetch('/api/health').then(handle<Health>),

  upload: (file: File) =>
    fetch('/api/jobs', { method: 'POST', body: form({ file }) }).then(handle<JobSummary>),

  /**
   * Read the tracker straight out of a Google Sheet instead of uploading an export.
   *
   * `gid` is an override. Without it the server finds the Main Database tab rather than
   * trusting whichever tab the pasted link happened to point at, and `reason` says which
   * tab it read and why.
   */
  fromGoogleSheet: (url: string, gid?: string) =>
    fetch('/api/jobs/from-google-sheet', json({ url, gid })).then(
      handle<JobSummary & { tabChosen?: string; reason?: string; candidates?: string[] }>,
    ),

  /** Pull the same tab again and rebuild from it. */
  refreshGoogleSheet: (id: string) =>
    fetch(`/api/jobs/${id}/refresh-google-sheet`, json({})).then(
      handle<
        JobSummary & {
          rowsBefore: number;
          rowsAfter: number;
          regenerated: boolean;
          clearedBizfile: boolean;
          clearedCrossCheck: boolean;
        }
      >,
    ),

  googleSheetTabs: (url: string) =>
    fetch(`/api/google-sheet/tabs?url=${encodeURIComponent(url)}`).then(
      handle<{
        spreadsheetTitle: string;
        selectedGid: string | null;
        tabs: { gid: string; title: string; rowCount: number }[];
      }>,
    ),

  /** Read every tab of the comps workbook live — one per district in the Market Watch source. */
  compsFromGoogleSheet: (id: string, url?: string) =>
    fetch(`/api/jobs/${id}/comps-from-google-sheet`, json({ url })).then(
      handle<JobSummary & { mode?: string; transactions?: number; districts?: number[] }>,
    ),

  /**
   * Distinct values in the outreach column, with counts — what Excel's column filter
   * shows, so the pick is made against the real sheet rather than five state names.
   */
  outreachValues: (id: string, channel: string, sheetName?: string) =>
    fetch(
      `/api/jobs/${id}/outreach-values?channel=${encodeURIComponent(channel)}` +
        (sheetName ? `&sheetName=${encodeURIComponent(sheetName)}` : ''),
    ).then(
      handle<{
        column: string;
        sheetName: string;
        rows: number;
        values: { value: string; status: string; label: string; count: number }[];
      }>,
    ),

  job: (id: string) => fetch(`/api/jobs/${id}`).then(handle<JobSummary>),

  sheetPreview: (id: string, sheet: string) =>
    fetch(`/api/jobs/${id}/sheets/${encodeURIComponent(sheet)}/preview`).then(handle<SheetPreview>),

  uploadComps: (id: string, file: File, sheetName?: string) =>
    fetch(`/api/jobs/${id}/comps`, { method: 'POST', body: form({ file, sheetName }) }).then(
      handle<JobSummary>,
    ),

  uploadSuppression: (id: string, file: File) =>
    fetch(`/api/jobs/${id}/suppression`, { method: 'POST', body: form({ file }) }).then(
      handle<JobSummary>,
    ),

  run: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/jobs/${id}/run`, json(body)).then(handle<RunResponse>),

  rows: (id: string, offset = 0, limit = 500) =>
    fetch(`/api/jobs/${id}/rows?offset=${offset}&limit=${limit}`).then(
      handle<{ channel: string; total: number; offset: number; rows: Record<string, unknown>[] }>,
    ),

  exclusions: (id: string) =>
    fetch(`/api/jobs/${id}/exclusions?limit=1000`).then(
      handle<{ total: number; rows: Record<string, unknown>[]; summary: { label: string; count: number }[] }>,
    ),

  flags: (id: string) =>
    fetch(`/api/jobs/${id}/flags`).then(
      handle<{ total: number; rows: Record<string, unknown>[]; summary: { label: string; count: number }[] }>,
    ),

  funnel: (id: string) => fetch(`/api/jobs/${id}/funnel`).then(handle<Funnel>),

  audit: (id: string) =>
    fetch(`/api/jobs/${id}/audit`).then(handle<{ total: number; rows: Record<string, unknown>[] }>),

  recipient: (id: string, index: number) =>
    fetch(`/api/jobs/${id}/recipients/${index}`).then(handle<RecipientDetail>),

  bizfileQueue: (id: string) =>
    fetch(`/api/jobs/${id}/bizfile/queue`).then(
      handle<{ total: number; rows: { ownerName: string; mailingAddresses: string[] }[] }>,
    ),

  bizfile: (id: string, file?: File) =>
    fetch(`/api/jobs/${id}/bizfile`, { method: 'POST', body: form({ file }) }).then(
      handle<JobSummary & { rows: Record<string, unknown>[] }>,
    ),

  /** Re-run the whole pipeline with corrected addresses applied before dedupe. */
  rerunAddresses: (id: string, opts: { file?: File; verdicts?: string[] } = {}) =>
    fetch(`/api/jobs/${id}/rerun-addresses`, {
      method: 'POST',
      body: form({ file: opts.file, verdicts: opts.verdicts?.join(',') }),
    }).then(
      handle<
        JobSummary & {
          offered: number;
          /** How many came from a hand-typed Corrected Address column. */
          typedCorrections: number;
          applied: number;
          skippedIncomplete: number;
          skippedSamples: { ownerName: string; address: string }[];
          recipientsBefore: number;
          recipientsAfter: number;
          overrides: Record<string, unknown>[];
        }
      >,
    ),

  /** Starter workbook for one step. */
  templateUrl: (kind: string) => `/api/templates/${kind}`,

  crossCheck: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/jobs/${id}/cross-check`, json(body)).then(
      handle<JobSummary & { findings: Record<string, unknown>[] }>,
    ),

  /** Set up the merge: the template, and optionally the operator's own edited workbook. */
  mailmerge: (id: string, template: File, data?: File) =>
    fetch(`/api/jobs/${id}/mailmerge`, {
      method: 'POST',
      body: form({ file: template, data }),
    }).then(handle<JobSummary>),

  /** Drive Word and export PDFs. `limit: 1` proves one PDF before committing to the run. */
  mailmergeRun: (id: string, opts: { limit?: number; splitPerRecord?: boolean } = {}) =>
    fetch(`/api/jobs/${id}/mailmerge/run`, json(opts)).then(handle<JobSummary>),

  mailmergePdfUrl: (id: string, index: number) => `/api/jobs/${id}/mailmerge/pdf/${index}`,
  mailmergeZipUrl: (id: string) => `/api/jobs/${id}/mailmerge/pdfs`,
  mailmergeScriptUrl: (id: string) => `/api/jobs/${id}/mailmerge/script`,

  downloadUrl: (id: string) => `/api/jobs/${id}/download`,
};
