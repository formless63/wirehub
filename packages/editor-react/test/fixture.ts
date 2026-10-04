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
 * A design whose `w2` is a plain two-core stock — the row-node fallback
 * example: the DC Y splitter, whose legs are a red/black DC pair.
 */
export function designWithFacelessWhip(): CableDesign {
  const design = loadDesignFromDisk('dc-y-splitter');
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

/**
 * A design over the starter multicore (three coax and four cores under a
 * foil with a drain): DE-9 plugs at both ends, the coax centres and cores on
 * their pins, the foil and drain twisted into a pigtail on each shell.
 * Synthetic — the starter catalog has no cable built on that stock.
 */
export function multicoreDesign(): CableDesign {
  const cores = ['core-red.center', 'core-green.center', 'core-blue.center', 'yellow', 'white', 'brown', 'orange'];
  const joints: CableDesign['joints'] = [];
  for (const [end, plug] of [['a', 'j1'], ['b', 'j2']] as const) {
    cores.forEach((path, index) => joints.push({ a: { instance: 'w1', terminal: path, end }, b: { instance: plug, terminal: String(index + 1) } }));
    joints.push({ a: { instance: 'w1', terminal: 'pigtail:gnd', end }, b: { instance: plug, terminal: 'shell' } });
  }
  return {
    schemaVersion: 4,
    id: 'multicore-test-lead',
    label: 'DE-9 → DE-9, multicore test lead',
    instances: {
      connectors: [
        { id: 'j1', def: 'de9-female' },
        { id: 'j2', def: 'de9-female' },
      ],
      segments: [
        {
          id: 'w1',
          def: 'multicore-3coax-4core',
          lengthMm: 1830,
          pigtails: [
            { id: 'gnd', end: 'a', members: ['foil', 'drain'] },
            { id: 'gnd', end: 'b', members: ['foil', 'drain'] },
          ],
        },
      ],
      components: [],
      pcbas: [],
    },
    joints,
    src: 'synthetic example: test fixture',
  };
}
