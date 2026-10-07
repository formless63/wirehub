/** Opt-in real WASM/child acceptance: run with the supported read-only artifact mounted. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { occurrenceFactory } from '../server/models/occurrence-reader.ts';
import { readStep } from '../server/models/step.ts';
import { convertModel, convertModelFiles } from '../server/models/convert.ts';
import { readGlbJson } from '../server/models/glb.ts';
import { applyBoardTexture } from '../server/models/board-texture.ts';
interface RawMesh {
  name?: string; sourceProductName?: string; sourceOccurrenceName?: string; sourceAssemblyPath?: string;
  color?: number[]; attributes: { position: { array: number[] }; normal?: { array: number[] } };
  index: { array: number[] }; brep_faces?: { first: number; last: number; color: number[] | null }[];
}
interface Reader { ReadStepFile(bytes: Uint8Array, options: object): { success: boolean; meshes: RawMesh[] } }
const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: .001, angularDeflection: .5 };
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/step-styles/${name}.step`, import.meta.url)));
const geometry = (meshes: RawMesh[]): unknown => meshes.map((m) => ({ attributes: m.attributes, index: m.index, faces: m.brep_faces?.map(({ first, last }) => ({ first, last })) }));
const near = (a: number[] | null | undefined, b: number[]): boolean => a !== undefined && a !== null && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < .00001);
const dir = process.env['WIREHUB_OCCT_STYLES_DIR'];
let readers: Promise<{ old: Reader; next: Reader }> | undefined;
const load = (): Promise<{ old: Reader; next: Reader }> => readers ??= (async () => ({
  old: await (createRequire(import.meta.url)('occt-import-js') as () => Promise<Reader>)(),
  next: await occurrenceFactory(dir!)() as Reader,
}))();
const art = { top: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 8"><rect width="10" height="8" fill="red"/></svg>', bottom: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 8"><rect width="10" height="8" fill="blue"/></svg>' };

describe.skipIf(dir === undefined || dir === '')('pinned occurrence reader', () => {
  it.each(['occurrence-colors', 'face-colors', 'nested-location-colors', 'named-board-coatings', 'coincident-occurrence-colors'])('keeps every raw vertex, normal, triangle and face range: %s', async (name) => {
    const { old, next } = await load(); const bytes = fixture(name);
    const before = old.ReadStepFile(bytes, params); const after = next.ReadStepFile(bytes, params);
    expect(before.success).toBe(true); expect(after.success).toBe(true);
    expect(geometry(after.meshes)).toEqual(geometry(before.meshes));
  });
  it('keeps occurrence colors separate for the same product at different locations', async () => {
    const { next } = await load(); const meshes = next.ReadStepFile(fixture('occurrence-colors'), params).meshes;
    expect(meshes).toHaveLength(2);
    expect(meshes.some((m) => near(m.color, [.8, .1, .1]))).toBe(true);
    expect(meshes.some((m) => near(m.color, [.1, .8, .1]))).toBe(true);
    expect(meshes.map((m) => m.sourceProductName)).toEqual(['Synthetic repeated component', 'Synthetic repeated component']);
    expect(new Set(meshes.map((m) => m.sourceOccurrenceName))).toEqual(new Set(['Synthetic red occurrence', 'Synthetic green occurrence']));
  });
  it('retains source-distinguished colors even for same-named coincident instances', async () => {
    const {next}=await load();
    const meshes=next.ReadStepFile(fixture('coincident-occurrence-colors'),params).meshes;
    expect(meshes).toHaveLength(2);
    expect(meshes.map(m=>m.sourceProductName)).toEqual(['Synthetic coincident product','Synthetic coincident product']);
    expect(meshes.every(m=>m.sourceOccurrenceName==='Synthetic coincident occurrence')).toBe(true);
    expect(meshes.some(m=>near(m.color,[.8,.1,.1])&&m.brep_faces?.every(f=>near(f.color,[.8,.1,.1])))).toBe(true);
    expect(meshes.some(m=>near(m.color,[.1,.8,.1])&&m.brep_faces?.every(f=>near(f.color,[.1,.8,.1])))).toBe(true);
  });
  it('restores face overrides lost by the legacy reader under nested repeated locations', async () => {
    const { old, next } = await load(); const bytes = fixture('nested-location-colors');
    const before = old.ReadStepFile(bytes, params).meshes;
    const after = next.ReadStepFile(bytes, params).meshes;
    expect(before.flatMap((m) => m.brep_faces ?? []).filter((f) => f.color !== null)).toHaveLength(0);
    expect(after.flatMap((m) => m.brep_faces ?? []).filter((f) => near(f.color, [.9, .8, .1]))).toHaveLength(2);
    expect(after.map((m) => m.sourceProductName)).toEqual(['Synthetic nested component', 'Synthetic nested component']);
    expect(after.every((m) => m.sourceOccurrenceName === 'Synthetic nested occurrence')).toBe(true);
    expect(new Set(after.map((m) => m.sourceAssemblyPath)).size).toBe(2);
  });
  it('retains named coating geometry and paints both actual outer faces', async () => {
    const bytes = fixture('named-board-coatings');
    const parts = await readStep(bytes, .001, false, 'occurrence');
    const masks = parts.filter((p) => p.sourceProductName?.endsWith('_soldermask'));
    expect(masks).toHaveLength(2);
    const painted = await applyBoardTexture(parts, art, 'occurrence');
    expect(painted.reduce((n, p) => n + p.indices.length, 0)).toBe(parts.reduce((n, p) => n + p.indices.length, 0));
    const outer = painted.filter((p) => p.sourceProductName?.endsWith('_soldermask'));
    expect(outer).toHaveLength(2);
    expect(outer.every((p) => p.image !== undefined && p.uv !== undefined)).toBe(true);
    expect(outer.some((p) => p.name.endsWith('-top'))).toBe(true);
    expect(outer.some((p) => p.name.endsWith('-bottom'))).toBe(true);
    const converted = await convertModel(bytes, 'synthetic.step', { boardArt: art, boardTextureProfile: 'occurrence', maxTriangles: 150_000 });
    const glb = readGlbJson(converted.glb)!;
    expect(glb['images']).toHaveLength(2);
    const nodes = glb['nodes'] as { extras?: { sourceProductName?: string } }[];
    expect(nodes.filter((n) => n.extras?.sourceProductName?.endsWith('_soldermask'))).toHaveLength(2);
  }, 30_000);
  it('keeps the multi-STL geometry/placement while preflighting the explicit profile in the child', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/models/tetra.stl', import.meta.url)));
    const files = [{bytes,name:'one.stl'},{bytes,name:'two.stl'}];
    const old = await convertModelFiles(files,{maxTriangles:150_000});
    const next = await convertModelFiles(files,{maxTriangles:150_000,boardTextureProfile:'occurrence'});
    expect(next.format).toBe('stl');
    expect(next.stats.triangles).toBe(old.stats.triangles);
    const before=readGlbJson(old.glb)!,after=readGlbJson(next.glb)!;
    expect(after['accessors']).toEqual(before['accessors']);
    expect(after['meshes']).toEqual(before['meshes']);
    expect(after['nodes']).toEqual(before['nodes']);
  }, 30_000);
  it('does not change a legacy cold conversion when the optional artifact is installed', async () => {
    const bytes = fixture('nested-location-colors');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('5cc9e97e7fd61342c5bae76e8d2a536dc0c078bf58b54742deaa014034161baf');
    const before = await convertModel(bytes, 'synthetic.step', { boardTextureProfile: 'legacy', maxTriangles: 150_000 });
    // Independently captured from the released npm-reader converter.
    expect(createHash('sha256').update(before.glb).digest('hex')).toBe('f408e38efb3f087aef841ee58dee29f6c51f9cc7842a37bf7ac234f1dc96e508');
    const after = await convertModel(bytes, 'synthetic.step', { boardTextureProfile: 'legacy', maxTriangles: 150_000 });
    expect(after.glb).toEqual(before.glb);
  }, 30_000);
});
