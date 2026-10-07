#!/usr/bin/env node
// The explicit optional runtime packages published by Pages. Built-ins are never bundled here.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

export const OFFICIAL_RUNTIME_MODULES = Object.freeze(['suppliers', 'fx-rates', 'standard-work']);
const repo = fileURLToPath(new URL('../', import.meta.url));

/** Build into the same output directory that store-index.mjs official subsequently indexes. */
export async function buildOfficialRuntime({ out, key = process.env.WIREHUB_PACK_SIGNING_KEY ?? '', log = console.log }) {
  if (key.trim() === '') {
    log('Optional runtime modules are omitted: no publisher signing key is configured.');
    return [];
  }
  const { buildModule } = await import('../apps/studio/scripts/wirehub-module.ts');
  const built = [];
  for (const id of OFFICIAL_RUNTIME_MODULES) {
    built.push(await buildModule({ moduleDir: join(repo, 'modules', id), out: resolve(out),
      keys: [key], publisher: { id: 'wirehub', name: 'WireHub' }, zip: true, log }));
  }
  return built;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.length !== 3) {
    console.error('Usage: build-official-runtime.mjs OUTPUT_DIRECTORY');
    process.exitCode = 1;
  } else {
    await buildOfficialRuntime({ out: process.argv[2] });
  }
}
