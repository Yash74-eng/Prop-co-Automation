/**
 * Selenium resolver for BizFile registered-address lookups.
 *
 * ## Read this before enabling it
 *
 * bizfile.gov.sg actively defends this endpoint, and both defences were confirmed by
 * probing the live site on 13 Aug 2026:
 *
 *  1. **CloudFront blocks headless Chrome.** A headless session gets `403 — The request
 *     could not be satisfied` before the app even renders. So this resolver runs a real,
 *     visible browser window by default.
 *  2. **The search is gated by reCAPTCHA.** In an automated-but-visible session the page
 *     renders correctly and the search submits, but the backend returns *zero results* —
 *     `DBS BANK` with the default filters reports "No matching results found". It fails
 *     by returning nothing rather than by erroring, which is the dangerous part.
 *
 * That second point is why this file leads with a canary check. A silently-blocked run
 * would stamp every corporate owner `not-found`, which reads on the audit sheet exactly
 * like "ACRA has no record of this company" — a false negative someone could act on.
 * So: verify a known-live entity first, and refuse to run the batch if it comes back
 * empty. Better to return no report than a confidently wrong one.
 *
 * The reliable paths remain `csvResolver` (upload a BizFile export) and ACRA's official
 * subscription APIs. This resolver is for attended use — a human at the machine who can
 * satisfy a challenge in the visible window — and never solves or circumvents one.
 *
 * Selector note: `#input-search-bar`, `#federated-search-input-button` and
 * `#right-results` were read off the live DOM and are correct. The *shape of a result
 * card* could not be observed, because no search in testing ever returned one. Field
 * extraction is therefore text-based and deliberately forgiving; treat it as unverified
 * until a run gets past the canary and you can compare output against the site by eye.
 */
import type { Builder as BuilderType, WebDriver } from 'selenium-webdriver';
import { BizFileRecord, CorporateOwnerQuery, BizFileVerification } from './types.js';
import { verifyAddress } from './resolver.js';
import { squash } from '../core/text.js';

export const BIZFILE_SEARCH_PAGE = 'https://www.bizfile.gov.sg/buy-info/search/results';

/** A live, unmistakable ACRA entity. If a search for this returns nothing, we are blocked. */
export const BIZFILE_CANARY = 'DBS BANK';

/** Thrown when the site is refusing to serve results to an automated session. */
export class BizFileBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BizFileBlockedError';
  }
}

/** Thrown when the attended browser window went away mid-run. */
export class BizFileWindowClosedError extends Error {
  constructor() {
    super(
      'The BizFile browser window was closed before the run finished, so no verification was ' +
        'recorded. The live resolver runs a visible window on purpose — leave it alone while it works.',
    );
    this.name = 'BizFileWindowClosedError';
  }
}

/** Selenium reports a closed window or dead session under several names. */
function isWindowGone(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = (error as { message?: string } | null)?.message ?? '';
  return (
    /NoSuchWindowError|NoSuchSessionError|WebDriverError/.test(name) &&
    /window already closed|web view not found|invalid session id|target window/i.test(
      `${name} ${message}`,
    )
  );
}

export interface SeleniumResolverOptions {
  /** Milliseconds to wait for one search's results before giving up. */
  timeoutMs: number;
  /** Milliseconds between searches. Keep this polite — it is a .gov.sg service. */
  delayMs: number;
  /** Hard cap on how many names to look up in one run. */
  limit: number;
  /** Run a visible browser. Headless is blocked by CloudFront, so this defaults on. */
  headful: boolean;
  /** Skip the canary preflight. Only for debugging — invites silent false negatives. */
  skipCanary?: boolean;
  onProgress?: (done: number, total: number, current: string) => void;
}

export function defaultSeleniumOptions(
  over: Partial<SeleniumResolverOptions> = {},
): SeleniumResolverOptions {
  return {
    timeoutMs: 30_000,
    delayMs: 4_000,
    limit: 10,
    headful: true,
    skipCanary: false,
    ...over,
  };
}

interface SearchOutcome {
  /** Result text for the query, or undefined when the site reported no match. */
  record?: BizFileRecord;
  /** True when the page showed a challenge or an outright block. */
  blocked: boolean;
  /** True when the site explicitly said there were no matches. */
  emptyResult: boolean;
  detail: string;
}

export async function seleniumResolver(options: SeleniumResolverOptions) {
  let Builder: typeof BuilderType;
  let chromeMod: typeof import('selenium-webdriver/chrome.js');
  try {
    ({ Builder } = await import('selenium-webdriver'));
    chromeMod = await import('selenium-webdriver/chrome.js');
  } catch {
    throw new Error(
      'selenium-webdriver is not installed. Run: npm i selenium-webdriver. A local Chrome is also required.',
    );
  }

  return async (queries: CorporateOwnerQuery[]): Promise<BizFileVerification[]> => {
    const chromeOptions = new chromeMod.Options();
    const args = ['--window-size=1500,2400', '--lang=en-SG', '--disable-dev-shm-usage'];
    // Headless is refused with a CloudFront 403, so only honour it if explicitly asked.
    if (!options.headful) args.push('--headless=new');
    chromeOptions.addArguments(...args);

    const driver = await new Builder().forBrowser('chrome').setChromeOptions(chromeOptions).build();
    const results: BizFileVerification[] = [];
    const todo = queries.slice(0, options.limit);

    try {
      await driver.manage().setTimeouts({ pageLoad: 60_000, script: options.timeoutMs });
      await openSearchPage(driver);

      if (!options.skipCanary) {
        const canary = await guardWindow(() => searchOne(driver, BIZFILE_CANARY, options.timeoutMs));
        if (canary.blocked || canary.emptyResult) {
          throw new BizFileBlockedError(
            `BizFile returned no results for the control search "${BIZFILE_CANARY}", which is a live ACRA entity. ` +
              'The site is gating automated sessions behind reCAPTCHA, so a batch run would mark every owner ' +
              '"not-found" incorrectly. Nothing was written. Use a BizFile export upload, or ACRA\'s ' +
              `subscription API, instead. (${canary.detail})`,
          );
        }
      }

      for (let i = 0; i < todo.length; i++) {
        const query = todo[i];
        options.onProgress?.(i, todo.length, query.ownerName);

        const outcome = await guardWindow(() =>
          searchOne(driver, query.ownerName, options.timeoutMs),
        );
        if (outcome.blocked) {
          throw new BizFileBlockedError(
            `BizFile started challenging the session after ${i} of ${todo.length} lookups. ` +
              `Partial results were discarded rather than reported as verified. (${outcome.detail})`,
          );
        }
        results.push(verifyAddress(query, outcome.record));

        if (i < todo.length - 1) await driver.sleep(options.delayMs);
      }
      options.onProgress?.(todo.length, todo.length, 'done');
    } finally {
      await driver.quit().catch(() => undefined);
    }
    return results;
  };
}

/** Turn a mid-run closed window into a message that says what to do about it. */
async function guardWindow<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isWindowGone(error)) throw new BizFileWindowClosedError();
    throw error;
  }
}

async function openSearchPage(driver: WebDriver): Promise<void> {
  const { By } = await import('selenium-webdriver');
  await driver.get(BIZFILE_SEARCH_PAGE);
  await driver.sleep(6_000);

  const text = await bodyText(driver);
  if (/request blocked|could not be satisfied|access denied/i.test(text)) {
    throw new BizFileBlockedError(
      'bizfile.gov.sg refused the connection outright (CloudFront block). This happens with headless ' +
        'Chrome — set BIZFILE_HEADFUL=1 to run a visible browser.',
    );
  }

  // Overlays intercept clicks on the search button, so clear the ones we know about.
  for (const id of ['notice-banner-close', 'action-modal-button', 'profile-ok', 'close-drawer']) {
    try {
      const el = await driver.findElement(By.id(id));
      if (await el.isDisplayed()) {
        await driver.executeScript('arguments[0].click()', el);
        await driver.sleep(400);
      }
    } catch {
      // Not present on this load — fine.
    }
  }
}

async function searchOne(
  driver: WebDriver,
  name: string,
  timeoutMs: number,
): Promise<SearchOutcome> {
  const { By, until } = await import('selenium-webdriver');
  const term = squash(name);
  if (!term) return { blocked: false, emptyResult: true, detail: 'empty search term' };

  const box = await driver.wait(until.elementLocated(By.id('input-search-bar')), timeoutMs);
  await driver.executeScript('arguments[0].scrollIntoView({block:"center"})', box);
  await box.clear();
  await box.sendKeys(term);
  await driver.sleep(800);

  const button = await driver.findElement(By.id('federated-search-input-button'));
  await driver.actions({ bridge: true }).move({ origin: button }).pause(120).click().perform();

  // Wait for the placeholder to be replaced by something, up to the per-search timeout.
  let timedOut = false;
  try {
    await driver.wait(async () => {
      const t = await resultsText(driver);
      return t.length > 40 && !/No matching results found/i.test(t);
    }, timeoutMs);
  } catch {
    timedOut = true;
  }

  const page = await bodyText(driver);
  if (/verify you are human|i'm not a robot|unusual traffic|request blocked|access denied/i.test(page)) {
    return { blocked: true, emptyResult: false, detail: 'challenge or block text on page' };
  }

  const results = await resultsText(driver);
  if (/No matching results found/i.test(results)) {
    return {
      blocked: false,
      emptyResult: true,
      detail: timedOut ? 'no results within timeout' : 'site reported no match',
    };
  }
  if (timedOut) {
    return { blocked: false, emptyResult: true, detail: 'timed out before results rendered' };
  }

  return {
    blocked: false,
    emptyResult: false,
    detail: 'result parsed',
    record: extractRecord(name, results),
  };
}

/** Text of the results pane, falling back to the whole page. */
async function resultsText(driver: WebDriver): Promise<string> {
  const t = await driver.executeScript<string>(
    'const r=document.querySelector("#right-results");return (r?r.innerText:document.body.innerText)||""',
  );
  return t ?? '';
}

async function bodyText(driver: WebDriver): Promise<string> {
  const t = await driver.executeScript<string>('return document.body.innerText||""');
  return t ?? '';
}

/**
 * Pull the fields we need out of a result block.
 *
 * Text-based on purpose: the card markup is unverified (see the file header), and a
 * regex over rendered text degrades to "found nothing" instead of throwing when the
 * layout shifts.
 */
export function extractRecord(queriedName: string, text: string): BizFileRecord | undefined {
  const uen = text.match(
    /\b(\d{9}[A-Z]|\d{8}[A-Z]|[A-Z]\d{2}[A-Z]{2}\d{4}[A-Z]|T\d{2}[A-Z]{2}\d{4}[A-Z])\b/,
  )?.[1];
  const status = text.match(
    /\b(LIVE(?: COMPANY)?|REGISTERED|STRUCK OFF|DISSOLVED|CEASED REGISTRATION|IN LIQUIDATION|IN RECEIVERSHIP|CANCELLED|EXPIRED)\b/i,
  )?.[1];
  const address = text.match(/\b\d+[A-Z]?[,\s][A-Z0-9'.\-#/&()\s]{4,80}SINGAPORE\s+\d{6}\b/i)?.[0];

  // A block with none of the three is not a record — most likely chrome or a filter panel.
  if (!uen && !address && !status) return undefined;

  // The entity name is usually the first non-trivial line of the card.
  const nameLine = text
    .split('\n')
    .map((l) => squash(l))
    .find((l) => l.length > 2 && !/^(filters|entity|industry|people|reserved name)$/i.test(l));

  return {
    name: nameLine || queriedName,
    uen,
    status,
    registeredAddress: address ? squash(address) : undefined,
    source: 'bizfile-scrape',
  };
}
