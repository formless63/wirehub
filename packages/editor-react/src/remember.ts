/**
 * Handing an arrangement back to the host that can outlive the page.
 *
 * Three rules, and each one is a way this could go wrong:
 *
 * 1. **Only what the user did.** A design that opened auto-arranged and was
 *    never touched is not an arrangement anybody chose, and storing it would
 *    freeze today's auto-layout into that design forever.
 * 2. **Not on every frame.** A drag is a position per animation frame; the host
 *    hears about the one the part came to rest at.
 * 3. **Not lost on the way out.** Switching designs unmounts the editor, and a
 *    part moved a moment before that must still be moved when you come back —
 *    so a pending write is flushed rather than dropped.
 */

import { useEffect, useRef } from 'react';

import type { XY } from './derive.ts';
import type { EditorLayoutStore } from './layout-store.ts';

/** How long a moved part waits before the host is asked to remember it. */
export const POSITION_SAVE_DEBOUNCE_MS = 300;

interface Mark {
  id: string;
  positions: Record<string, XY>;
}

export function useRememberedPositions(
  layout: EditorLayoutStore | undefined,
  designId: string,
  positions: Record<string, XY>,
): void {
  /** the arrangement as the host last saw it — or as this design opened */
  const saved = useRef<Mark>({ id: designId, positions });
  /** what is on screen right now, for the flush on the way out */
  const current = useRef<Mark>({ id: designId, positions });
  current.current = { id: designId, positions };

  useEffect(() => {
    if (layout === undefined) return;
    const mark = saved.current;
    if (mark.id !== designId) {
      // another document opened: what it opened *as* is not news
      saved.current = { id: designId, positions };
      return;
    }
    // identity, not equality: `positions` is replaced only by something that
    // moved a part, so an untouched canvas never reaches the host
    if (mark.positions === positions) return;
    const timer = setTimeout(() => {
      saved.current = { id: designId, positions };
      layout.savePositions(designId, positions);
    }, POSITION_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [layout, designId, positions]);

  useEffect(() => {
    if (layout === undefined) return;
    return () => {
      const { id, positions: last } = current.current;
      if (saved.current.id === id && saved.current.positions === last) return;
      layout.savePositions(id, last);
    };
  }, [layout]);
}
