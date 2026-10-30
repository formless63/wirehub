/**
 * Append-only catalog documents. A firmware commissioning record
 * (`data/firmware/commissions/<project>.json`, newest first) is only ever added to: a correction
 * is a new record. The generic document routes refuse these paths outright; this check stands in
 * front of every live commit (a request's unit of work, an import plan's publish), so a history
 * restore, a batch, a checkpoint undo or an import can never rewrite or remove one either.
 * The git mirror's replay of past change sets does not pass through here.
 */

import { isCommissionDocPath } from '../firmware/paths.ts';
import type { WorkbenchDeps } from '../api.ts';
import { CommitRefusedError, type RecordChange } from './change-set.ts';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Throws `CommitRefusedError` (403) when `changes` would rewrite or remove an append-only document. */
export async function refuseAppendOnlyRewrites(base: Pick<WorkbenchDeps, 'docs'>, changes: readonly RecordChange[]): Promise<void> {
  // the last staged change of each such document, against what is committed now
  const last = new Map<string, RecordChange>();
  for (const change of changes) if (change.kind === 'doc' && isCommissionDocPath(change.key)) last.set(change.key, change);
  for (const [key, change] of last) {
    const before = await base.docs?.read(key);
    const after = change.op === 'put' ? change.value : undefined;
    if (before === undefined && Array.isArray(after)) continue;
    const kept = Array.isArray(before) && Array.isArray(after) && after.length >= before.length && same(after.slice(after.length - before.length), before);
    if (!kept) throw new CommitRefusedError(403, 'Commissioning records are append-only; nothing was saved.', `${key} can only gain records (POST /api/firmware/:id/commissions); a correction is a new record.`);
  }
}
