/**
 * The derived mass beside the measured one (`docs/mass.md`, `docs/inventory.md`): a build view's
 * estimate per unit, and an estimate beside each batch that recorded `measured.unitMassG`. Only an
 * estimate: the measured figure is never changed, and neither ever goes into an export.
 */

import { deriveMass } from '@wirehub/docs';
import { effectivePieceMass, versionDb, type CableDesign, type Db, type MassMissing, type MassValue } from '@wirehub/model';

import { withDesignLibrary } from '../assemblies.ts';
import type { InventoryDeps } from './api.ts';
import type { Batch } from './types.ts';

/** One unit's derived mass, with what it is missing. */
export interface MassEstimate extends MassValue {
  missing: MassMissing[];
}

/** The estimate for one unit of `design` read against `db` (the library of designs already in it). */
export function massEstimateOf(design: CableDesign, db: Db): MassEstimate {
  const mass = deriveMass(design, db);
  return { g: mass.total.g, bound: mass.total.bound, missing: mass.missing };
}

/** The design at a saved revision (its frozen definitions) or its working copy, ready to weigh. */
async function designAt(deps: InventoryDeps, live: Db, id: string, rev: number | undefined): Promise<{ design: CableDesign; db: Db } | undefined> {
  let design: CableDesign | undefined;
  let db = live;
  if (rev !== undefined) {
    const file = await deps.versions?.read(id, rev);
    if (file !== undefined) {
      design = { ...file.design, id };
      db = versionDb(file.definitions, live);
    }
  }
  design ??= await deps.designs.read(id);
  if (design === undefined) return undefined;
  return { design, db: await withDesignLibrary(deps, design, db) };
}

/**
 * Batches with a measured unit mass gain `massEstimate`: a design build weighed at the batch's
 * revision (else the working copy), a library item (a print) by its record's `mass`.
 */
export async function withMassEstimates(deps: InventoryDeps, batches: readonly Batch[]): Promise<(Batch & { massEstimate?: MassValue })[]> {
  if (!batches.some((b) => b.measured.unitMassG !== undefined)) return [...batches];
  const live = await deps.loadDb();
  const cache = new Map<string, MassValue>();
  const estimate = async (batch: Batch): Promise<MassValue> => {
    const key = `${batch.item.kind}:${batch.item.id}@${batch.rev ?? ''}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    let value: MassValue = { g: null, bound: 'unknown' };
    if (batch.item.kind === 'designs') {
      const at = await designAt(deps, live, batch.item.id, batch.rev);
      if (at !== undefined) value = deriveMass(at.design, at.db).total;
    } else if (batch.item.kind !== 'wires') {
      const each = effectivePieceMass(live, batch.item.kind, batch.item.id);
      if (each !== undefined) value = { g: each.g, bound: 'exact' };
    }
    cache.set(key, value);
    return value;
  };
  const out: (Batch & { massEstimate?: MassValue })[] = [];
  for (const batch of batches) out.push(batch.measured.unitMassG === undefined ? batch : { ...batch, massEstimate: await estimate(batch) });
  return out;
}
