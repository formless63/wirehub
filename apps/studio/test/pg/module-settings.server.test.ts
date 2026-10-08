/**
 * Module settings on Postgres (cs-nws, module API 1.5; `server/module-settings.ts`): the scripted
 * session of `../module-settings-scenario.ts` over two studio processes on one database. A module
 * secret is a row of `studio.settings_secret` named `module.<id>.<key>` (migration 0023 admits the
 * name), ciphertext bound to the organisation under its row-level security; a change made in one
 * process is read by the other's next lookup through the catalog NOTIFY, and by its jobs.
 * (Files: `../module-settings.server.test.ts`.)
 */

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { handleWorkbenchRequest } from '../../server/api.ts';
import { workbenchDepsFromEnv } from '../../server/default-deps.ts';
import { inOrg, openPg, type PgHandle } from '../../server/pg/db.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { KEY, OWNER, SERVER_ENV, runModuleSettingsScenario, scenarioRegistry } from '../module-settings-scenario.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((done) => setTimeout(done, 100));
  }
};

describePg('module settings on Postgres', () => {
  let database: TestDatabase;
  let pgh: PgHandle;
  let orgId: string;
  let otherOrg: string;
  beforeAll(async () => {
    database = await freshDatabase();
    pgh = openPg(database.appUrl, { max: 2 });
    orgId = (await importCatalog(pgh.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
    otherOrg = (await importCatalog(pgh.db, { org: { slug: 'other', create: true }, files: readCatalogTree(dataPath('..')), blobs: testBlobs() })).orgId;
  }, 120_000);
  afterAll(async () => {
    await pgh?.close();
    await database?.drop();
  }, 60_000);

  const studio = async (registry: ReturnType<typeof scenarioRegistry>['registry']) => {
    const opened = await workbenchDepsFromEnv({ WIREHUB_BACKEND: 'pg', DATABASE_URL: database.appUrl, WIREHUB_ORG: 'starter', WIREHUB_SETTINGS_KEY: KEY, ...SERVER_ENV }, { blobs: testBlobs() });
    opened.deps.modules = registry;
    return opened;
  };

  it('runs the module settings session across two processes, the secrets as org-scoped ciphertext', async () => {
    const scenario = scenarioRegistry();
    const a = await studio(scenario.registry);
    const b = await studio(scenarioRegistry().registry);
    try {
      const rows = async (org = orgId) =>
        Object.fromEntries((await inOrg(pgh.db, org, async (tx) => (await sql<{ name: string; ciphertext: string }>`SELECT name, ciphertext FROM studio.settings_secret ORDER BY name`.execute(tx)).rows)).map((r) => [r.name, r.ciphertext]));
      const everywhere = async (): Promise<string> => {
        const stored = await inOrg(pgh.db, orgId, async (tx) => {
          const docs = (await sql<{ body: unknown }>`SELECT body FROM studio.catalog_doc`.execute(tx)).rows;
          const changes = (await sql<{ after: unknown; before: unknown }>`SELECT c.after_body AS after, c.before_body AS before FROM studio.change c`.execute(tx)).rows;
          const sets = (await sql<{ message: string }>`SELECT message FROM studio.change_set`.execute(tx)).rows;
          return JSON.stringify([docs, changes, sets]);
        });
        const exported = JSON.stringify((await handleWorkbenchRequest({ method: 'GET', path: '/api/export', user: OWNER }, a.deps)).body);
        const history = JSON.stringify((await handleWorkbenchRequest({ method: 'GET', path: '/api/history?limit=50', user: OWNER }, a.deps)).body);
        return [stored, exported, history].join('\n');
      };
      await runModuleSettingsScenario({ deps: a.deps, settings: a.settings, org: orgId, rows, everywhere, asked: scenario.asked, other: { deps: b.deps, settings: b.settings } }, until);

      // row-level security: the other organisation sees none of it
      expect(Object.keys(await rows())).toContain('module.suppliers.mouserKey');
      expect(await rows(otherOrg)).toEqual({});
      // the history names the change of the module settings document, by its author
      const history = (await handleWorkbenchRequest({ method: 'GET', path: '/api/history?limit=50', user: OWNER }, a.deps)).body;
      expect(JSON.stringify(history)).toContain('settings/modules.json');
      expect(JSON.stringify(history)).toContain(OWNER.name);
      // an editor's export leaves the owner-only document out
      const editorExport = JSON.stringify((await handleWorkbenchRequest({ method: 'GET', path: '/api/export', user: { ...OWNER, role: 'editor' } }, a.deps)).body);
      expect(editorExport).not.toContain('keyed-probe.region');
    } finally {
      await a.close();
      await b.close();
    }
  }, 120_000);

  it('admits module secret names, and still refuses anything else (migration 0023)', async () => {
    const put = (name: string) => inOrg(pgh.db, orgId, async (tx) => sql`INSERT INTO studio.settings_secret (org_id, name, ciphertext) VALUES (${orgId}::uuid, ${name}, 'v1.a.b.c')`.execute(tx));
    await put('module.acme-erp.apiToken');
    await put('smtp.otherName');
    for (const bad of ['module.Acme.apiToken', 'module.acme.api-token', 'module..x', 'a.b.c', 'module.acme-.key']) await expect(put(bad), bad).rejects.toThrow(/settings_secret_name_check/);
    await inOrg(pgh.db, orgId, async (tx) => sql`DELETE FROM studio.settings_secret WHERE name IN ('module.acme-erp.apiToken', 'smtp.otherName')`.execute(tx));
  });
});
