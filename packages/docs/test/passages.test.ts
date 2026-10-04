/**
 * The DC-continuity classifier, tested on its own.
 *
 * These are the rules the whole test spec rests on, so they are exercised
 * directly against the kind of `via` text board definitions carry.
 */

import { loadDb } from '@cable-studio/catalog';
import type { Passage } from '@cable-studio/model';
import { describe, expect, it } from 'vitest';

import { parsePassageElement, pathBehaviour } from '../src/passages.ts';

const db = loadDb();

const via = (instance: string, description: string): Passage => ({
  kind: 'pcba-link',
  instance,
  description,
});

describe('parsePassageElement', () => {
  it('reads a resistor and its value', () => {
    const element = parsePassageElement('R202 470 Ω');
    expect(element.role).toBe('resistor');
    expect(element.designator).toBe('R202');
    expect(element.ohms).toBe(470);
    expect(element.dc).toBe('pass');
  });

  it('reads a resistor with no recorded value without inventing one', () => {
    const element = parsePassageElement('R401');
    expect(element.role).toBe('resistor');
    expect(element.ohms).toBeUndefined();
  });

  it('reads a capacitor as a DC block', () => {
    for (const text of ['C1 220 µF', 'C201 0.1 µF', 'C1 220 µF (BOM-only, not net-verified)']) {
      const element = parsePassageElement(text);
      expect(element.role, text).toBe('capacitor');
      expect(element.dc, text).toBe('block');
    }
  });

  it('reads silicon as active, whether or not it has a designator', () => {
    expect(parsePassageElement('U201 LM1881 sync stripper').dc).toBe('active');
    expect(parsePassageElement('U1 SN74AHCT1G125 sync buffer').dc).toBe('active');
    expect(
      parsePassageElement(
        'sync/mode-select combiner (74HC123PW monostable + 74HC2G00DP NAND + SN74AHCT86PWR XOR + 74HC1G32GW OR + JS202011CQN DPDT 15/31 kHz switch — BOM-only, not net-verified; modeled as a pass-through in 15 kHz/SCART strap mode pending schematic/bench confirmation)',
      ).dc,
    ).toBe('active');
  });

  it('reads a bridged jumper as copper and an unbridged one as conditional', () => {
    expect(parsePassageElement('JP201 0 Ω (bridged — CPL Basic)').dc).toBe('pass');
    expect(parsePassageElement('JP1 (solder jumper — build option)').dc).toBe('conditional');
  });

  it('reads a switch position as conditional', () => {
    const element = parsePassageElement('SW1 (SP3T select — CS position)');
    expect(element.role).toBe('switch');
    expect(element.dc).toBe('conditional');
  });
});

describe('pathBehaviour', () => {
  it('calls plain copper continuous', () => {
    const behaviour = pathBehaviour([], db);
    expect(behaviour.verdict).toBe('continuous');
    expect(behaviour.dcContinuous).toBe(true);
  });

  it('sums series resistance so the reading can be predicted', () => {
    const behaviour = pathBehaviour([via('u1', 'R1 75 Ω'), via('u2', 'R203 180 Ω')], db);
    expect(behaviour.verdict).toBe('resistive');
    expect(behaviour.dcContinuous).toBe(true);
    expect(behaviour.ohms).toBe(255);
    expect(behaviour.expectation).toContain('255 Ω');
  });

  it('refuses to predict a reading when a resistor has no recorded value', () => {
    const behaviour = pathBehaviour([via('u1', 'R401')], db);
    expect(behaviour.ohms).toBeUndefined();
    expect(behaviour.unvaluedResistors).toBe(1);
    expect(behaviour.expectation).toContain('unrecorded value');
  });

  it('calls a series capacitor NOT DC-continuous', () => {
    const behaviour = pathBehaviour([via('u1', 'C1 220 µF')], db);
    expect(behaviour.verdict).toBe('blocked');
    expect(behaviour.dcContinuous).toBe(false);
    expect(behaviour.blockedBy.map((element) => element.designator)).toEqual(['C1']);
    expect(behaviour.expectation).toContain('NOT DC-continuous');
    expect(behaviour.expectation).toContain('do not rework');
  });

  it('calls a resistor-then-capacitor path NOT DC-continuous', () => {
    // `R1 75 Ω → C1 220 µF` is the standard 75 Ω-terminated coupled RGB path:
    // the resistor does not rescue the reading, the cap still blocks
    const behaviour = pathBehaviour([via('u1', 'R1 75 Ω → C1 220 µF')], db);
    expect(behaviour.verdict).toBe('blocked');
    expect(behaviour.dcContinuous).toBe(false);
  });

  it('calls an LM1881 path active — regenerated, not conducted', () => {
    const behaviour = pathBehaviour(
      [via('u2', 'C201 0.1 µF → U201 LM1881 sync stripper → R202 470 Ω')],
      db,
    );
    expect(behaviour.verdict).toBe('active');
    expect(behaviour.dcContinuous).toBe(false);
    expect(behaviour.activeBy.map((element) => element.designator)).toEqual(['U201']);
    // the cap is still recorded even though the IC took the verdict
    expect(behaviour.blockedBy.map((element) => element.designator)).toEqual(['C201']);
    expect(behaviour.expectation).toContain('never with a meter');
  });

  it('ranks active silicon above a blocking capacitor', () => {
    const both = pathBehaviour([via('u1', 'C1 0.1 µF → U1 LM1881 sync stripper')], db);
    expect(both.verdict).toBe('active');
  });

  it('flags a path through one switch in two states as unbuildable', () => {
    const behaviour = pathBehaviour(
      [
        via('u1', 'SW1 (SP3T select — L position)'),
        via('u1', 'SW1 (SP3T select — CV position)'),
      ],
      db,
    );
    expect(behaviour.verdict).toBe('exclusive');
    expect(behaviour.dcContinuous).toBe(false);
    expect(behaviour.expectation).toContain('more than one state at once');
  });

  it('does not confuse C1 on one board with C1 on another', () => {
    const behaviour = pathBehaviour([via('u1', 'C1 220 µF'), via('u2', 'C1 220 µF')], db);
    expect(behaviour.exclusiveOn).toEqual([]);
    expect(behaviour.verdict).toBe('blocked');
  });

  it('trusts a component definition over a regex', () => {
    // the def is what decides, not the description
    const behaviour = pathBehaviour(
      [{ kind: 'component', instance: 'c1', def: 'cap-100nf', description: 'c1 (100 nF)' }],
      db,
    );
    expect(behaviour.elements[0]?.role).toBe('capacitor');
    expect(behaviour.dcContinuous).toBe(false);

    const resistor = pathBehaviour(
      [{ kind: 'component', instance: 'r1', def: 'r-150', description: 'r1 (150 Ω)' }],
      db,
    );
    expect(resistor.verdict).toBe('resistive');
    expect(resistor.ohms).toBe(150);
  });
});

describe('structured link elements', () => {
  it('reads the declared elements, not the prose', () => {
    // prose no regex can classify; the structure says it is a series cap
    const passage: Passage = {
      kind: 'pcba-link',
      instance: 'u9',
      description: 'the coupling part',
      elements: [{ text: 'the coupling part', kind: 'capacitor', designator: 'C9', value: '10 µF' }],
    };
    const behaviour = pathBehaviour([passage], db);
    expect(behaviour.verdict).toBe('blocked');
    expect(behaviour.blockedBy[0]?.designator).toBe('C9');
    expect(behaviour.elements[0]?.text).toBe('the coupling part');
    // the same prose with no structure is honestly unknown
    expect(pathBehaviour([via('u9', 'the coupling part')], db).verdict).toBe('unknown');
  });

  it('a bridged jumper is copper by its declared state', () => {
    const passage: Passage = {
      kind: 'pcba-link',
      instance: 'u9',
      description: 'JP7 link',
      elements: [{ text: 'JP7 link', kind: 'jumper', designator: 'JP7', state: 'bridged' }],
    };
    expect(pathBehaviour([passage], db).verdict).toBe('continuous');
  });
});
