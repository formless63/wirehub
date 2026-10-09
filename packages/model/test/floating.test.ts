/**
 * A conductor that floats at both ends is a warning, and every sentence the
 * validator says about it uses names a person reads (`W1 pair 1 · blue`,
 * `J1 pin 2 · TXD`), never a terminal key.
 */

import { createCatalog, dataPath, fsCatalogSource } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { terminalName, validateDesign, warnings, type CableDesign, type Db } from '../src/index.ts';

const catalog = createCatalog(fsCatalogSource(dataPath(''), 'starter'));
const db: Db = catalog.loadDb();

/** A DE-9 at one end of a Cat 5e run and nothing jointed at all. */
function bare(): CableDesign {
  const design = structuredClone(catalog.loadDesign('de9-crossover'));
  design.instances.segments = [{ id: 'w1', def: 'cat5e-utp' }];
  design.instances.connectors = design.instances.connectors.slice(0, 1);
  design.instances.pcbas = [];
  design.joints = [];
  delete design.notes;
  return design;
}

const floating = (design: CableDesign) => warnings(validateDesign(design, db)).filter((i) => i.code === 'floating-conductor');

describe('conductors floating at both ends', () => {
  it('are one warning each, named for a person', () => {
    const found = floating(bare());
    expect(found).toHaveLength(8);
    expect(found[0]).toMatchObject({
      severity: 'warning',
      where: 'w1:pair-1.a@a',
      whereLabel: 'W1 pair 1 · blue (source end)',
    });
    expect(found.map((i) => i.message)[0]).toBe(
      'W1 pair 1 · blue is not connected at either end — connect it, or note it as a spare',
    );
  });

  it('are silenced by a design note naming either end', () => {
    const design = { ...bare(), notes: ['w1:pair-1.a@b spare'] };
    expect(floating(design)).toHaveLength(7);
  });

  it('become the one-end warning as soon as one end is jointed', () => {
    const design = bare();
    const pin = design.instances.connectors[0]!.id;
    design.joints = [{ a: { instance: pin, terminal: '1' }, b: { instance: 'w1', terminal: 'pair-1.a', end: 'a' } }];
    const issues = warnings(validateDesign(design, db));
    expect(issues.filter((i) => i.code === 'floating-conductor-end').map((i) => i.message)).toEqual([
      expect.stringContaining('W1 pair 1 · blue is connected at the source end but floating at the destination end'),
    ]);
    expect(floating(design)).toHaveLength(7);
  });

  /** the db with `cat5e-utp`'s conductor at `path` edited by `edit` (a generic stock marking) */
  function withStock(path: string, edit: (el: Record<string, unknown>) => void): Db {
    const wires = structuredClone(db.wires);
    const walk = (nodes: any[], prefix: string): void => {
      for (const n of nodes) {
        const p = prefix === '' ? n.id : `${prefix}.${n.id}`;
        if (p === path) edit(n);
        if (Array.isArray(n.children)) walk(n.children, p);
      }
    };
    const wire = wires.find((w) => w.id === 'cat5e-utp') as any;
    walk(wire.structure.children, '');
    return { ...db, wires };
  }

  it('are explained by a stock that marks the conductor as a spare (lane override)', () => {
    const marked = withStock('pair-1.a', (el) => { el.lane = 'spare'; });
    const found = warnings(validateDesign(bare(), marked)).filter((i) => i.code === 'floating-conductor');
    expect(found).toHaveLength(7);
    expect(found.map((i) => i.where)).not.toContain('w1:pair-1.a@a');
  });

  it('are explained by a stock label that says spare or NC, and by the tag table', () => {
    const labelled = withStock('pair-1.a', (el) => { el.label = 'Spare 1'; });
    expect(warnings(validateDesign(bare(), labelled)).filter((i) => i.code === 'floating-conductor')).toHaveLength(7);
    const tagged: Db = { ...db, tags: { ...db.tags, wires: { 'cat5e-utp': { lanes: { 'pair-1.a': 'nc', 'pair-1.b': 'spare' } } } } as never };
    expect(warnings(validateDesign(bare(), tagged)).filter((i) => i.code === 'floating-conductor')).toHaveLength(6);
  });

  it('still warn for conductors the stock does not mark', () => {
    const marked = withStock('pair-1.a', (el) => { el.lane = 'data-tx'; });
    expect(warnings(validateDesign(bare(), marked)).filter((i) => i.code === 'floating-conductor')).toHaveLength(8);
  });

  it('a stock-marked conductor jointed at one end only is explained at the other', () => {
    const marked = withStock('pair-1.a', (el) => { el.lane = 'nc'; });
    const design = bare();
    const pin = design.instances.connectors[0]!.id;
    design.joints = [{ a: { instance: pin, terminal: '1' }, b: { instance: 'w1', terminal: 'pair-1.a', end: 'a' } }];
    expect(warnings(validateDesign(design, marked)).filter((i) => i.code === 'floating-conductor-end')).toHaveLength(0);
    expect(warnings(validateDesign(design, db)).filter((i) => i.code === 'floating-conductor-end')).toHaveLength(1);
  });

  it('never leak a raw terminal key into a sentence', () => {
    for (const issue of validateDesign(bare(), db)) expect(issue.message).not.toMatch(/\bw1:/);
  });
});

describe('terminal names', () => {
  it('give a pin its number and its label, and a conductor its pair and colour', () => {
    const design = catalog.loadDesign('de9-crossover');
    const named: Db = {
      ...db,
      connectors: db.connectors.map((c) =>
        c.id === 'de9-female' ? { ...c, pins: c.pins.map((p) => (p.id === '2' ? { ...p, label: 'RXD' } : p)) } : c,
      ),
    };
    expect(terminalName(design, named, { instance: 'j1', terminal: '2' })).toBe('J1 pin 2 · RXD');
    expect(terminalName(design, named, { instance: 'j1', terminal: 'shell' })).toBe('J1 shell');
    expect(terminalName(bare(), db, { instance: 'w1', terminal: 'pair-2.b' })).toBe('W1 pair 2 · white orange');
  });
});
