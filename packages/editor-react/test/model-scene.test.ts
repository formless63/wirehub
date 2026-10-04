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

import { applyMaterials, countTriangles, frameBox, parseModel } from '../src/model-scene.ts';
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

  it.each(['iso', 'top', 'front', 'side'] as const)('keeps every corner of the part in view from %s', (preset) => {
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
