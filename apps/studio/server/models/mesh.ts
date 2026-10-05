/**
 * Triangle meshes for the Library's 3D views — the
 * server half: read an STL, weld it, bound it, thin it when it is too heavy,
 * and lay a multi-part print plate out so the parts do not sit inside each
 * other. Pure: bytes in, typed arrays out, no IO, no randomness.
 *
 * The Library shows a render of a part's 3D model right on its screen, so the
 * part can be checked at a glance.
 */

/** One named, single-coloured triangle mesh — a housing half, a board, a part. */
export interface MeshPart {
  name: string;
  /** xyz per vertex */
  positions: Float32Array;
  /** three vertex indices per triangle */
  indices: Uint32Array;
  /** per-vertex normals when the source had meaningful ones (STEP); STL leaves them to flat shading */
  normals?: Float32Array;
  /** linear rgb 0..1, when the source coloured it */
  color?: [number, number, number];
  /** uv per vertex ( board face art); `color` is then a neutral tint, not the surface's paint */
  uv?: Float32Array;
  /** a baseColorTexture image (PNG) sampled by `uv`, when the part is textured rather than flat-coloured */
  image?: Uint8Array;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function triangleCount(parts: readonly MeshPart[]): number {
  return parts.reduce((sum, part) => sum + part.indices.length / 3, 0);
}

/* ------------------------------------------------------------------ *
 * STL
 * ------------------------------------------------------------------ */

/** Binary when the size matches its own triangle count; ASCII only when it reads as one. */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  return 84 + count * 50 === bytes.byteLength;
}

export function isAsciiStl(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 1024))).trimStart();
  return /^solid\b/i.test(head) && /\bfacet\b/i.test(head) && !isBinaryStl(bytes);
}

/** An STL (binary or ASCII) as one welded mesh. Throws a sentence on anything else. */
export function parseStl(bytes: Uint8Array, name: string): MeshPart {
  let raw: Float32Array;
  if (isBinaryStl(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    raw = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
      const base = 84 + t * 50 + 12; // skip the facet normal
      for (let k = 0; k < 9; k++) raw[t * 9 + k] = view.getFloat32(base + k * 4, true);
    }
  } else if (isAsciiStl(bytes)) {
    const text = new TextDecoder().decode(bytes);
    const values: number[] = [];
    const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
    for (let m = vertex.exec(text); m !== null; m = vertex.exec(text)) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (values.length % 9 !== 0 || values.some((v) => !Number.isFinite(v))) throw new Error('That STL has a facet that is not three numeric vertices.');
    raw = Float32Array.from(values);
  } else {
    throw new Error('That is not an STL file (neither binary nor ASCII STL).');
  }
  for (const v of raw) if (!Number.isFinite(v)) throw new Error('That STL has a vertex that is not a finite number.');
  return weld(raw, name);
}

/** Non-indexed triangles → indexed, identical positions shared; degenerate triangles dropped. */
export function weld(triangles: Float32Array, name: string): MeshPart {
  const map = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const index = (i: number): number => {
    const x = triangles[i]!;
    const y = triangles[i + 1]!;
    const z = triangles[i + 2]!;
    const key = `${x},${y},${z}`;
    let at = map.get(key);
    if (at === undefined) {
      at = positions.length / 3;
      positions.push(x, y, z);
      map.set(key, at);
    }
    return at;
  };
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    const a = index(t);
    const b = index(t + 3);
    const c = index(t + 6);
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return { name, positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/* ------------------------------------------------------------------ *
 * Bounds, simplification, layout
 * ------------------------------------------------------------------ */

export function boundsOf(parts: readonly MeshPart[]): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const p = part.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p[i + a]!;
        if (v < min[a]!) min[a] = v;
        if (v > max[a]!) max[a] = v;
      }
    }
  }
  return { min, max };
}

/**
 * Vertex clustering: snap every vertex to a grid cell, merge a cell's
 * vertices into their average, drop triangles that collapse. Deterministic
 * and cheap; the cell is grown until the part fits `maxTriangles`. Good
 * enough for a look at a part — the source file stays the authority.
 */
export function simplify(part: MeshPart, maxTriangles: number): MeshPart {
  const triangles = part.indices.length / 3;
  if (triangles <= maxTriangles) return part;
  const { min, max } = boundsOf([part]);
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  // bisect the cell size (on a log scale) for the most detail that fits
  let fine = diagonal / 20_000;
  let coarse = diagonal / 8;
  let best = cluster(part, min, coarse);
  for (let step = 0; step < 14; step++) {
    const cell = Math.sqrt(fine * coarse);
    const out = cluster(part, min, cell);
    if (out.indices.length / 3 <= maxTriangles) {
      best = out;
      coarse = cell;
    } else {
      fine = cell;
    }
  }
  return best;
}

function cluster(part: MeshPart, origin: readonly number[], cell: number): MeshPart {
  const p = part.positions;
  const cellOf = new Map<string, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  const remap = new Uint32Array(p.length / 3);
  for (let v = 0; v < p.length / 3; v++) {
    const key = `${Math.floor((p[v * 3]! - origin[0]!) / cell)},${Math.floor((p[v * 3 + 1]! - origin[1]!) / cell)},${Math.floor((p[v * 3 + 2]! - origin[2]!) / cell)}`;
    let at = cellOf.get(key);
    if (at === undefined) {
      at = counts.length;
      cellOf.set(key, at);
      sums.push(0, 0, 0);
      counts.push(0);
    }
    sums[at * 3]! += p[v * 3]!;
    sums[at * 3 + 1]! += p[v * 3 + 1]!;
    sums[at * 3 + 2]! += p[v * 3 + 2]!;
    counts[at]! += 1;
    remap[v] = at;
  }
  const positions = new Float32Array(counts.length * 3);
  for (let c = 0; c < counts.length; c++) {
    for (let a = 0; a < 3; a++) positions[c * 3 + a] = sums[c * 3 + a]! / counts[c]!;
  }
  const seen = new Set<string>();
  const indices: number[] = [];
  for (let t = 0; t < part.indices.length; t += 3) {
    const a = remap[part.indices[t]!]!;
    const b = remap[part.indices[t + 1]!]!;
    const c = remap[part.indices[t + 2]!]!;
    if (a === b || b === c || a === c) continue;
    const key = `${a},${b},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    indices.push(a, b, c);
  }
  // normals no longer match merged vertices; the viewer shades these flat
  const { normals: _dropped, ...rest } = part;
  return { ...rest, positions, indices: Uint32Array.from(indices) };
}

/** Share of the smaller box's volume that the two boxes have in common. */
function overlapRatio(a: Bounds, b: Bounds): number {
  let common = 1;
  let smaller = Infinity;
  const volume = (x: Bounds): number => [0, 1, 2].reduce((v, i) => v * Math.max(x.max[i]! - x.min[i]!, 1e-6), 1);
  for (let i = 0; i < 3; i++) {
    const lo = Math.max(a.min[i]!, b.min[i]!);
    const hi = Math.min(a.max[i]!, b.max[i]!);
    if (hi <= lo) return 0;
    common *= hi - lo;
  }
  smaller = Math.min(volume(a), volume(b));
  return common / smaller;
}

function translate(part: MeshPart, dx: number, dy: number, dz: number): MeshPart {
  const positions = new Float32Array(part.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + dx;
    positions[i + 1] = positions[i + 1]! + dy;
    positions[i + 2] = positions[i + 2]! + dz;
  }
  return { ...part, positions };
}

/**
 * Several files for one part (a housing's top and bottom): when they were
 * exported on top of each other (both at the origin, as a slicer wants
 * them), set them side by side along X with a gap; when they already sit
 * apart (a print plate, an assembly), keep the source placement.
 */
export function layOut(parts: readonly MeshPart[]): MeshPart[] {
  if (parts.length < 2) return [...parts];
  const boxes = parts.map((part) => boundsOf([part]));
  let overlapping = false;
  for (let i = 0; i < boxes.length && !overlapping; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlapRatio(boxes[i]!, boxes[j]!) > 0.25) {
        overlapping = true;
        break;
      }
    }
  }
  if (!overlapping) return [...parts];
  const out: MeshPart[] = [];
  let cursor = boxes[0]!.min[0];
  const gap = Math.max(...boxes.map((b) => b.max[0] - b.min[0])) * 0.15;
  parts.forEach((part, i) => {
    const box = boxes[i]!;
    out.push(translate(part, cursor - box.min[0], 0, 0));
    cursor += box.max[0] - box.min[0] + gap;
  });
  return out;
}
