/**
 * First-run setup on Postgres: the domain modules' packs installed into the
 * database catalog. The file backend's setup works on directories, so the
 * snapshot is written to a scratch catalog directory (with an empty scratch
 * packs directory beside it), the setup handler runs on them unchanged, and
 * the result is flattened (`readFlattenedCatalog`: the packs merged record by
 * record into the catalog, `packs.json` and `setup.json` at its root — how the
 * database holds a catalog). Every file that changed is committed as one
 * change set of `doc` writes, with the tag tables regenerated in it. Nothing
 * is written when the handler refuses. The pack lifecycle (`/api/packs`, `packs.ts`) runs
 * through the same transaction, so a pack's update or disable is one change set too.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { assetSha, flatAssetPath, reconcileAssets, type InstalledPack } from '@wirehub/catalog';
import { canonicalJson, contentSha, isBlobRef, isSkippedPath } from '@wirehub/catalog/src/codec/index.ts';
import { readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';

import { commitUnit, publishCatalog, type WorkbenchDeps } from '../api.ts';
import type { SetupDeps } from '../setup.ts';
import { isDocPath, parseDoc } from '../storage/doc-store.ts';
import { rekeyBoardLinks } from '../models/board-art.ts';
import { UnitOfWork } from '../storage/unit-of-work.ts';
import type { SnapshotSource } from './deps.ts';

/** The packs a flattened `data/packs.json` records. */
function installedOf(content: string | Uint8Array | { blob: string } | undefined): InstalledPack[] {
  if (typeof content !== 'string') return [];
  return (JSON.parse(content) as { packs?: InstalledPack[] }).packs ?? [];
}

export interface PgSetupOptions {
  prompt: boolean;
  now: () => string;
  code?: string;
  suggested?: readonly string[];
}

export function pgSetupDeps(workbench: WorkbenchDeps, cache: SnapshotSource, options: PgSetupOptions): SetupDeps {
  return {
    dataDir: '',
    prompt: options.prompt,
    now: options.now,
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.suggested === undefined ? {} : { suggested: options.suggested }),
    transact: async (run, write) => {
      const snapshot = await cache.get();
      const work = mkdtempSync(join(tmpdir(), 'wirehub-setup-'));
      try {
        const before = new Map<string, string>();
        for (const [path, content] of snapshot.files) {
          if (typeof content !== 'string' || !path.startsWith('data/')) continue;
          before.set(path, content);
          mkdirSync(dirname(join(work, path)), { recursive: true });
          writeFileSync(join(work, path), content);
        }
        const packsDir = join(work, 'packs');
        const response = await run(join(work, 'data'), packsDir);
        if (!write || response.status >= 400) return response;
        const after = new Map(readFlattenedCatalog(work, packsDir));
        let changed = false;
        const uow = new UnitOfWork(workbench);
        const docs = uow.deps.docs;
        if (docs === undefined) throw new Error('the database backend has no doc store');
        // an installed pack's artwork: `depictions/<def>/…` (meta.json and the images) and the binary `data/art/…`.
        // Which files a pack owns is its `packs.json` record (`assets`): an update replaces or removes them, a disable
        // removes them, and a file the catalog holds of its own (not the pack's, or edited since) is left alone.
        // Images are bytes the codec holds as blobs: staged, they go to the blob store before the transaction
        // (`uploadChangeBlobs`) and are served by content address like every other depiction file.
        const depictions = uow.deps.depictions;
        const files = uow.deps.files;
        const holdingOf = (flat: string): string | undefined => {
          const text = snapshot.files.get(flat);
          if (typeof text === 'string') return assetSha(flat, text);
          const sha = snapshot.blobOf.get(flat);
          return sha;
        };
        const put = async (relative: string): Promise<void> => {
          const flat = flatAssetPath(relative);
          const content = after.get(flat);
          if (content === undefined || isBlobRef(content)) return;
          await stageAsset(flat, content);
        };
        const stageAsset = async (flat: string, content: string | Uint8Array): Promise<void> => {
          const match = /^depictions\/([^/]+)\/([^/]+)$/.exec(flat);
          if (match === null) {
            if (files === undefined) throw new Error('the database backend has no catalog file store');
            await files.write(flat, typeof content === 'string' ? new TextEncoder().encode(content) : content);
          } else {
            const [, def, file] = match as unknown as [string, string, string];
            if (depictions === undefined) throw new Error('the database backend has no depiction store');
            if (file === 'meta.json' && typeof content === 'string') await depictions.writeMeta(def, JSON.parse(content) as Record<string, unknown>);
            else await depictions.writeAsset(def, file, content);
          }
          changed = true;
        };
        const drop = async (relative: string): Promise<void> => {
          const flat = flatAssetPath(relative);
          const match = /^depictions\/([^/]+)\/([^/]+)$/.exec(flat);
          if (match === null) await files?.remove(flat);
          else {
            const [, def, file] = match as unknown as [string, string, string];
            if (depictions?.removeAsset === undefined) throw new Error('the database backend cannot remove a depiction file');
            await depictions.removeAsset(def, file);
          }
          changed = true;
        };
        const packsBefore = installedOf(snapshot.files.get('data/packs.json'));
        const packsAfter = installedOf(after.get('data/packs.json'));
        const claimed = new Set<string>();
        let ownership = false;
        const nextPacks: InstalledPack[] = [];
        for (const pack of packsAfter) {
          const was = packsBefore.find((p) => p.id === pack.id);
          const next = pack.assets ?? {};
          for (const relative of Object.keys(next)) claimed.add(flatAssetPath(relative));
          // a pack from before ownership was recorded: assume it owns what it ships now, as the catalog holds it
          const before = was === undefined ? undefined : (was.assets ?? Object.fromEntries(Object.keys(next).flatMap((r) => (holdingOf(flatAssetPath(r)) === undefined ? [] : [[r, holdingOf(flatAssetPath(r)) as string] as const]))));
          const ops = reconcileAssets(before, next, (r) => holdingOf(flatAssetPath(r)));
          for (const relative of ops.remove) await drop(relative);
          for (const relative of ops.write) await put(relative);
          if (Object.keys(next).length > 0 && JSON.stringify(ops.owned) !== JSON.stringify(next)) {
            ownership = true;
            const { assets: _assets, ...rest } = pack;
            nextPacks.push(Object.keys(ops.owned).length === 0 ? rest : { ...rest, assets: ops.owned });
          } else nextPacks.push(pack);
        }
        // a disabled pack: what it owned goes, unless the catalog changed it since
        for (const pack of packsBefore) {
          if (packsAfter.some((p) => p.id === pack.id) || pack.assets === undefined) continue;
          for (const relative of reconcileAssets(pack.assets, {}, (r) => holdingOf(flatAssetPath(r))).remove) await drop(relative);
        }
        if (ownership) {
          const record = JSON.parse(after.get('data/packs.json') as string) as Record<string, unknown>;
          after.set('data/packs.json', canonicalJson({ ...record, packs: nextPacks }));
        }
        // images no pack record accounts for (a pack installed before ownership was recorded): written when they differ
        for (const [path, content] of after) {
          if (claimed.has(path) || !/^depictions\/[^/]+\/[^/]+$/.test(path) || isBlobRef(content)) continue;
          if (typeof content === 'string') {
            if (snapshot.files.get(path) === content) continue;
          } else if (snapshot.blobOf.get(path) === contentSha(content)) continue;
          await stageAsset(path, content);
        }
        for (const [path, content] of after) {
          if (!path.startsWith('data/') || typeof content !== 'string' || before.get(path) === content) continue;
          if (!isDocPath(path)) throw new Error(`setup wrote ${path}, which the catalog cannot hold`);
          await docs.write(path, parseDoc(path, content));
          changed = true;
        }
        // a file the handler removed (a disabled pack's vocabulary list, an example design)
        for (const path of before.keys()) {
          if (after.has(path) || isSkippedPath(path)) continue;
          if (!isDocPath(path)) throw new Error(`setup removed ${path}, which the catalog cannot hold`);
          await docs.remove(path);
          changed = true;
        }
        // the tag tables cover every record, the packs' included
        if (changed) await uow.deps.tags?.regenerate();
        // artwork that came or went with a pack: a board's model link is keyed to its art (cs-d97)
        if (changed) await rekeyBoardLinks(uow.deps.depictions, uow.deps.modelLinks);
        const committed = await commitUnit(uow, { method: 'POST', path: '/api/setup' }, response);
        if (committed.status < 400 && changed) await publishCatalog(workbench);
        return committed;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
