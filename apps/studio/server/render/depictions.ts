/**
 * Board artwork for the headless renders on a backend that keeps it in a store
 * (cs-5k1.23): the database serves uploaded artwork to the browser only, so a
 * server render read the catalog's own tree and drew an uploaded board as a
 * plain block. `storeDepictions` reads the artwork the design's parts need
 * from the `DepictionStore` — layered over the catalog tree, as the browser
 * layers it — and a saved revision's frozen artwork wins over both for the
 * definitions it fixed (`versionDepictionSource`, as the cable page does).
 *
 * The renderers' `DepictionSource` is synchronous, so the files are read up
 * front, for the definitions the design uses (and the body a connector is
 * built on); manifests are read for every id the store lists.
 */

import { parseDepictionMeta } from '@wirehub/catalog';
import { catalogDepictions, layeredDepictions, type DepictionSource } from '@wirehub/layout';
import { versionArtwork, type CableDesign, type Db, type DesignVersionFile } from '@wirehub/model';

import { assembleDepictionSource, versionDepictionSource, type DepictionModules } from '../../src/depictions.assemble.ts';
import type { DepictionStore } from '../depictions.ts';
import { readVersionArtwork, type VersionStore } from '../versions.ts';

const RASTER: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** The ids whose artwork a design can draw: its parts, a connector's body and the body its drawing names. */
export function depictionIdsOf(design: CableDesign, db: Db): string[] {
  const { connectors, segments, components, pcbas, mechanical } = design.instances;
  const defs = [...pcbas, ...connectors, ...components, ...segments, ...(mechanical ?? [])].map((instance) => instance.def);
  const ids = new Set(defs);
  for (const def of defs) {
    const connector = db.connectors.find((c) => c.id === def);
    if (connector === undefined) continue;
    if (connector.body !== undefined) ids.add(connector.body);
    const drawing = db.bodies?.find((b) => b.id === connector.body)?.drawing;
    if (drawing !== undefined) ids.add(drawing);
  }
  return [...ids];
}

/** The store's artwork for `wanted`, as a source layered over the catalog tree. */
export async function storeDepictions(store: DepictionStore, wanted: readonly string[]): Promise<DepictionSource> {
  const modules: Required<DepictionModules> = { meta: {}, vector: {}, raster: {} };
  const listed = new Set(await store.listDefIds());
  for (const defId of listed) {
    const raw = await store.readMeta(defId);
    if (raw !== undefined) modules.meta[`${defId}/meta.json`] = raw;
  }
  for (const defId of new Set(wanted)) {
    const raw = modules.meta[`${defId}/meta.json`];
    if (raw === undefined) continue;
    const parsed = parseDepictionMeta(raw, `depictions/${defId}`).meta;
    for (const asset of Object.values(parsed?.views ?? {})) {
      if (asset.file.includes('/') || asset.file.includes('\\') || asset.file.includes('..')) continue;
      const bytes = await store.readAsset(defId, asset.file);
      if (bytes === undefined) continue;
      const path = `${defId}/${asset.file}`;
      const ext = asset.file.slice(asset.file.lastIndexOf('.') + 1).toLowerCase();
      if (asset.kind === 'vector') modules.vector[path] = new TextDecoder().decode(bytes);
      else if (RASTER[ext] !== undefined) modules.raster[path] = `data:${RASTER[ext]};base64,${Buffer.from(bytes).toString('base64')}`;
    }
  }
  return layeredDepictions(assembleDepictionSource(modules), safeCatalog());
}

export function safeCatalog(): DepictionSource {
  try {
    return catalogDepictions();
  } catch {
    return { meta: () => undefined, artwork: () => undefined };
  }
}

/** A saved revision's artwork over the live source: the definitions it fixed draw from its own copy. */
export async function revisionDepictions(versions: VersionStore, file: DesignVersionFile, live: DepictionSource): Promise<DepictionSource> {
  if (Object.keys(versionArtwork(file)).length === 0) return live;
  const { missing, ...own } = await readVersionArtwork(versions, file);
  const gone = new Set(missing);
  const d = file.definitions;
  const covered = new Set([...d.connectors, ...d.pcbas, ...d.wires, ...d.components, ...d.mechanicals].map((def) => def.id).filter((id) => !gone.has(id)));
  return versionDepictionSource(own, covered, live);
}
