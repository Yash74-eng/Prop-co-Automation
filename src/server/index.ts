/** Local web server: JSON API plus the built wizard UI. */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { router } from './routes.js';
import { pruneStorage, STORAGE_DIR } from './store.js';

// Load .env without adding a dependency.
loadEnv();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', router);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    storage: STORAGE_DIR,
    anthropicKey: !!process.env.ANTHROPIC_API_KEY,
    bizfileEnabled: process.env.BIZFILE_ENABLED === '1',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',
  });
});

const webDist = resolve('web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
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
