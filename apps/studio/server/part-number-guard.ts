/**
 * Refuse to save a part number that another part already carries (cs-5k1.3).
 *
 * Validation only warns about a duplicate (`pn-duplicate`); a save that would
 * newly *create* one is refused, so a number is never reused by accident. A number
 * the record already had is left alone: an old duplicate never blocks an unrelated
 * edit. Who counts as "another part" is `part-number-health.ts` — twins and a
 * design's own two copies (product reference, drawing) are one part.
 */

import { canonicalPartNumber, holdersOfNumber, partNumberHolders, type CableDesign, type Db, type PartNumberScheme } from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import { readAllDesigns } from './designs.ts';
import { partNumberSchemeOf } from './part-number-scheme.ts';

/**
 * "Existing numbers never change" (a scheme with `immutable`): a record that
 * carries a number cannot be saved with another one, or none. Absent a number
 * (a new record, or one not numbered yet) the first assignment is free.
 * `undefined` = fine to save.
 */
export function refuseChangedNumber(scheme: PartNumberScheme, where: string, next: string | undefined, current: string | undefined): ApiResponse | undefined {
  if (scheme.immutable !== true) return undefined;
  const was = canonicalPartNumber(current, scheme);
  if (was === undefined) return undefined;
  const now = canonicalPartNumber(next, scheme);
  if (now === was) return undefined;
  return {
    status: 422,
    body: {
      error: `${where} already has the part number '${current?.trim() ?? was}', and this scheme never changes an existing number.`,
      hint: 'Nothing was saved. Leave the number as it is (a new variant or a new part gets a new number), or turn off "existing numbers never change" in Settings, Part numbers.',
      issues: [{ code: 'pn-immutable', severity: 'warning', message: `'${was}' cannot be changed to '${now ?? '(empty)'}'`, where }],
    },
  };
}

export async function refuseTakenDesignNumber(
  deps: WorkbenchDeps,
  designId: string,
  /** which field is being saved */
  field: 'productRef' | 'drawing',
  /** the number being saved and the number the record has now */
  next: string | undefined,
  current: string | undefined,
): Promise<ApiResponse | undefined> {
  const pn = next?.trim();
  if (pn === current?.trim()) return undefined;
  const scheme = await partNumberSchemeOf(deps);
  const changed = refuseChangedNumber(scheme, field === 'drawing' ? `The drawing of '${designId}'` : `The cable '${designId}'`, next, current);
  if (changed !== undefined) return changed;
  if (pn === undefined || pn === '') return undefined;
  const db: Db = await deps.loadDb();
  const designs: CableDesign[] = await readAllDesigns(deps.designs);
  const drawings: Record<string, { partNumber?: string }> = {};
  for (const d of designs) {
    try {
      const meta = (await deps.drawings?.read(d.id))?.meta;
      if (meta !== undefined) drawings[d.id] = meta;
    } catch {
      // an unreadable sidecar carries no number
    }
  }
  const holders = partNumberHolders(db, designs, drawings, scheme);
  const taken = holdersOfNumber(holders, pn, scheme, `designs/${designId}`);
  if (taken.length === 0) return undefined;
  return {
    status: 422,
    body: {
      error: `The part number '${pn}' is already on ${taken.map((h) => h.where).join(', ')}.`,
      hint: `Nothing was saved. Use another number (Suggest in the ${field === 'drawing' ? 'drawing' : 'cable'} form proposes the next free one), or change the other record first.`,
      issues: [{ code: 'pn-duplicate', severity: 'warning', message: `part number '${pn}' is taken`, where: field === 'drawing' ? `drawings/${designId}` : `designs/${designId}` }],
    },
  };
}
