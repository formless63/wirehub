/**
 * The file backend's catalog version (storage seams): a
 * token that changes whenever a file the definition db is built from changes
 * — the studio's own writes, a `git pull`, a hand edit, a script. The unit of
 * work caches the loaded db under it, so a request that finds the token
 * unchanged skips re-reading ~40 files.
 *
 * Name, inode (an atomic write is a rename: a new inode), size and mtime of every file `loadDb()` reads (top-level JSON,
 * `vocab/`, `tags/`, `builds/` — `loadDb` lays each build over board-parts.json —
 * plus `devices/` and `rules/`); a few dozen `stat`s, well under a millisecond.
 */

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = ['', 'vocab', 'tags', 'builds', 'devices', 'rules'] as const;

export function fileCatalogVersion(root: string): string {
  const hash = createHash('sha1');
  for (const dir of DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(root, dir)).filter((name) => name.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const stat = statSync(join(root, dir, name));
        hash.update(`${dir}/${name}:${stat.ino}:${stat.size}:${stat.mtimeMs}\n`);
      } catch {
        hash.update(`${dir}/${name}:gone\n`);
      }
    }
  }
  return hash.digest('hex');
}
