import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildLinkedModel, buildProfileOf, type Converter } from '../server/models/build.ts';
import { sha256Hex, sourceKey, type ModelBuild, type SourceFile } from '../server/models/cache.ts';
import type { ModelLink } from '../server/models/links.ts';
import { embeddedFile, parseKicadPcb } from '../server/models/kicad-pcb.ts';
import { reprofileModelLink } from '../server/models/profile.ts';
import { relinkWithArt } from '../server/models/board-art.ts';

const pcb = new Uint8Array(readFileSync(new URL('./fixtures/models/kicad/board.kicad_pcb', import.meta.url)));
const step = new Uint8Array(readFileSync(new URL('./fixtures/models/cube-colours.stp', import.meta.url)));
const stl = new Uint8Array(readFileSync(new URL('./fixtures/models/tetra.stl', import.meta.url)));
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
const data = new Map<string, Uint8Array>([
  ['boards/synthetic.kicad_pcb', pcb], ['data/model-sources/synthetic.kicad_pcb.txt', pcb],
  ['models/synthetic.step', step], ['models/top.stl', stl], ['models/bottom.stl', stl],
  ['depictions/synthetic/board-top.svg', svg], ['depictions/synthetic/board-bottom.svg', svg],
]);
const file = (path: string): SourceFile => ({ path, sha256: sha256Hex(data.get(path)!) });
const art = [file('depictions/synthetic/board-top.svg'), file('depictions/synthetic/board-bottom.svg')];
const read = (path: string): Uint8Array | undefined => data.get(path);
function converter(): Converter {
  const result = { glb: new Uint8Array([1]), format: 'step' as const, stats: { triangles: 0, sourceTriangles: 0, simplified: false, parts: 0, glbBytes: 1, ms: 0 } };
  return { model: vi.fn<Converter['model']>().mockResolvedValue(result), files: vi.fn<Converter['files']>().mockResolvedValue(result), assembly: vi.fn<Converter['assembly']>().mockResolvedValue(result) };
}
function link(files: SourceFile[], build?: ModelBuild): ModelLink {
  return { record: 'bodies/synthetic', sourceKind: 'kicad-board', files, build, asset: sourceKey(files, 150_000, build), src: 'synthetic example' };
}
const options = { maxTriangles: 150_000, boardTextureProfile: 'appearance', boardArt: { top: new TextDecoder().decode(svg), bottom: new TextDecoder().decode(svg) } };

describe('explicit appearance rebuild recipes', () => {
  it.each(['boards/synthetic.kicad_pcb', 'data/model-sources/synthetic.kicad_pcb.txt'])('upgrades embedded connector recipes from %s without requiring a STEP source path', async path => {
    const original = link([file(path), ...art], { kind: 'embedded', name: 'Jack Fixture.step' });
    const upgraded = reprofileModelLink(original, 'appearance');
    expect(upgraded).toEqual({ ...original, asset: sourceKey(original.files!, 150_000, original.build, 'appearance') });
    expect(original.asset).not.toBe(upgraded.asset);
    expect(buildProfileOf(original)?.boardTextureProfile).toBe('exporter');
    expect(buildProfileOf(upgraded)).toEqual({ budget: 150_000, boardTextureProfile: 'appearance' });
    const convert = converter();
    const result = await buildLinkedModel(upgraded, read, convert);
    const embedded = embeddedFile(parseKicadPcb(new TextDecoder().decode(pcb)), 'Jack Fixture.step')!;
    expect(convert.model).toHaveBeenCalledExactlyOnceWith(embedded.bytes, 'Jack Fixture.step', options);
    expect(convert.assembly).not.toHaveBeenCalled();
    expect(convert.files).not.toHaveBeenCalled();
    expect(result.key).toBe(upgraded.asset);
    expect(result.inputs).toEqual(original.files!.map(f => ({ kind: 'source', ref: f.path, sha256: f.sha256 })));
  });

  it('preserves placed transforms while forwarding appearance and paired artwork', async () => {
    const build: ModelBuild = { kind: 'placed', offset: [3, 4, 5], rotate: [0, 0, 90] };
    const upgraded = reprofileModelLink(link([file('models/synthetic.step'), ...art], build), 'appearance');
    const convert = converter();
    await buildLinkedModel(upgraded, read, convert);
    const [plan, , received] = vi.mocked(convert.assembly).mock.calls[0]!;
    expect(plan.models).toEqual([{ name: 'synthetic.step', bytes: step }]);
    expect(plan.instances).toHaveLength(1);
    expect(plan.instances[0]!.matrix.slice(12, 15)).toEqual([3, 4, 5]);
    expect(received).toEqual(options);
    expect(upgraded.build).toEqual(build);
    expect(convert.model).not.toHaveBeenCalled();
  });

  it('keeps embedded footprint models in a board assembly using the appearance profile', async () => {
    const upgraded = reprofileModelLink(link([file('boards/synthetic.kicad_pcb'), ...art], { kind: 'assembly' }), 'appearance');
    const convert = converter();
    await buildLinkedModel(upgraded, read, convert);
    const [plan, , received] = vi.mocked(convert.assembly).mock.calls[0]!;
    expect(plan.models.some(model => model.name === 'Jack Fixture.step')).toBe(true);
    expect(plan.instances.length).toBeGreaterThan(0);
    expect(plan.board).toBeDefined();
    expect(received).toEqual(options);
    expect(convert.model).not.toHaveBeenCalled();
  });

  it('forwards appearance for multiple geometry files while preserving historical exporter options', async () => {
    const original = link([file('models/top.stl'), file('models/bottom.stl'), ...art]);
    const convert = converter();
    await buildLinkedModel(original, read, convert);
    expect(vi.mocked(convert.files).mock.lastCall?.[1]).toEqual({ maxTriangles: 150_000 });
    await buildLinkedModel(reprofileModelLink(original, 'appearance'), read, convert);
    expect(vi.mocked(convert.files).mock.lastCall?.[1]).toEqual(options);
  });

  it('retains the appearance profile when artwork is replaced and refuses unrecognized source keys', () => {
    const original = link([file('models/synthetic.step')]);
    const upgraded = reprofileModelLink(original, 'appearance');
    const painted = relinkWithArt(upgraded, art)!;
    expect(buildProfileOf(painted)).toEqual({ budget: 150_000, boardTextureProfile: 'appearance' });
    expect(painted.asset).toBe(sourceKey(painted.files!, 150_000, undefined, 'appearance'));
    expect(original.files).toHaveLength(1);
    expect(() => reprofileModelLink({ ...original, asset: 'unrecognized' }, 'appearance')).toThrow(/recognized source recipe/);
  });
});
