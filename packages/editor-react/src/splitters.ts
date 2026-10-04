/**
 * Pane sizes, and the arithmetic of dragging a splitter.
 *
 * The workbench is three columns and a dock, and until now every one of them
 * was a number in the stylesheet: the schematic preview got 38% of the middle
 * column whether the person reading it was checking a pin or reading the whole
 * drawing. Sizes belong to the person, so they live in
 * state, are dragged with the pointer, and are remembered by the host.
 *
 * No library and no measurement here: pure numbers, so the clamping — which is
 * the only part that can go wrong — is testable without a DOM. The rule is
 * that **nothing collapses**: every pane keeps a floor, and the canvas keeps
 * one too, so no drag can leave a pane the user cannot get back.
 */

/** The panes a user can resize. `dock` is the schematic/JSON pane's height. */
export type PaneKey = 'palette' | 'side' | 'dock';

export interface PaneSizes {
  /** parts palette, px wide */
  palette: number;
  /** inspector + issues column, px wide */
  side: number;
  /** schematic preview / JSON dock, px tall */
  dock: number;
}

/** The stylesheet's own numbers, kept as the reset target. */
export const DEFAULT_PANES: PaneSizes = { palette: 248, side: 340, dock: 300 };

/** Nothing may be dragged smaller than this. */
export const PANE_MIN: Record<PaneKey, number> = { palette: 150, side: 220, dock: 80 };

/** …and the canvas keeps at least this much, however hungry a pane gets. */
export const CANVAS_MIN = { width: 280, height: 120 } as const;

/** The grab strip between two panes, px. */
export const SPLITTER_SIZE = 6;

/** How far one arrow-key press moves a splitter. */
export const PANE_KEY_STEP = 16;

const HORIZONTAL: Record<'palette' | 'side', 'palette' | 'side'> = {
  palette: 'side',
  side: 'palette',
};

/**
 * The widest this pane may be: whatever is left once the other pane, the
 * canvas' floor and the splitters have had their share. `available` is the
 * container's size along the axis; a container that has not been measured yet
 * (0, or a jsdom test) imposes no ceiling, only the floor.
 */
export function paneLimit(sizes: PaneSizes, key: PaneKey, available: number): number {
  if (!Number.isFinite(available) || available <= 0) return Number.POSITIVE_INFINITY;
  if (key === 'dock') {
    return Math.max(PANE_MIN.dock, available - CANVAS_MIN.height - SPLITTER_SIZE);
  }
  const other = sizes[HORIZONTAL[key]];
  return Math.max(
    PANE_MIN[key],
    available - other - CANVAS_MIN.width - SPLITTER_SIZE * 2,
  );
}

/** `value` brought inside this pane's floor and ceiling, rounded to whole px. */
export function clampPane(
  sizes: PaneSizes,
  key: PaneKey,
  value: number,
  available: number,
): number {
  const limit = paneLimit(sizes, key, available);
  const wanted = Number.isFinite(value) ? value : sizes[key];
  return Math.round(Math.min(Math.max(wanted, PANE_MIN[key]), limit));
}

/** One pane set to a new size; the others are left exactly as they were. */
export function resizePane(
  sizes: PaneSizes,
  key: PaneKey,
  value: number,
  available: number,
): PaneSizes {
  const next = clampPane(sizes, key, value, available);
  return next === sizes[key] ? sizes : { ...sizes, [key]: next };
}

/** Double-click on a splitter: that pane goes back to the stylesheet's number. */
export function resetPane(sizes: PaneSizes, key: PaneKey, available: number): PaneSizes {
  return resizePane(sizes, key, DEFAULT_PANES[key], available);
}

/**
 * Sizes read back from a host's store. Anything that is not three finite
 * numbers is not sizes — a hand-edited or half-written record must not be able
 * to hide the palette.
 */
export function isPaneSizes(value: unknown): value is PaneSizes {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (['palette', 'side', 'dock'] as PaneKey[]).every((key) => {
    const size = candidate[key];
    return typeof size === 'number' && Number.isFinite(size) && size > 0;
  });
}

/** Stored sizes made safe: unknown shapes fall back to the defaults. */
export function paneSizesOf(value: unknown): PaneSizes {
  if (!isPaneSizes(value)) return DEFAULT_PANES;
  return {
    palette: Math.max(PANE_MIN.palette, Math.round(value.palette)),
    side: Math.max(PANE_MIN.side, Math.round(value.side)),
    dock: Math.max(PANE_MIN.dock, Math.round(value.dock)),
  };
}

/** `.cs-body`'s columns: palette | splitter | canvas | splitter | inspector. */
export function paneColumns(sizes: PaneSizes): string {
  return `${sizes.palette}px ${SPLITTER_SIZE}px minmax(0, 1fr) ${SPLITTER_SIZE}px ${sizes.side}px`;
}
