/**
 * The new-design wizard, connecting by signal: a DE-9 RS-232 lead between two PC ports is crossed
 * (transmit onto receive) from the pins' directions, the ground carried, the handshake lines the
 * four-core stock cannot hold dropped with a note, and the spare core noted so nothing floats.
 */

import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, layeredCatalogSource } from '@wirehub/catalog';
import { backEdges, initialWizardState, planCable, type WizardState } from '@wirehub/editor-react';
import { describe, expect, it } from 'vitest';

import { PC_SERIAL_PACK } from '../src/index.ts';

const packDir = fileURLToPath(PC_SERIAL_PACK);
const db = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(packDir, 'pc-serial')])).loadDb();

const lead: WizardState = {
  ...initialWizardState(db, []),
  label: 'Serial lead',
  id: 'serial-test',
  src: 'module test',
  source: { kind: 'connector', def: 'de9-female-rs232', plugs: {} },
  destination: { kind: 'connector', def: 'de9-female-rs232', plugs: {} },
  wireDef: 'shielded-2pair-24awg',
  lengthText: '1830',
};

describe('a DE-9 RS-232 lead, connected by signal', () => {
  it('crosses transmit onto receive and carries the ground, asking nothing and warning of nothing', () => {
    const plan = planCable(lead);
    expect(plan.choices).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
    const pins = (plug: string): string[] => [...new Set(
      plan.design.joints.map((j) => (j.a.instance === plug ? j.a : j.b.instance === plug ? j.b : undefined)).filter((r) => r !== undefined).map((r) => r!.terminal))].sort();
    expect(pins('j1')).toEqual(['2', '3', '5']);
    expect(pins('j2')).toEqual(['2', '3', '5']);
    // the conductor on pin 3 at one end is on pin 2 at the other
    const w = (end: 'a' | 'b'): Map<string, string> => {
      const m = new Map<string, string>();
      for (const j of plan.design.joints) {
        const [wire, plug] = j.a.instance === 'w1' ? [j.a, j.b] : [j.b, j.a];
        if (wire.instance === 'w1' && wire.end === end && plug.instance !== 'w1') m.set(wire.terminal, plug.terminal);
      }
      return m;
    };
    const a = w('a');
    const b = w('b');
    for (const [conductor, pinA] of a) {
      // the drain and braid are landed at the source end only
      if (!b.has(conductor)) continue;
      if (pinA === '5') expect(b.get(conductor)).toBe('5');
      else expect(b.get(conductor)).toBe(pinA === '2' ? '3' : '2');
    }
  });

  it('says which lines the stock could not carry', () => {
    const plan = planCable(lead);
    expect((plan.design.notes ?? []).some((n) => n.startsWith('Not carried'))).toBe(true);
  });

  it('opens with no back-edges', () => {
    expect(backEdges(planCable(lead).design, db)).toEqual([]);
  });
});
