/**
 * The new-design wizard, connecting by signal: an RJ45 patch cable is joined pin to pin by what the
 * pins carry, the four twisted pairs taken by the four differential pairs, with no floating cores.
 */

import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, layeredCatalogSource } from '@wirehub/catalog';
import { initialWizardState, planCable, type WizardState } from '@wirehub/editor-react';
import { describe, expect, it } from 'vitest';

import { NETWORKING_PACK } from '../src/index.ts';

const packDir = fileURLToPath(NETWORKING_PACK);
const db = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(packDir, 'networking')])).loadDb();

const patch = (over: Partial<WizardState> = {}): WizardState => ({
  ...initialWizardState(db, []),
  label: 'Patch',
  id: 'patch-test',
  src: 'module test',
  source: { kind: 'connector', def: 'rj45-plug-t568b', plugs: {} },
  destination: { kind: 'connector', def: 'rj45-plug-t568b', plugs: {} },
  wireDef: 'cat5e-utp',
  lengthText: '2000',
  ...over,
});

describe('an RJ45 patch cable, connected by signal', () => {
  it('joins all eight pins at both ends, pin to pin, with no floating cores', () => {
    const plan = planCable(patch());
    expect(plan.choices).toEqual([]);
    expect(plan.unconnected).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.design.joints).toHaveLength(16);
    const straight = plan.design.joints.every((j) => {
      const plug = j.a.instance === 'w1' ? j.b : j.a;
      return plug.instance === 'j1' || plug.instance === 'j2';
    });
    expect(straight).toBe(true);
  });

  it('puts the two halves of each differential pair on one twisted pair', () => {
    const plan = planCable(patch());
    const pairOf = (plug: string, pin: string): string | undefined => {
      const joint = plan.design.joints.find((j) => (j.a.instance === plug && j.a.terminal === pin) || (j.b.instance === plug && j.b.terminal === pin));
      const wireSide = joint?.a.instance === 'w1' ? joint.a : joint?.b;
      return wireSide?.terminal.split('.')[0];
    };
    expect(pairOf('j1', '1')).toBe(pairOf('j1', '2'));
    expect(pairOf('j1', '3')).toBe(pairOf('j1', '6'));
    expect(pairOf('j1', '4')).toBe(pairOf('j1', '5'));
    expect(pairOf('j1', '7')).toBe(pairOf('j1', '8'));
  });

  it('by colour, the same stock has nothing that names its cores; leaving it open joins nothing', () => {
    const byColour = planCable(patch({ connect: 'colour' }));
    expect(byColour.design.joints).toEqual([]);
    expect(byColour.unconnected).toHaveLength(8);
    const open = planCable(patch({ connect: 'open' }));
    expect(open.design.joints).toEqual([]);
    expect(open.design.instances.connectors.map((c) => c.id)).toEqual(['j1', 'j2']);
  });
});
