/**
 * Fresh layouts: what a new design looks like the first time it opens. Every wizard-made design
 * across the starter catalog's ends and stocks has its connectors on the outside, the wire in the
 * middle, and no back-edges: every handle faces the part it goes to.
 */

import { describe, expect, it } from 'vitest';

import { backEdges } from '../src/layout-check.ts';
import { autoLayout, deriveNodes } from '../src/derive.ts';
import { estimateNodeSize } from '../src/layout-size.ts';
import { initialWizardState, planCable } from '../src/wizard.ts';
import { diskDepictions, loadDbFromDisk } from './fixture.ts';

const db = loadDbFromDisk();
const depictions = diskDepictions();

const ends = [
  ...db.connectors.map((c) => ({ kind: 'connector' as const, def: c.id })),
  ...db.pcbas.map((c) => ({ kind: 'pcba' as const, def: c.id })),
];

function designs() {
  const out: { name: string; design: ReturnType<typeof planCable>['design'] }[] = [];
  for (const s of ends) {
    for (const d of ends) {
      for (const w of db.wires) {
        const plan = planCable({ ...initialWizardState(db, []), label: 'T', id: 't', src: 's', source: { ...s, plugs: {} }, destination: { ...d, plugs: {} }, wireDef: w.id, lengthText: '1000' });
        if (plan.design.joints.length > 0) out.push({ name: `${s.def} | ${w.id} | ${d.def}`, design: plan.design });
      }
    }
  }
  return out;
}

describe('a fresh two-ended layout', () => {
  const all = designs();

  it('covers a real spread of designs', () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it('has no back-edges, with or without board art', () => {
    const bad: string[] = [];
    for (const { name, design } of all) {
      for (const art of [false, true]) {
        const found = backEdges(design, db, art ? depictions : undefined);
        if (found.length > 0) bad.push(`${name} (${art ? 'art' : 'list'}): ${found[0]!.edge} ${found[0]!.reason}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('stands the plugs on the outside and the wire in the middle', () => {
    const bad: string[] = [];
    for (const { name, design } of all) {
      // an end nothing is soldered to is checked below
      const jointed = new Set(design.joints.flatMap((j) => [j.a.instance, j.b.instance]));
      if (!(jointed.has('j1') || jointed.has('u1')) || !(jointed.has('j2') || jointed.has('u2'))) continue;
      const { positions } = autoLayout(design, db);
      const boxes = new Map(deriveNodes(design, db, { positions }).filter((n) => n.parentId === undefined).map((n) => [n.id, { x: n.position.x, w: estimateNodeSize(n.data).width }]));
      const wire = boxes.get('w1');
      const first = boxes.get(design.instances.connectors[0]?.id ?? design.instances.pcbas[0]?.id ?? '');
      if (wire === undefined || first === undefined) continue;
      if (!(first.x + first.w <= wire.x)) bad.push(`${name}: the source end is not left of the wire`);
    }
    expect(bad).toEqual([]);
  });
});

describe('a design opened with its ends left open', () => {
  it('still reads left to right: source end, wire, far end', () => {
    const plan = planCable({ ...initialWizardState(db, []), label: 'T', id: 't', src: 's', source: { kind: 'connector', def: 'de9-female', plugs: {} }, destination: { kind: 'connector', def: 'de9-male', plugs: {} }, wireDef: 'shielded-2pair-24awg', lengthText: '1000', connect: 'open' });
    expect(plan.design.joints).toEqual([]);
    const { positions } = autoLayout(plan.design, db);
    expect(positions['j1']!.x).toBeLessThan(positions['w1']!.x);
    expect(positions['w1']!.x).toBeLessThan(positions['j2']!.x);
  });

  it('puts one open end on the side the jointed ones leave free', () => {
    const plan = planCable({ ...initialWizardState(db, []), label: 'T', id: 't', src: 's', source: { kind: 'connector', def: 'jst-xh-2-dc', plugs: {} }, destination: { kind: 'connector', def: 'jst-xh-2-dc', plugs: {} }, wireDef: 'dc-2core-24awg', lengthText: '1000' });
    const joined = { ...plan.design, joints: plan.design.joints.filter((j) => j.a.instance !== 'j2' && j.b.instance !== 'j2') };
    const { positions } = autoLayout(joined, db);
    expect(positions['j1']!.x).toBeLessThan(positions['w1']!.x);
    expect(positions['w1']!.x).toBeLessThan(positions['j2']!.x);
  });
});
