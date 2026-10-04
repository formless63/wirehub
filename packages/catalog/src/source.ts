/**
 * Where a catalog's files come from (storage seams).
 *
 * Every loader in `index.ts` reads through a `CatalogSource` instead of calling
 * `node:fs` itself, so the same loaders serve
 *
 * - the live catalog (`fsCatalogSource(dataPath(''))`, what `loadDb()` and
 *   friends read, per call, never memoised),
 * - the frozen fixture catalog under `fixtures/v1/` that snapshot tests pin
 *   their output to (`fixtureCatalog()`), and
 * - an in-memory map of path → text (`memoryCatalogSource`), for a test that
 *   has no filesystem (the studio's browser-path suite) or a future backend
 *   that holds the records somewhere other than files.
 *
 * Paths are always relative to the catalog's data root and use `/`, exactly
 * as they appear under `data/` (`designs/<id>.json`, `rules/policy.json`).
 * The interface is deliberately text-in: parsing, composition and precedence
 * stay in the loaders, so every source yields the same `Db` for the same bytes.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface CatalogSource {
  /** A file's text, or `undefined` when there is no such file. */
  read(relative: string): string | undefined;
  /** The file names directly inside a directory (not recursive); `[]` when the directory is absent. */
  list(relativeDir: string): string[];
  /** Human-readable name, for error messages ("the live catalog", a fixture path). */
  readonly name: string;
  /** The directory on disk this source reads, when it is one (tools that write beside it need it). */
  readonly root?: string;
}

function checkRelative(relative: string): void {
  if (relative.startsWith('/') || relative.split('/').includes('..')) {
    throw new Error(`'${relative}' is not a path inside the catalog`);
  }
}

/** A directory on disk laid out like `packages/catalog/data/`. Reads per call. */
export function fsCatalogSource(root: string, name = root): CatalogSource {
  return {
    name,
    root,
    read(relative) {
      checkRelative(relative);
      const path = join(root, relative);
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    },
    list(relativeDir) {
      checkRelative(relativeDir);
      const path = join(root, relativeDir);
      if (!existsSync(path)) return [];
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    },
  };
}

/**
 * A catalog held in memory: relative path → file text. Keys may carry a
 * leading prefix (`…/fixtures/v1/data/designs/x.json`) — pass `prefix` to
 * strip it, which is what an `import.meta.glob` map needs.
 */
export function memoryCatalogSource(files: Readonly<Record<string, string>>, options: { prefix?: string; name?: string } = {}): CatalogSource {
  const byPath = new Map<string, string>();
  for (const [key, text] of Object.entries(files)) {
    const at = options.prefix === undefined ? 0 : key.indexOf(options.prefix);
    if (at === -1) continue;
    const relative = options.prefix === undefined ? key : key.slice(at + options.prefix.length);
    byPath.set(relative.replace(/^\/+/, ''), text);
  }
  return {
    name: options.name ?? 'an in-memory catalog',
    read: (relative) => byPath.get(relative),
    list(relativeDir) {
      const dir = relativeDir.replace(/\/+$/, '');
      const prefix = dir === '' ? '' : `${dir}/`;
      const names: string[] = [];
      for (const path of byPath.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest !== '' && !rest.includes('/')) names.push(rest);
      }
      return names.sort();
    },
  };
}
