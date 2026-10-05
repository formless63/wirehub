/**
 * The write contract on the file backend itself — the real file stores over
 * a temporary copy of the starter catalog (`WIREHUB_CATALOG_DIR`) — compared
 * step by step and byte by byte with the in-memory commit tree the Postgres
 * commit uses. Modules are imported after the variable is set, so every store
 * resolves the copy.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'wirehub-writes-files-'));
cpSync(fileURLToPath(new URL('../../../../packages/catalog/data', import.meta.url)), join(work, 'data'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(work, 'data');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  rmSync(work, { recursive: true, force: true });
});

describe('storage contract (writes): files vs the commit tree', () => {
  it('answers every step identically and ends with the same catalog, byte for byte', async () => {
    const { defaultWorkbenchDeps } = await import('../../server/default-deps.ts');
    const { defaultDepictionDeps } = await import('../../server/depictions.ts');
    const { memoryWriteBackend, writeScenario } = await import('./writes.ts');
    const { batchScenario } = await import('./batch.ts');
    // the reference first: it reads the untouched copy, which the file run then edits
    const memoryBackend = memoryWriteBackend();
    const memory = await writeScenario(memoryBackend);
    const memoryBatch = await batchScenario(memoryBackend.deps);
    const filesDeps = defaultWorkbenchDeps();
    const files = await writeScenario({ deps: filesDeps, depictionDeps: defaultDepictionDeps() });
    const filesBatch = await batchScenario(filesDeps);
    const drop = (log: string[]) => log.filter((line) => !line.startsWith('export:') && !line.startsWith('read export:'));
    expect(drop(files.log)).toEqual(drop(memory.log));
    expect(drop(filesBatch)).toEqual(drop(memoryBatch));
    expect(files.exported.files).toEqual(memory.exported.files);
    expect(files.exported.blobs).toEqual(memory.exported.blobs);
  }, 60_000);
});
