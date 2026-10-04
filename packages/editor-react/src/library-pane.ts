/**
 * The Library's list pane: how wide it is and whether it is folded away
 * ( — "the sidebar for the library is likely too wide …
 * adjustable width and collapsible for when working on individual content").
 *
 * A per-viewer convenience, so it lives in this browser's `localStorage` and
 * nowhere else; every read and write is guarded, because storage can be
 * missing or throw (private windows, blocked site data, tests) and the pane
 * must still work at its defaults.
 */

export interface LibraryPaneState {
  /** the list's width, CSS px */
  width: number;
  collapsed: boolean;
}

export const LIBRARY_PANE_KEY = 'cs.library.list-pane';
export const LIBRARY_PANE_DEFAULT: LibraryPaneState = { width: 320, collapsed: false };
export const LIBRARY_PANE_MIN = 220;
export const LIBRARY_PANE_MAX = 640;
/** the list never takes more than this share of the Library's own width */
export const LIBRARY_PANE_MAX_SHARE = 0.6;
/** the keyboard combo that folds/unfolds the list (Ctrl or ⌘) */
export const LIBRARY_PANE_SHORTCUT = 'Ctrl+B';

/** A width the list can actually take in a Library `available` px wide. */
export function clampListWidth(width: number, available?: number): number {
  const ceiling =
    available === undefined || available <= 0
      ? LIBRARY_PANE_MAX
      : Math.min(LIBRARY_PANE_MAX, Math.max(LIBRARY_PANE_MIN, Math.floor(available * LIBRARY_PANE_MAX_SHARE)));
  if (!Number.isFinite(width)) return LIBRARY_PANE_DEFAULT.width;
  return Math.round(Math.min(ceiling, Math.max(LIBRARY_PANE_MIN, width)));
}

/** What this viewer left the pane as — or the defaults, whatever storage says. */
export function loadLibraryPane(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): LibraryPaneState {
  try {
    const raw = storage?.getItem(LIBRARY_PANE_KEY);
    if (raw === null || raw === undefined) return LIBRARY_PANE_DEFAULT;
    const parsed = JSON.parse(raw) as Partial<LibraryPaneState>;
    return {
      width: clampListWidth(typeof parsed.width === 'number' ? parsed.width : LIBRARY_PANE_DEFAULT.width),
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return LIBRARY_PANE_DEFAULT;
  }
}

export function saveLibraryPane(
  state: LibraryPaneState,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(LIBRARY_PANE_KEY, JSON.stringify(state));
  } catch {
    // a per-viewer nicety: losing it costs one drag next time
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
