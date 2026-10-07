import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyBoardTexture, looksLikeBoardPart } from '../server/models/board-texture.ts';
import { relinkWithArt } from '../server/models/board-art.ts';
import { buildLinkedModel, buildProfileOf, budgetOf } from '../server/models/build.ts';
import { CONVERTER_VERSION, identityKey, memoryModelCache, sha256Hex, sourceKey, type SourceFile } from '../server/models/cache.ts';
import { readGlbJson } from '../server/models/glb.ts';
import { cachedModelFile } from '../server/models/api.ts';
import type { ModelLink } from '../server/models/links.ts';
import type { Db } from '@wirehub/model';

const enc = new TextEncoder();
const cube = readFileSync(join(dirname(createRequire(import.meta.url).resolve('occt-import-js')), '../test/testfiles/simple-basic-cube/cube.stp'), 'utf8');
// Existing dependency fixture, synthetic exporter name; no vendor or private model copied.
const step = enc.encode(cube.replace("PRODUCT('cube','cube'", "PRODUCT('Board~Synth9','Board~Synth9'"));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0a0"/></svg>';
const geometry = { path: 'boards/synthetic.step', sha256: sha256Hex(step) };
const top = { path: 'depictions/synthetic/board-top.svg', sha256: sha256Hex(svg) };
const bottom = { path: 'depictions/synthetic/board-bottom.svg', sha256: sha256Hex(svg) };
const files: SourceFile[] = [geometry, top, bottom];
const read = (path: string): Uint8Array | undefined => path === geometry.path ? step : [top.path, bottom.path].includes(path) ? enc.encode(svg) : undefined;
const link = (asset: string): ModelLink => ({ record: 'pcbas/synthetic', asset, files, sourceKind: 'kicad-board', src: 'synthetic example' });

it('recognises only the bounded exporter board convention and preserves the legacy detector', () => {
  for (const name of ['Board~Synth9', 'board~abc', 'BOARD~123#2']) {
    expect(looksLikeBoardPart(name)).toBe(true);
    expect(looksLikeBoardPart(name, 'legacy')).toBe(false);
  }
  for (const name of ['board', 'synthetic_PCB', 'synthetic_PCB#2']) {
    expect(looksLikeBoardPart(name)).toBe(true);
    expect(looksLikeBoardPart(name, 'legacy')).toBe(true);
  }
  for (const name of ['Board', 'Board~', 'Board~id extra', 'xBoard~id', 'Board~id~component', 'Board~' + 'x'.repeat(65), 'Board~id#1234567']) expect(looksLikeBoardPart(name)).toBe(false);
});

it('changes only paired-art source keys; preserves geometry identity, old keys and budgets', () => {
  // Original key recipe is asserted independently: cold legacy keys must remain rebuildable.
  const legacy = sha256Hex(`${CONVERTER_VERSION}\n150000\n${files.map(f => `${f.path}\n${f.sha256}`).join('\n')}`);
  expect(sourceKey(files, 150_000, undefined, 'legacy')).toBe(legacy);
  const current = sourceKey(files, 150_000);
  expect(current).not.toBe(legacy);
  expect(buildProfileOf(link(legacy))).toEqual({ budget: 150_000, boardTextureProfile: 'legacy' });
  expect(buildProfileOf(link(current))).toEqual({ budget: 150_000, boardTextureProfile: 'exporter' });
  expect(budgetOf(link(legacy))).toBe(150_000);
  // Unrelated pack installs reconcile artwork too: same bytes must not opt in silently.
  expect(relinkWithArt(link(legacy), [bottom, top])).toBeUndefined();
  expect(relinkWithArt(link(legacy), [{ ...top, sha256: 'b'.repeat(64) }, bottom])?.asset).toBe(sourceKey([geometry, { ...top, sha256: 'b'.repeat(64) }, bottom], 150_000));
  expect(budgetOf(link(current))).toBe(150_000);
  expect(identityKey(files, 150_000)).toBe(sourceKey([geometry], 150_000));
  for (const unpainted of [[geometry], [geometry, top], [geometry, bottom], [geometry, { path: 'depictions/synthetic/mating-face.svg', sha256: top.sha256 }]]) {
    expect(sourceKey(unpainted, 150_000)).toBe(sourceKey(unpainted, 150_000, undefined, 'legacy'));
  }
  expect(buildProfileOf(link('a'.repeat(64)))).toBeUndefined();
});

it('rebuilds old and new keys through the real child with the correct texture output, leaving old cached bytes usable', async () => {
  const legacyKey = sourceKey(files, 150_000, undefined, 'legacy');
  const old = await buildLinkedModel(link(legacyKey), read);
  const modernKey = sourceKey(files, 150_000);
  const modern = await buildLinkedModel(link(modernKey), read);
  const oldJson = readGlbJson(old.glb)!;
  const modernJson = readGlbJson(modern.glb)!;
  expect(old.key).toBe(legacyKey);
  expect(oldJson['images']).toBeUndefined();
  expect(modern.key).toBe(modernKey);
  expect((modernJson['images'] as unknown[]).length).toBe(2);
  const meshes = modernJson['meshes'] as { primitives: { attributes: Record<string, number>; material?: number }[] }[];
  expect(meshes.filter(m => m.primitives[0]?.attributes['TEXCOORD_0'] !== undefined)).toHaveLength(2);
  expect(JSON.stringify(modernJson['asset'])).not.toContain('boardArtError');
  expect(sha256Hex(modern.glb)).not.toBe(sha256Hex(old.glb));
  const cache = memoryModelCache();
  cache.put(legacyKey, old.glb);
  const response = await cachedModelFile({ cache, loadDb: async () => ({} as Db) }, legacyKey);
  expect(response?.status).toBe(200);
  expect(response?.bytes).toEqual(old.glb);
  // Do not mutate the mesh source merely because it acquires a texture.
  expect(await applyBoardTexture([], { top: svg, bottom: svg })).toEqual([]);
}, 60_000);
