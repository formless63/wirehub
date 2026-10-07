import { defineConfig } from 'vitest/config';

/**
 * Three suites with opposite needs, so three projects.
 *
 * `*.browser.test.ts` runs under the app's own Vite config, where `node:fs` is
 * aliased to a throwing shim — that alias is the whole point of those tests:
 * they prove the browser path never reaches for a filesystem.
 *
 * `*.server.test.ts` is the workbench API, which *is* filesystem code. It runs
 * with no aliases at all, on plain Node.
 *
 * `*.dom.test.tsx` is the shell itself — `App.tsx` — mounted in jsdom with the
 * transport replaced by a call into the real API router. It deliberately does
 * **not** take the `node:fs` alias: the router underneath it is filesystem
 * code, and stubbing it out would leave the test driving a shim. It does need
 * Vite proper for the depiction tree's `import.meta.glob` (`depictions.browser.ts`);
 * catalog data comes from the API router it drives, never from the bundle.
 */
// Hubs trust the official store index by default; tests must never fetch it. Tests that cover the
// official store pass their own key and a local fixture (storeIndexesFromEnv's 2nd argument).
const noOfficialStore = { WIREHUB_STORE_INDEXES: 'none' };

// Vitest 4 inline projects do not inherit the root timeout. Apply the same
// shared-machine budget explicitly while keeping each project's Vite aliases separate.
const TEST_TIMEOUT = 15_000;

export default defineConfig({
  test: {
    // see packages/editor-react/vitest.config.ts: loaded shared box, not hangs
    testTimeout: TEST_TIMEOUT,
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'browser-path',
          testTimeout: TEST_TIMEOUT,
          include: ['test/**/*.browser.test.ts'],
          environment: 'node',
          env: noOfficialStore,
        },
      },
      {
        test: {
          name: 'workbench-api',
          testTimeout: TEST_TIMEOUT,
          include: ['test/**/*.server.test.ts'],
          environment: 'node',
          env: noOfficialStore,
        },
      },
      {
        test: {
          name: 'shell',
          testTimeout: TEST_TIMEOUT,
          include: ['test/**/*.dom.test.tsx'],
          environment: 'jsdom',
          env: noOfficialStore,
          // `@tanstack/react-virtual` (the cables list)
          // needs a non-zero measured viewport — jsdom does no layout, so
          // every element reports 0×0 without this. See setup-dom.ts.
          setupFiles: ['./test/setup-dom.ts'],
        },
      },
    ],
  },
});
