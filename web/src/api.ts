/** Thin client for the local API. Every call surfaces the server's error message. */

export interface JobSummary {
  id: string;
  createdAt: string;
  sourceFileName: string;
  sheetName?: string;
  sheetNames: string[];
  compsRows: number;
  compsSource: string;
  suppressionCount: number;
  hasResult: boolean;
  outputFileName?: string;
  stats: Record<string, number> | null;
  warnings: { scope: string; message: string; count?: number; samples?: string[] }[];
  channel: 'lawyer-letter' | 'postcard' | null;
  bizfile: { runAt: string; resolver: string; count: number; verdicts: Record<string, number> } | null;
  crossCheck: {
    runAt: string;
    rowsChecked: number;
    model: string;
    findings: number;
    severities: Record<string, number>;
    errors: string[];
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
}

export interface MergeCheck {
  check: {
    templateFields: string[];
    missingInSheet: string[];
    unusedInTemplate: string[];
    ok: boolean;
  };
  scriptPath: string;
  sheetName: string;
  command: string;
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

  crossCheck: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/jobs/${id}/cross-check`, json(body)).then(
      handle<JobSummary & { findings: Record<string, unknown>[] }>,
    ),

  mailmerge: (id: string, file: File, splitPerRecord: boolean) =>
    fetch(`/api/jobs/${id}/mailmerge`, {
      method: 'POST',
      body: form({ file, splitPerRecord: String(splitPerRecord) }),
    }).then(handle<MergeCheck>),

  downloadUrl: (id: string) => `/api/jobs/${id}/download`,
};
