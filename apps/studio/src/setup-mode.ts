/**
 * Whether first-run setup is on screen. While it is, the shell drops its chrome
 * and the studio does not probe the workbench for designs (a hub that has not
 * finished setup has nothing to list, and "Offline" there is noise). The flag
 * starts from the address bar so the very first render already knows.
 */

import { useSyncExternalStore } from 'react';

let active = typeof window !== 'undefined' && window.location.pathname === '/setup';
const listeners = new Set<() => void>();

export function setSetupMode(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of [...listeners]) listener();
}

export function useSetupMode(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => active,
    () => false,
  );
}
