/**
 * Component heights from a board's own 3D export: the `board-3d` op of the `kicad` tool pack
 * writes `board.glb` with one node per footprint, named by its reference (`J1`, `U1`), and the
 * board body as an unnamed mesh. Each footprint's height is how far its models reach above the
 * board's top face (or below its underside), read from the glTF accessors' bounds — KiCad's own 3D
 * models, so a fact "from KiCad source", not an estimate.
 *
 * glTF is y-up, metres. Pure: bytes in, numbers out; a file it cannot read gives nothing.
 */

type Mat = number[]; // column-major 4×4

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives?: { attributes?: { POSITION?: number } }[] }[];
  accessors?: { min?: number[]; max?: number[] }[];
}

export interface GlbHeights {
  /**
   * reference → mm above the top face (top-side parts) or below the underside (bottom-side parts);
   * `through`: how far a top-side part reaches below the underside (through-hole leads), mm
   */
  heights: Record<string, { mm: number; side: 'top' | 'bottom'; through?: number }>;
  /** the tallest part above / below, mm */
  above: number;
  below: number;
  /** the board body's thickness as the model has it, mm */
  thicknessMm?: number;
}

const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat, b: Mat): Mat {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

function local(node: GltfNode): Mat {
  if (node.matrix?.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const r = [
    1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! + z! * w!), 2 * (x! * z! - y! * w!),
    2 * (x! * y! - z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! + x! * w!),
    2 * (x! * z! + y! * w!), 2 * (y! * z! - x! * w!), 1 - 2 * (x! * x! + y! * y!),
  ];
  return [r[0]! * sx!, r[1]! * sx!, r[2]! * sx!, 0, r[3]! * sy!, r[4]! * sy!, r[5]! * sy!, 0, r[6]! * sz!, r[7]! * sz!, r[8]! * sz!, 0, tx!, ty!, tz!, 1];
}

/** The vertical (y) extent of a node's meshes, its subtree included, in the world frame. */
function yRange(gltf: Gltf, index: number, parent: Mat, seen: Set<number>): [number, number] | undefined {
  if (seen.has(index)) return undefined;
  seen.add(index);
  const node = gltf.nodes?.[index];
  if (node === undefined) return undefined;
  const m = mul(parent, local(node));
  let lo = Infinity;
  let hi = -Infinity;
  for (const prim of node.mesh === undefined ? [] : (gltf.meshes?.[node.mesh]?.primitives ?? [])) {
    const acc = prim.attributes?.POSITION === undefined ? undefined : gltf.accessors?.[prim.attributes.POSITION];
    if (acc?.min === undefined || acc.max === undefined) continue;
    for (const cx of [acc.min[0]!, acc.max[0]!]) for (const cy of [acc.min[1]!, acc.max[1]!]) for (const cz of [acc.min[2]!, acc.max[2]!]) {
      const y = m[1]! * cx + m[5]! * cy + m[9]! * cz + m[13]!;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  for (const c of node.children ?? []) {
    const r = yRange(gltf, c, m, seen);
    if (r !== undefined) {
      lo = Math.min(lo, r[0]);
      hi = Math.max(hi, r[1]);
    }
  }
  return lo === Infinity ? undefined : [lo, hi];
}

function readJson(bytes: Uint8Array): Gltf | undefined {
  if (bytes.byteLength < 20) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) return undefined; // 'glTF'
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.byteLength) return undefined; // 'JSON'
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as Gltf;
  } catch {
    return undefined;
  }
}

const REF = /^[A-Za-z]+[0-9]+[A-Za-z0-9_]*$/;
const round = (v: number): number => Math.round(v * 100) / 100;

export function glbHeights(bytes: Uint8Array): GlbHeights | undefined {
  const gltf = readJson(bytes);
  if (gltf === undefined) return undefined;
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? [];
  // the scene root may be a group: look one level in for the footprints and the board body
  const top = roots.flatMap((r) => (gltf.nodes?.[r]?.name === undefined && gltf.nodes?.[r]?.mesh === undefined ? (gltf.nodes?.[r]?.children ?? []).map((c) => ({ c, parent: local(gltf.nodes![r]!) })) : [{ c: r, parent: IDENTITY }]));
  let body: [number, number] | undefined;
  const parts: { ref: string; range: [number, number] }[] = [];
  for (const { c, parent } of top) {
    const node = gltf.nodes?.[c];
    const range = yRange(gltf, c, parent, new Set());
    if (node === undefined || range === undefined) continue;
    if (node.name !== undefined && REF.test(node.name)) parts.push({ ref: node.name, range });
    // the board body: a mesh not named by a reference (`=>[0:1:1:10]`); the thinnest such wins
    else if (node.mesh !== undefined && (body === undefined || range[1] - range[0] < body[1] - body[0])) body = range;
  }
  if (body === undefined || parts.length === 0) return undefined;
  const [bottom, topFace] = body;
  const heights: GlbHeights['heights'] = {};
  let above = 0;
  let below = 0;
  for (const p of parts) {
    const up = (p.range[1] - topFace) * 1000;
    const down = (bottom - p.range[0]) * 1000;
    if (up >= down) {
      heights[p.ref] = { mm: round(Math.max(up, 0)), side: 'top', ...(down > 0.05 ? { through: round(down) } : {}) };
      above = Math.max(above, up);
      below = Math.max(below, down);
    } else {
      heights[p.ref] = { mm: round(Math.max(down, 0)), side: 'bottom' };
      below = Math.max(below, down);
    }
  }
  return { heights, above: round(above), below: round(below), thicknessMm: round((topFace - bottom) * 1000) };
}
