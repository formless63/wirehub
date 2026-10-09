/**
 * Undo for deleting a design (cs-8kj.6). A delete goes through at once; what was there is kept so
 * that "Undo" within ten seconds puts it back: the design as it was stored, and its drawing details
 * and photo (the sidecar). A deleted design never had a released revision (the server refuses
 * those) and uploads are never removed, so these are all there was. Even without Undo the delete
 * stays in the change history.
 */

import type { CableDesign } from '@wirehub/model';
import type { DrawingAdapter, DrawingSidecar, Outcome, PersistenceAdapter } from '@wirehub/editor-react';

export interface DeletedDesign {
  design: CableDesign;
  sidecar?: DrawingSidecar;
}

/** the design and its drawing details, read just before a delete; `undefined` when it cannot be read (then there is no Undo) */
export async function captureDesign(persistence: Pick<PersistenceAdapter, 'load'>, drawings: Pick<DrawingAdapter, 'load'>, id: string): Promise<DeletedDesign | undefined> {
  const loaded = await persistence.load(id);
  if (!loaded.ok) return undefined;
  const sidecar = await drawings.load(id);
  return { design: loaded.value, ...(sidecar.ok && Object.keys(sidecar.value.meta).length > 0 ? { sidecar: sidecar.value } : {}) };
}

/** create the design again, then its drawing details and photo; `drawings` must be fresh (no stale-write version of the deleted sidecar) */
export async function restoreDesign(deleted: DeletedDesign, persistence: Pick<PersistenceAdapter, 'create'>, drawings: Pick<DrawingAdapter, 'save' | 'savePhoto'>): Promise<Outcome<CableDesign>> {
  const back = await persistence.create(deleted.design);
  if (!back.ok) return back;
  if (deleted.sidecar !== undefined) {
    await drawings.save(deleted.design.id, deleted.sidecar.meta);
    if (deleted.sidecar.photo !== undefined) await drawings.savePhoto(deleted.design.id, deleted.sidecar.photo);
  }
  return back;
}
