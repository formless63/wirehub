/**
 * Which module slots a person keeps open: "pin open" on a ModuleSlot, remembered per user.
 *
 * Storage: this browser's `localStorage`, one key per signed-in user
 * (`wirehub:module-slot-pins:<user>`), because the hub has no per-user preference store yet
 * (documented in `docs/modules.md`, "Module slots"). It follows the browser, not the account;
 * an unreadable or blocked store just means every slot starts collapsed.
 */

const PREFIX = 'wirehub:module-slot-pins:';

const keyOf = (user: string): string => `${PREFIX}${user}`;

/** the slots `user` pinned open, as `<slot>/<module>` */
export function readPins(user: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(keyOf(user));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writePin(user: string, slotKey: string, pinned: boolean): void {
  try {
    const pins = readPins(user);
    if (pinned) pins.add(slotKey);
    else pins.delete(slotKey);
    window.localStorage.setItem(keyOf(user), JSON.stringify([...pins].sort()));
  } catch {
    // best effort: the slot still opens for this page view
  }
}
