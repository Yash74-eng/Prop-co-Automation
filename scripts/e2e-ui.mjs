/**
 * Drives the wizard UI in a browser the way a user would, to confirm the step-1 channel
 * gate behaves: nothing proceeds until a deliverable is chosen. Headless is fine here —
 * this is localhost, not the WAF-protected BizFile site.
 */
import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = process.argv[2] ?? 'ui';
const UPLOAD = process.argv[3];

const options = new chrome.Options();
options.addArguments('--headless=new', '--window-size=1500,1200', '--force-device-scale-factor=1');
const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

const shot = async (tag) => {
  writeFileSync(`${OUT}-${tag}.png`, Buffer.from(await driver.takeScreenshot(), 'base64'));
  console.log(`  screenshot: ${OUT}-${tag}.png`);
};

const navState = () =>
  driver.executeScript(`
    return Array.from(document.querySelectorAll('.nav button')).map(b => ({
      label: b.innerText.replace(/\\s+/g,' ').trim(),
      disabled: b.disabled,
      active: b.className.includes('on'),
    }));
  `);

const heading = () => driver.executeScript('return (document.querySelector("h1")||{}).innerText||""');
const hasDropZone = () =>
  driver.executeScript(
    'return !!document.querySelector(".dropzone, [class*=drop]") || /Drop the workbook/i.test(document.body.innerText)',
  );

try {
  await driver.manage().setTimeouts({ pageLoad: 30_000, script: 20_000 });
  await driver.get('http://localhost:5173/');
  await driver.wait(until.elementLocated(By.css('.nav button')), 20_000);
  await driver.sleep(1200);

  console.log('\n=== STEP 1, NOTHING CHOSEN ===');
  console.log(`heading: "${await heading()}"`);
  console.log(`drop zone visible: ${await hasDropZone()}`);
  console.log('nav:');
  for (const b of await navState()) {
    console.log(`  ${b.label.padEnd(14)} disabled=${b.disabled} active=${b.active}`);
  }
  await shot('1-gate');

  console.log('\n=== CHOOSE POSTCARD ===');
  const buttons = await driver.findElements(By.css('button'));
  let clicked = false;
  for (const b of buttons) {
    const t = (await b.getText()).trim();
    if (/^●?○?\s*Postcard/.test(t) || /^Postcard$/m.test(t.split('\n')[0])) {
      await driver.executeScript('arguments[0].click()', b);
      clicked = true;
      break;
    }
  }
  console.log(`clicked the Postcard option: ${clicked}`);
  await driver.sleep(900);
  console.log(`heading now: "${await heading()}"`);
  console.log(`drop zone visible: ${await hasDropZone()}`);
  console.log('nav:');
  for (const b of await navState()) {
    console.log(`  ${b.label.padEnd(14)} disabled=${b.disabled} active=${b.active}`);
  }
  await shot('2-postcard-chosen');

  if (UPLOAD) {
    console.log('\n=== UPLOAD VIA THE UI ===');
    const input = await driver.findElement(By.css('input[type=file]'));
    await driver.executeScript(
      'arguments[0].style.display="block";arguments[0].style.opacity=1;arguments[0].style.height="auto"',
      input,
    );
    await input.sendKeys(resolve(UPLOAD));
    console.log('file handed to the input, waiting for the sheet check...');
    await driver.wait(async () => /Sheet check|Data rows/i.test(await driver.executeScript('return document.body.innerText')), 90_000);
    await driver.sleep(1500);
    const stats = await driver.executeScript(`
      return Array.from(document.querySelectorAll('.stats .tile, .stats > *')).map(t =>
        t.innerText.replace(/\\s+/g,' ').trim()).slice(0,6);
    `);
    console.log('stat tiles:', JSON.stringify(stats));
    console.log(`sidebar shows channel: ${await driver.executeScript(
      'return /Postcard/.test((document.querySelector(".sidebar")||{}).innerText||"")',
    )}`);
    await shot('3-uploaded');

    console.log('nav after upload:');
    for (const b of await navState()) {
      console.log(`  ${b.label.padEnd(14)} disabled=${b.disabled} active=${b.active}`);
    }
  }
} finally {
  await driver.quit().catch(() => undefined);
}
