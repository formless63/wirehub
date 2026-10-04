/** Element path resolution on the starter stocks. */

import { describe, expect, it } from 'vitest';
import { loadDb } from '@cable-studio/catalog';

import { findWire, resolveElementPath, type WireDefinition } from '../src/index.ts';

const db = loadDb();
const stock = (id: string): WireDefinition => {
  const wire = findWire(db, id);
  if (wire === undefined) throw new Error(`no ${id}`);
  return wire;
};

describe('element paths', () => {
  it('resolves a conductor inside a twisted pair', () => {
    expect(resolveElementPath(stock('cat5e-utp').structure, 'pair-2.a')?.kind).toBe('conductor');
  });

  it('resolves top-level screens and conductors', () => {
    const wire = stock('shielded-2pair-24awg');
    expect(resolveElementPath(wire.structure, 'foil')?.kind).toBe('shield');
    expect(resolveElementPath(wire.structure, 'drain')?.kind).toBe('conductor');
  });

  it('resolves a group, which is not itself electrical', () => {
    expect(resolveElementPath(stock('cat5e-utp').structure, 'pair-1')?.kind).toBe('group');
  });

  it('answers undefined for a path the stock does not have', () => {
    expect(resolveElementPath(stock('cat5e-utp').structure, 'pair-5.a')).toBeUndefined();
    expect(resolveElementPath(stock('mic-2core-braid').structure, 'drain')).toBeUndefined();
  });

  it('resolves the jacket, which carries no terminals', () => {
    expect(resolveElementPath(stock('mic-2core-braid').structure, 'jacket')?.kind).toBe('insulation');
  });
});
