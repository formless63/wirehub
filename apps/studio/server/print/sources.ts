/**
 * Print parts beyond the record's own uploads: the source files an imported 3D model link cites
 * (`models/links.ts` `files`), read where the model cache reads them (`WIREHUB_MODEL_SOURCES`, then
 * the catalog's own sources: `jobs/model-cache.ts` `sourcesFromEnv`). An STL or 3MF among them is
 * sliced as is, pinned by its sha256, so a shell imported as a GLB still prints from its exact mesh.
 * Before a slice the bytes go into the asset store (content-addressed), where the job reads every part.
 *
 * Also each STL part's size (its bounding box), so the panel can tell what fits a printer's bed.
 */

import { createHash } from 'node:crypto';

import type { WorkbenchDeps } from '../api.ts';
import { sourcesFromEnv } from '../jobs/model-cache.ts';
import { isBinaryStl } from '../models/mesh.ts';
import type { ModelLink } from '../models/links.ts';

export type PartFormat = 'stl' | '3mf';

/** A source file of a model link that can be sliced. */
export interface SourcePart {
  /** the link's path for it (`housings/…`) */
  source: string;
  name: string;
  sha256: string;
  bytes: number;
  format: PartFormat;
  size?: [number, number, number];
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const formatOf = (path: string): PartFormat | undefined => (/\.stl$/i.test(path) ? 'stl' : /\.3mf$/i.test(path) ? '3mf' : undefined);
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The STL's bounding box size in mm, or undefined when it does not read as an STL. */
export function stlSize(bytes: Uint8Array): [number, number, number] | undefined {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const take = (x: number, y: number, z: number): void => {
    const v = [x, y, z];
    for (let a = 0; a < 3; a++) {
      if (v[a]! < min[a]!) min[a] = v[a]!;
      if (v[a]! > max[a]!) max[a] = v[a]!;
    }
  };
  if (isBinaryStl(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    for (let t = 0; t < count; t++) {
      const base = 84 + t * 50 + 12;
      for (let k = 0; k < 3; k++) take(view.getFloat32(base + k * 12, true), view.getFloat32(base + k * 12 + 4, true), view.getFloat32(base + k * 12 + 8, true));
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
    for (let m = vertex.exec(text); m !== null; m = vertex.exec(text)) take(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return undefined;
  return [0, 1, 2].map((a) => Math.round((max[a]! - min[a]!) * 10) / 10) as [number, number, number];
}

// per process: a part's size by its sha256 (the bytes never change under a hash)
const sizes = new Map<string, [number, number, number] | null>();

/** The STL's size, read once per hash. */
export function cachedSize(sha: string, bytes: () => Promise<Uint8Array | undefined>): Promise<[number, number, number] | undefined> {
  const known = sizes.get(sha);
  if (known !== undefined) return Promise.resolve(known ?? undefined);
  return bytes().then((b) => {
    const size = b === undefined ? undefined : stlSize(b);
    if (sizes.size > 2000) sizes.clear();
    sizes.set(sha, size ?? null);
    return size;
  });
}

// per process: a source path read and matched its sha256 (`path@sha` → its byte count)
const readable = new Map<string, number>();

/**
 * The link's STL/3MF source files this hub can read and that still match the sha256 the link pins.
 * One already in the asset store (sliced before) counts without the mount.
 */
export async function sourceParts(deps: WorkbenchDeps, link: ModelLink, env: Record<string, string | undefined> = process.env): Promise<SourcePart[]> {
  const out: SourcePart[] = [];
  const files = (link.files ?? []).filter((f) => formatOf(f.path) !== undefined);
  if (files.length === 0) return out;
  const read = sourcesFromEnv(deps, env);
  for (const file of files) {
    const format = formatOf(file.path)!;
    const key = `${file.path}@${file.sha256}`;
    let bytes = readable.get(key);
    let got: Uint8Array | undefined;
    if (bytes === undefined) {
      const stored = await deps.assets?.get(file.sha256);
      got = stored === undefined ? await read(file.path) : new Uint8Array(stored.bytes);
      if (got === undefined || sha256(got) !== file.sha256) continue;
      bytes = got.byteLength;
      readable.set(key, bytes);
    }
    const size = format === 'stl' ? await cachedSize(file.sha256, async () => got ?? (await read(file.path))) : undefined;
    out.push({ source: file.path, name: baseName(file.path), sha256: file.sha256, bytes, format, ...(size === undefined ? {} : { size }) });
  }
  return out;
}

/** The source file's bytes, verified against its sha256 — for putting into the asset store before a slice. */
export async function readSourcePart(deps: WorkbenchDeps, path: string, sha: string, env: Record<string, string | undefined> = process.env): Promise<Uint8Array | undefined> {
  const got = await sourcesFromEnv(deps, env)(path);
  return got !== undefined && sha256(got) === sha ? got : undefined;
}
