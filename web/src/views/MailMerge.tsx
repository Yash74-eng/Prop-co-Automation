import { useState } from 'react';
import { api } from '../api.js';
import type { JobState } from '../useJob.js';
import { Card, Empty, Field, Msg, Spinner, StatTile, SummaryList, TemplateLink } from '../ui.jsx';

export function MailMergeView({ state }: { state: JobState }) {
  const { job, health, busy, guard, setJob } = state;
  const [template, setTemplate] = useState<File | null>(null);
  const [dataFile, setDataFile] = useState<File | null>(null);

  if (!job || !job.hasResult) {
    return <Empty>Generate a sheet first — there is nothing to merge yet.</Empty>;
  }

  const merge = job.merge;
  const run = job.mergeRun;
  const wordReady = health?.wordAvailable !== false;
  // A test run is a single record; anything else is the real thing.
  const wasTestRun = merge?.lastRunLimit === 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mail merge</h1>
          <p className="lede">
            Point a Word template at the sheet you are actually sending, prove one PDF looks right,
            then export the rest. Everything runs here — no workbook round-trip, no PowerShell.
          </p>
        </div>
      </div>

      {/* ------------------------------------------------------------ 1. setup */}
      <Card
        title="1 · Template and data"
        hint="The data source defaults to the workbook this tool generated."
      >
        <div className="grid">
          <Field label="Word template (.docx)" hint="The letter, the envelope, or the postcard.">
            <input
              type="file"
              accept=".docx"
              onChange={(e) => setTemplate(e.target.files?.[0] ?? null)}
            />
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="hint" style={{ margin: 0 }}>
                Start from a ready-made Word file — the merge fields are already in place:
              </span>
              <TemplateLink kind="letter-docx" label="Lawyer letter template .docx" />
              <TemplateLink kind="envelope-docx" label="Envelope template .docx" />
            </div>
          </Field>

          <Field
            label="Merge from your own sheet (.xlsx) — optional"
            hint="Upload the copy you edited after BizFile and the cross-check. Leave empty to merge from the generated workbook."
          >
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => setDataFile(e.target.files?.[0] ?? null)}
            />
            {dataFile ? (
              <p className="hint" style={{ marginTop: 8 }}>
                Merging from <b>{dataFile.name}</b>. The template is checked against{' '}
                <i>this file's</i> headers, not the ones this tool would have written — an edited
                sheet is the only thing that proves the merge.
              </p>
            ) : null}
          </Field>
        </div>

        <div className="actions">
          <button
            disabled={(!template && !merge) || !!busy}
            onClick={() =>
              template &&
              void guard(
                'Template check',
                () => api.mailmerge(job.id, template, dataFile ?? undefined),
                'Template checked',
              ).then((r) => r && setJob(r))
            }
          >
            {busy === 'Template check' ? <Spinner /> : null}
            Check template against the sheet
          </button>
        </div>
      </Card>

      {merge ? (
        <>
          {merge.check.ok ? (
            <Msg kind="ok">
              All {merge.check.templateFields.length} merge fields in <b>{merge.templateName}</b>{' '}
              have a matching column in <b>{merge.sheetName}</b> ({merge.dataName},{' '}
              {merge.dataRows.toLocaleString('en-SG')} records).
            </Msg>
          ) : (
            <Msg kind="err">
              This template expects fields <b>{merge.sheetName}</b> does not provide, so they would
              merge <b>blank</b>: {merge.check.missingInSheet.join(', ')}.
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
              {merge.check.templateFields.length ? (
                <SummaryList
                  items={merge.check.templateFields.map((f) => ({ label: f, count: 1 }))}
                />
              ) : (
                <p className="hint">No merge fields found in this document.</p>
              )}
            </Card>
            <Card title="Sheet columns the template does not use" flat>
              {merge.check.unusedInTemplate.length ? (
                <SummaryList
                  items={merge.check.unusedInTemplate.map((f) => ({ label: f, count: 1 }))}
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

          {/* -------------------------------------------------------- 2. produce */}
          <Card
            title="2 · Produce the PDFs"
            hint="Word is scripted, not reimplemented — these templates carry headers, footers, QR images and Chinese text that only Word renders faithfully."
          >
            {!wordReady ? (
              <Msg kind="warn">
                <b>PDFs cannot be produced on this machine.</b>
                <br />
                {health?.wordReason}
                <br />
                <span style={{ fontSize: 12.5 }}>
                  Set the merge up as above, then download the script below and run it on a PC that
                  can — it does exactly the same work.
                </span>
              </Msg>
            ) : null}

            {!merge.check.ok ? (
              <Msg kind="warn">
                Fix the missing fields first. Merging now would print letters with blank addresses.
              </Msg>
            ) : null}

            {run?.running ? (
              <Msg kind="info">
                <b>
                  Exported {run.done} of {run.total}
                </b>{' '}
                — Word opens one document per recipient, so a full run takes a few minutes. You can
                leave this page and come back.
              </Msg>
            ) : null}

            {run?.error ? (
              <Msg kind="err">
                <b>The merge did not finish.</b>
                <br />
                <span style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{run.error}</span>
              </Msg>
            ) : null}

            <div className="actions">
              <button
                disabled={!wordReady || !!busy || !!run?.running}
                onClick={() =>
                  void guard('Test PDF', () => api.mailmergeRun(job.id, { limit: 1 })).then(
                    (r) => r && setJob(r),
                  )
                }
              >
                {busy === 'Test PDF' ? <Spinner /> : null}
                Test one PDF
              </button>
              <button
                className="secondary"
                disabled={!wordReady || !!busy || !!run?.running || !merge.check.ok}
                onClick={() =>
                  void guard('Mail merge', () => api.mailmergeRun(job.id)).then(
                    (r) => r && setJob(r),
                  )
                }
              >
                {busy === 'Mail merge' || run?.running ? <Spinner /> : null}
                {run?.running
                  ? `Exporting ${run.done} / ${run.total}…`
                  : `Run all ${merge.dataRows.toLocaleString('en-SG')} records`}
              </button>
              <a className="button secondary tiny" href={api.mailmergeScriptUrl(job.id)}>
                Download the PowerShell script
              </a>
            </div>

            <p className="hint" style={{ marginTop: 10 }}>
              Start with one. A merge field that resolves to the wrong column looks fine in the
              header check and only shows up on the page.
            </p>
          </Card>

          {/* -------------------------------------------------------- 3. result */}
          {merge.pdfCount > 0 && !run?.running ? (
            <Card title={wasTestRun ? '3 · Check this PDF' : '3 · Collect the PDFs'}>
              <div className="stats" style={{ marginBottom: 14 }}>
                <StatTile label="PDFs" value={merge.pdfCount} accent />
                <StatTile label="Records in sheet" value={merge.dataRows} />
              </div>

              {wasTestRun ? (
                <>
                  <Msg kind="info">
                    One record only. Read it end to end — the owner name, the property address, the
                    mailing address and both prices — then run the rest.
                  </Msg>
                  <iframe
                    title="Test PDF"
                    src={api.mailmergePdfUrl(job.id, 0)}
                    style={{
                      width: '100%',
                      height: 620,
                      border: '1px solid var(--line)',
                      borderRadius: 7,
                      background: 'var(--panel-alt)',
                    }}
                  />
                  <div className="actions" style={{ marginTop: 10 }}>
                    <a
                      className="button secondary tiny"
                      href={api.mailmergePdfUrl(job.id, 0)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in a new tab
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <div className="actions">
                    <a className="button" href={api.mailmergeZipUrl(job.id)}>
                      Download all {merge.pdfCount.toLocaleString('en-SG')} PDFs (.zip)
                    </a>
                  </div>
                  {merge.pdfCount < merge.dataRows ? (
                    <Msg kind="warn">
                      {merge.dataRows - merge.pdfCount} of {merge.dataRows} records produced no PDF.
                      Check the run log before sending — a short export is not a complete mailing.
                    </Msg>
                  ) : null}
                  <p className="hint" style={{ marginTop: 10 }}>
                    Each file is named after the property address, prefixed with its row number so
                    the zip sorts in sheet order.
                  </p>
                  <SummaryList
                    items={merge.pdfNames.map((n) => ({ label: n, count: 1 }))}
                    max={12}
                  />
                </>
              )}
            </Card>
          ) : null}
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
          <li>
            Confirm the institutions-to-avoid flags are intended, since those are never
            auto-removed.
          </li>
        </ul>
      </Card>
    </>
  );
}
