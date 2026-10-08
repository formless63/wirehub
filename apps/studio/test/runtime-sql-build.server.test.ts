import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedRecordOf, packAssetFiles } from '@wirehub/catalog';
import { storePublicKeyOf, verifyPackSignature } from '@wirehub/catalog/src/server.ts';
import { explode, classifyPath } from '@wirehub/catalog/src/codec/index.ts';
import { expect, it } from 'vitest';
import { buildModule } from '../scripts/wirehub-module.ts';
import { readBundle } from '../server/pack-archive.ts';
import { authenticatedMigrationModule } from '../server/pg/runtime-migrations.ts';

it('builds raw signed SQL only from the explicit directory and preserves authenticated install proof and blob bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-sql-build-'));
  try {
    const source = join(root, 'module'); mkdirSync(source); const migrationsDir = join(root, 'sql'); mkdirSync(migrationsDir);
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'synthetic-module', main: 'index.ts', license: 'MIT' }));
    writeFileSync(join(source, 'index.ts'), "export const sqlModule = { id: 'sql-test', version: '1.0.0', label: 'SQL test', migrations: { dir: new URL('./migrations', import.meta.url) } };\n");
    const raw = '\ufeffSELECT 1;\r\n-- synthetic example\r\n';
    writeFileSync(join(migrationsDir, '0001_sql_test_table.sql'), raw);
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    await expect(buildModule({ moduleDir: source, out: join(root, 'out'), keys: [pem], publisher: { id: 'synthetic-publisher', name: 'Synthetic publisher' }, log: () => {} })).rejects.toThrow(/migrations-dir/);
    const built = await buildModule({ moduleDir: source, migrationsDir, out: join(root, 'out'), keys: [pem], publisher: { id: 'synthetic-publisher', name: 'Synthetic publisher' }, log: () => {} });
    const pin = built.module.migrations![0]!;
    expect(pin.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(readFileSync(join(built.dir, pin.path), 'utf8')).toBe(raw);
    expect(verifyPackSignature(built.manifest, readFileSync(join(built.dir, 'wirehub-pack.sig'), 'utf8'), [storePublicKeyOf(pem)]).ok).toBe(true);
    expect(packAssetFiles(built.dir)).toContain(pin.path);
    const installed = installedRecordOf(built.manifest, {}, {}, built.dir);
    expect(installed.module?.migrationProof?.signature).toBeTruthy();
    const result = await authenticatedMigrationModule(installed, [storePublicKeyOf(pem)], async (path) => new Uint8Array(readFileSync(join(built.dir, path))));
    expect(result.migrations).toMatchObject({ files: [{ sql: raw, sha256: pin.sha256 }] });
    const files = readBundle({ manifest: built.manifest, files: { [pin.path]: raw } });
    expect(files.get(pin.path)).toEqual(new TextEncoder().encode(raw));
    expect(classifyPath(`data/${pin.path}`)?.table).toBe('catalog_file → blob');
    const exploded = explode(new Map([[`data/${pin.path}`, new TextEncoder().encode(raw)]]));
    expect(exploded.errors).toEqual([]);
    expect(exploded.rows.blobs[0]?.bytes).toEqual(new TextEncoder().encode(raw));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
