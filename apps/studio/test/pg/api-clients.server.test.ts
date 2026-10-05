/**
 * SA1 (`specs/postgres-backend.md` §1): the contract's write session and the
 * batch / dry-run session run **through the HTTP API with a personal token**
 * against a pg studio answer exactly as the router answers them on the
 * in-memory commit tree — same statuses, same ETags, same bodies — and every
 * change set is the token's person's, with the token's id.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { readAuthConfig, type AuthConfigEnabled } from '../../server/auth/config.ts';
import { pgPeople } from '../../server/auth/people.ts';
import { createStudioAuth } from '../../server/auth/studio-auth.ts';
import { pgTokens } from '../../server/auth/tokens.ts';
import { fsBlobStore } from '../../server/blobs.ts';
import type { DepictionStore } from '../../server/depictions.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { createStandaloneApp } from '../../server/standalone-app.ts';
import { batchScenario, withBatchModule } from '../storage-contract/batch.ts';
import { httpTransport } from '../storage-contract/http.ts';
import { fixed, memoryWriteBackend, writeScenario } from '../storage-contract/writes.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

const BASE = 'http://studio.test';

describePg('SA1: API clients with a personal token', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  let closeAuth: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 4 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-pg-sa1-'));
    mkdirSync(join(work, 'dist'));
    writeFileSync(join(work, 'dist', 'index.html'), '<!doctype html><title>studio</title>');
  }, 60_000);
  afterAll(async () => {
    await closeAuth?.();
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('the write and batch sessions answer identically through the API', async () => {
    const orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
    const people = pgPeople(pgh.db, orgId);
    const person = await people.ensurePerson(fixed.localUser.email, fixed.localUser.name, 'editor');
    const tokens = pgTokens(pgh.db, orgId);
    const { token, secret } = await tokens.create({ person, name: 'contract client', scopes: ['catalog:write', 'imports'], days: 1, env: 'dev' });
    const config = readAuthConfig({ AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'test-only-secret-test-only-secret-0123456789', BETTER_AUTH_URL: BASE, WIREHUB_BACKEND: 'pg' }) as AuthConfigEnabled;
    const auth = await createStudioAuth(config, { pg: { url: database.appUrl, people, tokens, tokenEnv: 'dev' } });
    closeAuth = auth.close;
    const cache = new SnapshotCache(pgh.db, orgId);
    const deps = withBatchModule({ ...pgWorkbenchDeps({ cache, db: pgh.db, blobs: fsBlobStore(join(work, 'blobs')) }), ...fixed });
    const depictionDeps = { store: deps.depictions as DepictionStore, loadDb: deps.loadDb, loadDesigns: async () => (await cache.get()).catalog.loadDesigns() };
    const app = createStandaloneApp({ distDir: join(work, 'dist'), deps, depictionDeps, auth });
    const transport = httpTransport(async (url, init) => app.request(url, init), BASE, `Bearer ${secret}`);

    const reference = memoryWriteBackend();
    const memory = await writeScenario(reference);
    const memoryBatch = await batchScenario(reference.deps);
    const api = await writeScenario({ deps, depictionDeps, transport });
    const apiBatch = await batchScenario(deps, transport.call);
    const drop = (log: string[]) => log.filter((line) => !line.startsWith('export:') && !line.startsWith('read export:'));
    expect(drop(api.log)).toEqual(drop(memory.log));
    expect(drop(apiBatch)).toEqual(drop(memoryBatch));
    expect(api.exported.files).toEqual(memory.exported.files);

    const sets = await inOrg(pgh.db, orgId, async (tx) =>
      (await sql<{ actor_id: string | null; api_token_id: string | null; source: string }>`SELECT actor_id::text AS actor_id, api_token_id::text AS api_token_id, source FROM studio.change_set WHERE source <> 'import'`.execute(tx)).rows,
    );
    expect(sets.length).toBeGreaterThan(15);
    // the scenario's own in-process commit (the all-or-nothing check) is the only one without the token
    const viaToken = sets.filter((s) => s.api_token_id === token.id);
    expect(viaToken.length).toBe(sets.length);
    expect(new Set(viaToken.map((s) => s.actor_id))).toEqual(new Set([person.id]));
  }, 180_000);
});
