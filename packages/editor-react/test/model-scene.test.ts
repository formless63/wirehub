/**
 * The 3D view's loaders and framing, on tiny fixtures:
 * `fixtures/tetra.stl` (a 10 × 10 × 5 mm tetrahedron, Z-up) and
 * `fixtures/tetra.glb` (the same, as the studio's GLB writer stores it —
 * `apps/studio/test/models.server.test.ts` holds the writer to these bytes).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyMaterials, countTriangles, frameBox, modelAppearanceNote, parseModel } from '../src/model-scene.ts';
import { looksLikeGlb } from '../src/models.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bytes = (name: string): ArrayBuffer => {
  const buffer = readFileSync(join(here, 'fixtures', name));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
};

const PALETTE = { background: '#000000', body: '#c9c4ba', dark: true };

function sizeOf(root: THREE.Object3D): THREE.Vector3 {
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root, true).getSize(new THREE.Vector3());
}

describe('parseModel', () => {
  it('reads an STL and turns Z-up into Y-up', async () => {
    const root = await parseModel(bytes('tetra.stl'), 'model/stl');
    expect(countTriangles(root)).toBe(4);
    expect(modelAppearanceNote(root)).toMatch(/geometry only/);
    applyMaterials(root, PALETTE);
    expect(((root.getObjectByProperty('isMesh', true) as THREE.Mesh).material as THREE.Material).side).toBe(THREE.DoubleSide);
    const size = sizeOf(root);
    expect(size.x).toBeCloseTo(10, 3);
    expect(size.y).toBeCloseTo(5, 3); // the 5 mm Z height is now up
    expect(size.z).toBeCloseTo(10, 3);
  });

  it('reads the quantized GLB the studio stores, to the same size', async () => {
    const glb = bytes('tetra.glb');
    expect(looksLikeGlb(glb)).toBe(true);
    const root = await parseModel(glb, 'model/gltf-binary');
    expect(countTriangles(root)).toBe(4);
    expect(modelAppearanceNote(root)).toMatch(/geometry only/);
    const size = sizeOf(root);
    expect(size.x).toBeCloseTo(10, 2);
    expect(size.y).toBeCloseTo(5, 2);
    expect(size.z).toBeCloseTo(10, 2);
  });

  it('refuses a type it cannot show', async () => {
    await expect(parseModel(new ArrayBuffer(8), 'image/png')).rejects.toThrow(/cannot show/);
  });
});

describe('applyMaterials', () => {
  it('gives an uncoloured model the neutral body, flat-shaded when it has no normals', async () => {
    const root = await parseModel(bytes('tetra.glb'), 'model/gltf-binary');
    applyMaterials(root, PALETTE);
    const mesh = root.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.name).toBe('neutral');
    expect(`#${material.color.getHexString()}`).toBe('#c9c4ba');
    expect(material.flatShading).toBe(true);
    // a theme change re-applies the other body colour
    applyMaterials(root, { ...PALETTE, body: '#a9a49a', dark: false });
    expect(`#${(mesh.material as THREE.MeshStandardMaterial).color.getHexString()}`).toBe('#a9a49a');
  });

  it("keeps a source's own colour across theme changes", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ name: 'source-colour', color: 0x1d7a3a }));
    const root = new THREE.Group().add(mesh);
    applyMaterials(root, PALETTE);
    applyMaterials(root, { ...PALETTE, body: '#ffffff' });
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('1d7a3a');
  });

  it("keeps a board face's own gerber-art texture across theme changes", () => {
    const texture = new THREE.Texture();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ name: 'board-art', map: texture }));
    const root = new THREE.Group().add(mesh);
    applyMaterials(root, PALETTE);
    let material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.map).toBe(texture);
    // painted white, not tinted by the palette body colour — the art is the colour
    expect(material.color.getHexString()).toBe('ffffff');
    applyMaterials(root, { ...PALETTE, body: '#ff00ff' });
    material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.map).toBe(texture);
    expect(material.color.getHexString()).toBe('ffffff');
  });
});

describe('frameBox', () => {
  const box = new THREE.Box3(new THREE.Vector3(-40, -5, -15), new THREE.Vector3(40, 5, 15));

  it.each(['iso', 'top', 'bottom', 'front', 'side'] as const)('keeps every corner of the part in view from %s', (preset) => {
    const f = frameBox(box, preset, 35, 3);
    const camera = new THREE.PerspectiveCamera(35, 3, f.near, f.far);
    camera.position.copy(f.position);
    camera.lookAt(f.target);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const p = new THREE.Vector3(x, y, z).project(camera);
          expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});


describe('source material fidelity', () => {
  it.each([false, true])('keeps an explicitly supplied unnamed glTF material and doubleSided=%s across both themes', async (doubleSided) => {
    const original = new Uint8Array(bytes('tetra.glb'));
    const input = new DataView(original.buffer);
    const jsonLength = input.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(original.subarray(20, 20 + jsonLength)));
    json.materials = [{ pbrMetallicRoughness: { baseColorFactor: [0.1, 0.5, 0.2, 0.4], metallicFactor: 0.7, roughnessFactor: 0.3 }, alphaMode: 'BLEND', doubleSided }];
    json.meshes[0].primitives[0].material = 0;
    const encoded = new TextEncoder().encode(JSON.stringify(json));
    const padded = new Uint8Array((encoded.length + 3) & ~3).fill(32); padded.set(encoded);
    const binary = original.subarray(20 + jsonLength);
    const glb = new Uint8Array(20 + padded.length + binary.length); const out = new DataView(glb.buffer);
    out.setUint32(0, 0x46546c67, true); out.setUint32(4, 2, true); out.setUint32(8, glb.length, true);
    out.setUint32(12, padded.length, true); out.setUint32(16, 0x4e4f534a, true); glb.set(padded, 20); glb.set(binary, 20 + padded.length);
    const root = await parseModel(glb.buffer, 'model/gltf-binary');
    expect(modelAppearanceNote(root)).toBeUndefined();
    const mesh = root.getObjectByProperty('isMesh', true) as THREE.Mesh;
    for (const body of ['#ff00ff', '#ffffff']) {
      applyMaterials(root, { ...PALETTE, body });
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.color.toArray()).toEqual([0.1, 0.5, 0.2]);
      expect(material.opacity).toBe(0.4); expect(material.transparent).toBe(true);
      expect(material.metalness).toBe(0.7); expect(material.roughness).toBe(0.3);
      expect(material.side).toBe(doubleSided ? THREE.DoubleSide : THREE.FrontSide);
    }
  });

  it('culls the back of a supplied single-sided face while retaining explicitly double-sided faces', () => {
    const front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ name: 'synthetic-face', side: THREE.FrontSide }));
    const both = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ name: 'synthetic-sheet', side: THREE.DoubleSide }));
    const root = new THREE.Group().add(front, both);
    expect(modelAppearanceNote(root)).toBeUndefined();
    const behind = new THREE.Raycaster(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1));
    for (const dark of [false, true]) {
      applyMaterials(root, { ...PALETTE, dark });
      root.updateMatrixWorld(true);
      expect(behind.intersectObject(front)).toHaveLength(0);
      expect(behind.intersectObject(both).length).toBeGreaterThan(0);
    }
  });

  it('preserves multiple source materials, texture tint and geometry groups', () => {
    const texture = new THREE.Texture();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const normal = new THREE.Texture();
    const emissive = new THREE.Texture();
    const roughness = new THREE.Texture();
    const top = new THREE.MeshStandardMaterial({ color: 0x88cc88, map: texture, normalMap: normal, emissiveMap: emissive, roughnessMap: roughness, alphaTest: 0.4, side: THREE.DoubleSide });
    const bottom = new THREE.MeshStandardMaterial({ color: 0x2244cc, roughness: 0.2 });
    const mesh = new THREE.Mesh(geometry, [top, bottom]);
    const groups = structuredClone(geometry.groups);
    const root = new THREE.Group().add(mesh);
    for (const body of ['#ff00ff', '#ffffff']) {
      applyMaterials(root, { ...PALETTE, body });
      const materials = mesh.material as THREE.MeshStandardMaterial[];
      expect(materials).toHaveLength(2);
      expect(materials[0]!.map).toBe(texture);
      expect(materials[0]!.color.getHexString()).toBe('88cc88');
      expect(materials[0]!.alphaTest).toBe(0.4);
      expect(materials[0]!.normalMap).toBe(normal);
      expect(materials[0]!.emissiveMap).toBe(emissive);
      expect(materials[0]!.roughnessMap).toBe(roughness);
      expect(materials[0]!.side).toBe(THREE.DoubleSide);
      expect(materials[1]!.side).toBe(THREE.FrontSide);
      expect(materials[1]!.color.getHexString()).toBe('2244cc');
      expect(materials[1]!.roughness).toBe(0.2);
      expect(geometry.groups).toEqual(groups);
    }
  });
});
