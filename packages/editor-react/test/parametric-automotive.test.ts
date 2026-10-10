import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { ParametricSpec } from '@wirehub/model';
import { countTriangles, parseModel } from '../src/model-scene.ts';
import { buildParametricGlb } from '../src/parametric-model.ts';

const { links } = JSON.parse(readFileSync(new URL('../../../modules/automotive/pack/models.json', import.meta.url), 'utf8')) as { links: { record: string; parametric: ParametricSpec }[] };

describe('the Automotive connector envelopes', () => {
  it.each(links)('draws $record deterministically with finite geometry and complete rear views', async (link) => {
      const bytes = buildParametricGlb(link.parametric);
      expect(Buffer.from(buildParametricGlb(link.parametric)).equals(Buffer.from(bytes)), link.record).toBe(true);
      expect(bytes.byteLength).toBeLessThan(600_000);
      const model = await parseModel(bytes.buffer as ArrayBuffer, 'model/gltf-binary');
      expect(countTriangles(model), link.record).toBeGreaterThan(1_000);
      const bounds = new THREE.Box3().setFromObject(model, true);
      expect(bounds.min.z).toBeLessThan(0);
      expect(bounds.max.z).toBeGreaterThan(0);
      const size = bounds.getSize(new THREE.Vector3());
      expect(size.x).toBeCloseTo(link.parametric.params['widthMm']!, 1);
      expect(size.y).toBeGreaterThan(link.parametric.params['heightMm']! * 0.9);
      expect(size.y).toBeLessThan(link.parametric.params['heightMm']! * 1.1);
      expect(size.z).toBeGreaterThanOrEqual(link.parametric.params['lengthMm']!);
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const positions = object.geometry.getAttribute('position');
        expect(Array.from(positions.array).every(Number.isFinite), link.record).toBe(true);
      });
  });

  it('uses polymer, metal, rear seal and distinct plug/receptacle secondary-lock appearances', () => {
    for (const id of ['deutsch-dt04-2p', 'deutsch-dt06-2s']) {
      const spec = links.find((link) => link.record === `bodies/${id}`)!.parametric;
      const bytes = buildParametricGlb(spec);
      const length = new DataView(bytes.buffer).getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder().decode(bytes.slice(20, 20 + length))) as { materials: { name: string; pbrMetallicRoughness: { metallicFactor: number; baseColorFactor: number[] } }[] };
      const materials = new Map(gltf.materials.map((material) => [material.name, material]));
      expect(materials.get('polymer-gray')?.pbrMetallicRoughness.metallicFactor).toBe(0);
      expect(materials.get('steel')?.pbrMetallicRoughness.metallicFactor).toBeGreaterThan(0.5);
      expect(materials.get('seal-orange')?.pbrMetallicRoughness.metallicFactor).toBe(0);
      expect(materials.has('green')).toBe(spec.gender === 'male');
      expect(materials.get('polymer-gray')?.pbrMetallicRoughness.baseColorFactor).not.toEqual(materials.get('seal-orange')?.pbrMetallicRoughness.baseColorFactor);
    }
  });
});
