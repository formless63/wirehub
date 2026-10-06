import { createHash, generateKeyPairSync } from 'node:crypto';
import { dataPath, signPackManifest, storePublicKeyOf, type InstalledPack, type PackManifest } from '@wirehub/catalog';
import { createLiveRegistry, createRegistry, defineModule } from '@wirehub/modules';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authenticatedMigrationModule, migrateInstalledModules } from '../../server/pg/runtime-migrations.ts';
import { createCodeModuleHost } from '../../server/code-modules/host.ts';
import { emptySettings } from '../../server/code-modules/state.ts';
import { openPg, type PgHandle } from '../../server/pg/db.ts';
import { migrateModules, pendingPinnedMigrations } from '../../server/pg/module-migrations.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import { describePg, freshDatabase, testBlobs, type TestDatabase } from './harness.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const key = storePublicKeyOf(pem);
const server = 'synthetic runtime entry';
const first = 'CREATE TABLE t (id int, org_id uuid); ALTER TABLE t ENABLE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY; CREATE POLICY org_isolation ON t USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());';
function fixture(texts = [first]): { pack: InstalledPack; texts: Map<string, string> } {
  const migrations = texts.map((text, i) => ({ path: `code/sql-test/migrations/${String(i + 1).padStart(4, '0')}_sql_test_${i === 0 ? 'table' : 'more'}.sql`, sha256: sha(text) }));
  const module = { id: 'sql-test', version: texts.length === 1 ? '1.0.0' : '1.1.0', label: 'SQL test', apiVersion: '1.3', server: 'code/sql-test/server.mjs', extensionPoints: ['migrations'], permissions: ['server-code', 'database-schema'], migrations };
  const manifest: PackManifest = { format: 1, id: 'sql-test', name: 'SQL test', version: module.version, license: 'MIT', module, files: Object.fromEntries([...migrations.map((f) => [f.path, f.sha256]), [module.server, sha(server)]]) };
  const pack: InstalledPack = { id: manifest.id, version: manifest.version, license: 'MIT', added: {}, module: { ...module, files: { server: sha(server), migrations }, migrationProof: { manifest, signature: signPackManifest(manifest, [pem]) } } };
  return { pack, texts: new Map([...migrations.map((f, i) => [f.path, texts[i]!] as [string, string]), [module.server, server]]) };
}
const read = (f: ReturnType<typeof fixture>) => async (path: string) => f.texts.has(path) ? new TextEncoder().encode(f.texts.get(path)!) : undefined;

describe('owner migration authentication', () => {
  it('uses independently supplied roots and signed identity/pins, rejecting metadata and bytes tampering', async () => {
    const f = fixture();
    expect((await authenticatedMigrationModule(f.pack, [key], read(f))).id).toBe('sql-test');
    const bom = fixture(['\ufeffSELECT 1;']);
    expect((await authenticatedMigrationModule(bom.pack, [key], read(bom))).migrations).toMatchObject({ files: [{ sql: '\ufeffSELECT 1;' }] });
    await expect(authenticatedMigrationModule(f.pack, [], read(f))).rejects.toThrow(/signature/);
    const edited = JSON.parse(JSON.stringify(f.pack)) as InstalledPack;
    edited.module!.files.migrations![0]!.sha256 = sha('SELECT 2');
    await expect(authenticatedMigrationModule(edited, [key], read(f))).rejects.toThrow(/pins differ/);
    const proof = JSON.parse(JSON.stringify(f.pack)) as InstalledPack;
    proof.module!.migrationProof!.manifest.module!.migrations![0]!.sha256 = sha('SELECT 2');
    await expect(authenticatedMigrationModule(proof, [key], read(f))).rejects.toThrow(/signature/);
    const attacker = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    proof.module!.migrationProof!.signature = signPackManifest(proof.module!.migrationProof!.manifest, [attacker]);
    await expect(authenticatedMigrationModule(proof, [key], read(f))).rejects.toThrow(/signature/);
    const renamed = JSON.parse(JSON.stringify(f.pack)) as InstalledPack; renamed.id = 'another-pack';
    await expect(authenticatedMigrationModule(renamed, [key], read(f))).rejects.toThrow(/identity/);
    await expect(authenticatedMigrationModule(f.pack, [key], async () => new TextEncoder().encode('changed'))).rejects.toThrow(/missing or changed/);
    await expect(authenticatedMigrationModule(f.pack, [key], async () => undefined)).rejects.toThrow(/missing or changed/);
  });
});

describePg('runtime SQL readiness', () => {
  let db: TestDatabase; let owner: PgHandle; let app: PgHandle;
  beforeAll(async () => { db = await freshDatabase(); owner = openPg(db.ownerUrl); app = openPg(db.appUrl); });
  afterAll(async () => { await app?.close(); await owner?.close(); await db?.drop(); });
  it('imports only after owner applies SQL; re-enable checks history and an update waits again', async () => {
    let f = fixture();
    let settings = emptySettings(); settings.modules['sql-test'] = { enabled: true };
    let env: Record<string, string> = {};
    const importer = vi.fn(async () => ({ default: defineModule({ id: 'sql-test', version: f.pack.module!.version, label: 'SQL test', migrations: { dir: '/never-read' } }) }));
    const live = createLiveRegistry(createRegistry([]));
    const host = createCodeModuleHost({ builtins: [], live, importModule: importer, log: () => {}, env: () => env, source: {
      state: async () => ({ packs: [f.pack], settings }), bytes: async (_pack, path) => read(f)(path),
      migrations: async (id, files) => pendingPinnedMigrations(app.db, id, files.map((p) => ({ name: p.path.split('/').at(-1)!.slice(0, -4), sha256: p.sha256 }))),
    } });
    await host.sync(); expect(host.status()[0]?.state).toBe('pending'); expect(importer).not.toHaveBeenCalled();
    expect(await host.trial(f.pack.module!.migrationProof!.manifest.module!, new TextEncoder().encode(server), sha(server))).toEqual([]); expect(importer).not.toHaveBeenCalled();
    const module = await authenticatedMigrationModule(f.pack, [key], read(f));
    await expect(migrateModules(app.db, [module])).rejects.toThrow();
    await migrateModules(owner.db, [module]);
    const otherOrgVersion = fixture([first + '-- incompatible other organisation']);
    await expect(migrateModules(owner.db, [await authenticatedMigrationModule(otherOrgVersion.pack, [key], read(otherOrgVersion))])).rejects.toThrow(/changed/);
    await host.sync(); expect(host.status()[0]?.state).toBe('loaded'); expect(importer).toHaveBeenCalledTimes(1);
    settings.modules['sql-test'] = { enabled: false }; await host.sync(); expect(live.module('sql-test')).toBeUndefined();
    settings.modules['sql-test'] = { enabled: true }; await host.sync(); expect(host.status()[0]?.state).toBe('loaded');
    f = fixture([first, 'ALTER TABLE t ADD COLUMN note text;']); await host.sync(); expect(host.status()[0]?.state).toBe('pending'); expect(live.module('sql-test')).toBeUndefined();
    await migrateModules(owner.db, [await authenticatedMigrationModule(f.pack, [key], read(f))]); await host.sync(); expect(host.status()[0]?.state).toBe('loaded');
    const normal = f;
    f = fixture([first + '-- changed', 'ALTER TABLE t ADD COLUMN note text;']); await host.sync(); expect(host.status()[0]?.state).toBe('refused');
    await expect(migrateModules(owner.db, [await authenticatedMigrationModule(f.pack, [key], read(f))])).rejects.toThrow(/changed/);
    f = normal; f.pack.module!.files.migrations!.pop(); await host.sync(); expect(host.status()[0]?.error).toMatch(/missing/);
    f = fixture([first, 'ALTER TABLE t ADD COLUMN note text;']); f.texts.set(f.pack.module!.files.migrations![0]!.path, 'changed'); await host.sync(); expect(host.status()[0]?.error).toMatch(/missing or changed/);
    env = { WIREHUB_ALLOW_CODE_MODULES: 'false' }; await host.sync(); expect(host.status()[0]?.state).toBe('off');
  });
  it('loads installed SQL from org-scoped blobs with independent roots, obeys kill switches, and rejects conflicting org history', async () => {
    const isolated = await freshDatabase(); const own = openPg(isolated.ownerUrl); const application = openPg(isolated.appUrl); const blobs = testBlobs();
    try {
      const install = async (slug: string, f: ReturnType<typeof fixture>, enabled = true, allow = true) => {
        const files = new Map(readCatalogTree(dataPath('..')));
        files.set('data/packs.json', JSON.stringify({ src: 'synthetic example', packs: [f.pack] }, null, 2) + '\n');
        files.set('data/settings/code-modules.json', JSON.stringify({ src: 'synthetic example', allow, modules: { 'sql-test': { enabled } }, keys: [{ key }] }, null, 2) + '\n');
        for (const [path, text] of f.texts) files.set(`data/${path}`, new TextEncoder().encode(text));
        return (await importCatalog(application.db, { org: { slug, create: true }, files, blobs })).orgId;
      };
      const f = fixture(); const org = await install('first', f);
      expect(await migrateInstalledModules(own.db, org, [key], blobs, { WIREHUB_ALLOW_CODE_MODULES: 'false' })).toEqual([]);
      // Catalog-pinned keys are insufficient; only the caller's independent roots authorize owner SQL.
      await expect(migrateInstalledModules(own.db, org, [], blobs, {})).rejects.toThrow(/signature/);
      expect(await migrateInstalledModules(own.db, org, [key], blobs, {})).toEqual(['sql-test: 0001_sql_test_table']);
      expect(await migrateInstalledModules(own.db, org, [key], blobs, {})).toEqual([]);
      const future = fixture([first, 'CREATE TABLE disabled_table (id int);']);
      const disabled = await install('disabled', future, false);
      const off = await install('off', future, true, false);
      expect(await migrateInstalledModules(own.db, disabled, [key], blobs, {})).toEqual([]);
      expect(await migrateInstalledModules(own.db, off, [key], blobs, {})).toEqual([]);
      expect(await pendingPinnedMigrations(application.db, 'sql-test', future.pack.module!.files.migrations!.map((p) => ({ name: p.path.split('/').at(-1)!.slice(0, -4), sha256: p.sha256 })))).toEqual(['sql-test: 0002_sql_test_more']);
      const anotherOrg = await install('other', fixture([first + '-- incompatible org history']));
      await expect(migrateInstalledModules(own.db, anotherOrg, [key], blobs, {})).rejects.toThrow(/changed/);
    } finally { await application.close(); await own.close(); await isolated.drop(); }
  });
  it('a file backend refuses SQL without importing the entry', async () => {
    const f = fixture(); const importer = vi.fn(); const settings = emptySettings(); settings.modules['sql-test'] = { enabled: true };
    const host = createCodeModuleHost({ builtins: [], live: createLiveRegistry(createRegistry([])), importModule: importer, log: () => {}, source: { state: async () => ({ packs: [f.pack], settings }), bytes: async (_pack, path) => read(f)(path) } });
    await host.sync(); expect(host.status()[0]?.error).toMatch(/Postgres/); expect(importer).not.toHaveBeenCalled();
  });
});
