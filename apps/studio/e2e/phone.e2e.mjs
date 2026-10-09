/**
 * Browser pass over every route at a phone size (390 x 844): no horizontal page scroll, content on
 * every route, the design page a read-only summary ("Open on a desktop to edit"), Settings disabled.
 *
 *   BASE_URL=http://127.0.0.1:5860 node apps/studio/e2e/phone.e2e.mjs
 *
 * Same setup as `restart.e2e.mjs` (`PLAYWRIGHT_CORE`, `CHROME`, `SHOTS_DIR`). `ROUTES` (comma
 * separated paths) replaces the default list, which uses the starter catalog's ids. Exits non-zero
 * when a route scrolls sideways or is empty.
 */

import { mkdirSync } from 'node:fs';

const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const shots = process.env.SHOTS_DIR;
if (shots !== undefined) mkdirSync(shots, { recursive: true });

const ROUTES = process.env.ROUTES?.split(',') ?? [
  '/cables', '/cables/dc-y-splitter', '/cables/dc-y-splitter?view=schematic', '/cables/dc-y-splitter?view=documents',
  '/library/connectors', '/library/connectors/de9-female', '/library/components', '/library/components/r-150',
  '/library/wires', '/library/wires/cat5e-utp', '/library/pcbas', '/library/pcbas/pair-terminal-board',
  '/library/mechanicals', '/library/mechanicals/de9-backshell', '/library/kits',
  '/resolver', '/products', '/history', '/jobs', '/extensions?tab=browse', '/extensions?tab=installed', '/settings', '/part-numbers',
];

const browser = await chromium.launch({ ...(process.env.CHROME === undefined ? {} : { executablePath: process.env.CHROME }), args: ['--no-sandbox'] });
let failed = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  for (const route of ROUTES) {
    await page.goto(base + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, text: document.body.innerText.trim().length }));
    const problems = [];
    if (m.sw > m.cw) problems.push(`scrolls sideways (${m.sw} > ${m.cw})`);
    if (m.text < 40) problems.push('shows no content');
    if (route.startsWith('/cables/') && !route.includes('view=') && (await page.getByTestId('phone-edit-note').count()) === 0) problems.push('no read-only note');
    if (shots !== undefined) await page.screenshot({ path: `${shots}/${route.replace(/[^a-z0-9]+/gi, '_')}.png` });
    if (problems.length > 0) failed = true;
    console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${route} ${problems.join('; ')}`);
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
