import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { occurrenceFactory, OCCURRENCE_ARTIFACT, OCCURRENCE_VERSION } from '../server/models/occurrence-reader.ts';
import { sha256Hex, sourceKey, type SourceFile, type ModelBuild } from '../server/models/cache.ts';
import { buildProfileOf, buildLinkedModel, type Converter } from '../server/models/build.ts';
import { relinkWithArt } from '../server/models/board-art.ts';
import { prepareStepReader, readStep } from '../server/models/step.ts';
import { convertModel } from '../server/models/convert.ts';
import { assemble, IDENTITY, translation } from '../server/models/assembly.ts';
const dirs: string[] = [];
const temporary = (): string => { const d = mkdtempSync(join(tmpdir(), 'step-style-test-')); dirs.push(d); return d; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const files: SourceFile[] = [{ path: 'synthetic/component.step', sha256: 'a'.repeat(64) }];
const art: SourceFile[] = [{ path: 'depictions/synthetic/board-top.svg', sha256: 'b'.repeat(64) }, { path: 'depictions/synthetic/board-bottom.svg', sha256: 'c'.repeat(64) }];
it('keeps legacy/exporter keys and explicitly separates both components and paired boards', () => {
  expect(OCCURRENCE_VERSION.endsWith(':board-coating-2')).toBe(true);
  for (const sources of [files, [...files, ...art]]) {
    const keys = (['legacy', 'exporter', 'occurrence'] as const).map((profile) => sourceKey(sources, 150_000, undefined, profile));
    expect(keys[2]).not.toBe(keys[0]); expect(keys[2]).not.toBe(keys[1]);
    for (const [i, profile] of (['legacy', 'exporter', 'occurrence'] as const).entries()) {
      expect(buildProfileOf({ files: sources, asset: keys[i]! })?.boardTextureProfile).toBe(profile === 'legacy' && sources.length === 1 ? 'exporter' : profile);
    }
    expect(sourceKey(sources, 150_000)).toBe(keys[1]);
  }
  expect(sourceKey([...files, ...art], 150_000, undefined, 'legacy')).toBe('82448e9acabae7f2afaef56aae29208d7934d10fa424765042fd61495444efd7');
  expect(sourceKey([...files, ...art], 150_000, undefined, 'exporter')).toBe('2678e6039d8c468f64738395ff23c936592d53136ac12d41dd9bfff93990ef01');
  for (const [sources, build] of [
    [[{ ...files[0]!, path: 'synthetic/part.stl' }], undefined],
    [[{ ...files[0]!, path: 'synthetic/board.kicad_pcb' }], { kind: 'embedded', name: 'synthetic.step' }],
    [files, { kind: 'placed', offset: [1, 2, 3], rotate: [0, 0, 90] }],
  ] as [SourceFile[], ModelBuild | undefined][]) {
    const old = sourceKey(sources, 150_000, build);
    const next = sourceKey(sources, 150_000, build, 'occurrence');
    expect(next).not.toBe(old);
    expect(buildProfileOf({ asset: old, files: sources, ...(build === undefined ? {} : { build }) })?.boardTextureProfile).not.toBe('occurrence');
    expect(buildProfileOf({ asset: next, files: sources, ...(build === undefined ? {} : { build }) })?.boardTextureProfile).toBe('occurrence');
  }
});
it('keeps an opted-in reader when actual artwork changes, with no same-art upgrade', () => {
  const all = [...files, ...art];
  const link = { record: 'pcbas/synthetic', asset: sourceKey(all, 150_000, undefined, 'occurrence'), files: all, src: 'synthetic example', sourceKind: 'kicad-board' as const };
  expect(relinkWithArt(link, [...art].reverse())).toBeUndefined();
  const changed = [art[0]!, { ...art[1]!, sha256: 'd'.repeat(64) }];
  const next = relinkWithArt(link, changed)!;
  expect(next.asset).toBe(sourceKey([...files, ...changed], 150_000, undefined, 'occurrence'));
});
it('fails closed for absent configuration and unsupported profile before importing source bytes', async () => {
  expect(() => sourceKey(files, 150_000, undefined, 'unknown' as never)).toThrow(/Unsupported model conversion profile/);
  vi.stubEnv('WIREHUB_OCCT_STYLES_DIR', '');
  await expect(prepareStepReader('occurrence')).rejects.toThrow(/must be built and mounted/);
  await expect(readStep(new Uint8Array(), .001, false, 'unknown' as never)).rejects.toThrow(/Unsupported STEP conversion profile/);
});
it('rejects a symlinked artifact directory and files, unexpected manifest and changed bytes', () => {
  const dir = temporary(); const actual = join(dir, 'actual'); mkdirSync(actual);
  const alias = join(dir, 'alias'); symlinkSync(actual, alias);
  expect(() => occurrenceFactory(alias)).toThrow(/pinned manifest/);
  writeFileSync(join(actual, 'manifest.json'), JSON.stringify({ ...OCCURRENCE_ARTIFACT, profile: 'unreviewed' }));
  expect(() => occurrenceFactory(actual)).toThrow(/pinned manifest/);
  writeFileSync(join(actual, 'manifest.json'), JSON.stringify(OCCURRENCE_ARTIFACT));
  writeFileSync(join(dir, 'code.cjs'), 'throw new Error("must never execute")');
  symlinkSync(join(dir, 'code.cjs'), join(actual, 'occt-import-js.cjs'));
  writeFileSync(join(actual, 'occt-import-js.wasm'), 'changed');
  expect(() => occurrenceFactory(actual)).toThrow(/pinned manifest/);
  rmSync(join(actual, 'occt-import-js.cjs')); writeFileSync(join(actual, 'occt-import-js.cjs'), 'throw new Error("must never execute")');
  expect(() => occurrenceFactory(actual)).toThrow(/pinned manifest/);
});

it('preserves source identity while separating placed copies and component-file contexts', () => {
  const part = { name: 'synthetic', readerMeshId: 'occt-mesh:0', sourceProductName: 'Synthetic_PCB', sourceOccurrenceName: 'Synthetic instance', sourceAssemblyPath: '/1/2/',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), color: [1, 0, 0] as [number, number, number] };
  const out = assemble({ instances: [{ model: 0, matrix: IDENTITY }, { model: 0, matrix: translation(5, 0, 0) }, { model: 1, matrix: IDENTITY }] }, [[part], [part]]);
  expect(out).toHaveLength(3);
  expect(new Set(out.map((p) => p.sourceAssemblyPath)).size).toBe(3);
  expect(new Set(out.map(p=>p.readerMeshId)).size).toBe(3);
  expect(out.every((p) => p.sourceProductName === part.sourceProductName && p.sourceOccurrenceName === part.sourceOccurrenceName)).toBe(true);
  expect(out[1]!.positions[0]).toBe(5);
  expect(part.sourceAssemblyPath).toBe('/1/2/');
});

it('forwards the explicit profile/artwork for multi-file builds, keeping historical options unchanged', async () => {
  const stl = new Uint8Array(readFileSync(new URL('./fixtures/models/tetra.stl', import.meta.url)));
  const svg = new TextEncoder().encode('<svg/>');
  const sources = [{ path: 'synthetic/top.stl', sha256: sha256Hex(stl) }, { path: 'synthetic/bottom.stl', sha256: sha256Hex(stl) },
    { path: 'depictions/synthetic/board-top.svg', sha256: sha256Hex(svg) }, { path: 'depictions/synthetic/board-bottom.svg', sha256: sha256Hex(svg) }];
  const read = (path: string): Uint8Array => path.endsWith('.stl') ? stl : svg;
  const files = vi.fn<Converter['files']>().mockResolvedValue({ glb: new Uint8Array(), format: 'stl', stats: { triangles: 0, sourceTriangles: 0, simplified: false, parts: 0, glbBytes: 0, ms: 0 } });
  const unused = async (): Promise<never> => { throw new Error('Wrong conversion path'); };
  for (const profile of ['legacy', 'exporter', 'occurrence'] as const) {
    await buildLinkedModel({ record: 'bodies/synthetic', sourceKind: 'kicad-library', asset: sourceKey(sources,150_000,undefined,profile), files: sources, src: 'synthetic example' }, read, { files, model: unused, assembly: unused });
    expect(files.mock.lastCall?.[1]).toEqual(profile === 'occurrence' ? { maxTriangles:150_000, boardTextureProfile:profile, boardArt:{top:'<svg/>',bottom:'<svg/>'} } : {maxTriangles:150_000});
  }
  vi.stubEnv('WIREHUB_OCCT_STYLES_DIR','');
  await expect(buildLinkedModel({ record:'bodies/synthetic',sourceKind:'kicad-library',asset:sourceKey(sources,150_000,undefined,'occurrence'),files:sources,src:'synthetic example' },read)).rejects.toThrow(/must be built and mounted/);
}, 30_000);

it('keeps direct STL and GLB pass-through formats independent of the optional reader', async () => {
  vi.stubEnv('WIREHUB_OCCT_STYLES_DIR','');
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/models/tetra.stl',import.meta.url)));
  const old = await convertModel(bytes,'synthetic.stl',{maxTriangles:150_000});
  const next = await convertModel(bytes,'synthetic.stl',{maxTriangles:150_000,boardTextureProfile:'occurrence'});
  expect(next.glb).toEqual(old.glb);
  expect(next.format).toBe('stl');
  const glb = await convertModel(old.glb,'synthetic.glb',{boardTextureProfile:'occurrence'});
  expect(glb.glb).toEqual(old.glb);
  expect(glb.format).toBe('glb');
});
