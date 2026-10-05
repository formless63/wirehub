/** The one channel from a node/panel back into the store. */

import { createContext, useContext } from 'react';
import type { Db, StripPractice, TerminalRef } from '@wirehub/model';

import type { EditorAction, Selection } from './store.ts';

export interface EditorApi {
  dispatch: (action: EditorAction) => void;
  selection: Selection | undefined;
  /**
   * Opens the node picker — the `+` a free handle's
   * row/handle renders calls this with its own terminal as `anchor`; Tab on
   * the canvas and the "Add part…" command call it with `undefined` (list
   * everything, no fits-here filtering).
   */
  openPicker: (anchor?: TerminalRef) => void;
  /**
   * "Part labels": whether a populated board's parts
   * print their ref/value over the artwork. Off by default — a hover always
   * shows the same information as a tooltip (the part's `<title>`),
   * regardless of this toggle. The "Part labels" canvas-toolbar button
   * flips it; `CableEditor` remembers the choice per viewer (`EditorLayoutStore`).
   */
  partLabelsVisible: boolean;
  /**
   * Delete parts the safe way: straight away when no
   * wire lands on them, else after an in-app "Delete j1 and its 12 wires?".
   * Absent (a bare test harness), callers dispatch `delete-instances` itself.
   */
  requestDelete?: (ids: readonly string[]) => void;
  /** the bench's strip steps, when the host serves them — the segment 3D view's presets */
  stripPractice?: readonly StripPractice[];
  /**
   * Place another design as a sub-assembly (`assemblies.ts`): fetches the
   * design's ports first when the library does not hold it. Absent (a bare
   * test harness): dispatch `add-instance` with kind `subassembly`.
   */
  placeSubassembly?: (def: string, position?: { x: number; y: number }) => void;
  /** the library with design `def` loaded (its ports known) — resolves to the db to rank against */
  ensureAssembly?: (def: string) => Promise<Db>;
  /** open a placed design in its own editor — the host navigates (`CableEditorProps.onOpenDesign`) */
  openDesign?: (id: string) => void;
}

export const EditorContext = createContext<EditorApi | undefined>(undefined);

export function useEditorApi(): EditorApi {
  const api = useContext(EditorContext);
  if (api === undefined) {
    throw new Error('useEditorApi must be used inside <CableEditor>');
  }
  return api;
}

export function classes(...parts: (string | false | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}
