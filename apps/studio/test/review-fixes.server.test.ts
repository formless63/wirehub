/**
 * Server pieces of the 2026-09-26 review fixes that have no other home:
 * atomic writes, the live part-number endpoint, and the cable list reading
 * the library once.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { writeFileAtomic } from '../server/atomic-write.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { memoryWireLibraryStore } from '../server/wire-library.ts';

const CATALOG: Db = loadDb();
const REAL: CableDesign = loadDesign('trs-to-2rca-y');

function memoryDesigns(seed: CableDesign[]): DesignStore {
  const files = new Map<string, string>(seed.map((d) => [d.id, formatDesignJson(d)]));
  return {
    list: () => [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
    has: (id) => files.has(id),
    read: (id) => (files.has(id) ? (JSON.parse(files.get(id) as string) as CableDesign) : undefined),
    write: (id, design) => {
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
}

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirehub-atomic-'));
  });
  afterEach(async () => rmSync(dir, { recursive: true, force: true }));

  it('replaces the file whole and leaves no temp file behind', async () => {
    const path = join(dir, 'connectors.json');
    writeFileSync(path, '[{"id":"old"}]\n');
    writeFileAtomic(path, '[{"id":"new"}]\n', 'utf8');
    expect(readFileSync(path, 'utf8')).toBe('[{"id":"new"}]\n');
    writeFileAtomic(join(dir, 'photo.png'), new Uint8Array([1, 2, 3]));
    expect([...readFileSync(join(dir, 'photo.png'))]).toEqual([1, 2, 3]);
    expect(readdirSync(dir).sort()).toEqual(['connectors.json', 'photo.png']);
  });

  it('leaves the old file intact when the write cannot finish', async () => {
    const path = join(dir, 'connectors.json');
    writeFileSync(path, 'the old library\n');
    // a target whose rename cannot happen (a directory is in the way): the
    // temp file was written, the rename fails, the temp is cleaned up
    const blocked = join(dir, 'blocked.json');
    mkdirSync(join(blocked, 'inside'), { recursive: true });
    expect(() => writeFileAtomic(blocked, 'x')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('the old library\n');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('GET /api/part-numbers — live, not the bundle', () => {
  it('answers the files, every design and every drawing PN as stored now', async () => {
    const designs = memoryDesigns([structuredClone(REAL)]);
    const deps: WorkbenchDeps = {
      designs,
      loadDb: () => CATALOG,
      loadPartNumberFiles: () => ({ scheme: { schema: 'x' }, register: { entries: [] }, reconciliation: { rows: [] } }),
      drawings: {
        read: (id) => ({ meta: id === REAL.id ? { partNumber: 'CBL-00103-00' } : {} }),
        writeMeta: () => undefined,
        writePhoto: () => undefined,
        move: () => undefined,
        remove: () => undefined,
      },
    };
    const response = await handleWorkbenchRequest({ method: 'GET', path: '/api/part-numbers' }, deps);
    expect(response.status).toBe(200);
    const body = response.body as { scheme: unknown; designs: CableDesign[]; drawings: Record<string, { partNumber?: string }> };
    expect(body.scheme).toEqual({ schema: 'x' });
    expect(body.designs.map((d) => d.id)).toEqual([REAL.id]);
    expect(body.drawings[REAL.id]?.partNumber).toBe('CBL-00103-00');
    // a design saved since then is in the next answer
    designs.write('fresh-design' as never, { ...structuredClone(REAL), id: 'fresh-design' as never });
    const next = (await handleWorkbenchRequest({ method: 'GET', path: '/api/part-numbers' }, deps)).body as { designs: CableDesign[] };
    expect(next.designs.map((d) => d.id)).toContain('fresh-design');
  });
});

describe('GET /api/designs reads the library once', () => {
  it('does not re-read the catalog per wire recipe', async () => {
    let reads = 0;
    const deps: WorkbenchDeps = {
      designs: memoryDesigns([structuredClone(REAL)]),
      loadDb: () => {
        reads += 1;
        return CATALOG;
      },
      wireLibrary: memoryWireLibraryStore(
        { parts: [], recipes: [1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, label: `R${n}`, manufacturer: 'acme', src: 't', cores: [] }) as never) },
        [],
      ),
    };
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/designs' }, deps)).status).toBe(200);
    expect(reads).toBe(1);
  });
});
