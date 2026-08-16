/**
 * Mail-merge readiness (step 8).
 *
 * The PDF generation itself is templated later, but two things are worth having now:
 *
 *  1. `listMergeFields` reads the MERGEFIELD names out of a .docx so we can prove the
 *     generated sheet's headers line up with what the template asks for. A silent
 *     mismatch here is the classic mail-merge failure — «Full_Address» renders empty
 *     because the sheet header says "Full_Addressk".
 *
 *  2. `generateWordMergeScript` emits a PowerShell script that drives Word via COM to
 *     run the merge and export one PDF per record. Word is the only thing that renders
 *     these templates faithfully (they carry headers, footers, QR images and Chinese
 *     text), so scripting the installed Word beats re-implementing the layout.
 */
import { readFileSync } from 'node:fs';
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

/** Verify a template's merge fields against the headers this tool writes. */
export function checkMergeFields(
  docxPath: string,
  channel: 'lawyer-letter' | 'postcard',
): MergeFieldCheck {
  const templateFields = listMergeFields(docxPath);
  const sheetHeaders = (
    channel === 'lawyer-letter' ? LAWYER_LETTER_HEADERS : POSTCARD_HEADERS
  ) as unknown as string[];

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
  /** Generated workbook to use as the data source. */
  dataPath: string;
  /** Sheet inside the workbook, e.g. "Lawyer Letter". */
  sheetName: string;
  outputDir: string;
  /** Column whose value names each PDF, e.g. "Full_Address". */
  fileNameColumn?: string;
  /** Produce one PDF per record instead of a single merged document. */
  splitPerRecord: boolean;
}

/**
 * Emit a PowerShell script that runs the merge through the installed Word.
 * Written to disk and run by the user, so the tool never launches Word unasked.
 */
export function generateWordMergeScript(options: MergeScriptOptions): string {
  const {
    templatePath,
    dataPath,
    sheetName,
    outputDir,
    fileNameColumn = 'Full_Address',
    splitPerRecord,
  } = options;

  return `# Generated by Figment PropCo Automation.
# Runs the Word mail merge against the generated sheet and exports PDFs.
# Requires Microsoft Word installed on this machine.
#
#   Template : ${templatePath}
#   Data     : ${dataPath} [${sheetName}]
#   Output   : ${outputDir}

$ErrorActionPreference = 'Stop'

$template = '${escapePs(templatePath)}'
$data     = '${escapePs(dataPath)}'
$sheet    = '${escapePs(sheetName)}'
$outDir   = '${escapePs(outputDir)}'

if (-not (Test-Path $template)) { throw "Template not found: $template" }
if (-not (Test-Path $data))     { throw "Data file not found: $data" }
if (-not (Test-Path $outDir))   { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
  $doc = $word.Documents.Open($template, $false, $true)

  # wdMergeSubTypeAccess = 1 keeps Word from prompting for a delimiter dialog.
  $doc.MailMerge.OpenDataSource(
    $data,                                  # Name
    [Type]::Missing,                        # Format
    $false,                                 # ConfirmConversions
    $true,                                  # ReadOnly
    $true,                                  # LinkToSource
    $false,                                 # AddToRecentFiles
    [Type]::Missing, [Type]::Missing,       # PasswordDocument / PasswordTemplate
    [Type]::Missing, [Type]::Missing,       # Revert / WritePasswordDocument
    [Type]::Missing,                        # WritePasswordTemplate
    "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$data;Mode=Read;Extended Properties=""HDR=YES;IMEX=1"";",
    "SELECT * FROM [\`$sheet\$]",
    [Type]::Missing, [Type]::Missing,
    1                                       # wdMergeSubTypeAccess
  )

  $count = $doc.MailMerge.DataSource.RecordCount
  Write-Host "Records in data source: $count"

${
  splitPerRecord
    ? `  for ($i = 1; $i -le $count; $i++) {
    $doc.MailMerge.DataSource.FirstRecord = $i
    $doc.MailMerge.DataSource.LastRecord  = $i
    $doc.MailMerge.DataSource.ActiveRecord = $i

    $label = $doc.MailMerge.DataSource.DataFields.Item('${fileNameColumn}').Value
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

    if ($i % 25 -eq 0) { Write-Host "  exported $i / $count" }
  }`
    : `  $doc.MailMerge.Destination = 0              # wdSendToNewDocument
  $doc.MailMerge.Execute($false)

  $merged = $word.ActiveDocument
  $pdf = Join-Path $outDir 'merged.pdf'
  $merged.ExportAsFixedFormat($pdf, 17)       # wdExportFormatPDF
  $merged.Close($false)`
}

  $doc.Close($false)
  Write-Host "Done. PDFs are in $outDir"
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
