/**
 * The bridge between `CableRoute`'s `<CableEditor chrome="host" ref={…}>` and
 * the shell's own chrome (`TopBar`, `StatusBar`) —.
 *
 * `TopBar` is mounted once, above the routed page (`Shell.tsx`); `CableRoute`
 * is the routed page. Neither is an ancestor of the other, so the editor's
 * `EditorHandle` (a ref) and its `EditorChromeState` (dirty/undo/redo/…) have
 * to live in a context that wraps *both* — this one, provided by `Shell`.
 *
 * Deliberately **not** folded into `studio-context.tsx`: that file is another
 * task's ('s stale-write guard, the 409 toast) active
 * surface this session, and this state is purely about the editor's chrome —
 * it never touches persistence, routing or the query cache.
 */

import type { EditorChromeState, EditorHandle } from '@wirehub/editor-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

const DEFAULT_STATE: EditorChromeState = {
  dirty: false,
  saving: false,
  canUndo: false,
  undoLabel: undefined,
  canRedo: false,
  redoLabel: undefined,
  statusMessage: undefined,
  tool: 'select',
};

export interface EditorChromeApi {
  /** `undefined` whenever no `chrome="host"` `CableEditor` is mounted (no cable open) */
  handle: EditorHandle | null;
  /** the ref callback `CableRoute` hands `<CableEditor ref={…}>` */
  setHandle: (handle: EditorHandle | null) => void;
  state: EditorChromeState;
  setState: (state: EditorChromeState) => void;
}

const EditorChromeContext = createContext<EditorChromeApi | undefined>(undefined);

export function EditorChromeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [handle, setHandleState] = useState<EditorHandle | null>(null);
  const [state, setState] = useState<EditorChromeState>(DEFAULT_STATE);

  const setHandle = useCallback((next: EditorHandle | null): void => {
    setHandleState(next);
    // a cable just closed (or a different one just opened, which remounts
    // the editor — `key={id}` in CableRoute) — the old handle's numbers are
    // gone with it, so the header should not keep showing them stale
    if (next === null) setState(DEFAULT_STATE);
  }, []);

  const value = useMemo<EditorChromeApi>(
    () => ({ handle, setHandle, state, setState }),
    [handle, setHandle, state],
  );

  return <EditorChromeContext.Provider value={value}>{children}</EditorChromeContext.Provider>;
}

export function useEditorChrome(): EditorChromeApi {
  const value = useContext(EditorChromeContext);
  if (value === undefined) {
    throw new Error('useEditorChrome() must be used inside <EditorChromeProvider>');
  }
  return value;
}
