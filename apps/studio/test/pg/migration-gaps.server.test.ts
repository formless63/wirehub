/** Gaps a private shop's migration found, on Postgres (packs land in the database as one change set each). */

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { createRegistry } from '@wirehub/modules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../../server/api.ts';
import type { StudioUser } from '../../server/me.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { pgSetupDeps } from '../../server/pg/setup.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { runBenchRulesPackFlow, runBrandingFlow, runPackFontFlow, runVendorPdfPackFlow, runPadMapPreviewFlow, runSchemeAndSelectorsFlow, type FlowCall } from '../migration-gaps-flow.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

describePg('migration gaps on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
  }, 60_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
  }, 60_000);

  async function hub(slug: string) {
    const { orgId } = await importCatalog(pgh.db, { org: { slug, create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() });
    const cache = new SnapshotCache(pgh.db, orgId, { reuseMs: 0 });
    const deps: WorkbenchDeps = pgWorkbenchDeps({ cache, db: pgh.db, blobs: testBlobs() });
    deps.setup = pgSetupDeps(deps, cache, { prompt: false, now: () => '2026-10-05T12:00:00.000Z' });
    deps.modules = createRegistry([]);
    const call: FlowCall = async (method, path, body, user?: StudioUser, headers?: Record<string, string>) =>
      (await handleWorkbenchRequest({ method, path, ...(user === undefined ? {} : { user }), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any; headers?: Record<string, string>; bytes?: Uint8Array };
    return { deps, call, cache };
  }

  it('a pack preview loads the pack\'s PCBA pad table: preview validation equals post-install validation', async () => {
    const { call, cache } = await hub('gaps-pads');
    const v0 = BigInt(await cache.version());
    await runPadMapPreviewFlow(call);
    // install and disable are one change set each; previews write nothing
    expect(BigInt(await cache.version())).toBe(v0 + 2n);
  }, 60_000);

  it('a data pack\'s bench-rules.json is read at runtime and follows install, update and disable', async () => {
    const { call, cache } = await hub('gaps-bench');
    const v0 = BigInt(await cache.version());
    await runBenchRulesPackFlow(call);
    expect(BigInt(await cache.version())).toBe(v0 + 3n);
  }, 60_000);

  it('a numbering scheme with exclusions, unions and multi-segment matches, and cable-end rule selectors, through the API', async () => {
    const { call } = await hub('gaps-scheme');
    await runSchemeAndSelectorsFlow(call);
  }, 60_000);

  it('signed vendor PDFs in a pack: pinned, installed, linked, served with safe headers, replaced and removed', async () => {
    const { call } = await hub('gaps-pdf');
    await runVendorPdfPackFlow(call);
  }, 60_000);

  it('a licensed typeface and drawing art in Settings, Branding are stored as data and used by the sheets and PDFs', async () => {
    const { call } = await hub('gaps-branding');
    await runBrandingFlow(call);
  }, 60_000);

  it('a font a data pack ships is a font the hub may choose, and goes with the pack', async () => {
    const { call } = await hub('gaps-pack-font');
    await runPackFontFlow(call);
  }, 60_000);
});
