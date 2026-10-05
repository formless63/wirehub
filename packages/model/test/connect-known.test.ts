/** "Connect known pins" (cs-5k1.8): propose what the tags settle, list what they do not. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';

import { proposeKnownJoints, terminalKey, unwiredTerminals, type CableDesign, type Db, type Joint } from '../src/index.ts';

const db = loadDb();
const pairKey = (j: Joint): string => [terminalKey(j.a), terminalKey(j.b)].sort().join(' <> ');

/** the design with the joints satisfying `drop` removed, and the joints removed */
function without(design: CableDesign, drop: (j: Joint) => boolean): { design: CableDesign; removed: Joint[] } {
  const removed = design.joints.filter(drop);
  return { design: { ...design, joints: design.joints.filter((j) => !drop(j)) }, removed };
}

describe('proposeKnownJoints', () => {
  it('proposes nothing for a fully wired starter design', () => {
    for (const id of ['dc-led-lead', 'dc-y-splitter', 'de9-crossover', 'de9-terminal-board']) {
      expect(proposeKnownJoints(loadDesign(id), db), id).toEqual({ proposals: [], ambiguous: [] });
    }
  });

  it('proposes exactly the removed unambiguous joints of a lead, with the same pairs', () => {
    const lead = loadDesign('dc-led-lead');
    // the far end's two joints, which pair tagged conductors with tagged pins
    const { design, removed } = without(lead, (j) => [j.a, j.b].some((r) => r.instance === 'j2'));
    expect(removed).toHaveLength(2);
    const plan = proposeKnownJoints(design, db);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.proposals.map((p) => pairKey(p.joint)).sort()).toEqual(removed.map(pairKey).sort());
    expect(plan.proposals.map((p) => p.kind).sort()).toEqual(['ground', 'signal']);
    // written the way the editor writes it: source-end part first at end a, wire first at end b
    for (const p of plan.proposals) expect(p.joint.a.instance).toBe('w1');
    // applying them leaves nothing for a second run to propose
    const applied: CableDesign = { ...design, joints: [...design.joints, ...plan.proposals.map((p) => p.joint)] };
    expect(proposeKnownJoints(applied, db)).toEqual({ proposals: [], ambiguous: [] });
  });

  it('lists, and does not propose, a landing two identical plugs both qualify for', () => {
    const splitter = loadDesign('dc-y-splitter');
    const { design, removed } = without(splitter, (j) => [j.a, j.b].some((r) => r.instance === 'j2' || r.instance === 'j3'));
    expect(removed).toHaveLength(4);
    const plan = proposeKnownJoints(design, db);
    expect(plan.proposals).toEqual([]);
    expect(plan.ambiguous.length).toBeGreaterThan(0);
    for (const a of plan.ambiguous) expect(a.candidates.length).toBeGreaterThan(1);
    // one plug removed and one left wired: the removed one is now unambiguous
    const only = without(splitter, (j) => [j.a, j.b].some((r) => r.instance === 'j2'));
    const plan2 = proposeKnownJoints(only.design, db);
    expect(plan2.proposals.map((p) => pairKey(p.joint)).sort()).toEqual(only.removed.map(pairKey).sort());
    expect(plan2.ambiguous).toEqual([]);
  });

  it('never proposes into an untagged pin or an untagged conductor', () => {
    const crossover = loadDesign('de9-crossover');
    const { design } = without(crossover, (j) => [j.a, j.b].some((r) => r.instance === 'w1'));
    expect(proposeKnownJoints(design, db)).toEqual({ proposals: [], ambiguous: [] });
    expect(unwiredTerminals(design, db).length).toBeGreaterThan(0);
  });

  it('uses only the vocabulary: a pack can rename the signals and nothing changes', () => {
    const renamed: Db = structuredClone(db);
    const swap = new Map([['pwr-v', 'supply-rail']]);
    for (const c of renamed.connectors) for (const p of c.pins) if (p.signal !== undefined && typeof p.signal === 'string' && swap.has(p.signal)) p.signal = swap.get(p.signal)!;
    for (const e of renamed.vocab?.['signals']?.entries ?? []) if (swap.has(e.id)) (e as { id: string }).id = swap.get(e.id)!;
    const lead = loadDesign('dc-led-lead');
    const { design, removed } = without(lead, (j) => [j.a, j.b].some((r) => r.instance === 'j2'));
    const plan = proposeKnownJoints(design, renamed);
    expect(plan.proposals.map((p) => pairKey(p.joint)).sort()).toEqual(removed.map(pairKey).sort());
  });
});

describe('footprint mates', () => {
  const boardDb = (): Db => {
    const copy: Db = structuredClone(db);
    const base = copy.pcbas[0]!;
    const make = (id: string): Db['pcbas'][number] => ({
      ...structuredClone(base),
      id,
      label: id,
      terminals: [
        { id: 'j.1', label: 'pad 1', signal: 'pwr-v' },
        { id: 'j.2', label: 'pad 2', signal: 'gnd' },
        { id: 'j.3', label: 'pad 3' },
      ],
      integratedConnectors: [],
      internalLinks: [],
    });
    copy.pcbas = [...copy.pcbas, make('fp-board'), make('fp-board-2')];
    return copy;
  };
  const design = (boards: string[]): CableDesign => {
    const lead = loadDesign('dc-led-lead');
    return {
      ...lead,
      instances: {
        ...lead.instances,
        connectors: [{ id: 'j9', def: 'jst-xh-2-dc' }],
        segments: [],
        components: [],
        mechanical: [],
        pcbas: boards.map((b, i) => ({ id: `u${i + 1}`, def: b })),
      },
      joints: [],
    };
  };

  it('lands a connector\'s pins on the board footprint pads of the same number when the tags agree', () => {
    const plan = proposeKnownJoints(design(['fp-board']), boardDb());
    expect(plan.ambiguous).toEqual([]);
    expect(plan.proposals.map((p) => p.kind)).toEqual(['footprint', 'footprint']);
    expect(plan.proposals.map((p) => pairKey(p.joint)).sort()).toEqual(['j9:1 <> u1:j.1', 'j9:2 <> u1:j.2']);
  });

  it('lists the pins, and proposes nothing, when two boards offer the same footprint', () => {
    const plan = proposeKnownJoints(design(['fp-board', 'fp-board-2']), boardDb());
    expect(plan.proposals).toEqual([]);
    expect(plan.ambiguous.map((a) => a.terminal.terminal).sort()).toEqual(['1', '2']);
    expect(plan.ambiguous.every((a) => a.candidates.length === 2)).toBe(true);
  });

  it('does not mate a connector to a footprint whose tags disagree with its pins', () => {
    const copy = boardDb();
    copy.pcbas.find((p) => p.id === 'fp-board')!.terminals[0]!.signal = 'gnd';
    expect(proposeKnownJoints(design(['fp-board']), copy)).toEqual({ proposals: [], ambiguous: [] });
  });
});
