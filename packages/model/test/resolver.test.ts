/**
 * The device resolver (`devices.ts`, `resolve.ts`, `derive-cable.ts`, `cable-recipe.ts`) over the
 * starter catalog plus a small synthetic library built here: two signals that pair (a transmit
 * onto a receive), a differential pair, a level two inputs disagree on, a recipe that converts
 * it, a termination, an adapter board. Domain examples live in the modules' own tests.
 */

import { describe, expect, it } from 'vitest';
import { loadDb } from '@wirehub/catalog';

import {
  BUILT_IN_HAZARDS,
  bindPort,
  deriveCable,
  deviceLibraryIssues,
  inferCableRecipe,
  recipeDrift,
  recipeJointProposals,
  rederive,
  resolve,
  resolveDevice,
  suggestStocks,
  validateDb,
  validateDesign,
  type CableDesign,
  type ConditioningRecipe,
  type ConnectorDefinition,
  type Db,
  type DeviceProfile,
  type Interface,
  type PcbaDefinition,
  type VocabEntry,
} from '../src/index.ts';

const starter = loadDb();
const SRC = 'synthetic example';

const signal = (id: string, kind: string, extra: Record<string, unknown> = {}): VocabEntry => ({ id, label: id, kind, src: SRC, ...extra }) as VocabEntry;

const iface: Interface = {
  id: 'test-port',
  label: 'Test port on DE-9',
  bodies: ['de9-male', 'de9-female'],
  pins: {
    '1': { signal: 'test-tx', dir: 'out', label: 'TX' },
    '2': { signal: 'test-rx', dir: 'in', label: 'RX' },
    '3': { signal: 'test-a', dir: 'bidir', label: 'A' },
    '4': { signal: 'test-b', dir: 'bidir', label: 'B' },
    '5': { signal: 'gnd-signal', label: 'GND' },
    '6': { signal: 'nc', label: 'n/c' },
    '7': { signal: 'nc', label: 'n/c' },
    '8': { signal: 'nc', label: 'n/c' },
    '9': { signal: 'nc', label: 'n/c' },
    shell: { signal: 'gnd-chassis', label: 'Shell' },
  },
  src: SRC,
};

const plug = (id: string, body: string, gender: 'male' | 'female'): ConnectorDefinition => ({
  id,
  label: id,
  family: 'd-sub',
  gender,
  body,
  interface: 'test-port',
  pins: ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'shell'].map((p) => ({ id: p, label: p, ...(iface.pins[p] ? { signal: iface.pins[p]!.signal } : {}) })),
  src: SRC,
});

const pins = (levels: { tx?: string; rx?: string } = {}) => ({
  '1': { signal: 'test-tx', dir: 'out' as const, ...(levels.tx === undefined ? {} : { level: levels.tx }) },
  '2': { signal: 'test-rx', dir: 'in' as const, ...(levels.rx === undefined ? {} : { level: levels.rx }) },
});

const devices: DeviceProfile[] = [
  { id: 'unit-a', label: 'Unit A', kind: 'instrument', ports: [{ id: 'p1', interface: 'test-port', body: 'de9-male', pins: pins({ tx: 'lvl-hi', rx: 'lvl-hi' }) }], src: SRC },
  { id: 'unit-b', label: 'Unit B', kind: 'instrument', ports: [{ id: 'p1', interface: 'test-port', body: 'de9-male', pins: pins({ tx: 'lvl-hi', rx: 'lvl-hi' }) }], src: SRC },
  // a variant whose receiver takes the low level only
  { id: 'unit-b-low', label: 'Unit B (low-level input)', extends: 'unit-b', ports: [{ id: 'p1', pins: { '2': { signal: 'test-rx', dir: 'in', level: 'lvl-lo' } } }], src: SRC },
  // a bus device that must be terminated
  {
    id: 'bus-node',
    label: 'Bus node',
    ports: [
      {
        id: 'bus',
        interface: 'test-port',
        body: 'de9-female',
        pins: { '1': 'nc', '2': 'nc' },
        requires: [{ id: 'term', conditioning: 'termination', positions: ['3', '4'], src: SRC }],
      },
    ],
    src: SRC,
  },
];

const recipes: ConditioningRecipe[] = [
  { id: 'hi-to-lo', label: 'Divider hi → lo', conditioning: 'series-resistor', from: { level: 'lvl-hi' }, to: { level: 'lvl-lo' }, parts: [{ component: 'r-150', placement: 'series' }, { component: 'r-120', placement: 'shunt' }], src: SRC },
  { id: 'term-120', label: '120 Ω termination', conditioning: 'termination', parts: [{ component: 'r-120', placement: 'across' }], src: SRC },
];

function library(extra: Partial<Db> = {}): Db {
  const vocab = structuredClone(starter.vocab!);
  vocab['signals']!.entries.push(
    signal('test-tx', 'data', { pairsWith: ['test-rx'] }),
    signal('test-rx', 'data'),
    signal('test-a', 'data', { diffPair: 'test-b' }),
    signal('test-b', 'data', { diffPair: 'test-a' }),
  );
  vocab['levels']!.entries.push({ id: 'lvl-hi', label: 'High', src: SRC }, { id: 'lvl-lo', label: 'Low', src: SRC });
  return {
    ...starter,
    vocab,
    interfaces: [...(starter.interfaces ?? []), iface],
    connectors: [...starter.connectors, plug('test-plug-f', 'de9-female', 'female'), plug('test-plug-m', 'de9-male', 'male')],
    devices,
    conditioningRecipes: recipes,
    ...extra,
  };
}

const AB = { source: { device: 'unit-a' }, destination: { device: 'unit-b' } };

describe('devices', () => {
  it('validate clean, and lay a variant over its parent', () => {
    const db = library();
    expect(deviceLibraryIssues(db)).toEqual([]);
    expect(validateDb(db).filter((i) => i.severity === 'error')).toEqual([]);
    const low = resolveDevice(db.devices, 'unit-b-low')!;
    const bound = bindPort(db, low.ports[0]!);
    expect(bound.find((p) => p.position === '2')).toMatchObject({ signal: 'test-rx', level: 'lvl-lo', class: 'signal' });
    expect(bound.find((p) => p.position === '1')).toMatchObject({ signal: 'test-tx', level: 'lvl-hi' });
    expect(bound.find((p) => p.position === 'shell')).toMatchObject({ class: 'chassis' });
    expect(bound.find((p) => p.position === '5')).toMatchObject({ class: 'ground' });
  });

  it('report broken references and loops', () => {
    const db = library({
      devices: [
        ...devices,
        { id: 'loop-1', label: 'L1', extends: 'loop-2', ports: [], src: SRC },
        { id: 'loop-2', label: 'L2', extends: 'loop-1', ports: [], src: SRC },
        { id: 'odd', label: 'Odd', ports: [{ id: 'x', interface: 'no-such-pinout' }], src: SRC },
        { id: 'odd', label: 'Odd twice', ports: [], src: SRC },
        { id: 'odd-2', label: 'Odd again', ports: [{ id: 'y', interface: 'test-port', pins: { '42': { signal: 'test-tx' } } }], src: SRC },
      ],
    });
    const codes = deviceLibraryIssues(db).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['device-extends-cycle', 'device-port-interface', 'device-duplicate', 'device-pin-unknown']));
  });
});

describe('resolve', () => {
  it('pairs a transmit onto the far receive, both ways, and joins the grounds', () => {
    const r = resolve(library(), AB);
    expect(r.problems).toEqual([]);
    const best = r.options[0]!;
    expect(best.kind).toBe('direct');
    expect(best.missing).toEqual([]);
    expect(best.links.map((l) => `${l.from}->${l.to}:${l.how}`).sort()).toEqual(['1->2:pair', '2->1:pair', '3->3:same', '4->4:same']);
    expect(best.grounds).toEqual({ source: ['5'], destination: ['5'] });
    expect(best.chassis).toEqual({ source: ['shell'], destination: ['shell'] });
    expect(best.conductors).toBe(5);
    // pin for pin would put a transmit on a transmit: refused, with the reason
    const straight = r.rejected.find((x) => x.option.kind === 'straight');
    expect(straight?.why.map((w) => w.code)).toContain('hazard:output-contention');
  });

  it('converts a level with a recipe, and calls it missing without one', () => {
    const low = { ...AB, destination: { device: 'unit-b-low' } };
    const r = resolve(library(), low);
    expect(r.options[0]!.kind).toBe('conditioned');
    expect(r.options[0]!.links.find((l) => l.to === '2')?.recipes).toEqual(['hi-to-lo']);
    expect(r.options[0]!.parts).toBe(2);
    const bare = resolve(library({ conditioningRecipes: [] }), low);
    expect(bare.options[0]!.missing.map((m) => m.code)).toEqual(['level-unconverted']);
  });

  it('meets a port requirement with a recipe across two positions', () => {
    const r = resolve(library(), { source: { device: 'unit-a' }, destination: { device: 'bus-node' } });
    const best = r.options[0]!;
    expect(best.requirements).toEqual([{ end: 'destination', requirement: 'term', recipe: 'term-120', positions: ['3', '4'] }]);
    const none = resolve(library({ conditioningRecipes: [recipes[0]!] }), { source: { device: 'unit-a' }, destination: { device: 'bus-node' } });
    expect(none.options[0]!.missing.map((m) => m.code)).toContain('requirement-unmet');
  });

  it('refuses a supply onto a signal, and lets data switch a built-in hazard off', () => {
    const powered: DeviceProfile = { id: 'powered', label: 'Powered', ports: [{ id: 'p1', interface: 'test-port', body: 'de9-male', pins: { ...pins(), '6': { signal: 'pwr-5v', dir: 'out' } } }], src: SRC };
    const listens: DeviceProfile = { id: 'listens', label: 'Listens', ports: [{ id: 'p1', interface: 'test-port', body: 'de9-male', pins: { ...pins(), '6': { signal: 'test-rx', dir: 'in' } } }], src: SRC };
    const db = library({ devices: [...devices, powered, listens] });
    const q = { source: { device: 'powered' }, destination: { device: 'listens' } };
    const r = resolve(db, q);
    expect(r.rejected.find((x) => x.option.kind === 'straight')?.why.map((w) => w.code)).toEqual(expect.arrayContaining(['hazard:power-into-signal']));
    const off = resolve({ ...db, hazards: BUILT_IN_HAZARDS.map((h) => ({ ...h, enabled: false })) }, q);
    expect(off.rejected).toEqual([]);
  });

  it('ranks by the library policy', () => {
    const db = library();
    const byParts = resolve({ ...db, resolverPolicy: { order: ['parts'], src: SRC } }, { source: { device: 'unit-a' }, destination: { device: 'bus-node' } });
    expect(byParts.options.map((o) => o.parts)).toEqual([...byParts.options.map((o) => o.parts)].sort((a, b) => a - b));
    expect(byParts.options[0]!.score).toHaveLength(1);
  });

  it('reports what it cannot resolve', () => {
    expect(resolve(library(), { source: { device: 'nope' }, destination: { device: 'unit-b' } }).problems[0]!.code).toBe('device-unknown');
    expect(resolve(library(), { source: { device: 'unit-a', port: 'x' }, destination: { device: 'unit-b' } }).problems[0]!.code).toBe('port-unknown');
  });
});

describe('an adapter board', () => {
  const board: PcbaDefinition = {
    id: 'test-adapter',
    label: 'Test adapter board',
    partNumber: 'PCA-09999',
    revision: 'A',
    terminals: [{ id: 'X' }, { id: 'Y' }, { id: 'G' }],
    integratedConnectors: [{ connectorDefId: 'test-plug-f', terminalPrefix: 'j1' }],
    internalLinks: [
      { from: 'j1.1', to: 'X', via: 'U1 converter' },
      { from: 'Y', to: 'j1.2', via: 'U1 converter' },
      { from: 'j1.5', to: 'G' },
    ],
    src: SRC,
  };
  const adapter: DeviceProfile = {
    id: 'test-adapter',
    label: 'Test adapter',
    kind: 'adapter',
    board: 'test-adapter',
    ports: [
      { id: 'mate', interface: 'test-port', body: 'de9-female', terminals: 'j1', pins: { '1': { signal: 'test-tx', dir: 'in' }, '2': { signal: 'test-rx', dir: 'out' }, '3': 'nc', '4': 'nc' } },
      { id: 'pads', terminals: '', pins: { X: { signal: 'test-a', dir: 'bidir' }, Y: { signal: 'test-b', dir: 'bidir' }, G: { signal: 'gnd-signal' } } },
    ],
    src: SRC,
  };
  const onlyBus: DeviceProfile = { id: 'only-bus', label: 'Only a bus', ports: [{ id: 'bus', interface: 'test-port', body: 'de9-female', pins: { '1': 'nc', '2': 'nc' } }], src: SRC };
  const txOnly: DeviceProfile = { id: 'tx-only', label: 'Transmit only', ports: [{ id: 'p1', interface: 'test-port', body: 'de9-male', pins: { ...pins(), '3': 'nc', '4': 'nc' } }], src: SRC };
  const db = library({ devices: [...devices, adapter, onlyBus, txOnly], pcbas: [...starter.pcbas, board] });

  it('is an option, and the derived design places the board with no plug at its end', () => {
    const q = { source: { device: 'tx-only' }, destination: { device: 'only-bus' } };
    const r = resolve(db, q);
    expect(r.options[0]!.kind).toBe('board');
    expect(r.options[0]!.boards).toEqual([{ end: 'source', device: 'test-adapter', pcba: 'test-adapter', mate: 'mate', pads: 'pads' }]);
    const d = deriveCable(db, q);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.design.instances.pcbas).toEqual([{ id: 'u1', def: 'test-adapter' }]);
    expect(d.design.instances.connectors.map((c) => c.def)).toEqual(['test-plug-m']);
    expect(validateDesign(d.design, db).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('derive, drift, inference', () => {
  const db = library();
  const derived = (): CableDesign => {
    const d = deriveCable(db, { source: { device: 'unit-a' }, destination: { device: 'unit-b-low' } }, undefined, { lengthMm: 1500, id: 'a-to-b' });
    if (!d.ok) throw new Error(d.reason);
    return d.design;
  };

  it('suggests a stock with a twisted pair for the differential lines and a screen for the shells', () => {
    const option = resolve(db, AB).options[0]!;
    expect(suggestStocks(db, option)[0]!.id).toBe('shielded-2pair-24awg');
  });

  it('derives a design that validates clean and carries its recipe', () => {
    const design = derived();
    expect(design.status).toBe('development');
    expect(design.recipe).toMatchObject({ source: { device: 'unit-a', port: 'p1' }, destination: { device: 'unit-b-low', port: 'p1' }, stock: 'shielded-2pair-24awg', lengthMm: 1500 });
    expect(validateDesign(design, db)).toEqual([]);
    // the divider: the series part in the line at the receiving end, the shunt part to that end's ground
    expect(design.instances.components.map((c) => c.def).sort()).toEqual(['r-120', 'r-150']);
    expect(recipeDrift(design, db).state).toBe('in-step');
  });

  it('reports drift as a validation warning, and is quiet once the change is recorded', () => {
    const design = derived();
    const edited: CableDesign = { ...design, joints: design.joints.slice(1) };
    const codes = validateDesign(edited, db).map((i) => i.code);
    expect(codes).toContain('recipe-drift');
    // the same change recorded as an override with a reason
    const drift = recipeDrift(edited, db);
    const recorded: CableDesign = { ...edited, recipe: { ...edited.recipe!, overrides: drift.differences.map((d) => ({ ...d, reason: 'test' }) as never) } };
    expect(validateDesign(recorded, db).map((i) => i.code)).not.toContain('recipe-drift');
    // the recipe proposes the joint back, and re-deriving without the override restores it
    expect(recipeJointProposals(edited, db).map((p) => p.joint)).toEqual([design.joints[0]]);
    const back = rederive(edited, db);
    expect(back.ok && back.design.joints.length).toBe(design.joints.length);
  });

  it('infers the recipe of a design whose instances were renamed', () => {
    const design = derived();
    const rename = (id: string): string => (id === 'j1' ? 'p1' : id === 'w1' ? 'cable' : id);
    const hand: CableDesign = {
      ...design,
      recipe: undefined,
      instances: {
        ...design.instances,
        connectors: design.instances.connectors.map((c) => ({ ...c, id: rename(c.id) })),
        segments: design.instances.segments.map((s) => ({ ...s, id: rename(s.id) })),
      },
      joints: design.joints.map((j) => ({ ...j, a: { ...j.a, instance: rename(j.a.instance) }, b: { ...j.b, instance: rename(j.b.instance) } })),
    };
    delete (hand as { recipe?: unknown }).recipe;
    const inferred = inferCableRecipe(hand, db);
    expect(inferred).toMatchObject({ ok: true, state: 'identical', differences: 0 });
    if (!inferred.ok) return;
    expect(inferred.recipe.ids).toEqual({ j1: 'p1', w1: 'cable' });
    expect(validateDesign({ ...hand, recipe: inferred.recipe }, db).map((i) => i.code)).not.toContain('recipe-drift');
  });

  it('says why when no device takes the plugs', () => {
    const plain = loadDb();
    const lead: CableDesign = { ...derived(), instances: { ...derived().instances, connectors: [{ id: 'j1', def: 'de9-female' }, { id: 'j2', def: 'de9-female' }] } };
    expect(inferCableRecipe(lead, { ...plain, devices }).ok).toBe(false);
  });
});
