/**
 * The migrate step's adoption of a file deployment, and the first admin's
 * claim (Phase S): a fresh install is left to first-run setup; a catalog that
 * was in use is imported, packs flattened; with sign-in on and nobody owning
 * the adopted org, the hub waits in setup mode until /setup makes the admin.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPath, installPackLayer } from '@wirehub/catalog';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../../server/api.ts';
import { readAuthConfig, type AuthConfigEnabled } from '../../server/auth/config.ts';
import { pgPeople } from '../../server/auth/people.ts';
import { createStudioAuth, type StudioAuth } from '../../server/auth/studio-auth.ts';
import { adoptFileCatalog } from '../../server/pg/adopt.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { openPgBackend, type PgBackend } from '../../server/pg/deps.ts';
import { describePg, freshDatabase, type TestDatabase, testBlobs } from './harness.ts';

const CODE = 'WXYZ-2345-6789';

describePg('adopting a file deployment', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let work: string;
  let backend: PgBackend | undefined;
  let auth: StudioAuth | undefined;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    work = mkdtempSync(join(tmpdir(), 'wirehub-adopt-'));
  }, 60_000);
  afterAll(async () => {
    await auth?.close?.();
    await backend?.close();
    await pgh?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('leaves a fresh install to setup, adopts one in use, then the first admin claims it', async () => {
    const pristine = join(work, 'starter');
    cpSync(dataPath(''), pristine, { recursive: true });
    const deployment = join(work, 'deployment');
    cpSync(dataPath(''), join(deployment, 'data'), { recursive: true });
    const packs = join(work, 'packs');
    expect((await adoptFileCatalog(pgh.db, { root: deployment, packs, starter: pristine, blobs: testBlobs() })).kind).toBe('fresh');
    // the hub was used: a design edited, a pack installed
    const path = join(deployment, 'data/designs/de9-crossover.json');
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), label: 'Edited on files' }, null, 2)}\n`);
    installPackLayer(join(deployment, 'data'), packs, join(dataPath(''), '../../../modules/pc-serial/pack'));
    const adopted = await adoptFileCatalog(pgh.db, { root: deployment, packs, starter: pristine, blobs: testBlobs() });
    expect(adopted.kind).toBe('adopted');
    expect((await adoptFileCatalog(pgh.db, { root: deployment, packs, starter: pristine, blobs: testBlobs() })).kind).toBe('has-org');

    backend = await openPgBackend({ DATABASE_URL: database.appUrl, AUTH_ENABLED: 'true' }, { setupCode: CODE, blobs: testBlobs() });
    const config = readAuthConfig({ AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'test-only-secret-test-only-secret-0123456789', BETTER_AUTH_URL: 'http://studio.test', WIREHUB_BACKEND: 'pg' }) as AuthConfigEnabled;
    auth = await createStudioAuth(config, { pg: { url: database.appUrl, people: pgPeople(pgh.db, backend.orgId), setupMode: backend.setupMode } });
    backend.attachAuth(auth);
    expect(backend.setupMode()).toBe(true);
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/designs' }, backend.deps)).status).toBe(503);
    const view = (await handleWorkbenchRequest({ method: 'GET', path: '/api/setup' }, backend.deps)).body as { create: { claim: boolean } };
    expect(view.create.claim).toBe(true);
    const claim = { admin: { name: 'Ada', email: 'ada@example.com', password: 'a long admin password' } };
    expect((await handleWorkbenchRequest({ method: 'POST', path: '/api/setup', body: claim }, backend.deps)).status).toBe(403);
    expect((await handleWorkbenchRequest({ method: 'POST', path: '/api/setup', body: { ...claim, code: CODE } }, backend.deps)).status).toBe(200);
    expect(backend.setupMode()).toBe(false);
    const design = await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/de9-crossover' }, backend.deps);
    expect((design.body as { label: string }).label).toBe('Edited on files');
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/designs/db9-null-modem' }, backend.deps)).status).toBe(200);
    expect((await pgPeople(pgh.db, backend.orgId).personByEmail('ada@example.com'))?.role).toBe('owner');
  }, 120_000);
});
