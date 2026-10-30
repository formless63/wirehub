/**
 * A signal core never takes a supply line. A synthetic hub whose
 * colour code gives yellow a lane with no signal ("sync") and brown the
 * generic supply lane, whose vocabulary reads "Video Sync" as composite sync,
 * and a mini-coax stock with a "Video Sync" yellow core and a "+5 V" brown
 * core. By signal, the sync core lands on the boards' sync pad, the brown core
 * on +5 V, and nothing that reads as a signal is put on a supply.
 */

import type { ColourCodeEntry, Db, SignalEntry } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { initialWizardState, openChoices, planCable, type WizardState } from '../src/wizard.ts';
import { loadDbFromDisk } from './fixture.ts';

const SRC = 'synthetic example: wizard sync-rail test';

function syntheticDb(syncPadLabel: string, aliases = ['Composite sync', 'Sync', 'Video Sync']): Db {
  const db = structuredClone(loadDbFromDisk());
  const vocab = db.vocab!;
  (vocab['signals']!.entries as SignalEntry[]).push({ id: 'csync', label: 'CSync', aliases, kind: 'video', src: SRC });
  (vocab['colour-codes']!.entries as ColourCodeEntry[]).push({ id: 'synthetic-fleet', label: 'Synthetic fleet code', lanes: { yellow: 'sync', brown: 'power' }, src: SRC });
  db.wires.push({
    id: 'synthetic-sync-coax',
    label: 'Synthetic sync coax + power',
    colourCode: 'synthetic-fleet',
    structure: {
      kind: 'group', id: 'synthetic-sync-coax', label: 'Cable', role: 'cable',
      children: [
        {
          kind: 'group', id: 'core-yellow', label: 'Video Sync coax (yellow)', role: 'coax',
          children: [
            { kind: 'conductor', id: 'center', color: 'yellow', label: 'Video Sync centre conductor' },
            { kind: 'shield', id: 'shield', label: 'Video Sync coax shield', construction: 'braid' },
          ],
        },
        { kind: 'conductor', id: 'core-brown', color: 'brown', label: '+5 V DC (brown, unshielded)' },
        { kind: 'conductor', id: 'drain', bare: true, label: 'Drain wire (bare)' },
      ],
    },
    src: SRC,
  } as unknown as Db['wires'][number]);
  for (const [id, power] of [['synthetic-src-board', '5V'], ['synthetic-dst-board', 'V']] as const) {
    db.pcbas.push({
      id,
      label: `Synthetic ${id}`,
      terminals: [
        { id: 'S', label: syncPadLabel, role: 'sync', note: 'conductor landing pad S1' },
        { id: power, label: '+5 V', role: 'power', signal: 'pwr-5v', note: 'power conductor landing pad' },
        { id: 'GND', label: 'GND', role: 'gnd', signal: 'gnd', note: 'shield / ground pads' },
      ],
      internalLinks: [],
      src: SRC,
    } as unknown as Db['pcbas'][number]);
  }
  return db;
}

function state(db: Db): WizardState {
  return {
    ...initialWizardState(db, []),
    label: 'Synthetic sync cable',
    id: 'synthetic-sync-cable',
    src: SRC,
    source: { kind: 'pcba', def: 'synthetic-src-board', plugs: {} },
    destination: { kind: 'pcba', def: 'synthetic-dst-board', plugs: {} },
    wireDef: 'synthetic-sync-coax',
    connect: 'signal',
  };
}

const landings = (plan: ReturnType<typeof planCable>, path: string): string[] =>
  plan.design.joints
    .flatMap((j) => [[j.a, j.b], [j.b, j.a]] as const)
    .filter(([w]) => w.instance === 'w1' && w.terminal === path)
    .map(([, t]) => `${t.instance}.${t.terminal}`)
    .sort();

describe('the wizard lands a sync core on sync, never on a supply', () => {
  it('lands "Video Sync" on S and the +5 V core on the +5 V pads', () => {
    const plan = planCable(state(syntheticDb('Sync (delivered)')));
    expect(landings(plan, 'core-yellow.center')).toEqual(['u1.S', 'u2.S']);
    expect(landings(plan, 'core-brown')).toEqual(['u1.5V', 'u2.V']);
    expect(plan.errors).toEqual([]);
  });

  it('asks where the sync core goes when no pad reads as sync, and offers no supply', () => {
    const s = state(syntheticDb('S', ['Video Sync']));
    const choice = openChoices(s).find((c) => c.subject.includes('Video Sync'));
    expect(choice?.options.map((o) => o.value)).toEqual(['S']);
    const plan = planCable(s);
    expect(landings(plan, 'core-yellow.center').filter((t) => !t.endsWith('.S'))).toEqual([]);
    expect(plan.errors).toEqual([]);
  });
});
