/**
 * Parametric 3D models: every shipped link draws, the same every time, at the
 * size its dimensions say, and every starter connector (and body) has one.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isParametricAssetId, parametricAssetId, parametricProblems, type ParametricSpec } from '@wirehub/model';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { countTriangles, parseModel } from '../src/model-scene.ts';
import { buildParametricGlb, parametricMesh, parametricModelFile } from '../src/parametric-model.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const json = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
interface Link { record: string; asset: string; sourceKind: string; src: string; parametric: ParametricSpec }
const FILES = ['packages/catalog/data/models.json', 'modules/pro-audio/pack/models.json', 'modules/networking/pack/models.json'];
const links = FILES.flatMap((f) => json<{ links: Link[] }>(f).links);

describe('the shipped parametric links', () => {
  it('are well formed, cite their dimensions and name their geometry', () => {
    expect(links.length).toBeGreaterThanOrEqual(15);
    for (const link of links) {
      expect(parametricProblems(link.parametric), link.record).toEqual([]);
      expect(link.sourceKind).toBe('parametric');
      expect(link.src.length, link.record).toBeGreaterThan(20);
      expect(isParametricAssetId(link.asset)).toBe(true);
      expect(link.asset, link.record).toBe(parametricAssetId(link.parametric));
    }
  });

  it('cover every starter connector and its body', () => {
    const base = new Set(json<{ links: Link[] }>(FILES[0]!).links.map((l) => l.record));
    for (const kind of ['connectors', 'bodies']) {
      for (const record of json<{ id: string }[]>(`packages/catalog/data/${kind}.json`)) expect(base.has(`${kind}/${record.id}`), `${kind}/${record.id}`).toBe(true);
    }
  });

  it('draw the same bytes every time, as a GLB the viewer parses', async () => {
    for (const link of links) {
      const a = buildParametricGlb(link.parametric);
      expect(Buffer.from(buildParametricGlb(link.parametric)).equals(Buffer.from(a)), link.record).toBe(true);
      expect(a.byteLength, link.record).toBeLessThan(120_000);
      const { bytes, mime } = parametricModelFile(link.parametric);
      const model = await parseModel(bytes, mime);
      expect(countTriangles(model), link.record).toBeGreaterThan(50);
      model.updateMatrixWorld(true);
      const size = new THREE.Box3().setFromObject(model, true).getSize(new THREE.Vector3());
      expect(size.x, link.record).toBeGreaterThan(5);
      expect(size.y, link.record).toBeGreaterThan(5);
    }
  });

  it('size a D-sub from its flange', async () => {
    const link = links.find((l) => l.record === 'connectors/de9-male')!;
    const model = await parseModel(...Object.values(parametricModelFile(link.parametric)) as [ArrayBuffer, string]);
    const size = new THREE.Box3().setFromObject(model, true).getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(30.81, 1);
    expect(size.y).toBeCloseTo(12.55, 1);
  });

  it('refuse a spec that cannot be drawn', () => {
    expect(() => buildParametricGlb({ shape: 'rj45', pins: 8, params: {} })).toThrow(/cannot be drawn/);
  });
});

describe('RJ45 geometry and materials', () => {
  const plug = links.find((l) => l.record === 'bodies/rj45-8p8c-plug')!;
  const jack = links.find((l) => l.record === 'bodies/rj45-8p8c-jack')!;

  it('shows clear polymer with physical transmission and separate metallic contacts', async () => {
    const { bytes, mime } = parametricModelFile(plug.parametric);
    const model = await parseModel(bytes, mime);
    const materials: THREE.Material[] = [];
    model.traverse((node) => {
      if (node instanceof THREE.Mesh) materials.push(...(Array.isArray(node.material) ? node.material : [node.material]));
    });
    const clear = materials.find((m) => m.name === 'clear') as THREE.MeshPhysicalMaterial;
    expect(clear.isMeshPhysicalMaterial).toBe(true);
    expect(clear.transmission).toBeCloseTo(0.96);
    expect(clear.ior).toBeCloseTo(1.58);
    const gold = materials.find((m) => m.name === 'gold') as THREE.MeshStandardMaterial;
    expect(gold.metalness).toBe(1);
    expect(gold.color.r).toBeGreaterThan(gold.color.b);
  });

  it('keeps the plug body hollow almost to the beveled nose', () => {
    const mesh = parametricMesh(plug.parametric);
    const clear = mesh.parts.get('clear')!;
    const length = plug.parametric.params['lengthMm']!;
    // Interior wall vertices near the nose establish a shell rather than a solid front half.
    let hollowWall = false;
    for (let i = 0; i < clear.pos.length; i += 3) {
      if (clear.pos[i + 2]! > length - 1 && clear.pos[i + 2]! < length && Math.abs(clear.pos[i]!) < plug.parametric.params['widthMm']! / 2 - 0.5) hollowWall = true;
    }
    expect(hollowWall).toBe(true);
  });

  it('has a sloped latch and curved tapered boot rather than axis-aligned cuboids', () => {
    const mesh = parametricMesh(plug.parametric);
    const gold = mesh.parts.get('gold')!.pos;
    // The catalog numbers the mating face clip down: gold above, latch below.
    expect(gold.filter((_, i) => i % 3 === 1).every((y) => y > 0)).toBe(true);
    expect(Math.min(...mesh.parts.get('clear')!.pos.filter((_, i) => i % 3 === 1)))
      .toBeLessThan(-plug.parametric.params['heightMm']! / 2 - 1);
    for (const name of ['clear', 'rubber'] as const) {
      const normals = mesh.parts.get(name)!.nor;
      let oblique = false;
      for (let i = 0; i < normals.length; i += 3) {
        if (normals.slice(i, i + 3).filter((n) => Math.abs(n) > 0.1).length >= 2) oblique = true;
      }
      expect(oblique, name).toBe(true);
    }
    const rubber = mesh.parts.get('rubber')!.pos;
    const xAt = (z: number): number => {
      let extent = 0;
      for (let i = 0; i < rubber.length; i += 3) {
        if (Math.abs(rubber[i + 2]! - z) < 0.01) extent = Math.max(extent, Math.abs(rubber[i]!));
      }
      return extent;
    };
    expect(xAt(0)).toBeGreaterThan(xAt(-plug.parametric.params['bootLengthMm']!));
  });

  it('leaves the jack mouth open and places the solder tails below its housing', async () => {
    const { bytes, mime } = parametricModelFile(jack.parametric);
    const model = await parseModel(bytes, mime);
    model.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 50), new THREE.Vector3(0, 0, -1));
    const hits = ray.intersectObject(model, true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.point.z).toBeCloseTo(2, 1); // recessed back, not a face over the mouth
    const bounds = new THREE.Box3().setFromObject(model, true);
    expect(bounds.getSize(new THREE.Vector3()).x).toBeCloseTo(15.24, 2);
    expect(bounds.min.y).toBeCloseTo(-11.5 / 2 - 3.3, 2);
    expect(bounds.max.z).toBeCloseTo(18.1, 2);
  });
});
