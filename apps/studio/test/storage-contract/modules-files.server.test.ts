/**
 * The module session (`modules.ts`) on the file backend — the real file
 * stores over a temporary copy of the starter catalog — compared step by step
 * and byte by byte with the in-memory commit tree the Postgres commit uses.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'wirehub-modules-files-'));
cpSync(fileURLToPath(new URL('../../../../packages/catalog/data', import.meta.url)), join(work, 'data'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(work, 'data');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  rmSync(work, { recursive: true, force: true });
});

describe('module contract (server): files vs the commit tree', () => {
  it('answers every step identically and ends with the same catalog, derived records included', async () => {
    const { defaultWorkbenchDeps } = await import('../../server/default-deps.ts');
    const { memoryWriteBackend } = await import('./writes.ts');
    const { exampleRegistry, moduleScenario } = await import('./modules.ts');
    const memoryBackend = memoryWriteBackend(exampleRegistry);
    const memory = await moduleScenario(memoryBackend.deps);
    const files = await moduleScenario(defaultWorkbenchDeps({ modules: exampleRegistry }));
    expect(files).toEqual(memory);
    // the derived records are plain files in the catalog, beside the data they come from
    for (const name of ['summary.json', 'summary.md']) {
      const path = join(work, 'data', 'derived', 'example', name);
      expect(existsSync(path)).toBe(true);
      const exported = (await memoryBackend.deps.exportCatalog!()).files[`data/derived/example/${name}`];
      expect(readFileSync(path, 'utf8')).toBe(exported);
    }
  }, 60_000);
});
