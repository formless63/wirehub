/**
 * The pure `CableDesign → CableDesign` edit primitives — kept apart from
 * `@wirehub/editor-react`'s store because nothing
 * about them is editor-specific: every writer of a design document needs the
 * same semantics, notably that removing an instance removes the joints that
 * land on it, and that a joint's removal can leave a pigtail landed nowhere.
 *
 * The editor's own reducer-level tests (undo stack, commit/validate gating,
 * presentation state) stay in `packages/editor-react/test/store.test.ts` —
 * these test the primitives directly, with no reducer, no undo stack, no
 * validation in between.
 */

import { loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import {
  addInstance,
  addJoint,
  dropUnlandedPigtails,
  nextInstanceId,
  parseDesignJson,
  removeInstance,
  removeJoint,
  removeJoints,
  updateInstance,
} from '../src/index.ts';

describe('nextInstanceId', () => {
  it('assigns the per-kind prefix, next free number', () => {
    const design = loadDesign('de9-terminal-board');
    expect(nextInstanceId(design, 'connector', 'jst-xh-male')).toMatch(/^j\d+$/);
    expect(nextInstanceId(design, 'segment', 'cat5e-utp')).toBe('w2');
    expect(nextInstanceId(design, 'pcba', 'anything')).toBe('u2');
  });

  it('names components after what they are: r-* is a resistor, cap* a capacitor', () => {
    const design = loadDesign('de9-terminal-board');
    expect(nextInstanceId(design, 'component', 'r-150')).toBe('r1');
    expect(nextInstanceId(design, 'component', 'cap-100nf')).toBe('c1');
  });

  it('never returns an id already taken', () => {
    const design = loadDesign('de9-terminal-board');
    const taken = new Set([
      ...design.instances.connectors.map((i) => i.id),
      ...design.instances.segments.map((i) => i.id),
      ...design.instances.components.map((i) => i.id),
      ...design.instances.pcbas.map((i) => i.id),
    ]);
    expect(taken.has(nextInstanceId(design, 'connector', 'jst-xh-male'))).toBe(false);
  });
});

describe('addInstance', () => {
  it('appends the instance to its own list and leaves the rest untouched', () => {
    const design = loadDesign('de9-terminal-board');
    const next = addInstance(design, 'connector', 'jst-xh-male', 'j99');
    expect(next.instances.connectors.at(-1)).toEqual({ id: 'j99', def: 'jst-xh-male' });
    expect(next.instances.segments).toBe(design.instances.segments);
    expect(next.instances.components).toBe(design.instances.components);
    expect(next.instances.pcbas).toBe(design.instances.pcbas);
    expect(next.joints).toBe(design.joints);
    // the previous document is untouched — every edit is a new document
    expect(design.instances.connectors.some((i) => i.id === 'j99')).toBe(false);
  });
});

describe('removeInstance', () => {
  it('removes the instance and every joint that lands on it', () => {
    const design = loadDesign('de9-terminal-board');
    const attached = design.joints.filter(
      (joint) => joint.a.instance === 'u1' || joint.b.instance === 'u1',
    ).length;
    expect(attached).toBeGreaterThan(0);

    const next = removeInstance(design, 'u1');
    expect(next.instances.pcbas.map((i) => i.id)).not.toContain('u1');
    expect(next.joints).toHaveLength(design.joints.length - attached);
    expect(next.joints.some((j) => j.a.instance === 'u1' || j.b.instance === 'u1')).toBe(false);
  });

  it('cascades to pigtails that land only on the removed instance', () => {
    const design = loadDesign('de9-terminal-board');
    const w1Before = design.instances.segments.find((s) => s.id === 'w1');
    expect(w1Before?.pigtails?.some((p) => p.id === 'shield' && p.end === 'a')).toBe(true);

    // j1 is where pigtail shield@a lands — removing it takes the joint, and
    // dropUnlandedPigtails takes the now-unlanded source-end pigtail with it
    const next = removeInstance(design, 'j1');
    const w1After = next.instances.segments.find((s) => s.id === 'w1');
    expect(w1After?.pigtails?.some((p) => p.id === 'shield' && p.end === 'a')).toBe(false);
    // the destination-end pigtail, landed on u1, is untouched
    expect(w1After?.pigtails?.some((p) => p.id === 'shield' && p.end === 'b')).toBe(true);
  });

  it('is a no-op on the four instance lists it knows about when the id is not there', () => {
    const design = loadDesign('de9-terminal-board');
    const next = removeInstance(design, 'nope');
    expect(next.joints).toEqual(design.joints);
    expect(next.instances.connectors).toEqual(design.instances.connectors);
    expect(next.instances.segments).toEqual(design.instances.segments);
    expect(next.instances.components).toEqual(design.instances.components);
    expect(next.instances.pcbas).toEqual(design.instances.pcbas);
  });

  it('keeps instance kinds it does not edit (e.g. `mechanical`)', () => {
    const design = loadDesign('de9-terminal-board');
    expect(design.instances.mechanical?.length).toBeGreaterThan(0);
    const next = removeInstance(design, 'nope');
    expect(next.instances.mechanical).toEqual(design.instances.mechanical);
  });

  it('takes the mechanical parts attached to the removed instance with it, transitively', () => {
    const design = loadDesign('de9-crossover');
    const next = removeInstance(design, 'j1');
    const ids = (next.instances.mechanical ?? []).map((m) => m.id);
    // m1 is attached to j1, m2 to m1: both go; j2's hood stays
    expect(ids).toEqual(['m3', 'm4']);
  });

  it('drops a breakout whose leg is removed, keeps it otherwise', () => {
    const design = loadDesign('dc-y-splitter');
    expect(design.instances.breakouts?.length).toBe(1);
    expect(removeInstance(design, 'nope').instances.breakouts).toEqual(design.instances.breakouts);
    expect(removeInstance(design, 'w2').instances.breakouts).toEqual([]);
  });
});

describe('dropUnlandedPigtails', () => {
  it('drops a pigtail once no joint lands on it, and leaves the others', () => {
    const design = loadDesign('de9-terminal-board');
    const w1 = design.instances.segments.find((s) => s.id === 'w1')!;
    expect(w1.pigtails?.filter((p) => p.id === 'shield')).toHaveLength(2); // end a and end b

    const index = design.joints.findIndex(
      (j) => j.a.instance === 'w1' && j.a.terminal === 'pigtail:shield' && j.a.end === 'a',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const withoutLanding = { ...design, joints: design.joints.filter((_, at) => at !== index) };

    const next = dropUnlandedPigtails(withoutLanding);
    const w1After = next.instances.segments.find((s) => s.id === 'w1')!;
    expect(w1After.pigtails?.some((p) => p.id === 'shield' && p.end === 'a')).toBe(false);
    // the b end is landed by a different joint and survives
    expect(w1After.pigtails?.some((p) => p.id === 'shield' && p.end === 'b')).toBe(true);
  });

  it('is a pure no-op (same reference) when every pigtail is still landed', () => {
    const design = loadDesign('de9-terminal-board');
    expect(dropUnlandedPigtails(design)).toBe(design);
  });
});

describe('addJoint / removeJoint / removeJoints', () => {
  it('addJoint appends the joint verbatim', () => {
    const design = loadDesign('de9-terminal-board');
    const a = { instance: 'j1', terminal: '1' };
    const b = { instance: 'u1', terminal: 'GND' };
    const next = addJoint(design, a, b);
    expect(next.joints.at(-1)).toEqual({ a, b });
    expect(next.joints).toHaveLength(design.joints.length + 1);
    expect(design.joints).toHaveLength(next.joints.length - 1); // original untouched
  });

  it('removeJoint drops by index and also drops any pigtail that lands there', () => {
    const design = loadDesign('de9-terminal-board');
    const index = design.joints.findIndex(
      (j) => j.a.instance === 'w1' && j.a.terminal === 'pigtail:shield' && j.a.end === 'a',
    );
    const next = removeJoint(design, index);
    expect(next.joints).toHaveLength(design.joints.length - 1);
    const w1After = next.instances.segments.find((s) => s.id === 'w1')!;
    expect(w1After.pigtails?.some((p) => p.id === 'shield' && p.end === 'a')).toBe(false);
  });

  it('removeJoints drops several indices in one pass', () => {
    const design = loadDesign('de9-terminal-board');
    const before = design.joints.length;
    const next = removeJoints(design, [0, 2]);
    expect(next.joints).toHaveLength(before - 2);
    expect(next.joints).toEqual(design.joints.filter((_, at) => at !== 0 && at !== 2));
  });
});

describe('updateInstance', () => {
  it('patches only the given fields, per instance kind, and clears a field set to undefined/empty', () => {
    const design = loadDesign('de9-terminal-board');
    const lengthened = updateInstance(design, 'w1', { lengthMm: 2500 });
    expect(lengthened.instances.segments.find((i) => i.id === 'w1')?.lengthMm).toBe(2500);

    const roled = updateInstance(lengthened, 'w1', { role: 'trunk (8 ft)' });
    expect(roled.instances.segments.find((i) => i.id === 'w1')?.role).toBe('trunk (8 ft)');

    const noted = updateInstance(roled, 'u1', { note: 'hand-fitted hood' });
    expect(noted.instances.pcbas.find((i) => i.id === 'u1')?.note).toBe('hand-fitted hood');

    const cleared = updateInstance(noted, 'u1', { note: '' });
    expect(cleared.instances.pcbas.find((i) => i.id === 'u1')).not.toHaveProperty('note');
  });

  it('leaves every other instance exactly as it was', () => {
    const design = loadDesign('de9-terminal-board');
    const next = updateInstance(design, 'w1', { role: 'x' });
    expect(next.instances.connectors).toEqual(design.instances.connectors);
    expect(next.instances.pcbas).toEqual(design.instances.pcbas);
  });

  it('is a no-op on the four instance lists for an id that is not there', () => {
    const design = loadDesign('de9-terminal-board');
    const next = updateInstance(design, 'ghost', { note: 'x' });
    expect(next.instances.connectors).toEqual(design.instances.connectors);
    expect(next.instances.segments).toEqual(design.instances.segments);
    expect(next.instances.components).toEqual(design.instances.components);
    expect(next.instances.pcbas).toEqual(design.instances.pcbas);
  });

  it('keeps instance kinds it does not edit (e.g. `mechanical`)', () => {
    const design = loadDesign('de9-terminal-board');
    expect(design.instances.mechanical?.length).toBeGreaterThan(0);
    const next = updateInstance(design, 'ghost', { note: 'x' });
    expect(next.instances.mechanical).toEqual(design.instances.mechanical);
  });
});

describe('parseDesignJson', () => {
  it('parses a valid document', () => {
    const design = loadDesign('de9-terminal-board');
    const result = parseDesignJson(JSON.stringify(design));
    expect(result.ok).toBe(true);
    expect(result.ok && result.design.id).toBe(design.id);
  });

  it('rejects invalid JSON with the parser message', () => {
    const result = parseDesignJson('{not json');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('not JSON');
  });

  it('rejects a non-object', () => {
    const result = parseDesignJson('42');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('expected an object');
  });

  it('rejects an unsupported schemaVersion', () => {
    const result = parseDesignJson(JSON.stringify({ schemaVersion: 99 }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('unsupported schemaVersion');
  });

  it('rejects a document missing id/label/src', () => {
    const result = parseDesignJson(JSON.stringify({ schemaVersion: 1 }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("missing 'id'");
  });

  it('rejects a document missing its instances lists', () => {
    const result = parseDesignJson(
      JSON.stringify({ schemaVersion: 1, id: 'x', label: 'x', src: 'x' }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("missing 'instances'");
  });

  it('rejects a document missing its joints list', () => {
    const result = parseDesignJson(
      JSON.stringify({
        schemaVersion: 1,
        id: 'x',
        label: 'x',
        src: 'x',
        instances: { connectors: [], segments: [], components: [], pcbas: [] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("missing 'joints'");
  });
});
