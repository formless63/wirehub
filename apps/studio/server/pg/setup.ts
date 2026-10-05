/**
 * First-run setup on Postgres: the domain modules' packs installed into the
 * database catalog. The file backend's setup works on directories, so the
 * snapshot is written to a scratch catalog directory (with an empty scratch
 * packs directory beside it), the setup handler runs on them unchanged, and
 * the result is flattened (`readFlattenedCatalog`: the packs merged record by
 * record into the catalog, `packs.json` and `setup.json` at its root — how the
 * database holds a catalog). Every file that changed is committed as one
 * change set of `doc` writes, with the tag tables regenerated in it. Nothing
 * is written when the handler refuses.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
        for (const [path, content] of after) {
          if (!path.startsWith('data/') || typeof content !== 'string' || before.get(path) === content) continue;
          if (!isDocPath(path)) throw new Error(`setup wrote ${path}, which the catalog cannot hold`);
          await docs.write(path, parseDoc(path, content));
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
