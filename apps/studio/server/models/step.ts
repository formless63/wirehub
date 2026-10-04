/**
 * STEP → meshes, through OpenCascade compiled to WASM (`occt-import-js`,
 * LGPL-2.1, used unmodified as a library). Only ever run inside the
 * conversion child process (`convert-worker.ts`): a WASM heap grows and never
 * shrinks, so the studio process must not be the one that holds it.
 */

import { createRequire } from 'node:module';

import type { MeshPart } from './mesh.ts';

interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  attributes: { position: { array: number[] }; normal?: { array: number[] } };
  index: { array: number[] };
  brep_faces?: { first: number; last: number; color: [number, number, number] | null }[];
}

interface OcctResult {
  success: boolean;
  meshes: OcctMesh[];
}

interface Occt {
  ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
  ReadIgesFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
}

let occt: Promise<Occt> | undefined;

function loadOcct(): Promise<Occt> {
  const require = createRequire(import.meta.url);
  const factory = require('occt-import-js') as () => Promise<Occt>;
  return (occt ??= factory());
}

/**
 * `linearDeflection` as a share of the bounding box; coarser = fewer triangles.
 * `iges`: the file is IGES rather than STEP (a model KiCad embedded as .igs,
 *) — the same reader, the same meshes out.
 */
export async function readStep(bytes: Uint8Array, linearDeflection = 0.001, iges = false): Promise<MeshPart[]> {
  const lib = await loadOcct();
  const read = iges ? lib.ReadIgesFile.bind(lib) : lib.ReadStepFile.bind(lib);
  const result = read(bytes, {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection,
    angularDeflection: 0.5,
  });
  if (!result.success) throw new Error(`OpenCascade could not read that ${iges ? 'IGES' : 'STEP'} file.`);
  const parts: MeshPart[] = [];
  result.meshes.forEach((mesh, m) => {
    const name = mesh.name !== undefined && mesh.name !== '' ? mesh.name : `part-${m + 1}`;
    const positions = Float32Array.from(mesh.attributes.position.array);
    const normals = mesh.attributes.normal === undefined ? undefined : Float32Array.from(mesh.attributes.normal.array);
    const all = Uint32Array.from(mesh.index.array);
    // a face-coloured body (a board: green laminate, gold pads) splits by colour
    const faces = mesh.brep_faces ?? [];
    const colours = new Map<string, number[]>();
    const fallback = mesh.color;
    if (faces.length > 0 && faces.some((f) => f.color !== null)) {
      for (const face of faces) {
        const colour = face.color ?? fallback;
        const key = colour === undefined ? '' : colour.map((c) => c.toFixed(3)).join(',');
        const list = colours.get(key) ?? [];
        for (let t = face.first; t <= face.last; t++) list.push(all[t * 3]!, all[t * 3 + 1]!, all[t * 3 + 2]!);
        colours.set(key, list);
      }
    } else {
      colours.set(fallback === undefined ? '' : fallback.map((c) => c.toFixed(3)).join(','), Array.from(all));
    }
    let n = 0;
    for (const [key, indices] of [...colours.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const compact = compactPart(positions, normals, indices);
      parts.push({
        name: colours.size === 1 ? name : `${name}#${++n}`,
        ...compact,
        ...(key === '' ? {} : { color: key.split(',').map(Number) as [number, number, number] }),
      });
    }
  });
  return parts;
}

/** Only the vertices `indices` uses, renumbered. */
function compactPart(positions: Float32Array, normals: Float32Array | undefined, indices: number[]): Omit<MeshPart, 'name'> {
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const nrm: number[] = [];
  const out = new Uint32Array(indices.length);
  indices.forEach((v, i) => {
    let at = remap.get(v);
    if (at === undefined) {
      at = remap.size;
      remap.set(v, at);
      pos.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
      if (normals !== undefined) nrm.push(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!);
    }
    out[i] = at;
  });
  return { positions: Float32Array.from(pos), indices: out, ...(normals === undefined ? {} : { normals: Float32Array.from(nrm) }) };
}
