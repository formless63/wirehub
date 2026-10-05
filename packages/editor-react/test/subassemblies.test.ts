/** Sub-assemblies on the canvas: a block with its ports, edges to them, the store's edits, the palette and the library helpers. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign, loadDesigns } from '@wirehub/catalog';
import { createVersion, withAssemblies, type AssemblyLibrary, type CableDesign } from '@wirehub/model';

import { dbWithLibrary, mergeLibraries, missingDesigns, versionsOf } from '../src/assemblies.ts';
import { deriveFlow, type SubassemblyNodeData } from '../src/derive.ts';
import { cardDataOf } from '../src/lod.ts';
import { defTerminals } from '../src/picker.ts';
import { editorReducer, initialEditorState } from '../src/store.ts';
import { subassemblyEntries } from '../src/panels/Palette.tsx';

const live = loadDb();
const library: AssemblyLibrary = { working: loadDesigns() };
const db = withAssemblies(live, library);
const y = (): CableDesign => structuredClone(loadDesign('dc-y-from-leads'));

describe('the canvas', () => {
  it('draws a sub-assembly as a block with a row per port, grouped by end', () => {
    const flow = deriveFlow(y(), db);
    const node = flow.nodes.find((n) => n.id === 'lead-1')!;
    expect(node.type).toBe('subassembly');
    const data = node.data as SubassemblyNodeData;
    expect(data).toMatchObject({ kind: 'subassembly', def: 'dc-pigtail-lead', subtitle: 'working copy', missingDef: false });
    expect(data.rows.map((r) => r.key)).toEqual(['lead-1:j1:1', 'lead-1:j1:2', 'lead-1:w1@b:red', 'lead-1:w1@b:black']);
    expect(data.groups.map((g) => [g.label, g.count])).toEqual([
      ['JST XH 2-pin housing, DC (1 = +V)', 2],
      ['w1 end b (flying)', 2],
    ]);
    expect(data.rows.filter((r) => r.used).map((r) => r.terminal)).toEqual(['w1@b:red', 'w1@b:black']);
    expect(cardDataOf(node)).toMatchObject({ part: 'subassembly', title: data.title });
  });

  it('draws every joint to a port as an edge between the handles', () => {
    const flow = deriveFlow(y(), db);
    const handles = flow.edges.flatMap((e) => [e.sourceHandle, e.targetHandle]);
    for (const key of ['lead-1:w1@b:red', 'lead-2:w1@b:black', 'j1:1', 'j1:2']) expect(handles).toContain(key);
  });

  it('still draws the landed ports of a design it cannot open', () => {
    const flow = deriveFlow(y(), live);
    const data = flow.nodes.find((n) => n.id === 'lead-2')!.data as SubassemblyNodeData;
    expect(data.missingDef).toBe(true);
    expect(data.rows.map((r) => r.terminal)).toEqual(['w1@b:black', 'w1@b:red']);
  });
});

describe('the store', () => {
  it('places a design, connects to its port, pins and unpins it', () => {
    const base: CableDesign = { schemaVersion: 4, id: 'p', label: 'P', instances: { connectors: [{ id: 'j1', def: 'terminal-block-4' }], segments: [], components: [], pcbas: [] }, joints: [], src: 'test' };
    let state = initialEditorState(base, db);
    state = editorReducer(state, { type: 'add-instance', kind: 'subassembly', def: 'dc-pigtail-lead' });
    expect(state.rejection).toBeUndefined();
    expect(state.design.schemaVersion).toBe(5);
    expect(state.design.instances.subassemblies).toEqual([{ id: 'sa1', def: 'dc-pigtail-lead' }]);
    state = editorReducer(state, { type: 'add-joint', a: { instance: 'j1', terminal: '1' }, b: { instance: 'sa1', terminal: 'w1@b:red' } });
    expect(state.design.joints).toHaveLength(1);
    // a port that is not there is refused
    const refused = editorReducer(state, { type: 'add-joint', a: { instance: 'j1', terminal: '2' }, b: { instance: 'sa1', terminal: 'w1@a:red' } });
    expect(refused.design).toBe(state.design);
    expect(refused.rejection).toBeDefined();

    const rev1 = createVersion({ design: loadDesign('dc-pigtail-lead'), db: live, rev: 1, at: '2026-10-05T00:00:00.000Z', by: 't', note: 'one' });
    state = editorReducer(state, { type: 'load-db', db: withAssemblies(live, { ...library, versions: [{ designId: 'dc-pigtail-lead', rev: 1, released: true, design: rev1.design, definitions: rev1.definitions }] }) });
    state = editorReducer(state, { type: 'update-instance', id: 'sa1', patch: { rev: 1 } });
    expect(state.design.instances.subassemblies![0]!.rev).toBe(1);
    state = editorReducer(state, { type: 'update-instance', id: 'sa1', patch: { rev: undefined } });
    expect(state.design.instances.subassemblies![0]!.rev).toBeUndefined();
    state = editorReducer(state, { type: 'delete-instance', id: 'sa1' });
    expect(state.design.joints).toEqual([]);
  });

  it('offers a placed design\'s ports to the node picker', () => {
    expect(defTerminals('subassembly', 'dc-pigtail-lead', db).map((t) => t.terminal)).toEqual(['j1:1', 'j1:2', 'w1@b:red', 'w1@b:black']);
    expect(defTerminals('subassembly', 'dc-pigtail-lead', live)).toEqual([]);
  });
});

describe('the palette and the library', () => {
  it('offers the other designs as sub-assemblies, never the design itself', () => {
    const entries = subassemblyEntries([{ id: 'b', label: 'B' }, { id: 'a', label: 'A' }, { id: 'me', label: 'Me' }], 'me');
    expect(entries.map((e) => [e.kind, e.def])).toEqual([
      ['subassembly', 'a'],
      ['subassembly', 'b'],
    ]);
  });

  it('merges libraries, names what is missing, and lists a design\'s versions', () => {
    const one: AssemblyLibrary = { working: [loadDesign('dc-pigtail-lead')], versions: [{ designId: 'dc-pigtail-lead', rev: 1, released: false }] };
    const two: AssemblyLibrary = { working: [], versions: [{ designId: 'dc-pigtail-lead', rev: 1, released: true }, { designId: 'dc-pigtail-lead', rev: 2, released: true }] };
    const merged = mergeLibraries(one, two)!;
    expect(versionsOf(merged, 'dc-pigtail-lead')).toEqual([
      { rev: 2, released: true },
      { rev: 1, released: true },
    ]);
    expect(missingDesigns(y(), undefined)).toEqual(['dc-pigtail-lead']);
    expect(missingDesigns(y(), merged, ['de9-crossover'])).toEqual(['de9-crossover']);
    expect(dbWithLibrary(live, undefined)).toBe(live);
    expect(dbWithLibrary(live, one).assemblies?.working.map((d) => d.id)).toEqual(['dc-pigtail-lead']);
  });
});
