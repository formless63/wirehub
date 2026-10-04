/**
 * The drag strips between the panes, and the state behind them.
 *
 * Deliberately no library: a splitter is a pointer-down, a pointer-move and a
 * number. `splitters.ts` owns the number (and its clamping, which is the part
 * worth testing); this file owns the three DOM manners that make a drag feel
 * right — pointer capture so the gesture survives leaving the strip,
 * `touch-action: none` so a touch drag resizes instead of scrolling, and arrow
 * keys so it is reachable without a pointer at all.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

import type { EditorLayoutStore } from './../layout-store.ts';
import {
  PANE_KEY_STEP,
  paneColumns,
  paneSizesOf,
  resetPane,
  resizePane,
  type PaneKey,
  type PaneSizes,
} from './../splitters.ts';

export interface SplitterProps {
  /** `x` for a bar between side-by-side panes, `y` for one between stacked panes */
  axis: 'x' | 'y';
  /** what the pane's size does as the pointer moves along `+axis`: grow (1) or shrink (-1) */
  sign: 1 | -1;
  /** the pane's current size, px */
  size: number;
  /** what to say to a screen reader — "drag to resize the parts palette" */
  label: string;
  onResize: (size: number) => void;
  onReset: () => void;
}

export function Splitter(props: SplitterProps): JSX.Element {
  const { axis, sign, size, onResize, onReset } = props;
  const drag = useRef<{ from: number; base: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { from: axis === 'x' ? event.clientX : event.clientY, base: size };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const started = drag.current;
    if (started === null) return;
    const at = axis === 'x' ? event.clientX : event.clientY;
    // measured from where the drag began, never accumulated: a pointer pushed
    // past a pane's limit and brought back lands exactly where it looks like
    onResize(started.base + sign * (at - started.from));
  };

  const stop = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const grow = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    const shrink = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    if (event.key === grow) onResize(size + sign * PANE_KEY_STEP);
    else if (event.key === shrink) onResize(size - sign * PANE_KEY_STEP);
    else if (event.key === 'Home' || event.key === 'Enter') onReset();
    else return;
    event.preventDefault();
  };

  return (
    <div
      className={`cs-splitter cs-splitter-${axis}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={props.label}
      aria-valuenow={Math.round(size)}
      title={`${props.label} — double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}

/* ------------------------------------------------------------------ *
 * The pane state behind the three splitters
 * ------------------------------------------------------------------ */

export interface Panes {
  sizes: PaneSizes;
  /** put this on `.cs-body` — the clamp needs its width */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** …and this on `.cs-centre`, for the dock's height */
  centreRef: RefObject<HTMLDivElement | null>;
  resize: (key: PaneKey, value: number) => void;
  reset: (key: PaneKey) => void;
  /** `.cs-body`'s five columns */
  bodyStyle: CSSProperties;
  /** the dock's height */
  dockStyle: CSSProperties;
}

/** How long a settled size waits before the host is asked to remember it. */
export const PANE_SAVE_DEBOUNCE_MS = 300;

export function usePanes(store?: EditorLayoutStore): Panes {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const centreRef = useRef<HTMLDivElement | null>(null);
  const [sizes, setSizes] = useState<PaneSizes>(() => paneSizesOf(store?.panes()));
  const saved = useRef(sizes);

  const available = useCallback((key: PaneKey): number => {
    if (key === 'dock') return centreRef.current?.clientHeight ?? 0;
    return bodyRef.current?.clientWidth ?? 0;
  }, []);

  const resize = useCallback(
    (key: PaneKey, value: number): void => {
      setSizes((current) => resizePane(current, key, value, available(key)));
    },
    [available],
  );

  const reset = useCallback(
    (key: PaneKey): void => {
      setSizes((current) => resetPane(current, key, available(key)));
    },
    [available],
  );

  // a window that shrank (or sizes remembered from a bigger one) must not be
  // able to leave the canvas with nothing: re-clamp everything against what
  // there actually is, on mount and on every resize
  useEffect(() => {
    const fit = (): void => {
      setSizes((current) => {
        let next = current;
        for (const key of ['palette', 'side', 'dock'] as PaneKey[]) {
          next = resizePane(next, key, next[key], available(key));
        }
        return next;
      });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [available]);

  // a drag is a hundred sizes a second; the host hears about the one that
  // stuck, and never about a size the pointer passed through
  useEffect(() => {
    if (store === undefined || saved.current === sizes) return;
    const timer = setTimeout(() => {
      saved.current = sizes;
      store.savePanes(sizes);
    }, PANE_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sizes, store]);

  return {
    sizes,
    bodyRef,
    centreRef,
    resize,
    reset,
    bodyStyle: { gridTemplateColumns: paneColumns(sizes) },
    dockStyle: { flex: `0 0 ${sizes.dock}px` },
  };
}
