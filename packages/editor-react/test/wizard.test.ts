/**
 * The new-cable wizard, headless.
 *
 * Two things are proved here, and the second is the one that matters:
 *
 * 1. The flow is a state machine that will not let a step be left while the
 *    answers on it would produce something unbuildable.
 * 2. The generator is deterministic and reports what it cannot decide as a
 *    question or a sentence, never as a guessed joint. Every signal it knows
 *    comes from the catalog's vocabulary.
 */

import { noteReferencesTerminal, type CableDesign, type Db, type Joint } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import {
  LENGTH_PRESETS,
  describeLength,
  drainNote,
  initialWizardState,
  maxLengthOf,
  openChoices,
  parseLengthMm,
  planCable,
  readingsOfLabels,
  roleOfLabels,
  stepBlockers,
  wireLines,
  wizardReducer,
  type WizardState,
} from '../src/wizard.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

function answers(over: Partial<WizardState>): WizardState {
  return {
    ...initialWizardState(db, []),
    label: 'Test cable',
    id: 'test-cable',
    src: 'unit test',
    ...over,
  };
}

/** A joint as a comparable string, with the two sides in a stable order. */
function jointKey(joint: Joint): string {
  const side = (ref: Joint['a']): string =>
    `${ref.instance}.${ref.terminal}${ref.end === undefined ? '' : `@${ref.end}`}`;
  return [side(joint.a), side(joint.b)].sort().join(' — ');
}

/* ------------------------------------------------------------------ *
 * Reading the catalog's conventions
 * ------------------------------------------------------------------ */

describe('what the catalog says a terminal is for', () => {
  it('reads the role out of a label, against the vocabulary', () => {
    expect(roleOfLabels(db, ['Audio L'])?.role).toBe('audio-l');
    expect(roleOfLabels(db, ['Audio (mono)'])?.role).toBe('audio-mono');
    expect(roleOfLabels(db, ['+5 V'])?.role).toBe('pwr-5v');
    expect(roleOfLabels(db, ['+12 V'])?.role).toBe('pwr-12v');
    expect(roleOfLabels(db, ['TXD'])?.role).toBe('rs232-txd');
    expect(roleOfLabels(db, ['Not connected'])).toBeUndefined();
    expect(roleOfLabels(db, ['Mode select'])).toBeUndefined();
  });

  it('keeps every signal a pin and its aliases name, label first', () => {
    expect(readingsOfLabels(db, ['Audio L', '2', 'Audio (mono)']).map((r) => r.role)).toEqual(['audio-l', 'audio-mono']);
  });

  it('classes a ground by whatever it is a return for', () => {
    expect(roleOfLabels(db, ['Audio GND'])).toEqual({ role: 'ground', ground: 'gnd-audio' });
    expect(roleOfLabels(db, ['GND'])).toEqual({ role: 'ground' });
    expect(roleOfLabels(db, ['Shell / chassis'])).toEqual({ role: 'ground', ground: 'chassis' });
  });

  it('knows no signal the vocabulary does not have', () => {
    const bare: Db = { ...db, vocab: {} };
    expect(roleOfLabels(bare, ['Audio L'])).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Lengths
 * ------------------------------------------------------------------ */

describe('length', () => {
  it('says the millimetres in feet and inches', () => {
    expect(describeLength(1830)).toBe('6 ft 0 in');
    expect(describeLength(914)).toBe('3 ft 0 in');
    expect(describeLength(450)).toBe('1 ft 5.7 in');
    expect(describeLength(0)).toBe('');
  });

  it('only accepts a positive whole number of millimetres', () => {
    expect(parseLengthMm('1829')).toBe(1829);
    expect(parseLengthMm(' 1829.4 ')).toBe(1829);
    expect(parseLengthMm('')).toBeUndefined();
    expect(parseLengthMm('0')).toBeUndefined();
    expect(parseLengthMm('-5')).toBeUndefined();
    expect(parseLengthMm('six feet')).toBeUndefined();
  });

  it('offers the lengths the catalog actually builds', () => {
    expect(LENGTH_PRESETS.map((preset) => preset.mm)).toContain(1830);
  });

  it('has no ceiling to enforce, because no stock in the catalog states one', () => {
    for (const wire of db.wires) expect(maxLengthOf(wire)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The flow
 * ------------------------------------------------------------------ */

describe('the flow', () => {
  it('will not leave the first step without a name, an id and a source', () => {
    const fresh = initialWizardState(db, ['db9-null-modem']);
    expect(stepBlockers(fresh)).toHaveLength(3);

    const blocked = wizardReducer(fresh, { type: 'next' });
    expect(blocked.step).toBe('name');
    expect(blocked.blocked.join(' ')).toContain('name');
    expect(blocked.blocked.join(' ')).toContain('where this information comes from');
  });

  it('refuses an id that is already in the catalog, in plain words', () => {
    const state = answers({ id: 'db9-null-modem', taken: ['db9-null-modem'] });
    expect(stepBlockers(state).join(' ')).toContain('already exists');
  });

  it('refuses an id that is not an id', () => {
    expect(stepBlockers(answers({ id: 'Not An Id' })).join(' ')).toContain('cannot be used as an id');
  });

  it('suggests an id from the name until the user writes their own', () => {
    let state = initialWizardState(db, []);
    state = wizardReducer(state, { type: 'set-label', value: 'Mixer (Main) → Stage' });
    expect(state.id).toBe('mixer-main-stage');
    state = wizardReducer(state, { type: 'set-id', value: 'my-own-name' });
    state = wizardReducer(state, { type: 'set-label', value: 'Something else' });
    expect(state.id).toBe('my-own-name');
  });

  it('advances, remembers how far it got, and comes back', () => {
    let state = answers({});
    state = wizardReducer(state, { type: 'next' });
    expect(state.step).toBe('source');
    expect(state.blocked).toHaveLength(0);
    state = wizardReducer(state, { type: 'back' });
    expect(state.step).toBe('name');
    // the step already earned can be jumped to; the ones ahead cannot
    state = wizardReducer(state, { type: 'go', step: 'source' });
    expect(state.step).toBe('source');
    state = wizardReducer(state, { type: 'go', step: 'review' });
    expect(state.step).toBe('source');
  });

  it('changing an end throws away answers that were about the old one', () => {
    let state = answers({ picks: { 'source:ground': 'GND' } });
    state = wizardReducer(state, {
      type: 'set-end',
      end: 'source',
      kind: 'pcba',
      def: 'PCA-00110-rev4',
    });
    expect(state.picks).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * The generator, against cables that already exist
 * ------------------------------------------------------------------ */



describe('the plan', () => {

  it('reproduces the hand-made microphone lead from the vocabulary alone', () => {
    const state = answers({
      source: { kind: 'connector', def: 'xlr3-female', plugs: {} },
      destination: { kind: 'connector', def: 'xlr3-male', plugs: {} },
      wireDef: 'mic-2core-braid',
      lengthText: '3000',
    });
    const plan = planCable(state);
    expect(plan.errors).toEqual([]);
    expect(plan.choices).toEqual([]);
    expect(plan.unconnected).toEqual([]);
    const handMade = loadDesignFromDisk('xlr-mic-cable');
    expect(plan.design.joints.map(jointKey).sort()).toEqual(handMade.joints.map(jointKey).sort());
  });

  it('is the same document every time it is asked for', () => {
    const state = answers({
      source: { kind: 'connector', def: 'xlr3-female', plugs: {} },
      destination: { kind: 'pcba', def: 'rs485-terminal-board', plugs: {} },
      wireDef: 'mic-2core-braid',
      lengthText: '1830',
    });
    expect(JSON.stringify(planCable(state).design)).toBe(JSON.stringify(planCable(state).design));
  });

  it('reports its own blockers on the review step rather than creating something broken', () => {
    const state = answers({ step: 'review', wireDef: 'mini-coax', lengthText: '1830' });
    // no ends chosen: nothing to solder, but nothing invalid either
    expect(stepBlockers(state)).toHaveLength(0);
    expect(planCable(state).lines).toHaveLength(0);
  });
});
