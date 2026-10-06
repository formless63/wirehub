/** Auxiliary ownership follows an installed pack while local content stays local. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { reconcilePackAuxiliary, assetSha } from '../src/packs.ts';
import { applyPackDisable, applyPackUpdate, fsCatalogSource, installPack, planPackDisable, planPackUpdate, readInstalledPacks, catalogWithPacksSource, installPackLayer, planNewPack, memoryCatalogSource, packSourceProblems } from '../src/index.ts';

const work = mkdtempSync(join(tmpdir(), 'wirehub-auxiliary-'));
afterAll(() => rmSync(work, { force: true, recursive: true }));
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const put = (dir: string, path: string, value: unknown) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), json(value)); };
const link = (record: string, asset: string) => ({ record, asset: asset.repeat(64), sourceKind: 'vendor', src: 'synthetic example' });

it('replaces/removes untouched sidecars and model links, preserving local edits and unrelated links', () => {
  const data = join(work, 'data');
  const one = join(work, 'one');
  const two = join(work, 'two');
  for (const file of ['connectors', 'wires', 'components']) put(data, `${file}.json`, []);
  for (const [dir, version] of [[one, '1.0.0'], [two, '1.1.0']]) {
    put(dir!, 'wirehub-pack.json', { format: 1, id: 'aux', name: 'Aux', version, license: 'CC0-1.0' });
    put(dir!, 'drawings/demo.json', { title: version });
    put(dir!, 'models.json', { src: 'synthetic example', links: [link('revisions/demo/one', dir === one ? 'a' : 'b')] });
  }
  put(one, 'drawings/dropped.json', { title: 'old' });
  put(one, 'drawings/edited.json', { title: 'pack' });
  installPack(data, one);
  const recorded = readInstalledPacks(data).packs[0]!;
  expect(Object.keys(recorded.auxiliary!.models)).toEqual(['revisions/demo/one']);
  put(data, 'drawings/edited.json', { title: 'local' });
  put(data, 'models.json', { src: 'synthetic example', links: [link('revisions/demo/one', 'a'), link('revisions/local/one', 'c')] });
  const plan = planPackUpdate(fsCatalogSource(data), [recorded], two);
  expect(plan.ok).toBe(true);
  applyPackUpdate(data, undefined, two, plan, 'merged');
  expect(JSON.parse(readFileSync(join(data, 'drawings/demo.json'), 'utf8')).title).toBe('1.1.0');
  expect(fsCatalogSource(data).read('drawings/dropped.json')).toBeUndefined();
  expect(JSON.parse(readFileSync(join(data, 'drawings/edited.json'), 'utf8')).title).toBe('local');
  expect(JSON.parse(readFileSync(join(data, 'models.json'), 'utf8')).links).toEqual([link('revisions/demo/one', 'b'), link('revisions/local/one', 'c')]);
  const packs = readInstalledPacks(data).packs;
  applyPackDisable(data, undefined, 'aux', planPackDisable(fsCatalogSource(data), packs, 'aux'), 'merged');
  expect(fsCatalogSource(data).read('drawings/demo.json')).toBeUndefined();
  expect(JSON.parse(readFileSync(join(data, 'models.json'), 'utf8')).links).toEqual([link('revisions/local/one', 'c')]);
});

it('preview and layered installs preserve pre-existing sidecars and links', () => {
  const data = join(work, 'local');
  const pack = join(work, 'incoming');
  const packs = join(work, 'layers');
  for (const file of ['connectors', 'wires', 'components']) put(data, `${file}.json`, []);
  put(data, 'drawings/shared.json', { title: 'Local' });
  put(data, 'models.json', { src: 'synthetic example', links: [link('revisions/shared/one', 'a')] });
  put(pack, 'wirehub-pack.json', { format: 1, id: 'shared', name: 'Shared', version: '1.0.0', license: 'CC0-1.0' });
  put(pack, 'drawings/shared.json', { title: 'Pack' });
  put(pack, 'models.json', { src: 'synthetic example', links: [link('revisions/shared/one', 'b'), link('revisions/new/one', 'c')] });
  expect(planNewPack(fsCatalogSource(data), [], pack).ok).toBe(true);
  installPackLayer(data, packs, pack);
  const view = catalogWithPacksSource(data, packs);
  expect(JSON.parse(view.read('drawings/shared.json')!).title).toBe('Local');
  expect(JSON.parse(view.read('models.json')!).links).toEqual([link('revisions/new/one', 'c'), link('revisions/shared/one', 'a')]);
  const recorded = readInstalledPacks(packs).packs[0]!;
  expect(recorded.auxiliary!.files).toEqual({});
  expect(Object.keys(recorded.auxiliary!.models)).toEqual(['revisions/new/one']);
});

it('legacy layered update previews replace old sidecars and links using the view without the layer', () => {
  const data = join(work, 'legacy');
  const pack = join(work, 'legacy-pack');
  const packs = join(work, 'legacy-layers');
  for (const file of ['connectors', 'wires', 'components']) put(data, `${file}.json`, []);
  put(pack, 'wirehub-pack.json', { format: 1, id: 'legacy', name: 'Legacy', version: '1.0.0', license: 'CC0-1.0' });
  put(pack, 'drawings/example.json', { title: 'Old' });
  put(pack, 'models.json', { src: 'synthetic example', links: [link('revisions/example/one', 'a')] });
  installPackLayer(data, packs, pack);
  const recorded = readInstalledPacks(packs).packs[0]!;
  delete recorded.auxiliary;
  put(pack, 'wirehub-pack.json', { format: 1, id: 'legacy', name: 'Legacy', version: '1.1.0', license: 'CC0-1.0' });
  put(pack, 'drawings/example.json', { title: 'New' });
  put(pack, 'models.json', { src: 'synthetic example', links: [link('revisions/example/one', 'b')] });
  const plan = planPackUpdate(catalogWithPacksSource(data, packs), [recorded], pack, { without: fsCatalogSource(data) });
  expect(JSON.parse(plan.writes.get('drawings/example.json')!).title).toBe('New');
  expect(JSON.parse(plan.writes.get('models.json')!).links).toEqual([link('revisions/example/one', 'b')]);
  applyPackUpdate(data, packs, pack, plan, 'layer');
  expect(catalogWithPacksSource(data, packs).read('drawings/example.json')).toBe(plan.writes.get('drawings/example.json'));
});

it('legacy merged installs and locally edited model links are never deleted by guessed ownership', () => {
  const data = join(work, 'legacy-merged');
  const pack = join(work, 'legacy-merged-pack');
  for (const file of ['connectors', 'wires', 'components']) put(data, `${file}.json`, []);
  put(pack, 'wirehub-pack.json', { format: 1, id: 'old', name: 'Old', version: '1.0.0', license: 'CC0-1.0' });
  put(pack, 'models.json', { src: 'synthetic example', links: [link('revisions/old/one', 'a')] });
  put(pack, 'drawings/old.json', { title: 'Old' });
  installPack(data, pack);
  const recorded = readInstalledPacks(data).packs[0]!;
  put(data, 'models.json', { src: 'synthetic example', links: [link('revisions/old/one', 'b')] });
  const view = fsCatalogSource(data);
  const edited = planPackDisable(view, [recorded], 'old');
  expect(edited.writes.has('models.json')).toBe(false);
  delete recorded.auxiliary;
  const legacy = planPackDisable(view, [recorded], 'old');
  expect(legacy.writes.has('drawings/old.json')).toBe(false);
  expect(legacy.writes.has('models.json')).toBe(false);
});

it('additional lists, tag leaves and singleton settings follow their pack without taking local keys', () => {
  const data = join(work, 'other');
  const one = join(work, 'other-one');
  const two = join(work, 'other-two');
  const src = 'synthetic example';
  for (const file of ['connectors', 'wires', 'components']) put(data, `${file}.json`, []);
  put(data, 'wire-parts.json', [{ id: 'local', label: 'Local', src }]);
  put(data, 'tags/demo.json', { src, section: { local: 'Local' }, blocked: 'Local scalar' });
  for (const [dir, version] of [[one, '1.0.0'], [two, '1.1.0']] as const) {
    put(dir, 'wirehub-pack.json', { format: 1, id: 'other', name: 'Other', version, license: 'CC0-1.0' });
    put(dir, 'wire-parts.json', [{ id: 'pack', kind: 'conductor', label: version, src }]);
    put(dir, 'tags/demo.json', { src, section: { pack: version }, blocked: { leaf: 'Must not replace local scalar' } });
    put(dir, 'settings/demo.json', { src, value: version });
  }
  installPack(data, one);
  expect(JSON.parse(fsCatalogSource(data).read('tags/demo.json')!).blocked).toBe('Local scalar');
  const packs = readInstalledPacks(data).packs;
  applyPackUpdate(data, undefined, two, planPackUpdate(fsCatalogSource(data), packs, two), 'merged');
  expect(JSON.parse(fsCatalogSource(data).read('wire-parts.json')!).map((r: { label: string }) => r.label)).toEqual(['Local', '1.1.0']);
  expect(JSON.parse(fsCatalogSource(data).read('tags/demo.json')!).section).toEqual({ local: 'Local', pack: '1.1.0' });
  expect(JSON.parse(fsCatalogSource(data).read('settings/demo.json')!).value).toBe('1.1.0');
  const next = readInstalledPacks(data).packs;
  applyPackDisable(data, undefined, 'other', planPackDisable(fsCatalogSource(data), next, 'other'), 'merged');
  expect(JSON.parse(fsCatalogSource(data).read('wire-parts.json')!).map((r: { id: string }) => r.id)).toEqual(['local']);
  expect(JSON.parse(fsCatalogSource(data).read('tags/demo.json')!)).toEqual({ src, section: { local: 'Local' }, blocked: 'Local scalar' });
  expect(fsCatalogSource(data).read('settings/demo.json')).toBeUndefined();
});

it('preserves incompatible local list/document shapes and local tag subtrees across structural changes', () => {
  const src = 'synthetic example';
  const source = (files: Record<string, unknown>) => memoryCatalogSource(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, json(value)])));
  const path = 'settings/incompatible.json';
  const original = { src, local: 'keep' };
  const incoming = [{ id: 'pack-entry', src }];
  const preview = planNewPack(source({ [path]: original }), [], (() => {
    const pack = join(work, 'incompatible-pack');
    put(pack, 'wirehub-pack.json', { format: 1, id: 'incompatible', name: 'Incompatible', version: '1.0.0', license: 'CC0-1.0' });
    put(pack, path, incoming);
    return pack;
  })());
  expect(preview.writes.has(path)).toBe(false);
  const tag = 'tags/structural.json';
  const before = { files: {}, models: {}, keys: { [tag]: { '["section","pack"]': assetSha('entry.json', json('old')) } } };
  const changed = reconcilePackAuxiliary(source({ [tag]: { src, section: { local: 'keep', pack: 'old' } } }), before, source({ [tag]: { src, section: 'new scalar' } }));
  expect(JSON.parse(changed.writes.get(tag)!)).toEqual({ src, section: { local: 'keep' } });
  expect(changed.owned.keys?.[tag]?.['["section"]']).toBeUndefined();
  const scalarBefore = { files: {}, models: {}, keys: { [tag]: { '["section"]': assetSha('entry.json', json('old scalar')) } } };
  const expanded = reconcilePackAuxiliary(source({ [tag]: { src, section: 'old scalar' } }), scalarBefore, source({ [tag]: { src, section: { pack: 'new leaf' } } }));
  expect(JSON.parse(expanded.writes.get(tag)!)).toEqual({ src, section: { pack: 'new leaf' } });
  const blocked = reconcilePackAuxiliary(source({ [tag]: { src, section: 'local scalar' } }), scalarBefore, source({ [tag]: { src, section: { pack: 'new leaf' } } }));
  expect(blocked.writes.has(tag)).toBe(false);
});

it('reports malformed model link lists before auxiliary planning', () => {
  const pack = join(work, 'malformed-model-pack');
  put(pack, 'wirehub-pack.json', { format: 1, id: 'malformed-model', name: 'Malformed model', version: '1.0.0', license: 'CC0-1.0' });
  put(pack, 'models.json', { src: 'synthetic example', links: {} });
  expect(packSourceProblems(pack)).toContain('models.json: expected an object with a links array of model records.');
});
