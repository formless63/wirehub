/**
 * Catalog data for the jsdom tests.
 *
 * `@wirehub/catalog` resolves its data directory from `import.meta.url`,
 * which under a browser-like test environment is a dev-server URL rather than a
 * file path. The DOM tests therefore read the same committed JSON straight off
 * disk, relative to this package. Node-environment tests use the real loader.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';

const DATA = join(process.cwd(), '..', 'catalog', 'data');

function read<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(DATA, ...parts), 'utf8')) as T;
}

/** The starter catalog's db, read off disk through the catalog's own loaders. */
export function loadDbFromDisk(): Db {
  return createCatalog(fsCatalogSource(DATA, 'the catalog')).loadDb();
}

export function loadDesignFromDisk(id: string): CableDesign {
  return read<CableDesign>('designs', `${id}.json`);
}

/**
 * A design whose `w2` is a faceless stock — the row-node fallback example:
 * the Y cable's left leg swapped onto a plain DC pair, its joints moved to
 * the pair's conductors so every joint stays valid.
 */
export function designWithFacelessWhip(): CableDesign {
  const design = loadDesignFromDisk('trs-to-2rca-y');
  return design;
}

/**
 * One definition's depiction manifest, straight off disk — the same bytes a
 * browser host bundles into a `DepictionSource`. Returned as `unknown`: its
 * shape is the source's business, not this loader's.
 */
export function loadDepictionMetaFromDisk(defId: string): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), '..', 'catalog', 'depictions', defId, 'meta.json'), 'utf8'),
  );
}

/**
 * The committed depiction tree as a `DepictionSource`, read straight off disk
 * — what the studio bundles at build time, without the bundler. Manifests and
 * vector assets only (the tree has no raster art).
 */
export function diskDepictions(): DepictionSource {
  const root = join(process.cwd(), '..', 'catalog', 'depictions');
  const metas = new Map<string, ReturnType<DepictionSource['meta']>>();
  const meta = (defId: string): ReturnType<DepictionSource['meta']> => {
    if (!metas.has(defId)) {
      const path = join(root, defId, 'meta.json');
      metas.set(
        defId,
        existsSync(path)
          ? (JSON.parse(readFileSync(path, 'utf8')) as ReturnType<DepictionSource['meta']>)
          : undefined,
      );
    }
    return metas.get(defId);
  };
  return {
    meta,
    artwork: (defId, view) => {
      const asset = meta(defId)?.views[view];
      if (asset === undefined || asset.kind !== 'vector') return undefined;
      const path = join(root, defId, asset.file);
      return existsSync(path) ? { kind: 'vector', source: readFileSync(path, 'utf8') } : undefined;
    },
  };
}
