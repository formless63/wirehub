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

import { contentSha, isBlobRef, isSkippedPath } from '@wirehub/catalog/src/codec/index.ts';
import { readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';

import { commitUnit, publishCatalog, type WorkbenchDeps } from '../api.ts';
import type { SetupDeps } from '../setup.ts';
import { isDocPath, parseDoc } from '../storage/doc-store.ts';
import { UnitOfWork } from '../storage/unit-of-work.ts';
import type { SnapshotSource } from './deps.ts';

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
        const after = readFlattenedCatalog(work, packsDir);
        const uow = new UnitOfWork(workbench);
        const docs = uow.deps.docs;
        if (docs === undefined) throw new Error('the database backend has no doc store');
        let changed = false;
        // an installed pack's artwork: `depictions/<def>/meta.json` and its image files. The images are bytes the
        // codec holds as blobs: staged as depiction assets, they go to the blob store before the transaction
        // (`uploadChangeBlobs`) and are served by content address like every other depiction file.
        const depictions = uow.deps.depictions;
        for (const [path, content] of after) {
          const match = /^depictions\/([^/]+)\/([^/]+)$/.exec(path);
          if (match === null || isBlobRef(content)) continue;
          const [, def, file] = match as unknown as [string, string, string];
          if (typeof content === 'string') {
            if (snapshot.files.get(path) === content) continue;
          } else if (snapshot.blobOf.get(path) === contentSha(content)) continue;
          if (depictions === undefined) throw new Error('the database backend has no depiction store');
          if (file === 'meta.json' && typeof content === 'string') await depictions.writeMeta(def, JSON.parse(content) as Record<string, unknown>);
          else await depictions.writeAsset(def, file, content as string | Uint8Array);
          changed = true;
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
        const committed = await commitUnit(uow, { method: 'POST', path: '/api/setup' }, response);
        if (committed.status < 400 && changed) await publishCatalog(workbench);
        return committed;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
