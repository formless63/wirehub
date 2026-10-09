/**
 * Which module slots a person keeps open: "pin open" on a ModuleSlot, remembered per user.
 *
 * Stored with the person's other UI preferences (`prefs.browser.ts`): on the hub, per account, with
 * this browser's `localStorage` as the offline fallback. Pins made before that, under
 * `wirehub:module-slot-pins:<user>`, are still read and move to the new key at the next change.
 */

import { usePref } from '@wirehub/editor-react';

const LEGACY = 'wirehub:module-slot-pins:';
const KEY = 'slot-pins';

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** the slots `user` pinned in this browser before pins moved to the account, as `<slot>/<module>` */
export function legacyPins(user: string): string[] {
  try {
    const raw = window.localStorage.getItem(`${LEGACY}${user}`);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return isStrings(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** the pinned slots (`<slot>/<module>`) and a function that pins or unpins one */
export function useSlotPins(user: string): [ReadonlySet<string>, (slotKey: string, pinned: boolean) => void] {
  const [stored, setStored] = usePref<string[] | undefined>(KEY, undefined, (v): v is string[] | undefined => isStrings(v));
  const pins = stored ?? legacyPins(user);
  return [
    new Set(pins),
    (slotKey, pinned) => {
      const next = new Set(pins);
      if (pinned) next.add(slotKey);
      else next.delete(slotKey);
      setStored([...next].sort());
    },
  ];
}
