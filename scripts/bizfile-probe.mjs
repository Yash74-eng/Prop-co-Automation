/**
 * Reconnaissance: perform ONE real entity search the way a human does — type into the
 * search box, submit — then report exactly what fields a result card exposes.
 * Captures are taken immediately after submit so a closed window can't lose them.
 */
import { Builder, By, Key, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { writeFileSync } from 'node:fs';

const KEYWORD = process.argv[2] ?? 'DBS BANK';
const OUT = process.argv[3] ?? 'probe4';
const URL = 'https://www.bizfile.gov.sg/buy-info/search/results';

const options = new chrome.Options();
options.addArguments('--window-size=1500,2400', '--lang=en-SG', '--disable-dev-shm-usage');
const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

const safe = async (label, fn) => {
  try {
    return await fn();
  } catch (e) {
    console.log(`[${label}] failed: ${e.name}: ${String(e.message).split('\n')[0]}`);
    return undefined;
  }
};

const snapshot = async (tag) =>
  safe(`snapshot:${tag}`, async () => {
    const info = await driver.executeScript(`
      const rr = document.querySelector('#right-results');
      return {
        bodyLen: (document.body.innerText||'').length,
        right: (rr ? rr.innerText : '').slice(0, 2000),
        noResult: /No matching results found/i.test(document.body.innerText||''),
        challenge: /verify you are human|i'm not a robot|unusual traffic|access denied|request blocked/i
          .test(document.body.innerText||''),
        recaptchaBig: Array.from(document.querySelectorAll('iframe[src*=recaptcha]'))
          .some(f => { const r=f.getBoundingClientRect(); return r.width>50 && r.height>50; }),
        cards: Array.from(document.querySelectorAll(
          '.search-list-card, [class*="result-card"], [class*="entity-result"], #right-results div[class*="card"]'
        )).slice(0,5).map(c => ({ cls:String(c.className).slice(0,100), text:(c.innerText||'').slice(0,700) })),
        postals: (document.body.innerText.match(/\\bSINGAPORE\\s+\\d{6}\\b/gi)||[]).slice(0,5),
        addrWord: /registered (office )?address/i.test(document.body.innerText||''),
      };
    `);
    console.log(`\n### ${tag} ###`);
    console.log(JSON.stringify(info, null, 1).slice(0, 4000));
    writeFileSync(`${OUT}-${tag}.json`, JSON.stringify(info, null, 2), 'utf8');
    try {
      writeFileSync(`${OUT}-${tag}.png`, Buffer.from(await driver.takeScreenshot(), 'base64'));
    } catch {}
    return info;
  });

try {
  await driver.manage().setTimeouts({ pageLoad: 60_000, script: 30_000 });
  await safe('get', () => driver.get(URL));
  await driver.sleep(8_000);

  for (const id of ['notice-banner-close', 'action-modal-button', 'profile-ok', 'close-drawer']) {
    await safe(`dismiss:${id}`, async () => {
      const el = await driver.findElement(By.id(id));
      if (await el.isDisplayed()) {
        await driver.executeScript('arguments[0].click()', el);
        console.log('dismissed', id);
        await driver.sleep(500);
      }
    });
  }

  const box = await driver.wait(until.elementLocated(By.id('input-search-bar')), 30_000);
  await safe('scroll', () => driver.executeScript('arguments[0].scrollIntoView({block:"center"})', box));
  await safe('clear', () => box.clear());
  await box.sendKeys(KEYWORD);
  console.log('typed:', KEYWORD);
  await driver.sleep(1_500);

  // Real mouse click on the Search button, then Enter as a fallback.
  await safe('click-search', async () => {
    const btn = await driver.findElement(By.id('federated-search-input-button'));
    await driver.actions({ bridge: true }).move({ origin: btn }).pause(150).click().perform();
    console.log('clicked Search');
  });
  await driver.sleep(4_000);
  let info = await snapshot('after-click');

  if (!info || info.noResult) {
    console.log('\n-> no results yet, trying Enter key');
    await safe('enter', async () => {
      const b = await driver.findElement(By.id('input-search-bar'));
      await b.sendKeys(Key.RETURN);
    });
    await driver.sleep(6_000);
    info = await snapshot('after-enter');
  }

  // Poll up to 30s total for results to replace the placeholder.
  await safe('wait-results', () =>
    driver.wait(async () => {
      const t = await driver.executeScript(
        'return (document.querySelector("#right-results")||document.body).innerText || ""',
      );
      return t.length > 80 && !/No matching results found/i.test(t);
    }, 30_000),
  );
  await snapshot('final');
} finally {
  await safe('quit', () => driver.quit());
}
