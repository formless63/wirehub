import type { CableDesign } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import {
  connectionEndKey,
  connectionForSelection,
  connectionKey,
  connectionLabel,
  connectionOfJoint,
  connectionOfTerminal,
  connectionsOf,
  connectionsOfInstance,
  endOfTerminal,
  isSegmentInstance,
  orientJoint,
  type Connection,
} from '../src/connection.ts';
import type { Selection } from '../src/store.ts';

/** A small design shaped like `a board design`: a board (u1) with a
 * connector (j1) on one side and a wire (w1, both ends jointed) on the other,
 * plus an unrelated floating pin. */
function design(): CableDesign {
  return {
    schemaVersion: 1,
    id: 'test-design',
    label: 'test',
    src: 'test fixture',
    instances: {
      connectors: [{ id: 'j1', def: 'de9-male' }],
      segments: [{ id: 'w1', def: 'multicore-3coax' }],
      components: [],
      pcbas: [{ id: 'u1', def: 'demo-board' }],
    },
    joints: [
      // 0: j1 <-> u1 (connector-side, no ends)
      { a: { instance: 'j1', terminal: '3' }, b: { instance: 'u1', terminal: 'j.3' } },
      // 1-3: w1 end a <-> u1 (three conductors, one connection)
      { a: { instance: 'w1', terminal: 'core-red.center', end: 'a' }, b: { instance: 'u1', terminal: 'R' } },
      { a: { instance: 'u1', terminal: 'G' }, b: { instance: 'w1', terminal: 'core-green.center', end: 'a' } },
      {
        a: { instance: 'w1', terminal: 'core-red.shield', end: 'a' },
        b: { instance: 'u1', terminal: 'GND' },
        note: 'shield',
      },
      // 4: w1 end b <-> u1 — a *different* connection from end a, same two instances
      { a: { instance: 'w1', terminal: 'core-red.center', end: 'b' }, b: { instance: 'u1', terminal: 'R2' } },
    ],
  };
}

describe('connection identity', () => {
  it('is order-independent', () => {
    const a = { instance: 'u1' };
    const b = { instance: 'w1', end: 'a' as const };
    expect(connectionKey(a, b)).toBe(connectionKey(b, a));
  });

  it('distinguishes ends of the same segment', () => {
    const a = { instance: 'w1', end: 'a' as const };
    const b = { instance: 'w1', end: 'b' as const };
    expect(connectionKey(a, b)).not.toBe(connectionKey(a, a));
    expect(connectionEndKey(a)).not.toBe(connectionEndKey(b));
  });

  it('reads a segment end off a TerminalRef, and leaves it off a plain instance', () => {
    expect(endOfTerminal({ instance: 'w1', terminal: 'core-red.center', end: 'a' })).toEqual({
      instance: 'w1',
      end: 'a',
    });
    expect(endOfTerminal({ instance: 'j1', terminal: '3' })).toEqual({ instance: 'j1' });
  });
});

describe('isSegmentInstance', () => {
  it('is true only for segment instances', () => {
    const d = design();
    expect(isSegmentInstance(d, 'w1')).toBe(true);
    expect(isSegmentInstance(d, 'u1')).toBe(false);
    expect(isSegmentInstance(d, 'j1')).toBe(false);
  });
});

describe('connectionsOf', () => {
  it('groups joints into three connections: j1<->u1, w1(a)<->u1, w1(b)<->u1', () => {
    const connections = connectionsOf(design());
    expect(connections).toHaveLength(3);

    const byJoints = new Map(connections.map((c) => [c.joints.join(','), c]));
    expect(byJoints.has('0')).toBe(true);
    expect(byJoints.has('1,2,3')).toBe(true);
    expect(byJoints.has('4')).toBe(true);
  });

  it('puts the segment side as `b`, whichever way the joint was authored', () => {
    const connections = connectionsOf(design());
    const wireA = connections.find((c) => c.joints.includes(1));
    expect(wireA?.a).toEqual({ instance: 'u1' });
    expect(wireA?.b).toEqual({ instance: 'w1', end: 'a' });
  });
});

describe('connectionOfJoint', () => {
  it('returns every joint of the connection a given joint belongs to', () => {
    const d = design();
    const connection = connectionOfJoint(d, 2);
    expect(connection?.joints).toEqual([1, 2, 3]);
  });

  it('is undefined for a joint index that does not exist', () => {
    expect(connectionOfJoint(design(), 99)).toBeUndefined();
  });
});

describe('connectionOfTerminal', () => {
  it('finds the connection a terminal is jointed into', () => {
    const d = design();
    const connection = connectionOfTerminal(d, { instance: 'u1', terminal: 'G' });
    expect(connection?.joints).toEqual([1, 2, 3]);
  });

  it('is undefined for a terminal with no joints', () => {
    const d = design();
    expect(connectionOfTerminal(d, { instance: 'u1', terminal: 'S' })).toBeUndefined();
  });
});

describe('connectionsOfInstance', () => {
  it('lists every connection an instance takes part in, ends kept separate', () => {
    const d = design();
    const connections = connectionsOfInstance(d, 'u1');
    expect(connections).toHaveLength(3);
    const wire = connectionsOfInstance(d, 'w1');
    expect(wire).toHaveLength(2); // end a and end b are different connections
  });
});

describe('connectionForSelection', () => {
  const d = design();

  it('resolves a joint selection', () => {
    const selection: Selection = { kind: 'joint', index: 1 };
    expect(connectionForSelection(d, selection)?.joints).toEqual([1, 2, 3]);
  });

  it('resolves a ground-bundle (joints) selection from its first member', () => {
    const selection: Selection = { kind: 'joints', indices: [3, 2, 1] };
    expect(connectionForSelection(d, selection)?.joints).toEqual([1, 2, 3]);
  });

  it('resolves a terminal selection', () => {
    const selection: Selection = { kind: 'terminal', ref: { instance: 'u1', terminal: 'R' } };
    expect(connectionForSelection(d, selection)?.joints).toEqual([1, 2, 3]);
  });

  it('is undefined for an instance selection — that is the Part tab, not Connection', () => {
    const selection: Selection = { kind: 'instance', id: 'u1' };
    expect(connectionForSelection(d, selection)).toBeUndefined();
  });

  it('is undefined for no selection, and for a terminal with nothing jointed', () => {
    expect(connectionForSelection(d, undefined)).toBeUndefined();
    const selection: Selection = { kind: 'terminal', ref: { instance: 'u1', terminal: 'S' } };
    expect(connectionForSelection(d, selection)).toBeUndefined();
  });
});

describe('orientJoint', () => {
  it('flips a joint authored b-then-a to match the connection`s own a/b', () => {
    const d = design();
    const connection = connectionOfJoint(d, 2) as Connection;
    // joint 2 was authored { a: u1:G, b: w1:core-green.center@a } — the reverse
    // of the connection's own (a=u1, b=w1@a)
    const joint = d.joints[2];
    if (joint === undefined) throw new Error('fixture joint missing');
    const oriented = orientJoint(connection, joint);
    expect(oriented.a.instance).toBe('u1');
    expect(oriented.b.instance).toBe('w1');
  });
});

describe('connectionLabel', () => {
  it('names a segment side by its end', () => {
    const d = design();
    const connection = connectionOfJoint(d, 1) as Connection;
    expect(connectionLabel(connection)).toBe('u1 → w1 · end a');
  });

  it('leaves the end off a non-segment side', () => {
    const d = design();
    const connection = connectionOfJoint(d, 0) as Connection;
    expect(connectionLabel(connection)).toBe('j1 → u1');
  });
});
