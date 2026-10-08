/** Owner-only SQL loader. It reads signed data, never a runtime entry. */
import { createHash } from 'node:crypto';
import { type InstalledPack } from '@wirehub/catalog';
import { verifyPackSignature } from '@wirehub/catalog/src/server.ts';
import { apiCompatibility, codeModuleManifestProblems } from '@wirehub/modules';
import { blobObjectKey } from './keys.ts';
import type { BlobStore } from '../blobs.ts';
import { codeModulesAllowedByEnv, settingsOf } from '../code-modules/state.ts';
import type { Db } from './db.ts';
import { loadSnapshot } from './snapshot.ts';
import { migrateModules, type MigrationModule } from './module-migrations.ts';

/** Re-authenticate app-writable records against roots supplied by the schema owner. */
export async function authenticatedMigrationModule(pack: InstalledPack, keys: readonly string[], bytes: (path: string, sha: string) => Promise<Uint8Array | undefined>): Promise<MigrationModule> {
  const installed = pack.module;
  const proof = installed?.migrationProof;
  if (installed === undefined || proof === undefined) throw new Error(`Module '${installed?.id ?? pack.id}' has no signed migration proof; reinstall its signed bundle.`);
  const verified = verifyPackSignature(proof.manifest, proof.signature, [...keys]);
  if (!verified.ok) throw new Error(`Module '${installed.id}' migration signature is not trusted by the schema owner (${verified.reason}).`);
  const m = proof.manifest.module;
  if (m === undefined || proof.manifest.id !== pack.id || proof.manifest.version !== pack.version || m.id !== installed.id || m.version !== installed.version) throw new Error('Signed migration identity does not match the installed module.');
  const problems = codeModuleManifestProblems(m);
  if (problems.length !== 0 || !apiCompatibility(m.apiVersion).ok || m.migrations === undefined) throw new Error(`Module '${installed.id}' has an invalid signed migration manifest.`);
  // The authenticated manifest, rather than the installed pins, is the authority.
  if (JSON.stringify(m.migrations) !== JSON.stringify(installed.files.migrations)) throw new Error(`Module '${m.id}' migration pins differ from its signed manifest.`);
  const files = [];
  for (const pin of m.migrations) {
    if (proof.manifest.files?.[pin.path] !== pin.sha256) throw new Error(`Module '${m.id}' migration pin is not covered by its signature.`);
    const raw = await bytes(pin.path, pin.sha256);
    if (raw === undefined || createHash('sha256').update(raw).digest('hex') !== pin.sha256) throw new Error(`Module '${m.id}' migration '${pin.path}' is missing or changed.`);
    const sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    files.push({ name: pin.path.split('/').at(-1)!.slice(0, -4), sql, sha256: pin.sha256 });
  }
  return { id: m.id, migrations: { files } };
}

/** The caller connects as studio_owner; SQL roots never come from catalog settings. */
export async function migrateInstalledModules(db: Db, orgId: string, keys: readonly string[], blobs: BlobStore | undefined, env: Readonly<Record<string, string | undefined>>): Promise<string[]> {
  if (!codeModulesAllowedByEnv(env)) return [];
  const snapshot = await loadSnapshot(db, orgId);
  const settingsText = snapshot.source.read('settings/code-modules.json');
  const settings = settingsOf(settingsText === undefined ? undefined : JSON.parse(settingsText));
  if (settings.allow === false) return [];
  const packsText = snapshot.source.read('packs.json');
  const packs = (packsText === undefined ? [] : (JSON.parse(packsText) as { packs: InstalledPack[] }).packs);
  const modules: MigrationModule[] = [];
  for (const pack of packs) {
    if (!pack.module?.extensionPoints.includes('migrations') || settings.modules[pack.module.id]?.enabled !== true) continue;
    modules.push(await authenticatedMigrationModule(pack, keys, async (path, sha) => {
      if (snapshot.blobOf.get(`data/${path}`) !== sha) return undefined;
      const row = snapshot.rows.blobs.find((b) => b.sha256 === sha);
      const found = row === undefined ? undefined : await blobs?.get(blobObjectKey(orgId, sha));
      return found === undefined ? undefined : new Uint8Array(found);
    }));
  }
  return migrateModules(db, modules);
}
