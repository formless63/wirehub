/**
 * The host's edit session around one record ( edit
 * locks) — a context, so no editor needs a new prop threaded through it.
 *
 * - `locked`: someone else is editing this record. Every editor under the
 *   session shows everything but changes nothing — controls disabled, not
 *   hidden; the canvas keeps pan/zoom/select.
 * - `onDirtyChange`: every unsaved-changes guard under the session reports
 *   here (`useUnsavedChangesGuard`), which is how a host learns "the person
 *   just made their first change" without each editor knowing about locks.
 *
 * With no provider (a host without locks, the tests) nothing is locked and
 * nobody listens — exactly the editor's behaviour before.
 */

import { createContext, useContext } from 'react';

export interface EditSession {
  locked: boolean;
  /** one editor under the session became dirty (`true`) or clean again (`false`) */
  onDirtyChange?: (dirty: boolean) => void;
}

const NO_SESSION: EditSession = { locked: false };

export const EditSessionContext = createContext<EditSession>(NO_SESSION);

export function useEditSession(): EditSession {
  return useContext(EditSessionContext);
}

/** `true` when someone else holds the record's edit lock. */
export function useEditLocked(): boolean {
  return useContext(EditSessionContext).locked;
}
