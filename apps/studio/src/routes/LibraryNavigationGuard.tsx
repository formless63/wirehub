import { useBlocker } from '@tanstack/react-router';
import { ConfirmDialog, EditSessionContext, useEditSession } from '@wirehub/editor-react';
import { useCallback, useMemo, useState, type JSX, type ReactNode } from 'react';

/** Protect Library drafts when leaving the section (Home, Settings, etc.).
 * Selection within Library remains owned by its existing editor controls. */
export function LibraryNavigationGuard({ children }: { children: ReactNode }): JSX.Element {
  const session = useEditSession();
  const [dirtyCount, setDirtyCount] = useState(0);
  const onDirtyChange = useCallback((dirty: boolean): void => {
    session.onDirtyChange?.(dirty);
    setDirtyCount(count => Math.max(0, count + (dirty ? 1 : -1)));
  }, [session.onDirtyChange]);
  const value = useMemo(() => ({ ...session, onDirtyChange }), [session, onDirtyChange]);
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => (next.pathname === '/library/store' || (!next.pathname.startsWith('/library/') && next.pathname !== '/library')) && dirtyCount > 0,
    enableBeforeUnload: false, // the Library already provides the browser unload guard
    withResolver: true,
  });
  return <EditSessionContext.Provider value={value}>
    {children}
    <ConfirmDialog open={blocker.status === 'blocked'} title="Discard unsaved Library edits?" confirmLabel="Discard and leave" cancelLabel="Stay" destructive onConfirm={() => blocker.proceed?.()} onCancel={() => blocker.reset?.()}>
      Leaving this page loses the edits you have not saved.
    </ConfirmDialog>
  </EditSessionContext.Provider>;
}
