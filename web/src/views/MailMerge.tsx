import { useState } from 'react';
import { api, type MergeCheck } from '../api.js';
import type { JobState } from '../useJob.js';
import { Card, Check, Empty, Field, Msg, Spinner, SummaryList, TemplateLink } from '../ui.jsx';

export function MailMergeView({ state }: { state: JobState }) {
  const { job, busy, guard } = state;
  const [file, setFile] = useState<File | null>(null);
  const [splitPerRecord, setSplitPerRecord] = useState(true);
  const [result, setResult] = useState<MergeCheck | null>(null);

  if (!job || !job.hasResult) {
    return <Empty>Generate a sheet first — there is nothing to merge yet.</Empty>;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mail merge</h1>
          <p className="lede">
            Check a Word template against the generated headers, then run the emitted script to
            export PDFs through the Word installed on this machine. A field-name mismatch here is
            the classic silent failure — the letter prints with a blank address.
          </p>
        </div>
      </div>

      <Card title="Validate a template">
        <div className="grid">
          <Field label="Word template (.docx)" hint="The letter, or the envelope.">
            <input
              type="file"
              accept=".docx"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
              }}
            />
            <div
              style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <span className="hint" style={{ margin: 0 }}>
                Start from a ready-made Word file — the merge fields are already in place:
              </span>
              <TemplateLink kind="letter-docx" label="Lawyer letter template .docx" />
              <TemplateLink kind="envelope-docx" label="Envelope template .docx" />
              <TemplateLink kind="postcard-docx" label="Postcard template .docx" />
              <TemplateLink kind="merge-fields" label="Merge field reference .xlsx" />
            </div>
          </Field>
        </div>

        <Check
          checked={splitPerRecord}
          onChange={setSplitPerRecord}
          label="One PDF per record"
          hint="Off produces a single merged document instead."
        />

        <div className="actions">
          <button
            disabled={!file || !!busy}
            onClick={() =>
              file &&
              void guard(
                'Template check',
                () => api.mailmerge(job.id, file, splitPerRecord),
                'Template checked',
              ).then((r) => r && setResult(r))
            }
          >
            {busy === 'Template check' ? <Spinner /> : null}
            Validate and build merge script
          </button>
        </div>
      </Card>

      {result ? (
        <>
          {result.check.ok ? (
            <Msg kind="ok">
              All {result.check.templateFields.length} merge fields in this template have a matching
              column in the <b>{result.sheetName}</b> sheet.
            </Msg>
          ) : (
            <Msg kind="err">
              This template expects fields the sheet does not provide, so they would merge{' '}
              <b>blank</b>: {result.check.missingInSheet.join(', ')}.
              <br />
              <span style={{ fontSize: 12.5 }}>
                If those look like the other channel's field names, this template belongs to the
                other deliverable — the envelope template pairs with the lawyer letter, not the
                postcard.
              </span>
            </Msg>
          )}

          <div className="grid">
            <Card title="Fields in the template" flat>
              {result.check.templateFields.length ? (
                <SummaryList items={result.check.templateFields.map((f) => ({ label: f, count: 1 }))} />
              ) : (
                <p className="hint">No merge fields found in this document.</p>
              )}
            </Card>
            <Card title="Sheet columns the template does not use" flat>
              {result.check.unusedInTemplate.length ? (
                <SummaryList
                  items={result.check.unusedInTemplate.map((f) => ({ label: f, count: 1 }))}
                  max={30}
                />
              ) : (
                <p className="hint">Every column is used.</p>
              )}
              <p className="hint" style={{ marginTop: 8 }}>
                Harmless — these are working columns like <code>Comments</code> and{' '}
                <code>Status</code>.
              </p>
            </Card>
          </div>

          <Card title="Run the merge" hint="Requires Microsoft Word on this machine.">
            <p style={{ fontSize: 13.5 }}>
              Open PowerShell in the repo and run:
            </p>
            <pre
              style={{
                background: 'var(--panel-alt)',
                border: '1px solid var(--line)',
                borderRadius: 7,
                padding: '10px 12px',
                overflowX: 'auto',
                fontSize: 12.5,
                margin: '8px 0',
              }}
            >
              <code>{result.command}</code>
            </pre>
            <button
              className="secondary tiny"
              onClick={() => void navigator.clipboard?.writeText(result.command)}
            >
              Copy command
            </button>
            <p className="hint" style={{ marginTop: 12 }}>
              The script opens the template, points it at the <b>{result.sheetName}</b> sheet of the
              generated workbook, and exports{' '}
              {splitPerRecord ? 'one PDF per record' : 'a single merged PDF'} into a folder beside
              it. Word is scripted rather than reimplemented because these templates carry headers,
              footers, QR images and Chinese text that only Word renders faithfully.
            </p>
          </Card>
        </>
      ) : null}

      <Card title="Before you send" flat>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
          <li>
            Clear the <b>Review Flags</b> sheet — especially anything marked <code>error</code>.
          </li>
          <li>
            Check every row whose <code>Comments</code> says <b>VERIFY BEFORE SENDING</b>: the price
            was derived from GFA × psf rather than a comparable.
          </li>
          <li>
            Resolve <code>mismatch</code> and <code>entity-inactive</code> verdicts on the BizFile
            sheet — an inactive entity should not receive an offer.
          </li>
          <li>Confirm the institutions-to-avoid flags are intended, since those are never auto-removed.</li>
        </ul>
      </Card>
    </>
  );
}
