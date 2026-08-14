/**
 * Runs just the canary preflight through the real resolver, so you can tell whether a
 * live BizFile run would work today without touching a job or writing a workbook.
 * Exits 0 if BizFile is answering, 1 if the session is being gated.
 */
import {
  seleniumResolver,
  defaultSeleniumOptions,
  BizFileBlockedError,
  BizFileWindowClosedError,
} from '../src/bizfile/selenium.js';

const resolve = await seleniumResolver(
  defaultSeleniumOptions({ limit: 0, timeoutMs: 30_000, headful: process.env.BIZFILE_HEADFUL !== '0' }),
);

try {
  // limit: 0 means the canary runs and no owner lookups follow it.
  await resolve([]);
  console.log('OK — the control search returned results. A live run should work.');
  process.exit(0);
} catch (error) {
  if (error instanceof BizFileBlockedError) {
    console.log('BLOCKED — a live run would produce false "not-found" verdicts, so it is refused.\n');
    console.log(error.message);
    process.exit(1);
  }
  if (error instanceof BizFileWindowClosedError) {
    console.log('WINDOW CLOSED — could not complete the check.\n');
    console.log(error.message);
    console.log(
      '\nAttended mode needs a real interactive desktop session. It will not survive a\n' +
        'headless/service context, and headless itself is CloudFront-blocked — so on this\n' +
        'machine, use a BizFile export upload instead.',
    );
    process.exit(1);
  }
  throw error;
}
