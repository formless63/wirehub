/**
 * Which files a request wrote — what the backup's
 * auto-commit stages, so a save commits exactly its own files and never a
 * blanket `git add -A`.
 *
 * Every store write goes through `writeFileAtomic` (which reports here), and
 * the few deletes and renames call `recordWrite` themselves. A host wraps one
 * request's handler in `collectWrites`; outside one, reporting is a no-op, so
 * scripts and tests that call the stores directly are unaffected.
 *
 * The handlers are asynchronous (storage seams);
 * `AsyncLocalStorage` keeps two requests' journals apart across their awaits,
 * and `collectWritesAsync` waits for the whole handler — its commit included.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

const journal = new AsyncLocalStorage<Set<string>>();

/** Note that `path` (a file or a whole directory) was written, moved or removed. */
export function recordWrite(...paths: string[]): void {
  const set = journal.getStore();
  if (set === undefined) return;
  for (const path of paths) set.add(resolve(path));
}

/** `collectWrites` for an async `fn`: the journal follows it across every await. */
export async function collectWritesAsync<T>(fn: () => Promise<T>): Promise<{ result: T; paths: string[] }> {
  const set = new Set<string>();
  const result = await journal.run(set, fn);
  return { result, paths: [...set].sort() };
}

/** Runs `fn`, returning what it returned plus every absolute path it reported, sorted. */
export function collectWrites<T>(fn: () => T): { result: T; paths: string[] } {
  const set = new Set<string>();
  const result = journal.run(set, fn);
  return { result, paths: [...set].sort() };
}
