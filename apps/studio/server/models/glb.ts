/**
 * Meshes → a binary glTF (`.glb`) — the one format the Library stores for a
 * converted model. Hand-written rather than
 * three.js's exporter so the server stays DOM-free and the output is byte
 * deterministic (same meshes in, same sha256 out — the asset store dedups on
 * exactly that).
 *
 * Positions are quantized to int16 (`KHR_mesh_quantization`, which three's
 * GLTFLoader reads natively) with each part's node carrying the scale and
 * offset back to millimetres: well under a micron of error on a part this
 * size, and about a third of the bytes of float32. Normals, when a part has
 * them, are int8; a part without them (every STL) is shaded flat by the
 * viewer.
 */

import { boundsOf, type MeshPart } from './mesh.ts';

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3';
  normalized?: boolean;
  min?: number[];
  max?: number[];
}

const BYTE = 5120;
const SHORT = 5122;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const FLOAT = 5126;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/** `extras.sourceKind` etc. — carried into the file so it explains itself. */
export interface GlbExtras {
  [key: string]: string | number | boolean;
}

export function writeGlb(parts: readonly MeshPart[], extras: GlbExtras = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: { buffer: 0; byteOffset: number; byteLength: number; byteStride?: number; target?: number }[] = [];
  const accessors: Accessor[] = [];
  const meshes: unknown[] = [];
  const nodes: unknown[] = [];
  const materials: unknown[] = [];
  const images: unknown[] = [];
  const textures: unknown[] = [];
  // a part's own image, by reference — top and bottom are always distinct arrays, so identity is enough
  const textureOf = new Map<Uint8Array, number>();

  const push = (bytes: Uint8Array, target?: number, byteStride?: number): number => {
    const padded = new Uint8Array(pad4(bytes.byteLength));
    padded.set(bytes);
    chunks.push(padded);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(byteStride === undefined ? {} : { byteStride }), ...(target === undefined ? {} : { target }) });
    offset += padded.byteLength;
    return bufferViews.length - 1;
  };

  /** The texture index for a part's PNG, embedding the image once per distinct array. */
  const textureFor = (image: Uint8Array): number => {
    const known = textureOf.get(image);
    if (known !== undefined) return known;
    const imageView = push(image);
    images.push({ bufferView: imageView, mimeType: 'image/png' });
    textures.push({ source: images.length - 1, sampler: 0 });
    const at = textures.length - 1;
    textureOf.set(image, at);
    return at;
  };

  for (const part of parts) {
    const vertexCount = part.positions.length / 3;
    if (vertexCount === 0 || part.indices.length === 0) continue;
    const { min, max } = boundsOf([part]);
    const center = [0, 1, 2].map((a) => (min[a]! + max[a]!) / 2);
    const half = Math.max(...[0, 1, 2].map((a) => (max[a]! - min[a]!) / 2), 1e-9);

    // positions: int16 xyz + 2 bytes padding (stride 8)
    const pos = new Int16Array(vertexCount * 4);
    const qmin = [32767, 32767, 32767];
    const qmax = [-32767, -32767, -32767];
    for (let v = 0; v < vertexCount; v++) {
      for (let a = 0; a < 3; a++) {
        const q = Math.max(-32767, Math.min(32767, Math.round(((part.positions[v * 3 + a]! - center[a]!) / half) * 32767)));
        pos[v * 4 + a] = q;
        if (q < qmin[a]!) qmin[a] = q;
        if (q > qmax[a]!) qmax[a] = q;
      }
    }
    const posView = push(new Uint8Array(pos.buffer), ARRAY_BUFFER, 8);
    accessors.push({
      bufferView: posView,
      componentType: SHORT,
      normalized: true,
      count: vertexCount,
      type: 'VEC3',
      // glTF wants the accessor's raw component values here, not normalized ones
      min: qmin,
      max: qmax,
    });
    const attributes: Record<string, number> = { POSITION: accessors.length - 1 };

    if (part.normals !== undefined && part.normals.length === part.positions.length) {
      const nrm = new Int8Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) {
        const x = part.normals[v * 3]!;
        const y = part.normals[v * 3 + 1]!;
        const z = part.normals[v * 3 + 2]!;
        const len = Math.hypot(x, y, z) || 1;
        nrm[v * 4] = Math.round((x / len) * 127);
        nrm[v * 4 + 1] = Math.round((y / len) * 127);
        nrm[v * 4 + 2] = Math.round((z / len) * 127);
      }
      const nrmView = push(new Uint8Array(nrm.buffer), ARRAY_BUFFER, 4);
      accessors.push({ bufferView: nrmView, componentType: BYTE, normalized: true, count: vertexCount, type: 'VEC3' });
      attributes['NORMAL'] = accessors.length - 1;
    }

    if (part.uv !== undefined && part.uv.length === vertexCount * 2) {
      const uvView = push(new Uint8Array(part.uv.buffer, part.uv.byteOffset, part.uv.byteLength), ARRAY_BUFFER, 8);
      accessors.push({ bufferView: uvView, componentType: FLOAT, count: vertexCount, type: 'VEC2' });
      attributes['TEXCOORD_0'] = accessors.length - 1;
    }

    const small = vertexCount <= 65535;
    const idx = small ? Uint16Array.from(part.indices) : part.indices;
    const idxView = push(new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength), ELEMENT_ARRAY_BUFFER);
    accessors.push({ bufferView: idxView, componentType: small ? UNSIGNED_SHORT : UNSIGNED_INT, count: part.indices.length, type: 'SCALAR' });
    const primitive: Record<string, unknown> = { attributes, indices: accessors.length - 1, mode: 4 };

    if (part.image !== undefined && attributes['TEXCOORD_0'] !== undefined) {
      materials.push({
        name: 'board-art',
        pbrMetallicRoughness: { baseColorTexture: { index: textureFor(part.image) }, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.85 },
      });
      primitive['material'] = materials.length - 1;
    } else if (part.color !== undefined) {
      materials.push({
        name: 'source-colour',
        pbrMetallicRoughness: { baseColorFactor: [...part.color.map((c) => Math.round(c * 1000) / 1000), 1], metallicFactor: 0, roughnessFactor: 0.7 },
      });
      primitive['material'] = materials.length - 1;
    }
    meshes.push({ name: part.name, primitives: [primitive] });
    nodes.push({ name: part.name, mesh: meshes.length - 1, translation: center, scale: [half, half, half] });
  }

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Cable Studio model import', ...(Object.keys(extras).length === 0 ? {} : { extras }) },
    extensionsUsed: ['KHR_mesh_quantization'],
    extensionsRequired: ['KHR_mesh_quantization'],
    scene: 0,
    // CAD (STL, STEP) is Z-up, glTF is Y-up: one root turns the lot -90° about X
    scenes: [{ nodes: [nodes.length] }],
    nodes: [...nodes, { name: 'z-up', rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: nodes.map((_, i) => i) }],
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
    ...(materials.length === 0 ? {} : { materials }),
    // CLAMP_TO_EDGE both ways: a board face's art stops at its own edge, never tiling into
    // the next part. LINEAR both filters, no mipmap: a raster's own size is not a power of
    // two (mm × 20 px/mm), and a mipmapped minFilter on an NPOT texture is an incomplete
    // texture in WebGL — it would sample as black/undefined rather than refuse to build.
    ...(textures.length === 0 ? {} : { images, textures, samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }] }),
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array(pad4(jsonBytes.byteLength)).fill(0x20);
  jsonPadded.set(jsonBytes);
  const total = 12 + 8 + jsonPadded.byteLength + 8 + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonPadded, 20);
  let at = 20 + jsonPadded.byteLength;
  view.setUint32(at, offset, true);
  view.setUint32(at + 4, 0x004e4942, true); // 'BIN\0'
  at += 8;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The glTF JSON chunk of a `.glb`, or `undefined` when it is not one. */
export function readGlbJson(bytes: Uint8Array): Record<string, unknown> | undefined {
  if (bytes.byteLength < 20) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) return undefined;
  if (view.getUint32(8, true) !== bytes.byteLength) return undefined;
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.byteLength) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
