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
import { buildParametricGlb, parametricModelFile } from '../src/parametric-model.ts';

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
