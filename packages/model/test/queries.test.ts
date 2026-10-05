/**
 * Model queries: enumerating a design's instances, enumerating the terminals
 * an instance exposes, and finding which note talks about a terminal.
 *
 * These exist because downstream packages kept re-deriving them (the schematic
 * layout had its own copy of all three —). The tests below
 * therefore care as much about *agreement* — that the general form and the
 * special-case form can never drift apart — as about the answers themselves.
 */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';

import {
  designInstances,
  breakoutFates,
  electricalPaths,
  segmentElectricalPaths,
  findConnector,
  findInstance,
  findPcba,
  findWire,
  noteIndexReferencingTerminal,
  noteReferencesTerminal,
  pcbaTerminalIds,
  terminalKey,
  terminalsOf,
  type CableDesign,
  type Db,
} from '../src/index.ts';

const db = loadDb();

/* ------------------------------------------------------------------ *
 * A synthetic design with one instance of every kind
 * ------------------------------------------------------------------ */

const TOY_DB: Db = {
  connectors: [
    {
      id: 'plug-2',
      label: '2-contact plug',
      family: 'test',
      pins: [
        { id: 'tip', label: 'Signal', note: 'tinned' },
        { id: 'sleeve', label: 'Ground' },
      ],
      src: 'synthetic',
    },
  ],
  wires: [
    {
      id: 'coax-1',
      label: '1-core coax',
      structure: {
        kind: 'group',
        id: 'coax-1',
        role: 'cable',
        children: [
          { kind: 'conductor', id: 'center', label: 'Centre' },
          { kind: 'insulation', id: 'dielectric', label: 'Dielectric' },
          { kind: 'shield', id: 'shield', label: 'Braid', construction: 'braid' },
        ],
      },
      src: 'synthetic',
    },
  ],
  components: [
    {
      id: 'cap-1',
      label: '220 µF',
      kind: 'capacitor',
      terminals: [
        { id: 'p', polarity: '+' },
        { id: 'n', polarity: '-' },
      ],
      src: 'synthetic',
    },
  ],
  pcbas: [
    {
      id: 'board-1',
      label: 'Test board',
      partNumber: 'TB-1',
      revision: 'Rev1',
      terminals: [
        { id: 'IN', label: 'Signal in', note: 'pad is gold' },
        { id: 'GND' },
      ],
      integratedConnectors: [{ connectorDefId: 'plug-2', terminalPrefix: 'j' }],
      internalLinks: [{ from: 'IN', to: 'j.tip' }],
      src: 'synthetic',
    },
  ],
};

const TOY: CableDesign = {
  schemaVersion: 1,
  id: 'toy',
  label: 'Toy design',
  instances: {
    connectors: [{ id: 'j1', def: 'plug-2' }],
    segments: [{ id: 'w1', def: 'coax-1' }],
    components: [{ id: 'c1', def: 'cap-1' }],
    pcbas: [{ id: 'u1', def: 'board-1' }],
  },
  joints: [
    { a: { instance: 'j1', terminal: 'tip' }, b: { instance: 'w1', terminal: 'center', end: 'a' } },
    { a: { instance: 'w1', terminal: 'center', end: 'b' }, b: { instance: 'u1', terminal: 'IN' } },
  ],
  notes: [
    'General build note that names no terminal at all.',
    'The braid is landed at the console end only — w1 shield @b is deliberately cut.',
    'A later note that also mentions w1:shield@b, and must not win over the first.',
  ],
  src: 'synthetic',
};

/* ------------------------------------------------------------------ *
 * designInstances / findInstance
 * ------------------------------------------------------------------ */

describe('designInstances', () => {
  it('flattens the four categories in a fixed order', () => {
    expect(designInstances(TOY)).toEqual([
      { id: 'j1', kind: 'connector', def: 'plug-2' },
      { id: 'w1', kind: 'segment', def: 'coax-1' },
      { id: 'c1', kind: 'component', def: 'cap-1' },
      { id: 'u1', kind: 'pcba', def: 'board-1' },
    ]);
  });

  it('accounts for every instance of every catalog design, exactly once', () => {
    for (const id of listDesignIds()) {
      const design = loadDesign(id);
      const flat = designInstances(design);
      const declared =
        design.instances.connectors.length +
        design.instances.segments.length +
        design.instances.components.length +
        design.instances.pcbas.length;
      expect(flat, id).toHaveLength(declared);
      expect(new Set(flat.map((instance) => instance.id)).size, id).toBe(declared);
    }
  });

  it('is empty for a design with no instances', () => {
    const empty: CableDesign = {
      ...TOY,
      instances: { connectors: [], segments: [], components: [], pcbas: [] },
      joints: [],
    };
    expect(designInstances(empty)).toEqual([]);
  });
});

describe('findInstance', () => {
  it('finds an instance of each kind and reports the definition it names', () => {
    expect(findInstance(TOY, 'j1')).toEqual({ id: 'j1', kind: 'connector', def: 'plug-2' });
    expect(findInstance(TOY, 'w1')).toEqual({ id: 'w1', kind: 'segment', def: 'coax-1' });
    expect(findInstance(TOY, 'c1')).toEqual({ id: 'c1', kind: 'component', def: 'cap-1' });
    expect(findInstance(TOY, 'u1')).toEqual({ id: 'u1', kind: 'pcba', def: 'board-1' });
  });

  it('returns undefined for an id the design does not declare', () => {
    expect(findInstance(TOY, 'nope')).toBeUndefined();
    expect(findInstance(TOY, '')).toBeUndefined();
  });

  it('agrees with designInstances on every catalog design', () => {
    for (const id of listDesignIds()) {
      const design = loadDesign(id);
      for (const instance of designInstances(design)) {
        expect(findInstance(design, instance.id), `${id}/${instance.id}`).toEqual(instance);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * terminalsOf
 * ------------------------------------------------------------------ */

describe('terminalsOf', () => {
  it('lists a connector instance one entry per pin, in definition order', () => {
    expect(terminalsOf(TOY, TOY_DB, 'j1')).toEqual([
      {
        key: 'j1:tip',
        instance: 'j1',
        instanceKind: 'connector',
        def: 'plug-2',
        terminal: 'tip',
        label: 'Signal',
        note: 'tinned',
      },
      {
        key: 'j1:sleeve',
        instance: 'j1',
        instanceKind: 'connector',
        def: 'plug-2',
        terminal: 'sleeve',
        label: 'Ground',
      },
    ]);
  });

  it('lists a segment as its electrical paths at end a, then end b', () => {
    const terminals = terminalsOf(TOY, TOY_DB, 'w1');
    expect(terminals.map((terminal) => terminal.key)).toEqual([
      'w1:center@a',
      'w1:shield@a',
      'w1:center@b',
      'w1:shield@b',
    ]);
    // insulation carries no terminals, so `dielectric` is absent
    expect(terminals.map((terminal) => terminal.terminal)).not.toContain('dielectric');
    // and each one comes back resolved, element and all
    expect(terminals[0]?.element?.kind).toBe('conductor');
    expect(terminals[1]?.element?.kind).toBe('shield');
    expect(terminals[0]?.end).toBe('a');
    expect(terminals[3]?.end).toBe('b');
  });

  it('lists a component one entry per terminal', () => {
    expect(terminalsOf(TOY, TOY_DB, 'c1').map((terminal) => terminal.key)).toEqual([
      'c1:p',
      'c1:n',
    ]);
  });

  it('lists a PCBA as its own pads, then its integrated connector pins', () => {
    const terminals = terminalsOf(TOY, TOY_DB, 'u1');
    expect(terminals.map((terminal) => terminal.terminal)).toEqual([
      'IN',
      'GND',
      'j.tip',
      'j.sleeve',
    ]);
    // a pad describes itself; an integrated pin borrows the pin it *is*
    expect(terminals[0]?.label).toBe('Signal in');
    expect(terminals[0]?.note).toBe('pad is gold');
    expect(terminals[1]?.label).toBeUndefined();
    expect(terminals[2]?.label).toBe('Signal');
    expect(terminals[2]?.note).toBe('tinned');
  });

  it('is the general form of pcbaTerminalIds', () => {
    for (const id of listDesignIds()) {
      const design = loadDesign(id);
      for (const instance of design.instances.pcbas) {
        const definition = findPcba(db, instance.def);
        expect(definition, `${id}/${instance.id}`).toBeDefined();
        expect(
          terminalsOf(design, db, instance.id).map((terminal) => terminal.terminal),
          `${id}/${instance.id}`,
        ).toEqual(pcbaTerminalIds(definition!, db));
      }
    }
  });

  it('agrees with every definition on every catalog design', () => {
    for (const id of listDesignIds()) {
      const design = loadDesign(id);
      for (const instance of design.instances.connectors) {
        expect(
          terminalsOf(design, db, instance.id).map((terminal) => terminal.terminal),
          `${id}/${instance.id}`,
        ).toEqual(findConnector(db, instance.def)?.pins.map((pin) => pin.id));
      }
      for (const instance of design.instances.segments) {
        const paths = segmentElectricalPaths(findWire(db, instance.def)!, instance);
        expect(
          terminalsOf(design, db, instance.id).map((terminal) => terminal.key),
          `${id}/${instance.id}`,
        ).toEqual(
          (['a', 'b'] as const).flatMap((end) => [
            ...paths.map((path) => `${instance.id}:${path}@${end}`),
            ...(instance.pigtails ?? [])
              .filter((pigtail) => pigtail.end === end)
              .map((pigtail) => `${instance.id}:pigtail:${pigtail.id}@${end}`),
          ]),
        );
      }
    }
  });

  it('covers every terminal the design joints actually land on', () => {
    for (const id of listDesignIds()) {
      const design = loadDesign(id);
      const exposed = new Set(
        designInstances(design).flatMap((instance) =>
          terminalsOf(design, db, instance.id).map((terminal) => terminal.key),
        ),
      );
      for (const joint of design.joints) {
        for (const ref of [joint.a, joint.b]) {
          expect(exposed.has(terminalKey(ref)), `${id}: ${terminalKey(ref)}`).toBe(true);
        }
      }
    }
  });

  it('answers "used vs. unused" by intersection with the joints', () => {
    const used = new Set(
      TOY.joints.flatMap((joint) => [terminalKey(joint.a), terminalKey(joint.b)]),
    );
    const split = (instance: string): { used: string[]; unused: string[] } => {
      const out = { used: [] as string[], unused: [] as string[] };
      for (const terminal of terminalsOf(TOY, TOY_DB, instance)) {
        (used.has(terminal.key) ? out.used : out.unused).push(terminal.terminal);
      }
      return out;
    };
    expect(split('j1')).toEqual({ used: ['tip'], unused: ['sleeve'] });
    expect(split('u1')).toEqual({ used: ['IN'], unused: ['GND', 'j.tip', 'j.sleeve'] });
  });

  it('enumerates nothing, rather than failing, for a broken reference', () => {
    expect(terminalsOf(TOY, TOY_DB, 'no-such-instance')).toEqual([]);
    const dangling: CableDesign = {
      ...TOY,
      instances: { ...TOY.instances, connectors: [{ id: 'j9', def: 'no-such-def' }] },
    };
    expect(terminalsOf(dangling, TOY_DB, 'j9')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * noteIndexReferencingTerminal
 * ------------------------------------------------------------------ */

describe('noteIndexReferencingTerminal', () => {
  it('returns the 0-based index of the first note that names the terminal', () => {
    expect(
      noteIndexReferencingTerminal(TOY, { instance: 'w1', terminal: 'shield', end: 'b' }),
    ).toBe(1);
  });

  it('returns undefined when no note names it', () => {
    expect(
      noteIndexReferencingTerminal(TOY, { instance: 'w1', terminal: 'center', end: 'b' }),
    ).toBeUndefined();
    expect(
      noteIndexReferencingTerminal({ ...TOY, notes: undefined }, {
        instance: 'w1',
        terminal: 'shield',
        end: 'b',
      }),
    ).toBeUndefined();
  });

  it('ignores whitespace and accepts all three separator spellings', () => {
    const ref = { instance: 'w1', terminal: 'shield', end: 'b' } as const;
    for (const spelling of ['w1:shield@b', 'w1.shield@b', 'w1 shield @b', 'W1 SHIELD @B']) {
      expect(
        noteIndexReferencingTerminal({ ...TOY, notes: ['first', `cut ${spelling} here`] }, ref),
        spelling,
      ).toBe(1);
    }
  });

  it('does not match a terminal the note never mentions', () => {
    expect(
      noteIndexReferencingTerminal({ ...TOY, notes: ['w1 center @a is fine'] }, {
        instance: 'w1',
        terminal: 'center',
        end: 'b',
      }),
    ).toBeUndefined();
  });

  it('is the same question noteReferencesTerminal answers, on every design', () => {
    for (const id of listDesignIds()) {
      const design = loadDesign(id);
      for (const instance of designInstances(design)) {
        for (const terminal of terminalsOf(design, db, instance.id)) {
          const ref = {
            instance: terminal.instance,
            terminal: terminal.terminal,
            ...(terminal.end === undefined ? {} : { end: terminal.end }),
          };
          expect(
            noteIndexReferencingTerminal(design, ref) !== undefined,
            `${id}: ${terminal.key}`,
          ).toBe(noteReferencesTerminal(design, ref));
        }
      }
    }
  });

  it('finds the note behind every deliberately cut conductor end in the catalog', () => {
    // The whole reason the helper exists: a conductor soldered at one end and
    // cut at the other is only legal because a design note says so, and the
    // drawing wants to print a footnote reference at the cut. Both need the
    // note, and this is every such end the catalog actually has.
    let checked = 0;
    for (const id of listDesignIds()) {
      const design = loadDesign(id);
      const jointed = new Set(
        design.joints.flatMap((joint) => [terminalKey(joint.a), terminalKey(joint.b)]),
      );
      for (const segment of design.instances.segments) {
        for (const terminal of terminalsOf(design, db, segment.id)) {
          if (terminal.element?.kind !== 'conductor') continue;
          if (jointed.has(terminal.key)) continue;
          const otherEnd = terminal.end === 'a' ? 'b' : 'a';
          // cut at this end but landed at the other one — a deliberate cut
          if (!jointed.has(`${segment.id}:${terminal.terminal}@${otherEnd}`)) continue;
          // a breakout accounts for its own ends: passed through, or NC with a reason
          if (breakoutFates(design, db).has(terminal.key)) continue;
          checked += 1;
          const index = noteIndexReferencingTerminal(design, {
            instance: terminal.instance,
            terminal: terminal.terminal,
            end: terminal.end,
          });
          expect(index, `${id}: ${terminal.key}`).toBeTypeOf('number');
          expect((design.notes ?? [])[index!], `${id}: ${terminal.key}`).toBeDefined();
        }
      }
    }
    expect(checked, 'no cut conductor end in the whole catalog?').toBeGreaterThan(0);
  });
});
