/**
 * Refuse to save a part number that another part already carries (cs-5k1.3).
 *
 * Validation only warns about a duplicate (`pn-duplicate`); a save that would
 * newly *create* one is refused, so a number is never reused by accident. A number
 * the record already had is left alone: an old duplicate never blocks an unrelated
 * edit. Who counts as "another part" is `part-number-health.ts` — twins and a
 * design's own two copies (product reference, drawing) are one part.
 */

import { holdersOfNumber, partNumberHolders, type CableDesign, type Db } from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import { readAllDesigns } from './designs.ts';
import { partNumberSchemeOf } from './part-number-scheme.ts';

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
  if (pn === undefined || pn === '' || pn === current?.trim()) return undefined;
  const scheme = await partNumberSchemeOf(deps);
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
