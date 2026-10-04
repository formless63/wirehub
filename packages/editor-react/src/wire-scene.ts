/**
 * The three.js half of the parametric wire view: a
 * `WireModel` (pure pieces from `@wirehub/layout`) → a scene group.
 * DOM-free, so it is unit-tested in Node; only the lazy viewer chunk
 * (`panels/WireModel3d.tsx`) and tests import it.
 *
 * Every piece is swept along its centreline (parallel-transport frames: no
 * twisting seams on a helix) as an annulus — outer wall, inner wall, and
 * ring or disk caps — so a stripped end reads as layers, not as one blob.
 * Pieces with the same `shapeKey` (the six coax sheaths of one strip) share
 * one geometry as an `InstancedMesh`, turned about the cable axis and
 * coloured per instance: a stripped 6+2 end is a handful of draw calls.
 *
 * Materials (realism pass): copper and tinned copper
 * are full metals lit by the viewer's room environment; PE is natural
 * off-white; a coax sheath or core insulation takes the conductor colour the
 * tokens paint with a little sheen, the overall jacket is matte; a screen or
 * twisted lead is its metal with a procedural 128 px strand texture (also its
 * bump map) — fine helical strands for a spiral or a lead, over-under
 * carriers for a braid; the cut filler is fibre-white, else the bore is dark.
 */

import * as THREE from 'three';

import type { WireMaterialKind, WireModel, WirePiece } from '@wirehub/render-svg';

export interface WirePalette {
  /** catalog colour name → CSS colour (`red` → `#e5484d`) */
  colours: Record<string, string>;
  dark: boolean;
}

/** The conductor colours when no stylesheet says (tokens.css, light theme). */
export const FALLBACK_COLOURS: Record<string, string> = {
  red: '#e5484d',
  green: '#3fb56a',
  blue: '#3b82f6',
  yellow: '#e6c229',
  brown: '#9a5b34',
  purple: '#9b6ce0',
  white: '#e9e7e2',
  black: '#1b1b1d',
  grey: '#8a8f96',
  gray: '#8a8f96',
  orange: '#e8833a',
  natural: '#efece4',
};

const METAL: Record<'copper' | 'tinned', { color: number; roughness: number }> = {
  // bright copper, and tinned copper's soft satin silver
  copper: { color: 0xd98a5a, roughness: 0.28 },
  tinned: { color: 0xd4d6d8, roughness: 0.34 },
};

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * One piece swept into a mesh geometry, before its `rotateDeg`. UVs: `u`
 * runs along the centreline in lay lengths (`piece.layMm`, else the
 * circumference), `v` once around — what the screen stripes wrap on.
 */
export function sweepPiece(piece: WirePiece): THREE.BufferGeometry {
  const pts = piece.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const n = pts.length;
  const radial = Math.max(3, piece.radialSegments);
  const rO = piece.rOuter;
  const rI = piece.rInner;
  const along = piece.layMm ?? Math.max(2 * Math.PI * rO, 1e-3);

  // tangents, and parallel-transported normals
  const tangents: THREE.Vector3[] = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)] as THREE.Vector3;
    const b = pts[Math.min(n - 1, i + 1)] as THREE.Vector3;
    const t = b.clone().sub(a);
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(1, 0, 0) : t.normalize();
  });
  const t0 = tangents[0] as THREE.Vector3;
  const seed = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  let normal = seed.sub(t0.clone().multiplyScalar(seed.dot(t0))).normalize();
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = tangents[i] as THREE.Vector3;
    normal = normal.sub(t.clone().multiplyScalar(normal.dot(t)));
    if (normal.lengthSq() < 1e-12) normal = new THREE.Vector3(0, 1, 0).cross(t);
    normal.normalize();
    normals.push(normal.clone());
    binormals.push(t.clone().cross(normal).normalize());
  }
  const lengths: number[] = [0];
  for (let i = 1; i < n; i += 1) lengths.push((lengths[i - 1] as number) + (pts[i] as THREE.Vector3).distanceTo(pts[i - 1] as THREE.Vector3));

  const position: number[] = [];
  const norm: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const dir = new THREE.Vector3();
  const vertex = (p: THREE.Vector3, nx: number, ny: number, nz: number, u: number, v: number): number => {
    position.push(p.x, p.y, p.z);
    norm.push(nx, ny, nz);
    uv.push(u, v);
    return position.length / 3 - 1;
  };
  const wall = (r: number, inward: boolean): void => {
    const base = position.length / 3;
    for (let i = 0; i < n; i += 1) {
      const p = pts[i] as THREE.Vector3;
      const N = normals[i] as THREE.Vector3;
      const B = binormals[i] as THREE.Vector3;
      for (let j = 0; j <= radial; j += 1) {
        const a = (j / radial) * Math.PI * 2;
        dir.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
        const s = inward ? -1 : 1;
        vertex(p.clone().addScaledVector(dir, r), dir.x * s, dir.y * s, dir.z * s, (lengths[i] as number) / along, j / radial);
      }
    }
    for (let i = 0; i < n - 1; i += 1) {
      for (let j = 0; j < radial; j += 1) {
        const a = base + i * (radial + 1) + j;
        const b = a + radial + 1;
        // counter-clockwise seen from the side the normal faces: an outer wall
        // faces out, a bore faces in (: these were swapped,
        // so the near wall was culled and every tube looked hollow)
        if (inward) index.push(a, b, a + 1, b, b + 1, a + 1);
        else index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  };
  const cap = (at: number, facing: 1 | -1, kind: 'ring' | 'disk' | 'none'): void => {
    if (kind === 'none') return;
    const p = pts[at] as THREE.Vector3;
    const t = (tangents[at] as THREE.Vector3).clone().multiplyScalar(facing);
    const N = normals[at] as THREE.Vector3;
    const B = binormals[at] as THREE.Vector3;
    const inner = kind === 'ring' && rI > 0 ? rI : 0;
    const base = position.length / 3;
    for (let j = 0; j <= radial; j += 1) {
      const a = (j / radial) * Math.PI * 2;
      dir.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      vertex(p.clone().addScaledVector(dir, rO), t.x, t.y, t.z, 1, j / radial);
      vertex(p.clone().addScaledVector(dir, inner), t.x, t.y, t.z, 0, j / radial);
    }
    for (let j = 0; j < radial; j += 1) {
      const o0 = base + j * 2;
      const i0 = o0 + 1;
      const o1 = o0 + 2;
      const i1 = o0 + 3;
      // wind so the face looks along `t`; a disk is one fan triangle per segment
      if (inner === 0) {
        if (facing === 1) index.push(o0, o1, i0);
        else index.push(o0, i0, o1);
      } else if (facing === 1) index.push(o0, o1, i0, i0, o1, i1);
      else index.push(o0, i0, o1, i0, i1, o1);
    }
  };

  wall(rO, false);
  if (rI > 0) wall(rI, true);
  cap(0, -1, piece.caps.start);
  cap(n - 1, 1, piece.caps.end);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

/* ------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------ */

/** A tile's fractional part, always in [0, 1). */
const fract = (v: number): number => v - Math.floor(v);
/** The lit profile across one round strand: bright on its crown, dark in the gap. */
const strandShade = (f: number): number => {
  const c = 2 * f - 1;
  return Math.sqrt(Math.max(0, 1 - c * c));
};

/**
 * A 128 px screen texture (greyscale, also the bump map). `u` is one lay
 * length, `v` once around. `spiral`: fine strands laid side by side as a
 * helix (a served screen, a twisted lead); `braid`: two carrier families
 * crossing over and under, each carrier a few ends wide.
 */
export function screenTexture(kind: 'braid' | 'spiral'): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let shade: number;
      if (kind === 'spiral') {
        shade = 0.25 + 0.75 * strandShade(fract(16 * (u - v)));
      } else {
        const carriers = 8;
        const ends = 4;
        const a = carriers * (u + v);
        const b = carriers * (u - v);
        const over = (Math.floor(a) + Math.floor(b)) & 1;
        const along = over === 0 ? fract(b) : fract(a); // position along the top carrier
        const across = over === 0 ? fract(a) : fract(b); // across its ends
        // each carrier dips under its neighbour at both ends of its float
        const dip = 0.55 + 0.45 * Math.sin(Math.PI * along);
        shade = 0.18 + 0.82 * dip * (0.35 + 0.65 * strandShade(fract(across * ends)));
      }
      const c = Math.round(255 * shade);
      const o = (y * size + x) * 4;
      data[o] = c;
      data[o + 1] = c;
      data[o + 2] = c;
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function colourOf(name: string | undefined, palette: WirePalette, fallback: string): string {
  if (name === undefined) return fallback;
  return palette.colours[name] ?? FALLBACK_COLOURS[name] ?? fallback;
}

/** PE as it comes off the drum: natural, a little warm */
const NATURAL_PE = '#ece8dc';

class MaterialCache {
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();
  private readonly textures = new Map<string, THREE.DataTexture>();
  constructor(private readonly palette: WirePalette) {}

  /** `tinted`: the colour comes per instance, so the base is white */
  get(piece: WirePiece, tinted: boolean): THREE.MeshStandardMaterial {
    const colour = tinted ? '#ffffff' : this.baseColour(piece);
    const screen = piece.material === 'braid' || piece.material === 'spiral';
    const key = `${piece.material}|${colour}|${piece.opacity ?? 1}|${screen ? this.metalOf(piece) : ''}|${piece.kind === 'jacket' || piece.kind === 'web' ? 'matte' : ''}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const material = this.make(piece, colour);
    this.cache.set(key, material);
    return material;
  }

  baseColour(piece: WirePiece): string {
    switch (piece.material) {
      case 'copper':
      case 'tinned':
        return `#${METAL[piece.material].color.toString(16).padStart(6, '0')}`;
      case 'braid':
      case 'spiral':
        return `#${METAL[this.metalOf(piece)].color.toString(16).padStart(6, '0')}`;
      case 'pe':
        return colourOf(piece.colorName, this.palette, NATURAL_PE);
      case 'filler':
        return this.palette.dark ? '#b9b2a2' : '#d9d1bf';
      case 'bore':
        return this.palette.dark ? '#0b0b0c' : '#141416';
      case 'pvc':
        return colourOf(piece.colorName, this.palette, '#1b1b1d');
    }
  }

  private metalOf(piece: WirePiece): 'copper' | 'tinned' {
    return piece.metal ?? 'copper';
  }

  private make(piece: WirePiece, colour: string): THREE.MeshStandardMaterial {
    const kind: WireMaterialKind = piece.material;
    const opacity = piece.opacity ?? 1;
    const base = { color: new THREE.Color(colour), side: THREE.FrontSide } as const;
    if (kind === 'copper' || kind === 'tinned') {
      return new THREE.MeshStandardMaterial({ ...base, name: kind, metalness: 1, roughness: METAL[kind].roughness });
    }
    if (kind === 'braid' || kind === 'spiral') {
      let texture = this.textures.get(kind);
      if (texture === undefined) {
        texture = screenTexture(kind);
        this.textures.set(kind, texture);
      }
      const metal = this.metalOf(piece);
      // the texture darkens the gaps between strands and raises their crowns
      return new THREE.MeshStandardMaterial({ ...base, name: kind, metalness: 1, roughness: METAL[metal].roughness + 0.08, map: texture, bumpMap: texture, bumpScale: 1.2 });
    }
    // solid or foamed PE: a soft, slightly waxy white, lit a touch from within
    if (kind === 'pe') return new THREE.MeshStandardMaterial({ ...base, name: kind, metalness: 0, roughness: 0.62, emissive: new THREE.Color(colour).multiplyScalar(0.12) });
    if (kind === 'filler') return new THREE.MeshStandardMaterial({ ...base, name: kind, metalness: 0, roughness: 1 });
    if (kind === 'bore') return new THREE.MeshStandardMaterial({ ...base, name: kind, metalness: 0, roughness: 1 });
    const matte = piece.kind === 'jacket' || piece.kind === 'web';
    return new THREE.MeshStandardMaterial({
      ...base,
      name: matte ? 'jacket' : kind,
      metalness: 0,
      // an overall jacket is matte; a coax sheath or core insulation has a little sheen
      roughness: matte ? 0.82 : 0.48,
      ...(opacity < 1 ? { transparent: true, opacity, depthWrite: false } : {}),
    });
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.cache.clear();
    this.textures.clear();
  }
}

/* ------------------------------------------------------------------ *
 * The scene object
 * ------------------------------------------------------------------ */

export interface WireObject {
  group: THREE.Group;
  /** meshes drawn (one per instanced group) */
  drawCalls: number;
  triangles: number;
  dispose: () => void;
}

/** Every piece of `model` as meshes. */
export function buildWireObject(model: WireModel, palette: WirePalette): WireObject {
  const group = new THREE.Group();
  group.name = `wire:${model.wire}`;
  const materials = new MaterialCache(palette);
  const geometries: THREE.BufferGeometry[] = [];
  const byShape = new Map<string, WirePiece[]>();
  for (const piece of model.pieces) {
    const list = byShape.get(piece.shapeKey);
    if (list === undefined) byShape.set(piece.shapeKey, [piece]);
    else list.push(piece);
  }
  let drawCalls = 0;
  let triangles = 0;
  const matrix = new THREE.Matrix4();
  for (const [key, pieces] of byShape) {
    const first = pieces[0] as WirePiece;
    const geometry = sweepPiece(first);
    geometries.push(geometry);
    const tris = (geometry.index?.count ?? 0) / 3;
    const colours = new Set(pieces.map((p) => materials.baseColour(p)));
    if (pieces.length === 1) {
      const mesh = new THREE.Mesh(geometry, materials.get(first, false));
      mesh.name = first.id;
      mesh.rotation.x = (first.rotateDeg * Math.PI) / 180;
      mesh.userData['piece'] = first.id;
      if ((first.opacity ?? 1) < 1) mesh.renderOrder = 2;
      group.add(mesh);
      drawCalls += 1;
      triangles += tris;
      continue;
    }
    const tinted = colours.size > 1;
    const mesh = new THREE.InstancedMesh(geometry, materials.get(first, tinted), pieces.length);
    mesh.name = `instanced:${key}`;
    pieces.forEach((piece, i) => {
      matrix.makeRotationX((piece.rotateDeg * Math.PI) / 180);
      mesh.setMatrixAt(i, matrix);
      if (tinted) mesh.setColorAt(i, new THREE.Color(materials.baseColour(piece)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    mesh.userData['pieces'] = pieces.map((p) => p.id);
    mesh.computeBoundingSphere();
    group.add(mesh);
    drawCalls += 1;
    triangles += tris * pieces.length;
  }
  return {
    group,
    drawCalls,
    triangles: Math.round(triangles),
    dispose: () => {
      for (const g of geometries) g.dispose();
      materials.dispose();
      for (const child of group.children) if ((child as THREE.InstancedMesh).isInstancedMesh) (child as THREE.InstancedMesh).dispose();
    },
  };
}
