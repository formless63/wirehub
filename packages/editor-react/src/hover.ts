/**
 * The hovered ground pigtail, shared between the edge that carries it (its
 * `×n` badge) and the wire node that draws it (its members light up on the
 * face). A tiny external store, so a hover re-renders only the wire node and
 * edge that care, not every consumer of the editor context. Presentation
 * only; never part of the editor state or its history.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';

export interface HoverStore {
  get: () => string | undefined;
  set: (portId: string | undefined) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createHoverStore(): HoverStore {
  let current: string | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (portId) => {
      if (portId === current) return;
      current = portId;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const fallback = createHoverStore();

export const HoverContext = createContext<HoverStore>(fallback);

/** The store, to set the hovered port. */
export function useHoverStore(): HoverStore {
  return useContext(HoverContext);
}

/** The hovered port id, when it is one of `ids` (so other hovers do not re-render). */
export function useHoveredPort(ids: ReadonlySet<string>): string | undefined {
  const store = useContext(HoverContext);
  return useSyncExternalStore(
    store.subscribe,
    () => {
      const id = store.get();
      return id !== undefined && ids.has(id) ? id : undefined;
    },
    () => undefined,
  );
}
