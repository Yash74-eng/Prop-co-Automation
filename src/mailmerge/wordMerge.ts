/**
 * Mail merge (step 8) — turning the approved sheet into PDFs.
 *
 * Three pieces:
 *
 *  1. `listMergeFields` reads the MERGEFIELD names out of a .docx so we can prove the
 *     data source's headers line up with what the template asks for. A silent
 *     mismatch here is the classic mail-merge failure — «Full_Address» renders empty
 *     because the sheet header says "Full_Addressk".
 *
 *  2. `generateWordMergeScript` emits a PowerShell script that drives Word via COM to
 *     run the merge and export PDFs. Word is the only thing that renders these
 *     templates faithfully (they carry headers, footers, QR images and Chinese text),
 *     so scripting the installed Word beats re-implementing the layout.
 *
 *  3. `runWordMerge` runs that script and reports progress, so the operator never has
 *     to leave the app to open a terminal. It only works where Word is installed —
 *     `wordAvailable()` says so up front rather than failing halfway through a run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { LAWYER_LETTER_HEADERS, POSTCARD_HEADERS } from '../core/pipeline.js';

const require = createRequire(import.meta.url);

/** Extract MERGEFIELD names from a .docx, in document order, de-duplicated. */
export function listMergeFields(docxPath: string): string[] {
  const buffer = readFileSync(docxPath);
  const xml = extractDocumentXml(buffer);
  const names = new Set<string>();

  // Word writes fields two ways: as a w:instrText run, and as a w:fldSimple attribute.
  //
  // Names containing spaces must be quoted in the instruction, and the postcard sheet is
  // full of them ("Owner Name", "Full Address"). Match the quoted form first, or every
  // postcard template reads as having no fields at all.
  for (const m of xml.matchAll(/MERGEFIELD\s+"([^"]+)"/g)) names.add(m[1].trim());
  for (const m of xml.matchAll(/MERGEFIELD\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
  // The displayed «Field» form, which may also carry spaces.
  for (const m of xml.matchAll(/«([^»<]{1,60})»/g)) names.add(m[1].trim());

  return [...names];
}

function extractDocumentXml(buffer: Buffer): string {
  // A .docx is a zip. Read word/document.xml plus the headers/footers, which can also
  // carry merge fields (the envelope template puts the address block in the body, but
  // letter templates often use a header).
  const zlib = require('node:zlib') as typeof import('node:zlib');
  const parts: string[] = [];

  let offset = 0;
  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;

    // Directory entries are legitimately zero-length. Several writers emit them, so skip
    // rather than stop — stopping here meant never reaching word/document.xml.
    if (name.endsWith('/')) {
      offset = dataStart;
      continue;
    }

    if (compressedSize === 0 && uncompressedSize === 0) {
      // Sizes live in the data descriptor — we cannot tell where this entry ends.
      break;
    }

    if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) {
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      try {
        parts.push(method === 0 ? raw.toString('utf8') : zlib.inflateRawSync(raw).toString('utf8'));
      } catch {
        // Skip a part we cannot inflate rather than failing the whole read.
      }
    }
    offset = dataStart + compressedSize;
  }

  if (parts.length === 0) {
    // Last resort: scan the raw bytes. Field names survive as plain ASCII in some writers.
    parts.push(buffer.toString('latin1'));
  }
  return parts.join('\n');
}

export interface MergeFieldCheck {
  templateFields: string[];
  sheetHeaders: string[];
  /** Fields the template wants that the sheet does not provide — these render blank. */
  missingInSheet: string[];
  /** Sheet columns the template never uses. Harmless, listed for completeness. */
  unusedInTemplate: string[];
  ok: boolean;
}

/**
 * Verify a template's merge fields against the headers of the data source.
 *
 * Pass `headers` to check against the sheet actually being merged. Once the operator has
 * edited the workbook by hand, checking against the headers this tool *would* have
 * written proves nothing about the file Word is going to open.
 */
export function checkMergeFields(
  docxPath: string,
  channel: 'lawyer-letter' | 'postcard',
  headers?: string[],
): MergeFieldCheck {
  const templateFields = listMergeFields(docxPath);
  const sheetHeaders =
    headers ??
    ((channel === 'lawyer-letter' ? LAWYER_LETTER_HEADERS : POSTCARD_HEADERS) as unknown as string[]);

  // Word replaces spaces in a data-source header with underscores when it builds the
  // field list, so compare on that basis.
  const normalise = (value: string) => value.replace(/\s+/g, '_').toLowerCase();
  const headerKeys = new Set(sheetHeaders.map(normalise));
  const fieldKeys = new Set(templateFields.map(normalise));

  const missingInSheet = templateFields.filter((f) => !headerKeys.has(normalise(f)));
  const unusedInTemplate = sheetHeaders.filter((h) => !fieldKeys.has(normalise(h)));

  return {
    templateFields,
    sheetHeaders,
    missingInSheet,
    unusedInTemplate,
    ok: missingInSheet.length === 0,
  };
}

export interface MergeScriptOptions {
  templatePath: string;
  /** Workbook to use as the data source — generated, or the operator's edited copy. */
  dataPath: string;
  /** Sheet inside the workbook, e.g. "Lawyer Letter". */
  sheetName: string;
  outputDir: string;
  /**
   * File holding one PDF name per record, in sheet order, UTF-8, newline separated.
   *
   * The obvious alternative — asking Word for the value of a named data field — is
   * fragile: Word rewrites data-source header names (spaces become underscores) and a
   * postcard sheet's headers are full of spaces, so the lookup silently returns nothing
   * and every PDF lands as "record-1". The server already holds the rows; it can name
   * the files itself and be right.
   */
  labelsPath?: string;
  /**
   * Where the script records the Word process it started, so a stuck run can be killed
   * precisely. Empty when Word was already running and we attached to that instance —
   * killing the operator's own Word would be worse than leaving the run stuck.
   */
  pidPath?: string;
  /** Produce one PDF per record instead of a single merged document. */
  splitPerRecord: boolean;
  /** Stop after this many records — 1 is the "check one PDF before committing" run. */
  limit?: number;
}

/** Emit a PowerShell script that runs the merge through the installed Word. */
export function generateWordMergeScript(options: MergeScriptOptions): string {
  const { templatePath, dataPath, sheetName, outputDir, labelsPath, pidPath, splitPerRecord } =
    options;
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.trunc(options.limit!)) : 0;

  return `# Generated by Figment PropCo Automation.
# Runs the Word mail merge against the approved sheet and exports PDFs.
# Requires Microsoft Word installed on this machine.
#
#   Template : ${templatePath}
#   Data     : ${dataPath} [${sheetName}]
#   Output   : ${outputDir}
#   Records  : ${limit > 0 ? `first ${limit}` : 'all'}

$ErrorActionPreference = 'Stop'

$template   = '${escapePs(templatePath)}'
$data       = '${escapePs(dataPath)}'
$sheet      = '${escapePs(sheetName)}'
$outDir     = '${escapePs(outputDir)}'
$labelsFile = '${escapePs(labelsPath ?? '')}'
$pidFile    = '${escapePs(pidPath ?? '')}'
$limit      = ${limit}

if (-not (Test-Path $template)) { throw "Template not found: $template" }
if (-not (Test-Path $data))     { throw "Data file not found: $data" }
if (-not (Test-Path $outDir))   { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$labels = @()
if ($labelsFile -and (Test-Path $labelsFile)) {
  $labels = @(Get-Content -LiteralPath $labelsFile -Encoding UTF8)
}

$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

# Record only the Word we started. If Word was already open, COM attaches to that instance
# and this list is empty — the caller must never kill the operator's own session.
if ($pidFile) {
  $mine = @(Get-Process WINWORD -ErrorAction SilentlyContinue |
    Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
  ($mine -join ',') | Out-File -FilePath $pidFile -Encoding ascii
}

try {
  # Not read-only: Word records the data-source link on the document. Nothing is ever
  # saved back — every Close passes $false.
  $doc = $word.Documents.Open($template, $false, $false)

  $conn  = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$data;Mode=Read;Extended Properties=""HDR=YES;IMEX=1"";"
  # Built by concatenation so the sheet name interpolates but the OLEDB table suffix
  # stays a literal dollar sign.
  $query = "SELECT * FROM [" + $sheet + '$]'

  # Stop at SQLStatement. The trailing OpenExclusive/SubType arguments are optional, and
  # supplying them makes PowerShell's COM binder fail outright:
  #   Cannot convert the "1" value of type "int" to type "Object"
  # An explicit connection string and SELECT already suppress Word's "Select Table" prompt,
  # which is the only thing SubType was buying.
  $m = [Type]::Missing
  $doc.MailMerge.OpenDataSource(
    $data,                                  # Name
    $m,                                     # Format
    $false,                                 # ConfirmConversions
    $true,                                  # ReadOnly
    $true,                                  # LinkToSource
    $false,                                 # AddToRecentFiles
    $m, $m,                                 # PasswordDocument / PasswordTemplate
    $m, $m,                                 # Revert / WritePasswordDocument
    $m,                                     # WritePasswordTemplate
    $conn,
    $query
  )

  $available = $doc.MailMerge.DataSource.RecordCount
  Write-Host "RECORDS $available"

  $count = $available
  if ($limit -gt 0 -and $limit -lt $count) { $count = $limit }

${
  splitPerRecord
    ? `  for ($i = 1; $i -le $count; $i++) {
    $doc.MailMerge.DataSource.FirstRecord = $i
    $doc.MailMerge.DataSource.LastRecord  = $i

    $label = ''
    if ($i -le $labels.Count) { $label = $labels[$i - 1] }
    if ([string]::IsNullOrWhiteSpace($label)) { $label = "record-$i" }
    # Strip characters Windows will not accept in a file name.
    $safe = ($label -replace '[\\\\/:*?"<>|]', '-').Trim()
    if ($safe.Length -gt 90) { $safe = $safe.Substring(0, 90) }

    $doc.MailMerge.Destination = 0            # wdSendToNewDocument
    $doc.MailMerge.Execute($false)

    $merged = $word.ActiveDocument
    $pdf = Join-Path $outDir ("{0:D4} - {1}.pdf" -f $i, $safe)
    $merged.ExportAsFixedFormat($pdf, 17)     # wdExportFormatPDF
    $merged.Close($false)

    Write-Host "PROGRESS $i $count"
  }`
    : `  $doc.MailMerge.DataSource.FirstRecord = 1
  $doc.MailMerge.DataSource.LastRecord  = $count
  $doc.MailMerge.Destination = 0              # wdSendToNewDocument
  $doc.MailMerge.Execute($false)

  $merged = $word.ActiveDocument
  $pdf = Join-Path $outDir 'merged.pdf'
  $merged.ExportAsFixedFormat($pdf, 17)       # wdExportFormatPDF
  $merged.Close($false)
  Write-Host "PROGRESS $count $count"`
}

  $doc.Close($false)
  Write-Host "DONE $count"
}
finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
`;
}

function escapePs(value: string): string {
  return value.replace(/'/g, "''");
}

export interface WordMergeRun {
  /** Records the data source actually offered Word — not necessarily what we exported. */
  available: number;
  exported: number;
  log: string;
}

export interface RunOptions {
  /** Kill the run after this long with no further progress. */
  stallMs?: number;
  /** Sidecar file the script writes its own Word pid into. */
  pidPath?: string;
}

/**
 * Run a generated merge script and report progress as PDFs land.
 *
 * The script is spawned rather than executed in-process because Word COM belongs to
 * PowerShell here; Node has no supported binding. Failure is surfaced verbatim — a Word
 * COM error is unreadable enough already without a wrapper swallowing it.
 *
 * The stall timer is not belt-and-braces. An unlicensed Office runs Word in
 * reduced-functionality mode, where the merge itself succeeds and then *saving* blocks
 * forever at full CPU with no error and no dialog. Without a deadline that presents to
 * the operator as a progress bar that never moves.
 */
export function runWordMerge(
  scriptPath: string,
  options: RunOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<WordMergeRun> {
  const stallMs = options.stallMs ?? 4 * 60_000;

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    );

    let available = 0;
    let exported = 0;
    let stalled = false;
    const chunks: string[] = [];
    let pending = '';

    let timer: NodeJS.Timeout;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        killWord(options.pidPath);
        child.kill();
      }, stallMs);
    };
    arm();

    const consume = (text: string) => {
      chunks.push(text);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const records = /^RECORDS (\d+)$/.exec(line.trim());
        if (records) available = Number(records[1]);
        const progress = /^PROGRESS (\d+) (\d+)$/.exec(line.trim());
        if (progress) {
          exported = Number(progress[1]);
          arm();
          onProgress?.(exported, Number(progress[2]));
        }
      }
    };

    child.stdout.on('data', (d: Buffer) => consume(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => consume(d.toString('utf8')));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start PowerShell: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const log = chunks.join('');
      if (stalled) {
        reject(
          new Error(
            `Word stopped responding after ${exported} of ${available} records ` +
              `(no progress for ${Math.round(stallMs / 1000)}s), so the run was cancelled.\n\n` +
              'The usual cause is an unactivated Office: Word will open documents and run the ' +
              'merge, but silently refuses to save or export. Open Word, check whether the title ' +
              'bar says "Unlicensed Product", and sign in.',
          ),
        );
        return;
      }
      if (code !== 0) {
        // Word's own message is the useful part; keep the tail of the transcript.
        reject(new Error(`Word merge failed (exit ${code}).\n${log.trim().slice(-1200)}`));
        return;
      }
      resolve({ available, exported, log });
    });
  });
}

/** Kill only the Word the merge script started, never one the operator opened. */
function killWord(pidPath?: string): void {
  if (!pidPath || !existsSync(pidPath)) return;
  const ids = readFileSync(pidPath, 'utf8')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  for (const id of ids) {
    try {
      process.kill(id);
    } catch {
      // Already gone.
    }
  }
}

export interface WordStatus {
  available: boolean;
  /** Why not, in words the operator can act on. */
  reason?: string;
}

let wordProbe: Promise<WordStatus> | undefined;

/**
 * Whether this machine can actually produce PDFs.
 *
 * Two separate questions, because they fail differently. Word must be installed — probed
 * by instantiating it, since a registered-but-broken install only shows up then. And
 * Office must be *activated*: an unlicensed Word automates happily right up to the point
 * it is asked to write a file, then hangs. Checking the licence up front turns a
 * permanent hang into a sentence.
 */
export function wordStatus(): Promise<WordStatus> {
  if (process.platform !== 'win32') {
    return Promise.resolve({ available: false, reason: 'PDFs need Microsoft Word on Windows.' });
  }
  wordProbe ??= new Promise<WordStatus>((resolve) => {
    // LicenseStatus 1 is Licensed; 2 and 3 are grace periods that still save. Anything
    // else — 5 "Notification" in particular — is reduced-functionality mode.
    const command =
      "$bad = @(Get-CimInstance SoftwareLicensingProduct -Filter \"PartialProductKey is not null\" " +
      "-ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*Office*' -and $_.Name -notlike '*OneNote*' }); " +
      'if ($bad.Count -gt 0 -and -not ($bad | Where-Object { $_.LicenseStatus -in 1,2,3 })) { exit 2 }; ' +
      '$w = $null; try { $w = New-Object -ComObject Word.Application; exit 0 } ' +
      'catch { exit 1 } finally { if ($w) { $w.Quit() } }';

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true },
    );
    child.on('error', () =>
      resolve({ available: false, reason: 'Could not start PowerShell to look for Word.' }),
    );
    child.on('close', (code) => {
      if (code === 0) resolve({ available: true });
      else if (code === 2)
        resolve({
          available: false,
          reason:
            'Microsoft Office is not activated on this machine. Word will run the merge but ' +
            'refuses to save or export, so no PDF is ever written. Open Word, sign in to ' +
            'activate it, then try again.',
        });
      else
        resolve({
          available: false,
          reason: 'Microsoft Word is not installed on this machine, so PDFs cannot be produced here.',
        });
    });
  });
  return wordProbe;
}
