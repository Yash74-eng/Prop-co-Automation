/** Local web server: JSON API plus the built wizard UI. */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compsSheetUrl, router } from './routes.js';
import { pruneStorage, STORAGE_DIR } from './store.js';
import { wordStatus } from '../mailmerge/wordMerge.js';
import { serviceAccount } from '../sheets/google.js';

// Load .env without adding a dependency.
loadEnv();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Never let a browser or proxy hold onto an API response. Every one of these describes
// mutable server state — a job's sheet list, a run's progress, a funnel — and a cached
// copy read after the state moved is indistinguishable from a bug in the app.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/api', router);

app.get('/api/health', async (_req, res) => {
  // Whether this machine can produce PDFs itself, so the UI can say so before the
  // operator commits to a run rather than after it hangs.
  const word = await wordStatus();
  res.json({
    ok: true,
    storage: STORAGE_DIR,
    anthropicKey: !!process.env.ANTHROPIC_API_KEY,
    bizfileEnabled: process.env.BIZFILE_ENABLED === '1',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',
    wordAvailable: word.available,
    wordReason: word.reason ?? null,
    // Whether a private Google Sheet can be read. Without a key only a link-shared or
    // published sheet works, and the UI should say so before the fetch fails.
    googleServiceAccount: googleServiceAccountEmail(),
    // The comps workbook, so the UI can offer it without anyone pasting a link.
    compsSheetUrl: compsSheetUrl(),
  });
});

/** The configured service-account address, so the UI can say who to share the sheet with. */
function googleServiceAccountEmail(): string | null {
  try {
    return serviceAccount()?.client_email ?? null;
  } catch {
    // A malformed key is reported when a fetch is attempted, not on every health poll.
    return null;
  }
}

const webDist = resolve('web/dist');
if (existsSync(webDist)) {
  /**
   * index.html is never cached; the files it points at always are.
   *
   * Vite fingerprints every asset (`index-CsUmApuL.js`), so those are safe to keep
   * forever — the name changes when the contents do. The shell is the opposite: one
   * stale copy pins the browser to the previous build's asset names, and the app quietly
   * carries on running last week's UI. That looks like a feature not having shipped, and
   * it is the hardest kind of report to act on.
   */
  const noStore = (res: import('express').Response) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Expires', '0');
  };

  app.use(
    express.static(webDist, {
      etag: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) noStore(res);
        else if (/[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get(/^(?!\/api).*/, (_req, res) => {
    noStore(res);
    res.sendFile(resolve(webDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) =>
    res
      .status(200)
      .type('html')
      .send(
        `<pre style="font:14px ui-monospace,monospace;padding:24px;line-height:1.6">
Figment PropCo Automation — API is running.

The web UI has not been built yet. Run:

    npm --prefix web install
    npm run web:build

then reload this page. For development with hot reload:

    npm run dev          (this server, port ${port()})
    npm run web:dev      (UI on port 5174, proxying /api here)

API endpoints are live now at /api/health, /api/jobs, ...
</pre>`,
      ),
  );
}

// Anything unhandled becomes JSON rather than an HTML stack trace.
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  },
);

function port(): number {
  const n = Number(process.env.PORT);
  return Number.isFinite(n) && n > 0 ? n : 5173;
}

const removed = pruneStorage(72);
if (removed > 0) console.log(`Pruned ${removed} storage files older than 72h`);

app.listen(port(), () => {
  console.log(`\n  Figment PropCo Automation`);
  console.log(`  http://localhost:${port()}`);
  console.log(`  storage: ${STORAGE_DIR}`);
  console.log(
    `  Claude cross-check: ${process.env.ANTHROPIC_API_KEY ? 'ready' : 'set ANTHROPIC_API_KEY in .env to enable'}`,
  );
  console.log(
    `  BizFile live lookup: ${process.env.BIZFILE_ENABLED === '1' ? 'enabled' : 'disabled (upload a BizFile export instead)'}\n`,
  );
});

function loadEnv(): void {
  const path = resolve('.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
