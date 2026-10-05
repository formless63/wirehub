/**
 * The browser's own "Leave site? Changes you made may not be saved." prompt,
 * armed exactly while something on screen is unsaved (review fix, 2026-09-26:
 * a reload or tab close dropped edits silently). In-app navigation keeps
 * drafts on its own; this only covers leaving the page.
 *
 * It also tells the host's edit session (`edit-session.ts`, edit locks)
 * when this editor turns dirty or clean again: the
 * first change is the moment a host takes the record's edit lock.
 */

import { useEffect } from 'react';

import { useEditSession } from './edit-session.ts';

export function useUnsavedChangesGuard(dirty: boolean): void {
  const { onDirtyChange } = useEditSession();
  useEffect(() => {
    if (!dirty || onDirtyChange === undefined) return;
    onDirtyChange(true);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // older browsers show the prompt only when returnValue is set
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
