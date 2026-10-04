/**
 * Where the *look* of a workbench is remembered — and, as with designs and
 * artwork, the editor does not know.
 *
 * Two things here belong to the person rather than to the document: where they
 * dragged the parts of a cable, and how big they made the panes. Neither is a
 * fact about a cable, so neither may go in the design file; both should still
 * be there tomorrow morning. So the editor keeps them in state, and a host that
 * can store them hands one of these in — the studio writes localStorage, the
 * ERP will write a user record, and the tests use a `Map`. No `window`, no key
 * names and no JSON appear in this package.
 *
 * Every method is allowed to fail silently (a full disk, a private-mode
 * browser): a workbench whose sizes did not persist is a workbench, and the
 * editor must not break because storage said no.
 */

import type { XY } from './derive.ts';
import type { CanvasDetail } from './lod.ts';
import type { PaneSizes } from './splitters.ts';

export interface EditorLayoutStore {
  /** where this design's parts were left, or `undefined` for "never arranged" */
  positions(designId: string): Record<string, XY> | undefined;
  /** remember this design's arrangement */
  savePositions(designId: string, positions: Record<string, XY>): void;
  /** the pane sizes, or `undefined` to use the editor's defaults */
  panes(): PaneSizes | undefined;
  savePanes(sizes: PaneSizes): void;
  /** the canvas's Parts | Pins choice, or `undefined` for Pins (optional: older hosts) */
  detail?(): CanvasDetail | undefined;
  saveDetail?(detail: CanvasDetail): void;
  /**
   * The "Part labels" toggle: whether a populated
   * board's parts print their ref/value over the artwork. `undefined` (the
   * default, and every older host) means off — a hover always shows the same
   * facts as a tooltip regardless.
   */
  partLabels?(): boolean | undefined;
  savePartLabels?(visible: boolean): void;
}

/**
 * A store that remembers nothing, for hosts that do not care and for tests
 * that want the editor's own defaults.
 */
export const NO_LAYOUT_STORE: EditorLayoutStore = {
  positions: () => undefined,
  savePositions: () => {},
  panes: () => undefined,
  savePanes: () => {},
};

/** A store backed by a plain `Map` — what a test uses, and a fair reference. */
export function memoryLayoutStore(): EditorLayoutStore {
  const arrangements = new Map<string, Record<string, XY>>();
  let panes: PaneSizes | undefined;
  let detail: CanvasDetail | undefined;
  let partLabels: boolean | undefined;
  return {
    positions: (designId) => arrangements.get(designId),
    savePositions: (designId, positions) => {
      arrangements.set(designId, positions);
    },
    panes: () => panes,
    savePanes: (sizes) => {
      panes = sizes;
    },
    detail: () => detail,
    saveDetail: (next) => {
      detail = next;
    },
    partLabels: () => partLabels,
    savePartLabels: (next) => {
      partLabels = next;
    },
  };
}
