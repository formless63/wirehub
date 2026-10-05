/**
 * First-run setup on Postgres: the domain modules' packs installed into the
 * database catalog. The file backend's installer works on a directory, so the
 * snapshot is written to a scratch directory, the setup handler runs on it
 * unchanged, and every file it added or changed is committed as one change
 * set of `doc` writes — which the commit explodes into records like any other
 * catalog file. Nothing is written when the handler refuses.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';

import { commitUnit, publishCatalog, type ApiResponse, type WorkbenchDeps } from '../api.ts';
import type { SetupDeps } from '../setup.ts';
import { isDocPath, parseDoc } from '../storage/doc-store.ts';
import { UnitOfWork } from '../storage/unit-of-work.ts';
import type { SnapshotSource } from './deps.ts';

export function pgSetupDeps(workbench: WorkbenchDeps, cache: SnapshotSource, options: { prompt: boolean; now: () => string; user?: () => { name: string } | undefined }): SetupDeps {
  return {
    dataDir: '',
    prompt: options.prompt,
    now: options.now,
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
        const response = await run(join(work, 'data'));
        if (!write || response.status >= 400) return response;
        const after = readCatalogTree(work, { depictionsDir: join(work, 'no-depictions') });
        const uow = new UnitOfWork(workbench);
        const docs = uow.deps.docs;
        if (docs === undefined) throw new Error('the database backend has no doc store');
        for (const [path, content] of after) {
          if (typeof content !== 'string' || before.get(path) === content) continue;
          if (!isDocPath(path)) throw new Error(`setup wrote ${path}, which the catalog cannot hold`);
          await docs.write(path, parseDoc(path, content));
        }
        const committed = await commitUnit(uow, { method: 'POST', path: '/api/setup', ...(options.user?.() === undefined ? {} : { user: { ...options.user()!, source: 'session' as const } }) }, response);
        if (committed.status < 400) await publishCatalog(workbench);
        return committed;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}

export type { ApiResponse };
