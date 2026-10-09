/**
 * Parametric connector models: a `ParametricSpec` (`@wirehub/model`, a shape
 * and its dimensions in millimetres) to a binary glTF the Library's 3D view
 * already knows how to show.
 *
 * Deterministic: the same spec gives the same bytes (coordinates are rounded
 * to 0.1 µm before they are stored, so no engine's last-digit differences
 * leak in). No three.js, no DOM, no randomness: the geometry is plain
 * triangles with flat normals, grouped by material. Axes: x across, y up, z
 * the mating direction (the mating face is at +z).
 *
 * These are honest envelopes, not CAD replicas: the outside dimensions, the
 * contacts at their pitch, the latch or the screws where they show. A real
 * manufacturer model, when a pack carries one, replaces the link.
 */

import { parametricProblems, type ParametricSpec } from '@wirehub/model';

type V = [number, number, number];
type Poly = [number, number][];

interface Material {
  color: [number, number, number];
  metallic: number;
  roughness: number;
}

/** Colours are written as sRGB (what a person reads off a swatch); glTF wants them linear. */
const MATERIALS = {
  steel: { color: [0.72, 0.74, 0.77], metallic: 0.9, roughness: 0.38 },
  gold: { color: [0.85, 0.68, 0.2], metallic: 1, roughness: 0.3 },
  black: { color: [0.06, 0.06, 0.07], metallic: 0, roughness: 0.6 },
  rubber: { color: [0.1, 0.1, 0.11], metallic: 0, roughness: 0.85 },
  clear: { color: [0.6, 0.68, 0.78], metallic: 0, roughness: 0.25 },
  natural: { color: [0.74, 0.66, 0.46], metallic: 0, roughness: 0.55 },
  green: { color: [0.1, 0.46, 0.26], metallic: 0, roughness: 0.55 },
} satisfies Record<string, Material>;
type MaterialName = keyof typeof MATERIALS;

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l === 0 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l];
};

/** Triangles by material, each with a flat normal pointing the way the builder meant. */
class Mesh {
  readonly parts = new Map<MaterialName, { pos: number[]; nor: number[] }>();

  private part(m: MaterialName): { pos: number[]; nor: number[] } {
    let p = this.parts.get(m);
    if (p === undefined) {
      p = { pos: [], nor: [] };
      this.parts.set(m, p);
    }
    return p;
  }

  /** A triangle, wound so its normal points away from `ref` (or towards it when `inward`). */
  tri(m: MaterialName, a: V, b: V, c: V, ref: V, inward = false): void {
    let n = cross(sub(b, a), sub(c, a));
    const centre: V = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const side = dot(n, sub(centre, ref)) * (inward ? -1 : 1);
    if (side < 0) {
      [b, c] = [c, b];
      n = cross(sub(b, a), sub(c, a));
    }
    const unit = norm(n);
    const p = this.part(m);
    for (const v of [a, b, c]) {
      p.pos.push(v[0], v[1], v[2]);
      p.nor.push(unit[0], unit[1], unit[2]);
    }
  }

  quad(m: MaterialName, a: V, b: V, c: V, d: V, ref: V, inward = false): void {
    this.tri(m, a, b, c, ref, inward);
    this.tri(m, a, c, d, ref, inward);
  }

  box(m: MaterialName, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
    const x = sx / 2;
    const y = sy / 2;
    const z = sz / 2;
    const p = (i: number, j: number, k: number): V => [cx + (i ? x : -x), cy + (j ? y : -y), cz + (k ? z : -z)];
    const ref: V = [cx, cy, cz];
    this.quad(m, p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0), ref);
    this.quad(m, p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1), ref);
    this.quad(m, p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0), ref);
    this.quad(m, p(1, 0, 0), p(1, 0, 1), p(1, 1, 1), p(1, 1, 0), ref);
    this.quad(m, p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1), ref);
    this.quad(m, p(0, 1, 0), p(1, 1, 0), p(1, 1, 1), p(0, 1, 1), ref);
  }

  /** A (possibly tapered) cylinder between two points; `capped` closes both ends. */
  cylinder(m: MaterialName, from: V, to: V, r0: number, r1: number = r0, segments = 24, capped = true): void {
    const axis = norm(sub(to, from));
    const helper: V = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(axis, helper));
    const w = cross(axis, u);
    const ring = (centre: V, r: number, i: number): V => {
      const t = (i / segments) * Math.PI * 2;
      const c = Math.cos(t) * r;
      const s = Math.sin(t) * r;
      return [centre[0] + u[0] * c + w[0] * s, centre[1] + u[1] * c + w[1] * s, centre[2] + u[2] * c + w[2] * s];
    };
    const mid: V = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
    for (let i = 0; i < segments; i++) {
      this.quad(m, ring(from, r0, i), ring(from, r0, i + 1), ring(to, r1, i + 1), ring(to, r1, i), mid);
      if (capped) {
        this.tri(m, from, ring(from, r0, i), ring(from, r0, i + 1), mid);
        this.tri(m, to, ring(to, r1, i), ring(to, r1, i + 1), mid);
      }
    }
  }

  /** A convex outline extruded along z. */
  prism(m: MaterialName, outline: Poly, z0: number, z1: number): void {
    const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length;
    const cy = outline.reduce((s, p) => s + p[1], 0) / outline.length;
    const ref: V = [cx, cy, (z0 + z1) / 2];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      this.quad(m, [a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1], ref);
      this.tri(m, [cx, cy, z0], [a[0], a[1], z0], [b[0], b[1], z0], ref);
      this.tri(m, [cx, cy, z1], [a[0], a[1], z1], [b[0], b[1], z1], ref);
    }
  }

  /** A wall: `outer` and `inner` are the same outline (same vertex count) at two sizes. */
  ring(m: MaterialName, outer: Poly, inner: Poly, z0: number, z1: number): void {
    const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length;
    const cy = outer.reduce((s, p) => s + p[1], 0) / outer.length;
    const ref: V = [cx, cy, (z0 + z1) / 2];
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      const [oa, ob, ia, ib] = [outer[i]!, outer[j]!, inner[i]!, inner[j]!];
      this.quad(m, [oa[0], oa[1], z0], [ob[0], ob[1], z0], [ob[0], ob[1], z1], [oa[0], oa[1], z1], ref);
      this.quad(m, [ia[0], ia[1], z0], [ib[0], ib[1], z0], [ib[0], ib[1], z1], [ia[0], ia[1], z1], ref, true);
      for (const z of [z0, z1]) this.quad(m, [oa[0], oa[1], z], [ob[0], ob[1], z], [ib[0], ib[1], z], [ia[0], ia[1], z], ref);
    }
  }
}

/** A regular polygon standing in for a circle. */
function circle(r: number, segments = 28): Poly {
  return Array.from({ length: segments }, (_, i) => [Math.cos((i / segments) * Math.PI * 2) * r, Math.sin((i / segments) * Math.PI * 2) * r] as [number, number]);
}

/** The D outline of a D-sub shell: wide at the top, 10° sides, the narrow corners cut. */
function dOutline(w: number, h: number): Poly {
  const top = w / 2;
  const bottom = Math.max(top - h * Math.tan((10 * Math.PI) / 180), 0.2);
  const c = Math.min(1.3, h / 4);
  return [
    [-top, h / 2],
    [-bottom, -h / 2 + c],
    [-bottom + c * 0.8, -h / 2],
    [bottom - c * 0.8, -h / 2],
    [bottom, -h / 2 + c],
    [top, h / 2],
  ];
}

/** Contact positions of a D-sub: two rows, the upper one longer. */
function dSubContacts(pins: number, pitch: number, rowPitch: number): [number, number][] {
  const upper = Math.ceil(pins / 2);
  const lower = pins - upper;
  const row = (count: number, y: number): [number, number][] => Array.from({ length: count }, (_, k) => [(k - (count - 1) / 2) * pitch, y] as [number, number]);
  return [...row(upper, rowPitch / 2), ...row(lower, -rowPitch / 2)];
}

type Params = Record<string, number>;

function dSub(mesh: Mesh, spec: ParametricSpec, p: Params): void {
  const male = spec.gender === 'male';
  const fw = p['flangeWidthMm']!;
  const fh = p['flangeHeightMm']!;
  const depth = p['shellDepthMm']!;
  const hood = p['hoodDepthMm']!;
  const sw = p['shellWidthMm']!;
  const sh = p['shellHeightMm']!;
  const t = 0.45;
  mesh.box('steel', 0, 0, 0.5, fw, fh, 1);
  mesh.box('black', 0, 0, -hood / 2, fw - 1.2, fh - 0.8, hood);
  // the jackscrew posts
  for (const sx of [-1, 1]) mesh.cylinder('steel', [sx * p['mountPitchMm']! / 2, 0, 1], [sx * p['mountPitchMm']! / 2, 0, 1 + depth * (male ? 0.8 : 0.45)], 2.1, 2.1, 6);
  mesh.ring('steel', dOutline(sw, sh), dOutline(sw - 2 * t, sh - 2 * t), 1, 1 + depth);
  const inner = dOutline(sw - 2 * t - 0.2, sh - 2 * t - 0.2);
  const faceZ = 1 + depth - (male ? 1.2 : 1.6);
  mesh.prism('black', inner, 1, faceZ);
  for (const [x, y] of dSubContacts(spec.pins, p['pinPitchMm']!, p['rowPitchMm']!)) {
    if (male) mesh.cylinder('gold', [x, y, faceZ], [x, y, 1 + depth - 0.4], 0.5, 0.5, 10);
    else {
      mesh.cylinder('gold', [x, y, faceZ], [x, y, faceZ + 0.15], 0.85, 0.85, 10);
      mesh.cylinder('black', [x, y, faceZ + 0.15], [x, y, faceZ + 0.25], 0.5, 0.5, 10);
    }
  }
}

function xlr(mesh: Mesh, spec: ParametricSpec, p: Params): void {
  const male = spec.gender === 'male';
  const r = p['shellDiameterMm']! / 2;
  const length = p['shellLengthMm']!;
  const boot = p['bootDiameterMm']! / 2;
  mesh.cylinder('rubber', [0, 0, 0], [0, 0, -p['bootLengthMm']!], r * 0.92, boot, 28, true);
  mesh.cylinder('steel', [0, 0, 0], [0, 0, length * 0.62], r, r, 32, true);
  if (male) {
    mesh.ring('steel', circle(r), circle(r - 0.7), length * 0.62, length);
    mesh.cylinder('black', [0, 0, length * 0.62], [0, 0, length * 0.62 + 0.5], r - 0.75, r - 0.75, 28);
  } else {
    mesh.cylinder('steel', [0, 0, length * 0.62], [0, 0, length], r, r, 32, true);
    mesh.cylinder('black', [0, 0, length - 0.1], [0, 0, length + 0.1], r - 1.2, r - 1.2, 28);
    mesh.box('steel', 0, r + 0.6, length * 0.85, 4.2, 1.6, length * 0.3);
  }
  const pc = p['pinCircleDiameterMm']! / 2;
  for (let i = 0; i < Math.min(spec.pins, 3); i++) {
    const a = ((210 + i * 120) * Math.PI) / 180;
    const x = Math.cos(a) * pc;
    const y = Math.sin(a) * pc;
    if (male) mesh.cylinder('gold', [x, y, length * 0.62 + 0.5], [x, y, length - 1], 0.8, 0.8, 10);
    else {
      mesh.cylinder('gold', [x, y, length + 0.1], [x, y, length + 0.3], 1.4, 1.4, 12);
      mesh.cylinder('black', [x, y, length + 0.3], [x, y, length + 0.4], 0.8, 0.8, 12);
    }
  }
}

function rj45(mesh: Mesh, spec: ParametricSpec, p: Params): void {
  const w = p['widthMm']!;
  const h = p['heightMm']!;
  const l = p['lengthMm']!;
  mesh.box('clear', 0, 0, l / 2, w, h, l);
  // the latch: a tab standing on the top face, hinged at the cable end
  mesh.box('clear', 0, h / 2 + p['latchHeightMm']! / 2, l * 0.3, w * 0.62, p['latchHeightMm']!, l * 0.6);
  // the blades, on the face opposite the latch
  for (let i = 0; i < spec.pins; i++) mesh.box('gold', (i - (spec.pins - 1) / 2) * p['contactPitchMm']!, -h / 2 - 0.05, l * 0.7, 0.5, 0.12, l * 0.5);
  mesh.box('rubber', 0, 0, -p['bootLengthMm']! / 2, w + 1.2, h + 2.2, p['bootLengthMm']!);
}

function jstXh(mesh: Mesh, spec: ParametricSpec, p: Params): void {
  const w = p['widthMm']!;
  const h = p['heightMm']!;
  const d = p['depthMm']!;
  const pitch = p['pitchMm']!;
  mesh.box('natural', 0, 0, d / 2, w, h, d);
  // the mating latch ridge, on one long side
  mesh.box('natural', 0, h / 2 + 0.3, d * 0.55, w * 0.34, 0.6, d * 0.5);
  for (let i = 0; i < spec.pins; i++) {
    const x = (i - (spec.pins - 1) / 2) * pitch;
    mesh.box('black', x, 0, d + 0.05, 1.7, 1.7, 0.1);
    mesh.box('black', x, 0, -0.05, 1.7, 1.7, 0.1);
  }
}

function terminalBlock(mesh: Mesh, spec: ParametricSpec, p: Params): void {
  const pitch = p['pitchMm']!;
  const h = p['heightMm']!;
  const d = p['depthMm']!;
  const w = pitch * spec.pins;
  mesh.box('green', 0, h / 2, 0, w, h, d);
  for (let i = 0; i < spec.pins; i++) {
    const x = (i - (spec.pins - 1) / 2) * pitch;
    mesh.cylinder('steel', [x, h, -d * 0.12], [x, h + 0.7, -d * 0.12], 1.8, 1.8, 18);
    mesh.box('black', x, h + 0.72, -d * 0.12, 3, 0.1, 0.5);
    mesh.box('black', x, h * 0.42, d / 2 + 0.05, pitch * 0.52, h * 0.34, 0.1);
    mesh.cylinder('gold', [x, 0, 0], [x, -3.4, 0], 0.5, 0.5, 8);
  }
}

const BUILDERS: Record<ParametricSpec['shape'], (mesh: Mesh, spec: ParametricSpec, p: Params) => void> = {
  'd-sub': dSub,
  xlr,
  rj45,
  'jst-xh': jstXh,
  'terminal-block': terminalBlock,
};

/** The triangles of a spec, grouped by material. Throws with the problems when the spec cannot be drawn. */
export function parametricMesh(spec: ParametricSpec): Mesh {
  const problems = parametricProblems(spec);
  if (problems.length > 0) throw new Error(`This 3D model cannot be drawn: ${problems.join('; ')}.`);
  const mesh = new Mesh();
  BUILDERS[spec.shape](mesh, spec, spec.params);
  return mesh;
}

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const round = (n: number): number => Math.round(n * 10000) / 10000;

/** A binary glTF of the spec: one mesh, one primitive per material. */
export function buildParametricGlb(spec: ParametricSpec): Uint8Array {
  const mesh = parametricMesh(spec);
  const names = [...mesh.parts.keys()].sort();
  const chunks: Float32Array[] = [];
  const views: { buffer: 0; byteOffset: number; byteLength: number; target: 34962 }[] = [];
  const accessors: { bufferView: number; componentType: 5126; count: number; type: 'VEC3'; min?: number[]; max?: number[] }[] = [];
  const primitives: { attributes: { POSITION: number; NORMAL: number }; material: number; mode: 4 }[] = [];
  let offset = 0;
  const push = (data: number[], bounds: boolean): number => {
    const f = new Float32Array(data.map(round));
    views.push({ buffer: 0, byteOffset: offset, byteLength: f.byteLength, target: 34962 });
    offset += f.byteLength;
    chunks.push(f);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    if (bounds) {
      for (let i = 0; i < f.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, f[i + k]!);
          max[k] = Math.max(max[k]!, f[i + k]!);
        }
      }
    }
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count: f.length / 3, type: 'VEC3', ...(bounds ? { min, max } : {}) });
    return accessors.length - 1;
  };
  names.forEach((name, material) => {
    const part = mesh.parts.get(name)!;
    primitives.push({ attributes: { POSITION: push(part.pos, true), NORMAL: push(part.nor, false) }, material, mode: 4 });
  });
  const json = {
    asset: { version: '2.0', generator: 'wirehub-parametric', extras: { source: 'parametric', shape: spec.shape } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: spec.shape }],
    meshes: [{ primitives }],
    materials: names.map((name) => ({
      name,
      doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [...MATERIALS[name].color.map((c) => round(linear(c))), 1], metallicFactor: MATERIALS[name].metallic, roughnessFactor: MATERIALS[name].roughness },
    })),
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.length;
  view.setUint32(binAt, offset, true);
  view.setUint32(binAt + 4, 0x004e4942, true);
  let at = binAt + 8;
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer), at);
    at += c.byteLength;
  }
  return out;
}

/** The viewer's input for a spec. */
export function parametricModelFile(spec: ParametricSpec): { bytes: ArrayBuffer; mime: string } {
  const glb = buildParametricGlb(spec);
  return { bytes: glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, mime: 'model/gltf-binary' };
}
