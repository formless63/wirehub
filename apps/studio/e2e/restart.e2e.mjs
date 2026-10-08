/**
 * Browser test of Restart WireHub (Settings › Code modules): the ConfirmDialog first, then the
 * progress state ("Restarting… N s"), then "reconnected in N s". The server's restart endpoints
 * are answered by the test (`page.route`), so any running studio will do, and nothing is restarted.
 *
 *   BASE_URL=http://127.0.0.1:5840 node apps/studio/e2e/restart.e2e.mjs
 *
 * Needs `playwright-core` and a Chromium: `PLAYWRIGHT_CORE=<path to playwright-core>` (default: resolved
 * from the current directory) and `CHROME=<chromium executable>` (default: Playwright's own). Set
 * `SHOTS_DIR` to save a screenshot of each state. Exits non-zero on the first failed expectation.
 */

import { mkdirSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const shots = process.env.SHOTS_DIR;
if (shots !== undefined) mkdirSync(shots, { recursive: true });

const view = { apiVersion: '1.6', allowed: { env: true, settings: true, effective: true }, builtins: [], supervised: true, modules: [], keys: [] };
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const browser = await chromium.launch({ ...(process.env.CHROME === undefined ? {} : { executablePath: process.env.CHROME }), args: ['--no-sandbox'] });
let failed = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  let restarts = 0;
  let polls = 0;
  await page.route('**/api/code-modules', (route) => route.fulfill(json(view)));
  await page.route('**/api/system/restart', (route) => {
    restarts += 1;
    return route.fulfill(json({ restarting: true, bootId: 'boot-1', supervised: true, poll: '/api/system/boot' }));
  });
  await page.route('**/api/system/boot', (route) => {
    // the old process answers for a moment, then the new boot id appears
    polls += 1;
    const back = restarts > 0 && polls > 4;
    return route.fulfill(json({ bootId: back ? 'boot-2' : 'boot-1', restarting: restarts > 0 && !back, supervised: true }));
  });

  await page.goto(`${base}/settings?section=modules`);
  await page.getByRole('button', { name: 'Restart WireHub' }).click();

  // 1. a ConfirmDialog, and nothing has been requested yet
  const dialog = page.getByTestId('confirm-dialog');
  await dialog.waitFor();
  if (restarts !== 0) throw new Error('restart was requested before it was confirmed');
  if (shots !== undefined) await page.screenshot({ path: `${shots}/restart-1-confirm.png` });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });
  if (restarts !== 0) throw new Error('Cancel still restarted the server');

  // 2. confirm: the progress state counts seconds
  await page.getByRole('button', { name: 'Restart WireHub' }).click();
  await page.getByTestId('confirm-dialog-ok').click();
  const overlay = page.getByTestId('restart-overlay');
  await overlay.getByText(/Restarting WireHub… \d+ s/).waitFor();
  if (shots !== undefined) await page.screenshot({ path: `${shots}/restart-2-progress.png` });

  // 3. the new boot id answers: "reconnected in N s", then the page reloads
  await overlay.getByText(/reconnected in \d+ s/).waitFor({ timeout: 30_000 });
  if (shots !== undefined) await page.screenshot({ path: `${shots}/restart-3-reconnected.png` });
  if (restarts !== 1) throw new Error(`expected one restart request, saw ${restarts}`);
  console.log('restart flow: confirm, progress and reconnected states all shown');
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
