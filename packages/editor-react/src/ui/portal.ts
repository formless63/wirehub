import { createContext, useContext } from 'react';

/**
 * Where overlays (Select, Popover, Menu, Tooltip, Dialog) mount. Default: `document.body`. A host
 * that scopes a theme to a subtree (the `/dev/ui` gallery shows light and dark side by side) provides
 * that subtree, so a portalled list inherits the same `data-theme`.
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
