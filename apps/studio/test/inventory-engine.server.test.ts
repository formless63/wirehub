/**
 * The inventory invariants (`server/inventory/engine.ts`) on the in-memory store: a cut never spans
 * two reels, a balance is always the sum of its ledger, on hand never drops below what is held, and
 * releasing gives the held stock back; a build finished in parts counts its units and closes once.
 */

import { describe, expect, it } from 'vitest';

import { adjust, completeUnits, consume, createLocation, receive, release, reserve } from '../server/inventory/engine.ts';
import type { BuildRequirement } from '../server/inventory/requirements.ts';
import { memoryInventoryStore } from '../server/inventory/store.ts';
import { InventoryError } from '../server/inventory/types.ts';

const wire = { kind: 'wires' as const, id: 'synthetic-2-core' };
const plug = { kind: 'connectors' as const, id: 'synthetic-plug' };

function requirement(buildQty: number): BuildRequirement {
  const perCutMm = 20;
  return {
    design: 'synthetic-lead',
    label: 'Synthetic lead',
    buildQty,
    allowance: { perCutMm, pct: 0 },
    gaps: [],
    lines: [
      { item: wire, dim: 'length', label: 'wire', category: 'wire', perUnit: 1000, pieces: [1000], needed: (1000 + perCutMm) * buildQty, route: { route: 'buy', assumed: true }, bomKeys: [] },
      { item: plug, dim: 'count', label: 'plug', category: 'connector', perUnit: 2, needed: 2 * buildQty, route: { route: 'buy', assumed: true }, bomKeys: [] },
    ],
  };
}

describe('inventory engine', () => {
  it('holds each cut on one reel, keeps balances equal to the ledger, and releases', async () => {
    const store = memoryInventoryStore();
    const shelf = await store.transact('tester', (tx) => createLocation(tx, { name: 'Shelf' }));
    const short = await store.transact('tester', (tx) => receive(tx, { item: wire, dim: 'length', qty: 2500, location: shelf.id }));
    const long = await store.transact('tester', (tx) => receive(tx, { item: wire, dim: 'length', qty: 4000, location: shelf.id }));
    await store.transact('tester', (tx) => receive(tx, { item: plug, dim: 'count', qty: 7, location: shelf.id }));

    // 5 cuts of 1020 mm: 6500 mm in total would cover 5100, but only 2 fit on the short reel and 3 on the long one
    const r = await store.transact('tester', (tx) => reserve(tx, requirement(5), { partial: true }));
    const wireLine = r.lines.find((l) => l.item.kind === 'wires')!;
    for (const a of wireLine.allocations) expect(a.qty % 1020).toBe(0);
    expect(Object.fromEntries(wireLine.allocations.map((a) => [a.lot, a.qty]))).toEqual({ [short.lot.id]: 2040, [long.lot.id]: 3060 });
    // the plugs are short by 3: held what there is
    expect(r.lines.find((l) => l.item.kind === 'connectors')!.allocations.reduce((s, a) => s + a.qty, 0)).toBe(7);

    // on hand never drops below what is held
    await expect(store.transact('tester', (tx) => adjust(tx, long.lot.id, { count: 1000, reason: 'count' }, undefined))).rejects.toBeInstanceOf(InventoryError);

    await store.transact('tester', (tx) => consume(tx, r.id, { units: 2 }, undefined));
    const released = await store.transact('tester', (tx) => release(tx, r.id, {}, undefined));
    expect(released.status).toBe('closed');

    await store.read(async (tx) => {
      for (const lot of await tx.lots({ empty: true })) {
        const sum = (await tx.movements({ lot: lot.id })).filter((m) => m.lot === lot.id).reduce((s, m) => s + m.qty, 0);
        expect(lot.onHand).toBeCloseTo(sum, 6);
        expect(lot.reserved).toBe(0);
      }
      // two finished units took two cuts and four plugs
      const used = (await tx.movements({ reservation: r.id })).reduce((s, m) => s + m.qty, 0);
      expect(used).toBe(-(2 * 1020 + 4));
    });
  });

  it('finishes a build in parts: each unit takes its share, serials stay unique, the last part closes it', async () => {
    const store = memoryInventoryStore();
    const shelf = await store.transact('tester', (tx) => createLocation(tx, { name: 'Shelf' }));
    await store.transact('tester', (tx) => receive(tx, { item: wire, dim: 'length', qty: 10_000, location: shelf.id }));
    await store.transact('tester', (tx) => receive(tx, { item: plug, dim: 'count', qty: 20, location: shelf.id }));
    const r = await store.transact('tester', (tx) => reserve(tx, requirement(5), { partial: true }));

    const first = await store.transact('tester', (tx) => completeUnits(tx, r.id, { units: 2, serials: ['S1', 'S2'], into: shelf.id }, undefined));
    expect(first.reservation).toMatchObject({ status: 'open', unitsDone: 2 });
    expect(first.lot).toMatchObject({ item: { kind: 'designs', id: 'synthetic-lead' }, onHand: 2 });
    await expect(store.transact('tester', (tx) => completeUnits(tx, r.id, { units: 1, serials: ['S2'] }, undefined))).rejects.toThrow(/already recorded/);
    await expect(store.transact('tester', (tx) => completeUnits(tx, r.id, { units: 4 }, undefined))).rejects.toThrow(/3 unit\(s\) left/);

    // the rest, one of them scrapped: the scrapped unit's parts come from free stock
    const last = await store.transact('tester', (tx) => completeUnits(tx, r.id, { units: 3, failed: 1 }, undefined));
    expect(last.reservation).toMatchObject({ status: 'closed', unitsDone: 5 });
    await store.read(async (tx) => {
      const consumed = (await tx.movements({})).filter((m) => m.kind === 'consume');
      expect(consumed.filter((m) => m.item.kind === 'connectors').reduce((s, m) => s + m.qty, 0)).toBe(-12);
      expect(consumed.every((m) => m.batch !== undefined)).toBe(true);
      expect((await tx.batches({ reservation: r.id })).map((b) => b.units).sort()).toEqual([2, 3]);
      for (const lot of await tx.lots({ empty: true })) expect(lot.reserved).toBe(0);
    });
  });
});
