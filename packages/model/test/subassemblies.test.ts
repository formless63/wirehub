/** Sub-assemblies: a design placed in another, its ports, flattening, validation and freezing. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign, loadDesigns } from '@wirehub/catalog';

import {
  addInstance,
  createVersion,
  deriveNets,
  designChangeLines,
  errors,
  flattenSubassemblies,
  parseSubassemblyPortId,
  pinSubassemblies,
  removeInstance,
  resolveTerminal,
  schemaVersionFor,
  subassemblyParents,
  subassemblyPortId,
  subassemblyPorts,
  terminalsOf,
  trace,
  updateInstance,
  upgradeDesignSchema,
  validateDesign,
  validateVersion,
  withAssemblies,
  type AssemblyLibrary,
  type CableDesign,
  type Db,
} from '../src/index.ts';

const live = loadDb();
const lead = (): CableDesign => structuredClone(loadDesign('dc-pigtail-lead'));
const y = (): CableDesign => structuredClone(loadDesign('dc-y-from-leads'));
const library = (extra: Partial<AssemblyLibrary> = {}): AssemblyLibrary => ({ working: loadDesigns(), ...extra });
const db = (extra: Partial<AssemblyLibrary> = {}): Db => withAssemblies(live, library(extra));
const codes = (design: CableDesign, on: Db): string[] => validateDesign(design, on).map((i) => i.code);

/** A saved version of the pigtail lead, as a host would list it. */
const savedLead = (rev: number, released: boolean, change?: (d: CableDesign) => void) => {
  const design = lead();
  change?.(design);
  const file = createVersion({ design, db: live, rev, at: '2026-10-05T00:00:00.000Z', by: 'tester', note: `rev ${rev}` });
  return { designId: 'dc-pigtail-lead', rev, released, design: file.design, definitions: file.definitions };
};

describe('ports', () => {
  it('are every connector pin and the conductors of a free wire end', () => {
    const ports = subassemblyPorts(lead(), live);
    expect(ports.map((p) => p.id)).toEqual(['j1:1', 'j1:2', 'w1@b:red', 'w1@b:black']);
    expect(ports.find((p) => p.id === 'w1@b:red')).toMatchObject({ kind: 'lead', group: 'w1@b', label: '+V', ref: { instance: 'w1', terminal: 'red', end: 'b' } });
    expect(ports.find((p) => p.id === 'j1:1')).toMatchObject({ kind: 'pin', group: 'j1' });
  });

  it('round-trip through their ids', () => {
    for (const ref of [
      { instance: 'j1', terminal: '3' },
      { instance: 'w1', terminal: 'pair-1.a', end: 'b' as const },
      { instance: 'u1', terminal: 'scart.15' },
    ]) {
      expect(parseSubassemblyPortId(subassemblyPortId(ref))).toEqual(ref);
    }
    expect(parseSubassemblyPortId('lead-1:j2:1')).toEqual({ instance: 'lead-1', terminal: 'j2:1' });
    expect(parseSubassemblyPortId('nonsense')).toBeUndefined();
  });

  it('are the terminals of the sub-assembly instance, resolved with their labels', () => {
    const terminals = terminalsOf(y(), db(), 'lead-1');
    expect(terminals.map((t) => t.key)).toEqual(['lead-1:j1:1', 'lead-1:j1:2', 'lead-1:w1@b:red', 'lead-1:w1@b:black']);
    expect(terminals[2]).toMatchObject({ instanceKind: 'subassembly', def: 'dc-pigtail-lead', label: 'w1 end b (flying) +V' });
  });

  it('of a nested sub-assembly are the ports its parent leaves free', () => {
    const outer: CableDesign = {
      schemaVersion: 5,
      id: 'outer',
      label: 'Outer',
      instances: { connectors: [], segments: [], components: [], pcbas: [], subassemblies: [{ id: 'y1', def: 'dc-y-from-leads' }] },
      joints: [],
      src: 'test',
    };
    const ids = terminalsOf(outer, db(), 'y1').map((t) => t.terminal);
    // the Y's own terminal block, then its leads' connectors (their flying ends are landed inside the Y)
    expect(ids).toEqual(['j1:1', 'j1:2', 'j1:3', 'j1:4', 'lead-1:j1:1', 'lead-1:j1:2', 'lead-2:j1:1', 'lead-2:j1:2']);
  });
});

describe('validation', () => {
  it('passes the starter Y with its library, and without one (ports unverified)', () => {
    expect(validateDesign(y(), db())).toEqual([]);
    expect(errors(validateDesign(y(), live))).toEqual([]);
    expect(validateDesign(lead(), live)).toEqual([]);
  });

  it('refuses a joint to a port that is not there, or is connected inside', () => {
    const d = y();
    d.joints.push({ a: { instance: 'j1', terminal: '3' }, b: { instance: 'lead-1', terminal: 'w1@a:red' } });
    d.joints.push({ a: { instance: 'j1', terminal: '4' }, b: { instance: 'lead-1', terminal: 'not-a-port' } });
    const issues = validateDesign(d, db());
    expect(issues.filter((i) => i.code === 'subassembly-unknown-port')).toHaveLength(2);
    expect(issues.find((i) => i.code === 'subassembly-unknown-port')?.message).toMatch(/changed, or that end is connected inside it/);
    // a sub-assembly's terminal never carries an end
    d.joints.push({ a: { instance: 'j1', terminal: '4' }, b: { instance: 'lead-2', terminal: 'j1:1', end: 'a' } });
    expect(codes(d, db())).toContain('unexpected-end');
  });

  it('names a missing design, a missing revision and a cycle', () => {
    const missing = y();
    missing.instances.subassemblies![0]!.def = 'no-such-design';
    expect(codes(missing, db())).toContain('subassembly-unknown-design');

    const pinned = y();
    pinned.instances.subassemblies![0]!.rev = 7;
    expect(codes(pinned, db({ versions: [savedLead(1, true)] }))).toContain('subassembly-unknown-rev');

    const self = y();
    self.instances.subassemblies![0]!.def = 'dc-y-from-leads';
    expect(codes(self, db())).toContain('subassembly-cycle');

    // the lead places the Y that places the lead
    const looping = lead();
    looping.schemaVersion = 5;
    looping.instances.subassemblies = [{ id: 'back', def: 'dc-y-from-leads' }];
    const lib = db({ working: [...loadDesigns().filter((d) => d.id !== 'dc-pigtail-lead'), looping] });
    expect(codes(looping, lib)).toContain('subassembly-cycle');
    expect(codes(y(), lib)).toContain('subassembly-cycle');
  });

  it('warns about an unreleased pin, a newer release and an old schema number', () => {
    const d = y();
    d.instances.subassemblies![0]!.rev = 1;
    d.instances.subassemblies![1]!.rev = 2;
    const on = db({ versions: [savedLead(1, true), savedLead(2, false), savedLead(3, true)] });
    const issues = validateDesign(d, on);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.map((i) => `${i.code} ${i.where}`)).toEqual(
      expect.arrayContaining(['subassembly-newer-rev lead-1', 'subassembly-rev-unreleased lead-2', 'subassembly-newer-rev lead-2']),
    );
    const old = y();
    old.schemaVersion = 4;
    expect(codes(old, db())).toContain('subassembly-schema');
  });

  it('checks the ports of the pinned version, not the working copy', () => {
    // Rev 1 had its flying end on w1@a (the connector at b)
    const flipped = savedLead(1, true, (d) => {
      for (const j of d.joints) j.b.end = 'b';
      d.notes = ['Flying end: w1:red@a and w1:black@a are left free.'];
    });
    const d = y();
    d.instances.subassemblies![0]!.rev = 1;
    expect(validateDesign(d, db({ versions: [flipped] })).map((i) => i.where)).toEqual(expect.arrayContaining(['joints[0] lead-1:w1@b:red']));
  });
});

describe('flattening', () => {
  it('places every part under its sub-assembly and lands the parent joints on what the ports are', () => {
    const flat = flattenSubassemblies(y(), db());
    expect(flat.issues).toEqual([]);
    expect(flat.design.instances.subassemblies).toBeUndefined();
    expect(flat.design.instances.connectors.map((c) => c.id)).toEqual(['j1', 'lead-1/j1', 'lead-2/j1']);
    expect(flat.design.instances.segments.map((s) => s.id)).toEqual(['lead-1/w1', 'lead-2/w1']);
    expect(flat.design.joints).toHaveLength(8);
    expect(flat.design.joints[0]).toMatchObject({ a: { instance: 'j1', terminal: '1' }, b: { instance: 'lead-1/w1', terminal: 'red', end: 'b' } });
    expect(flat.ports.get('lead-2:w1@b:black')).toEqual({ instance: 'lead-2/w1', terminal: 'black', end: 'b' });
    // the flat design is an ordinary design
    expect(errors(validateDesign(flat.design, flat.db))).toEqual([]);
  });

  it('carries nets and traces through the leads', () => {
    const on = db();
    const net = deriveNets(y(), on).find((n) => n.terminals.some((t) => t.key === 'j1:1'))!;
    expect(net.terminals.map((t) => t.key)).toEqual(
      expect.arrayContaining(['j1:1', 'lead-1:j1:1', 'lead-1/j1:1', 'lead-1/w1:red@a', 'lead-1:w1@b:red', 'lead-2/j1:1', 'lead-2:j1:1']),
    );
    const reached = trace(y(), on, { instance: 'lead-1', terminal: 'j1:1' }).reached.map((s) => s.terminal.key);
    expect(reached).toEqual(expect.arrayContaining(['j1:1', 'lead-2/j1:1', 'lead-2:j1:1']));
    expect(reached).not.toContain('lead-2/j1:2');
    // a flat terminal is a valid start too
    expect(trace(y(), on, { instance: 'lead-2/j1', terminal: '2' }).reached.map((s) => s.terminal.key)).toContain('j1:2');
  });

  it('flattens nested sub-assemblies all the way down', () => {
    const outer: CableDesign = {
      schemaVersion: 5,
      id: 'outer',
      label: 'Outer',
      instances: { connectors: [{ id: 'j9', def: 'terminal-block-4' }], segments: [], components: [], pcbas: [], subassemblies: [{ id: 'y1', def: 'dc-y-from-leads' }] },
      joints: [{ a: { instance: 'j9', terminal: '1' }, b: { instance: 'y1', terminal: 'lead-1:j1:1' } }],
      src: 'test',
    };
    const flat = flattenSubassemblies(outer, db());
    expect(flat.design.instances.connectors.map((c) => c.id)).toEqual(['j9', 'y1/j1', 'y1/lead-1/j1', 'y1/lead-2/j1']);
    expect(flat.design.joints[0]).toMatchObject({ b: { instance: 'y1/lead-1/j1', terminal: '1' } });
    const reached = trace(outer, db(), { instance: 'j9', terminal: '1' }).reached.map((s) => s.terminal.key);
    expect(reached).toEqual(expect.arrayContaining(['y1/j1:1', 'y1/lead-2/j1:1']));
    // a port profiles as what it is: a JST pin meeting a terminal block pin is no mating
    expect(validateDesign(outer, db()).map((i) => i.code)).toEqual(['pin-to-foreign-pin']);
  });

  it('keeps a pinned version on its own frozen definitions, renamed where the library moved on', () => {
    const rev1 = savedLead(1, true);
    const moved: Db = { ...live, wires: live.wires.map((w) => (w.id === 'dc-2core-24awg' ? { ...w, odMm: 9 } : w)) };
    const d = y();
    d.instances.subassemblies![0]!.rev = 1;
    const flat = flattenSubassemblies(d, withAssemblies(moved, library({ versions: [rev1] })));
    expect(flat.design.instances.segments.map((s) => s.def)).toEqual(['dc-2core-24awg@dc-pigtail-lead.1', 'dc-2core-24awg']);
    expect(flat.db.wires.find((w) => w.id === 'dc-2core-24awg@dc-pigtail-lead.1')?.odMm).toBe(3.5);
  });
});

describe('editing, versions and where used', () => {
  it('adds, pins, unpins and removes a sub-assembly', () => {
    const base: CableDesign = { schemaVersion: 4, id: 'p', label: 'P', instances: { connectors: [{ id: 'j1', def: 'terminal-block-4' }], segments: [], components: [], pcbas: [] }, joints: [], src: 'test' };
    let d = addInstance(base, 'subassembly', 'dc-pigtail-lead', 'sa1');
    expect(d.schemaVersion).toBe(5);
    expect(schemaVersionFor(d)).toBe(5);
    d = { ...d, joints: [{ a: { instance: 'j1', terminal: '1' }, b: { instance: 'sa1', terminal: 'w1@b:red' } }] };
    d = updateInstance(d, 'sa1', { rev: 2, label: 'LEAD A' });
    expect(d.instances.subassemblies).toEqual([{ id: 'sa1', def: 'dc-pigtail-lead', rev: 2, label: 'LEAD A' }]);
    d = updateInstance(d, 'sa1', { rev: undefined });
    expect(d.instances.subassemblies![0]!.rev).toBeUndefined();
    expect(designChangeLines(base, d)).toEqual(expect.arrayContaining(['+ sub-assembly sa1 (dc-pigtail-lead)']));
    const removed = removeInstance(d, 'sa1');
    expect(removed.instances.subassemblies).toEqual([]);
    expect(removed.joints).toEqual([]);
    expect(upgradeDesignSchema(removed).design.schemaVersion).toBe(4);
    expect(upgradeDesignSchema({ ...d, schemaVersion: 4 }).design.schemaVersion).toBe(5);
  });

  it('freezes an unpinned sub-assembly to its newest release when a version is saved', () => {
    const on = db({ versions: [savedLead(1, true), savedLead(2, true), savedLead(3, false)] });
    const pinned = pinSubassemblies(y(), on);
    expect(pinned.issues).toEqual([]);
    expect(pinned.design.instances.subassemblies!.map((s) => s.rev)).toEqual([2, 2]);
    const file = createVersion({ design: y(), db: on, rev: 0, at: '2026-10-05T00:00:00.000Z', by: 'tester', note: 'first' });
    expect(file.design.instances.subassemblies!.map((s) => s.rev)).toEqual([2, 2]);
    expect(validateVersion(file, on.assemblies)).toEqual([]);
    expect(validateVersion(file).filter((i) => i.severity === 'error')).toEqual([]);

    const none = pinSubassemblies(y(), db());
    expect(none.issues.map((i) => i.code)).toEqual(['subassembly-not-released', 'subassembly-not-released']);
  });

  it('answers where a design is used', () => {
    expect(subassemblyParents(loadDesigns(), 'dc-pigtail-lead')).toEqual([
      { id: 'dc-y-from-leads', label: loadDesign('dc-y-from-leads').label, instances: ['lead-1', 'lead-2'] },
    ]);
    expect(subassemblyParents(loadDesigns(), 'dc-led-lead')).toEqual([]);
  });

  it('resolves a port with what it is inside', () => {
    const result = resolveTerminal(y(), db(), { instance: 'lead-2', terminal: 'j1:2' });
    expect(result.ok && result.terminal.port?.ref).toEqual({ instance: 'j1', terminal: '2' });
  });
});
