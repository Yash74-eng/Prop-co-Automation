import { useEffect, useMemo, useState } from 'react';
import { useJob } from './useJob.js';
import { ToastHost, useTheme, formatTime } from './ui.jsx';
import { UploadView } from './views/Upload.jsx';
import { ConfigureView, defaultSettings, type RunSettings } from './views/Configure.jsx';
import { ReviewView } from './views/Review.jsx';
import { VerifyView } from './views/Verify.jsx';
import { MailMergeView } from './views/MailMerge.jsx';

type Step = 'upload' | 'configure' | 'review' | 'verify' | 'merge';

const STEPS: { key: Step; label: string; num: string }[] = [
  { key: 'upload', label: 'Upload', num: '1' },
  { key: 'configure', label: 'Configure', num: '2' },
  { key: 'review', label: 'Review', num: '3' },
  { key: 'verify', label: 'Verify', num: '4' },
  { key: 'merge', label: 'Mail merge', num: '5' },
];

export function App() {
  return (
    <ToastHost>
      <Shell />
    </ToastHost>
  );
}

function Shell() {
  const state = useJob();
  const { job, health, busy } = state;
  const { theme, toggle } = useTheme();
  const [step, setStep] = useState<Step>('upload');
  const [settings, setSettings] = useState<RunSettings>(() => defaultSettings());

  // Land on the furthest step the job has reached, so a reload resumes where you were.
  useEffect(() => {
    if (!job) return setStep('upload');
    setStep((current) => (current === 'upload' && job.hasResult ? 'review' : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.hasResult]);

  const done: Record<Step, boolean> = useMemo(
    () => ({
      upload: !!job,
      configure: !!job?.hasResult,
      review: !!job?.hasResult,
      verify: !!job?.bizfile || !!job?.crossCheck,
      merge: false,
    }),
    [job],
  );

  const enabled: Record<Step, boolean> = {
    upload: true,
    // Configure needs both a workbook and an explicit channel choice from step 1.
    configure: !!job && !!settings.channel,
    review: !!job?.hasResult,
    verify: !!job?.hasResult,
    merge: !!job?.hasResult,
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">
            Prop<em>Co</em> Outreach
          </span>
          <span className="tag">Figment · lawyer letters &amp; postcards</span>
        </div>

        <nav className="nav">
          {STEPS.map((s) => (
            <button
              key={s.key}
              className={step === s.key ? 'on' : ''}
              disabled={!enabled[s.key]}
              onClick={() => setStep(s.key)}
            >
              <span className={`dot${done[s.key] ? ' done' : ''}`}>{done[s.key] ? '✓' : s.num}</span>
              {s.label}
            </button>
          ))}
        </nav>

        {job ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, color: 'var(--ink-soft)', wordBreak: 'break-word' }}>
              {job.sourceFileName}
            </div>
            {job.sheetName ? <div>sheet: {job.sheetName}</div> : null}
            {job.stats?.recipients !== undefined ? (
              <div>{job.stats.recipients.toLocaleString('en-SG')} recipients</div>
            ) : null}
            {(job.channel ?? settings.channel) ? (
              <div>
                {(job.channel ?? settings.channel) === 'lawyer-letter'
                  ? 'Lawyer letter'
                  : 'Postcard'}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="sidebar-foot">
          {busy ? (
            <div className="env-row" style={{ color: 'var(--accent)' }}>
              <span className="spinner" />
              <span style={{ flex: 1, textAlign: 'right' }}>{busy}…</span>
            </div>
          ) : null}
          <div className="env-row">
            <span>Claude check</span>
            <span className={`pill ${health?.anthropicKey ? 'ok' : ''}`}>
              {health?.anthropicKey ? 'ready' : 'no key'}
            </span>
          </div>
          <div className="env-row">
            <span>BizFile live</span>
            <span className={`pill ${health?.bizfileEnabled ? 'ok' : ''}`}>
              {health?.bizfileEnabled ? 'on' : 'upload only'}
            </span>
          </div>
          <button className="switch" onClick={toggle} title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'} {theme === 'dark' ? 'Light' : 'Dark'} mode
          </button>
        </div>
      </aside>

      <main className="main">
        {step === 'upload' ? (
          <UploadView
            state={state}
            settings={settings}
            onChange={setSettings}
            onNext={() => setStep('configure')}
          />
        ) : null}
        {step === 'configure' ? (
          <ConfigureView
            state={state}
            settings={settings}
            onChange={setSettings}
            onRan={() => setStep('review')}
          />
        ) : null}
        {step === 'review' ? <ReviewView state={state} /> : null}
        {step === 'verify' ? <VerifyView state={state} /> : null}
        {step === 'merge' ? <MailMergeView state={state} /> : null}

        {job?.log.length ? (
          <details style={{ marginTop: 24 }}>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 12.5,
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                fontWeight: 600,
              }}
            >
              Activity log ({job.log.length})
            </summary>
            <div className="log" style={{ marginTop: 8 }}>
              {job.log
                .slice()
                .reverse()
                .map((l, i) => (
                  <div key={i}>
                    {formatTime(l.at)} [{l.step}] {l.message}
                  </div>
                ))}
            </div>
          </details>
        ) : null}
      </main>
    </div>
  );
}
