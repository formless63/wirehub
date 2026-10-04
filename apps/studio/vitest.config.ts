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
export default defineConfig({
  test: {
    // see packages/editor-react/vitest.config.ts: loaded shared box, not hangs
    testTimeout: 15_000,
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'browser-path',
          include: ['test/**/*.browser.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'workbench-api',
          include: ['test/**/*.server.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'shell',
          include: ['test/**/*.dom.test.tsx'],
          environment: 'jsdom',
          // `@tanstack/react-virtual` (the cables list)
          // needs a non-zero measured viewport — jsdom does no layout, so
          // every element reports 0×0 without this. See setup-dom.ts.
          setupFiles: ['./test/setup-dom.ts'],
        },
      },
    ],
  },
});
