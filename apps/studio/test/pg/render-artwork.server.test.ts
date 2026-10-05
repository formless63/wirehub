/**
 * Headless renders on Postgres (cs-5k1.23): the sheets draw artwork from the
 * database's depiction store — an artwork upload shows in the schematic — and
 * the BOM carries part-number proposals, as the browser's does.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../../server/api.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

describePg('headless renders on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  let orgId: string;
  let blobs: ReturnType<typeof fsBlobStore>;

  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-render-'));
    blobs = fsBlobStore(join(work, 'blobs'));
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs })).orgId;
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('draws the artwork the database holds, and proposes part numbers', async () => {
    const deps = pgWorkbenchDeps({ cache: new SnapshotCache(pgh.db, orgId, { reuseMs: 0 }), db: pgh.db, blobs });
    const marked = {
      ...deps.depictions!,
      listDefIds: () => deps.depictions!.listDefIds(),
      readMeta: (id: string) => deps.depictions!.readMeta(id),
      // an uploaded face: the database's own bytes with a mark the catalog tree lacks
      readAsset: async (id: string, file: string) => {
        const bytes = await deps.depictions!.readAsset(id, file);
        if (id !== 'de9-female' || file !== 'mating-face.svg' || bytes === undefined || !uploaded) return bytes;
        return new TextEncoder().encode(new TextDecoder().decode(bytes).replace('</svg>', '<rect id="pg-artwork-marker" x="0" y="0" width="1" height="1"/></svg>'));
      },
    };
    let uploaded = false;
    const text = async (path: string): Promise<string> => {
      const r = await handleWorkbenchRequest({ method: 'GET', path }, { ...deps, depictions: marked });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return new TextDecoder().decode(r.bytes);
    };
    const before = await text('/api/designs/de9-crossover/documents/schematic');
    expect(before).not.toContain('pg-artwork-marker');
    // a changed face in the database, which the catalog tree does not have
    uploaded = true;
    const after = await text('/api/designs/de9-crossover/documents/schematic');
    expect(after).toContain('pg-artwork-marker');
    // the BOM reads the scheme and numbers in use from the database too
    expect(await text('/api/designs/de9-crossover/documents/bom')).toContain('CON-00012');
  }, 60_000);
});
