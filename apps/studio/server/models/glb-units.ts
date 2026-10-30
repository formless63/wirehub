/**
 * Units of an uploaded GLB. The studio's models are in millimetres
 * (the viewer's size readout, the device scene and enclosure heights read
 * them so); glTF itself is in metres, and a GLB from a tool that follows the
 * spec — KiCad's own 3D export, which writes through Open CASCADE — arrives a
 * thousand times too small. Such a file is wrapped, on registration, in one
 * root node scaling it to millimetres: its meshes and buffers stay byte for
 * byte as sent, only the JSON chunk changes, and the file says so in
 * `asset.extras.wirehubUnits`.
 *
 * Only a file that declares a metre-writing generator is scaled: a GLB of
 * unknown origin is kept as sent, as before (many tools export millimetres
 * against the spec, and a tiny part in millimetres looks like a large one in metres).
 */

import { readGlbJson } from './glb.ts';

/** Why a GLB is taken to be in metres, or `undefined` when it is kept as sent. */
export function metreSource(json: Record<string, unknown>): string | undefined {
  const asset = (json['asset'] ?? {}) as { generator?: unknown; extras?: { generator?: unknown; wirehubUnits?: unknown } };
  if (asset.extras?.wirehubUnits === 'mm') return undefined;
  const generator = typeof asset.generator === 'string' ? asset.generator : '';
  const tool = typeof asset.extras?.generator === 'string' ? asset.extras.generator : '';
  if (/^KiCad\b/i.test(tool)) return tool;
  if (/^KiCad\b/i.test(generator) || /Open CASCADE/i.test(generator)) return generator;
  return undefined;
}

/**
 * The GLB in millimetres: scaled when it declares metres (see `metreSource`),
 * else the same bytes. `scaledFrom` names the generator when it was scaled.
 */
export function glbInMillimetres(bytes: Uint8Array): { bytes: Uint8Array; scaledFrom?: string } {
  const json = readGlbJson(bytes);
  if (json === undefined) return { bytes };
  const source = metreSource(json);
  if (source === undefined) return { bytes };
  const nodes = ((json['nodes'] as unknown[] | undefined) ?? []).slice();
  const scenes = ((json['scenes'] as { nodes?: number[] }[] | undefined) ?? []).map((scene) => {
    const root = nodes.length;
    nodes.push({ name: 'millimetres', scale: [1000, 1000, 1000], children: scene.nodes ?? [] });
    return { ...scene, nodes: [root] };
  });
  const asset = (json['asset'] ?? {}) as Record<string, unknown>;
  const extras = (asset['extras'] ?? {}) as Record<string, unknown>;
  const next = { ...json, asset: { ...asset, extras: { ...extras, wirehubUnits: 'mm', wirehubScaledFrom: 'm' } }, nodes, scenes };
  return { bytes: repackJson(bytes, next), scaledFrom: source };
}

/** The same GLB with a new JSON chunk (padded with spaces to four bytes); the chunks after it are kept as they are. */
function repackJson(bytes: Uint8Array, json: Record<string, unknown>): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const oldLength = view.getUint32(12, true);
  const rest = bytes.subarray(20 + oldLength);
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(text.byteLength / 4) * 4;
  const out = new Uint8Array(12 + 8 + padded + rest.byteLength);
  const w = new DataView(out.buffer);
  w.setUint32(0, 0x46546c67, true);
  w.setUint32(4, 2, true);
  w.setUint32(8, out.byteLength, true);
  w.setUint32(12, padded, true);
  w.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.byteLength, 20 + padded);
  out.set(rest, 20 + padded);
  return out;
}
