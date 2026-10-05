import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { prepareHostEnv } from './server/env.ts';
import { workbenchApi } from './server/plugin.ts';

// the dev server: `*_FILE` variables, and installed packs in the checkout's
// gitignored data/packs/. Not under vitest: the suites read the starter as committed.
if (process.env.VITEST === undefined) {
  const fileEnv = prepareHostEnv(process.env);
  if (fileEnv.errors.length > 0) throw new Error(fileEnv.errors.join(' '));
}

const nodeShim = fileURLToPath(new URL('./src/node-shim.ts', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  // the example module's dev flag, for the browser half of the manifest (`modules.config.ts`)
  define: { 'import.meta.env.VITE_WIREHUB_EXAMPLE_MODULE': JSON.stringify(process.env.WIREHUB_EXAMPLE_MODULE ?? '') },
  // `workbenchApi` serves /api/* from the same dev server: the studio's saves
  // are validated server-side and land as JSON files in
  // `packages/catalog/data/designs/`. Dev only — see `server/plugin.ts`.
  //
  // `tailwindcss()` compiles every CSS file it finds an `@import "tailwindcss…"`
  // in — `studio.css` (unprefixed) and, via `main.tsx`'s import of
  // `@wirehub/editor-react/editor.css`, that package's own `prefix(cs)`
  // stylesheet too. Each is its own independent Tailwind root (see the
  // comments at the top of those two files).
  plugins: [tailwindcss(), react(), workbenchApi()],
  resolve: {
    alias: [
      // `@wirehub/catalog` imports these at module scope for the depiction
      // tree; the studio never reads a file, so they resolve to a loud stub
      { find: /^node:(fs|url|path)$/, replacement: nodeShim },
    ],
  },
  server: {
    port: 5183,
    // bind to all interfaces so the owner can drive the editor over the LAN
    host: true,
    // the catalog's JSON lives outside this app
    fs: { allow: [workspaceRoot] },
  },
});
