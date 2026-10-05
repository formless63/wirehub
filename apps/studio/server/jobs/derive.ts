/**
 * The `derive` job — repair only (`specs/postgres-backend.md` §2, §4.4; task
 * C5). Every commit recomputes the derived records its changes make stale,
 * in the same transaction, so this finds nothing in normal operation. It
 * exists for what bypassed a commit (a restore, a hand edit, a bug): it
 * recomputes the derived records over the catalog as it stands and, only
 * when they differ from what is stored, commits the difference as a change
 * set of its own (`source = 'worker'`).
 */

import type { WorkbenchDeps } from '../api.ts';
import { CatalogTree, treeWorkbenchDeps } from '../pg/tree.ts';
import { commitChangeSet } from '../storage/unit-of-work.ts';
import type { DerivedKind } from '../storage/change-set.ts';
import type { JobContext, JobOutcome } from './types.ts';

/** The derived files that would change if they were recomputed now (paths). */
export async function staleDerivedFiles(deps: WorkbenchDeps): Promise<string[]> {
  if (deps.exportCatalog === undefined) return [];
  const exported = await deps.exportCatalog();
  const tree = new CatalogTree(Object.entries(exported.files));
  const stores = treeWorkbenchDeps(tree, { orgId: 'derive' });
  await stores.tags?.regenerate();
  const out: string[] = [];
  for (const [path, content] of tree.files) if (typeof content === 'string' && exported.files[path] !== content) out.push(path);
  for (const path of Object.keys(exported.files)) if (!tree.files.has(path)) out.push(path);
  return out.sort();
}

export async function runDeriveJob(context: JobContext, deps: WorkbenchDeps, options: { refresh?: () => void } = {}): Promise<JobOutcome> {
  // read every row again: what bypassed a commit did not move the version the snapshot cache follows
  options.refresh?.();
  const stale = await staleDerivedFiles(deps);
  if (stale.length === 0) return { result: { stale: [], repaired: false } };
  await context.step(`recomputing ${stale.length} derived file(s)`);
  options.refresh?.();
  const derive = new Set<DerivedKind>(['tags']);
  const set = { changes: [], context: { method: 'POST', path: '/api/jobs/derive', source: 'worker' as const, body: { message: 'Derived records recomputed (repair)' } } };
  const result = deps.commit !== undefined ? await deps.commit(set, derive) : await commitChangeSet(deps, set, derive);
  return { result: { stale, repaired: true, derived: result.derived } };
}
