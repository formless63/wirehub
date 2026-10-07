import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, patch] = process.argv.slice(2);
if (dir === undefined || patch === undefined) throw new Error('Usage: manifest.mjs OUTPUT_DIRECTORY PATCH_FILE');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest = {
  schema: 1,
  profile: 'occt-occurrence-1',
  importer: 'c2148e54b456b571238d35cac037d304053d64b2',
  occt: 'd2abb6d844231cb8f29be6894440874a4700e4a5',
  emscripten: '3.1.69',
  patch: hash(patch),
  files: { 'occt-import-js.cjs': hash(join(dir, 'occt-import-js.cjs')), 'occt-import-js.wasm': hash(join(dir, 'occt-import-js.wasm')) },
};
writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
