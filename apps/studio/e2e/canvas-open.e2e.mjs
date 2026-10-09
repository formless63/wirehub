/**
 * Browser test: a design opens on a canvas that is already fitted. Samples the viewport transform on
 * every frame while the canvas is visible and fails if it takes more than one value (a first paint at
 * zoom 1 followed by a fit-to-view is the jump this guards against).
 *
 *   BASE_URL=http://127.0.0.1:5840 node apps/studio/e2e/canvas-open.e2e.mjs [design-id ...]
 *
 * Needs a running studio (`pnpm bundle` + `pnpm start`), `playwright-core` (`PLAYWRIGHT_CORE`, default
 * resolved from the current directory) and a Chromium (`CHROME`, default Playwright's own). Without ids,
 * it opens the first three designs the API lists.
 */

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

let ids = process.argv.slice(2);
if (ids.length === 0) ids = ((await (await fetch(`${base}/api/designs`)).json()).designs ?? []).slice(0, 3).map((d) => d.id);

const browser = await chromium.launch({ ...(process.env.CHROME === undefined ? {} : { executablePath: process.env.CHROME }), args: ['--no-sandbox'] });
let failed = false;
try {
  for (const id of ids) {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.addInitScript(() => {
      window.__vp = [];
      const tick = () => {
        const vp = document.querySelector('.react-flow__viewport');
        const canvas = document.querySelector('.react-flow');
        const shown = canvas !== null && getComputedStyle(canvas).visibility !== 'hidden' && getComputedStyle(canvas).opacity !== '0';
        if (vp !== null && shown && document.querySelectorAll('.react-flow__node').length > 0) window.__vp.push(vp.style.transform);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(`${base}/cables/${id}`, { waitUntil: 'load' });
    await page.waitForTimeout(3500);
    const distinct = [...new Set(await page.evaluate(() => window.__vp))];
    const ok = distinct.length === 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}: ${distinct.length} distinct visible viewport transform(s) ${ok ? '' : JSON.stringify(distinct)}`);
    if (!ok) failed = true;
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
