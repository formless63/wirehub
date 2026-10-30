/**
 * Built units from the inventory's design batches: each good unit of a batch, `<batch id>.<n>`.
 * Kept free of the router so the firmware commissioning record can link to a unit.
 */

import { UNIT_ID, type BuiltUnit } from '../../src/units.ts';
import type { InventoryStore } from '../inventory/store.ts';
import type { Batch } from '../inventory/types.ts';

export type UnitRow = Omit<BuiltUnit, 'latest' | 'tests'>;

const MAX_UNITS = 5000;

/** Every good unit of these design batches, in batch order (newest first) then place. */
export function unitsOfBatches(batches: readonly Batch[], labels: Map<string, string>): UnitRow[] {
  const out: UnitRow[] = [];
  for (const b of batches) {
    if (b.item.kind !== 'designs') continue;
    for (let n = 1; n <= Math.floor(b.units) && out.length < MAX_UNITS; n += 1) {
      const serial = b.serials[n - 1];
      out.push({
        id: `${b.id}.${n}`,
        design: b.item.id,
        label: labels.get(b.item.id) ?? b.item.id,
        batch: b.id,
        n,
        ...(serial === undefined ? {} : { serial }),
        ...(b.batchCode === undefined ? {} : { batchCode: b.batchCode }),
        ...(b.rev === undefined ? {} : { rev: b.rev }),
        builtAt: b.at,
        builtBy: b.by,
      });
    }
  }
  return out;
}

export async function designBatches(inventory: InventoryStore, design?: string): Promise<Batch[]> {
  return inventory.read((tx) => tx.batches(design === undefined ? {} : { item: { kind: 'designs', id: design } }));
}

/**
 * The built unit a loose reference names (a commissioning record's unit): a unit id, else a serial
 * that exactly one built unit carries. Undefined when none does, or the serial is ambiguous.
 */
export async function resolveUnitRef(deps: { inventory?: InventoryStore }, ref: string, serial?: string): Promise<string | undefined> {
  if (deps.inventory === undefined) return undefined;
  const batches = (await designBatches(deps.inventory)).filter((b) => b.item.kind === 'designs');
  const units = unitsOfBatches(batches, new Map());
  for (const key of [ref, serial]) {
    if (key === undefined || key === '') continue;
    if (UNIT_ID.test(key) && units.some((u) => u.id === key)) return key;
    const bySerial = units.filter((u) => u.serial === key);
    if (bySerial.length === 1) return bySerial[0]!.id;
  }
  return undefined;
}

