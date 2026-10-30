/**
 * The one safe way to drop uploaded assets (`AssetStore.remove`): only the hub's own assets, only
 * those nothing names, logged. "Names" is searched as text, the sha256 itself, so a new kind of
 * record is covered without being listed here:
 *
 * - current: every record, document, design version and drawing (the catalog files, or the
 *   database's tables), job requests included;
 * - history: every earlier state the history can restore (git log of the catalog, or the
 *   `studio.change` rows).
 *
 * A current or version reference always keeps the asset. A history-only reference keeps it too,
 * unless the caller names the asset that replaces it (`replacedBy`: a cleaned copy of the same
 * photo); then `assets/replaced.json` records the pair and reading the old id answers the new
 * asset, so restoring an older state brings back the clean copy.
 *
 * Call it with a unit of work's deps: the drop is staged and committed like any change (on
 * Postgres the row goes and GC sweeps the blob after a backup, `pg/gc.ts`). References are read
 * from what is committed, so repoint first, commit, then remove.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { WorkbenchDeps } from './api.ts';
import { ASSET_REPLACED_DOC } from './assets.ts';

export interface AssetReferences {
  /** where a current record, document or version names it */
  current: string[];
  /** earlier states that name it (commits, change sets) */
  history: string[];
}

export type AssetReferenceFinder = (ids: readonly string[]) => Promise<Map<string, AssetReferences>>;

export interface RemoveAssetsOptions {
  /** list what would go, change nothing */
  dryRun?: boolean;
  /** old id → the asset that replaces it; lets a history-only reference through */
  replacedBy?: Readonly<Record<string, string>>;
  /** who asked, for the log */
  by?: string;
}

export interface RemoveAssetsOutcome {
  dryRun: boolean;
  removed: { id: string; name: string; bytes: number }[];
  kept: { id: string; reason: string; where?: string[] }[];
}

const SHA = /^[0-9a-f]{64}$/;
const SKIP = new Set([`data/${ASSET_REPLACED_DOC}`, 'data/assets/index.json']);
/** paths whose mention of an id is the asset's own bookkeeping, not a reference */
const isBookkeeping = (path: string): boolean => SKIP.has(path) || SKIP.has(`data/${path}`);

export async function removeUnreferencedAssets(deps: WorkbenchDeps, ids: readonly string[], options: RemoveAssetsOptions = {}): Promise<RemoveAssetsOutcome> {
  const dryRun = options.dryRun === true;
  const out: RemoveAssetsOutcome = { dryRun, removed: [], kept: [] };
  const wanted = [...new Set(ids)].filter((id) => SHA.test(id));
  const assets = deps.assets;
  if (assets?.remove === undefined || deps.assetReferences === undefined) {
    for (const id of wanted) out.kept.push({ id, reason: 'This hub cannot check what names its files, so it removes none.' });
    return out;
  }
  const listed = new Map((await assets.list()).map((r) => [r.id, r]));
  const refs = await deps.assetReferences(wanted.filter((id) => listed.has(id)));
  const go: string[] = [];
  for (const id of wanted) {
    const record = listed.get(id);
    if (record === undefined) continue; // already gone
    const found = refs.get(id) ?? { current: [], history: [] };
    const replacement = options.replacedBy?.[id];
    if (found.current.length > 0) out.kept.push({ id, reason: 'Still in use.', where: found.current.slice(0, 10) });
    else if (found.history.length > 0 && (replacement === undefined || !listed.has(replacement) || replacement === id)) out.kept.push({ id, reason: 'An earlier state names it.', where: found.history.slice(0, 10) });
    else go.push(id);
  }
  if (dryRun) {
    for (const id of go) out.removed.push({ id, name: listed.get(id)!.originalName, bytes: listed.get(id)!.bytes });
    return out;
  }
  const removed = go.length === 0 ? [] : await assets.remove(go);
  for (const id of go) if (!removed.includes(id)) out.kept.push({ id, reason: 'A pack provides it.' });
  for (const id of removed) out.removed.push({ id, name: listed.get(id)!.originalName, bytes: listed.get(id)!.bytes });
  const pairs = removed.filter((id) => options.replacedBy?.[id] !== undefined);
  if (pairs.length > 0 && deps.docs !== undefined) {
    const path = `data/${ASSET_REPLACED_DOC}`;
    const map = { ...((await deps.docs.read(path)) as Record<string, string> | undefined) };
    for (const id of pairs) map[id] = options.replacedBy![id]!;
    await deps.docs.write(path, Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1))));
  }
  if (removed.length > 0) console.info(`[assets] ${options.by ?? 'someone'} removed ${removed.length} unreferenced asset(s): ${removed.join(', ')}`);
  return out;
}

/* ------------------------------------------------------------------ *
 * File backend: the catalog directory and its git history
 * ------------------------------------------------------------------ */

const TEXT = /\.(json|md|txt)$/;
const MAX_TEXT = 64 * 1024 * 1024;

function walk(dir: string, visit: (path: string) => void): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (st === undefined) continue;
    if (st.isDirectory()) walk(path, visit);
    else if (st.isFile() && TEXT.test(name) && st.size <= MAX_TEXT) visit(path);
  }
}

/** References in a catalog directory (`dataDir`, the `data/` folder) and its git history. */
export function fileAssetReferences(dataDir: string): AssetReferenceFinder {
  return async (ids) => {
    const out = new Map<string, AssetReferences>(ids.map((id) => [id, { current: [], history: [] }]));
    if (ids.length === 0 || !existsSync(dataDir)) return out;
    walk(dataDir, (path) => {
      const rel = `data/${relative(dataDir, path)}`;
      if (isBookkeeping(rel)) return;
      const text = readFileSync(path, 'utf8');
      for (const id of ids) if (text.includes(id)) out.get(id)!.current.push(rel);
    });
    // history: any commit that added or dropped the id anywhere but the asset bookkeeping
    const inGit = spawnSync('git', ['-C', dataDir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', timeout: 10_000 });
    if (inGit.status !== 0) return out;
    for (const id of ids) {
      const log = spawnSync('git', ['-C', dataDir, 'log', '--all', '--format=%h', '-n', '5', `-S${id}`, '--', '.', ':(exclude)assets/index.json', `:(exclude)${ASSET_REPLACED_DOC}`], { encoding: 'utf8', timeout: 120_000 });
      // a git that cannot answer counts as a reference: never remove on doubt
      if (log.status !== 0) out.get(id)!.history.push('git history (unreadable)');
      else for (const line of log.stdout.split('\n')) if (line.trim() !== '') out.get(id)!.history.push(`commit ${line.trim()}`);
    }
    return out;
  };
}
