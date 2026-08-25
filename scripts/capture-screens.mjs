/**
 * Walk the wizard and screenshot every step, for a deck.
 *
 * Runs on the Main Database template rather than the real tracker: the images go into a
 * file that leaves this machine, and example owners make the same point about the tool
 * without putting real names and mailing addresses on a slide. The comps are the live
 * Market Watch workbook, so the pricing shown is genuine.
 *
 * Two things the wizard needs before the later steps unlock, both learned the hard way:
 * `hasResult` (so the pipeline must run first) and `settings.channel`, which is React
 * state — refreshing the page after choosing a channel throws it away and lands back on
 * the channel gate.
 */
import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:5173';
const OUT = process.argv[2] ?? 'deck-shots';
mkdirSync(OUT, { recursive: true });

const api = async (path, body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error}`);
  return j;
};

console.log('preparing a job through the API');
const template = Buffer.from(
  await (await fetch(`${BASE}/api/templates/main-database`)).arrayBuffer(),
);
const fd = new FormData();
fd.append('file', new Blob([template]), 'PropCo Dealflow Tracker.xlsx');
const job = await (await fetch(`${BASE}/api/jobs`, { method: 'POST', body: fd })).json();
if (job.error) throw new Error(job.error);

const comps = await api(`/jobs/${job.id}/comps-from-google-sheet`, {});
console.log(`  comps: ${comps.transactions?.toLocaleString('en-SG')} transactions`);

const run = await api(`/jobs/${job.id}/run`, { channel: 'lawyer-letter', mailDate: '2026-09-01' });
console.log(`  generated: ${run.stats?.recipients} recipients`);

// A BizFile verdict and a Claude finding, so steps 4 and 5 are not empty panels.
const rows = await (await fetch(`${BASE}/api/jobs/${job.id}/rows?limit=5`)).json();
const owner = rows.rows.find((r) => /PTE|LTD|LIMITED/i.test(String(r.Registered_Proprietor ?? '')));
if (owner) {
  const XLSX = (await import('xlsx')).default;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Entity Name', 'UEN', 'Entity Status', 'Registered Office Address'],
      [owner.Registered_Proprietor, '200012345A', 'Live', '9 SOMEWHERE ELSE ROAD SINGAPORE 555555'],
    ]),
    'Export',
  );
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const bf = new FormData();
  bf.append('file', new Blob([buf]), 'bizfile-export.xlsx');
  await fetch(`${BASE}/api/jobs/${job.id}/bizfile`, { method: 'POST', body: bf });
  for (let i = 0; i < 20; i++) {
    const s = await (await fetch(`${BASE}/api/jobs/${job.id}`)).json();
    if (!s.bizfileRun?.running) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log('  bizfile: verified');
}

const options = new chrome.Options();
options.addArguments('--headless=new', '--window-size=1500,1000', '--force-device-scale-factor=1.5');
const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

const shots = [];

/**
 * One viewport-sized frame, optionally scrolled to the panel that matters.
 *
 * Deliberately not the full page height. The Configure page is ~3,500px tall; scaled to
 * fit a slide that becomes a 3.8-inch-wide sliver nobody can read, which defeats the point
 * of putting it in front of someone. A 3:2 frame fills the slide and stays legible.
 */
const shot = async (name, caption, scrollTo) => {
  await driver.sleep(900);
  if (scrollTo) {
    await driver.executeScript(
      `const want = ${JSON.stringify(scrollTo.toLowerCase())};
       const t = [...document.querySelectorAll('.card')]
         .find((e) => (e.textContent || '').toLowerCase().includes(want));
       if (t) { t.scrollIntoView({ block: 'start' }); window.scrollBy(0, -20); }`,
    );
  } else {
    await driver.executeScript('window.scrollTo(0, 0)');
  }
  await driver.sleep(700);
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(await driver.takeScreenshot(), 'base64'));
  shots.push({ name, file: file.replace(/\\/g, '/'), caption });
  console.log(`  ${name}.png`);
};

const clickText = async (selector, text) => {
  const els = await driver.findElements(By.css(selector));
  for (const el of els) {
    // textContent, not getText(): getText() returns '' for anything outside the viewport,
    // and shot() resizes the window, so a button below the fold reads as blank.
    const label = (await el.getAttribute('textContent')) ?? '';
    if (label.toLowerCase().includes(text.toLowerCase())) {
      await driver.executeScript('arguments[0].scrollIntoView({block:"center"})', el);
      await driver.sleep(150);
      await el.click();
      return;
    }
  }
  throw new Error(`no ${selector} matching "${text}"`);
};

try {
  // 1 — the channel gate, with nothing loaded. Capture this before seeding a job: App
  // jumps an adopted job with a result straight to Review, so the gate is unreachable
  // once one exists.
  await driver.get(BASE);
  await driver.executeScript("localStorage.removeItem('propco.jobId')");
  await driver.navigate().refresh();
  await driver.wait(until.elementLocated(By.css('.nav button')), 15000);
  await driver.sleep(1200);
  await shot('01-channel', 'One deliverable per run, chosen before anything else');

  // Now adopt the finished job. This lands on Review; walk back to Upload for step 1.
  await driver.executeScript(`localStorage.setItem('propco.jobId', ${JSON.stringify(job.id)})`);
  await driver.navigate().refresh();
  await driver.wait(until.elementLocated(By.css('.nav button')), 15000);
  await driver.sleep(1800);

  await clickText('.nav button', 'Upload');
  await driver.sleep(800);
  // From here on there is no refresh: the channel is React state and a reload loses it.
  await clickText('button', 'Lawyer letter');
  await driver.sleep(1800);
  await shot('02-upload', 'The tracker read live, every column mapped and checked');

  await clickText('.nav button', 'Configure');
  await driver.sleep(1200);
  await shot('03-configure', 'Who to write to, and how the offer range is worked out', 'who to skip');

  // Open the Excel-style value picker.
  for (const sel of await driver.findElements(By.css('select'))) {
    const values = await Promise.all(
      (await sel.findElements(By.css('option'))).map((o) => o.getAttribute('value')),
    );
    if (values.includes('custom')) {
      await driver.executeScript(
        "arguments[0].value='custom'; arguments[0].dispatchEvent(new Event('change',{bubbles:true}))",
        sel,
      );
      break;
    }
  }
  await driver.sleep(2200);
  await shot('04-picker', 'The outreach column itself, filtered like a spreadsheet', 'who to include');

  await clickText('.nav button', 'Review');
  await driver.sleep(1500);
  await shot('05-review', 'Every row accounted for, with a reason for each one dropped');

  await clickText('.nav button', 'Verify');
  await driver.sleep(1500);
  await shot('06-verify', 'ACRA address checks, and a Claude read of every row');

  await clickText('.nav button', 'Mail merge');
  await driver.sleep(1500);
  await shot('07-merge', 'Word templates checked, one PDF proved, then the rest exported');

  writeFileSync(join(OUT, 'shots.json'), JSON.stringify({ shots, stats: run.stats }, null, 2));
  console.log(`\n${shots.length} screenshots -> ${OUT}/`);
} finally {
  await driver.quit();
}
