/**
 * The Schematic view ( spec: ui-redesign "Information
 * architecture" — Build / Schematic / Documents): the same render-svg
 * schematic `PreviewPane` draws in the old dock, full size, with its own
 * pan/zoom — wheel to zoom (centred on the cursor), drag to pan, arrow keys
 * to pan, +/- to zoom, 0 to fit, Fit and 100% buttons — around a themed
 * chrome and a white "paper" sheet, exactly as print paper reads regardless
 * of theme.
 *
 * Reuses `renderPreview` (`Preview.tsx`) rather than re-deriving: the same
 * debounced `renderSchematic(design, db, { depictions })` call, so this view
 * and the old dock's tab draw byte-identical markup from byte-identical
 * input — only the surrounding chrome differs.
 *
 * **Panning vs. selecting text.** The view keeps
 * `user-select: none` at all times, so a drag never turns into a text
 * selection — click-to-trace already tells a click from a drag by movement
 * threshold (`CLICK_SLOP`), independent of selection. The sheet's own text
 * (pin/pad labels, notes, the drawing's every other label) stays copyable
 * through the "Copy text" toolbar button, which reads it straight out of the
 * SVG — no need to hold a modifier or fight the drag handler for a selection.
 */

import { deriveNets, type CableDesign, type Db } from '@wirehub/model';
import { IconClipboard, IconTag, IconX } from '@tabler/icons-react';
import type { DepictionSource } from '@wirehub/render-svg';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import { classes } from '../context.ts';
import { applyTrace, pickOf, traceFromPick, type TracePick, type TraceSummary } from '../trace-highlight.ts';
import { renderPreview } from './Preview.tsx';

export interface SchematicPaneProps {
  design: CableDesign;
  db: Db;
  debounceMs?: number;
  depictions?: boolean | DepictionSource;
  /**
   * Print each populated board's parts' ref/value over its artwork
   * — default `false`, same as a printed sheet's; a
   * host that remembers the choice (`CableEditor`'s "Part labels" toggle)
   * passes its own state through here, and `onTogglePartLabels` back the
   * other way. A host that does not care can ignore both — the toolbar
   * button still shows and toggles the request, it just returns to `false`
   * on the next render if nothing stores it.
   */
  partLabels?: boolean;
  onTogglePartLabels?: () => void;
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 4;
/** clear air the Fit button leaves around the sheet, px. */
const FIT_MARGIN = 32;
/** a press that moves less than this is a click (a pick), not a pan, px. */
const CLICK_SLOP = 4;

export function SchematicPane({
  design,
  db,
  debounceMs = 250,
  depictions = false,
  partLabels = false,
  onTogglePartLabels,
}: SchematicPaneProps): JSX.Element {
  const [result, setResult] = useState<{ svg: string } | { error: string }>({ svg: '' });
  // the design the drawn sheet was rendered from: a trace is taken on what
  // is on screen, whose net ids the SVG carries
  const [drawn, setDrawn] = useState<{ design: CableDesign; db: Db }>({ design, db });
  const nets = useMemo(() => deriveNets(drawn.design, drawn.db), [drawn]);
  const [traced, setTraced] = useState<TraceSummary | undefined>(undefined);
  const [preview, setPreview] = useState<TraceSummary | undefined>(undefined);
  const press = useRef<{ x: number; y: number; pick?: TracePick } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setResult(renderPreview(design, db, depictions, partLabels));
      setDrawn({ design, db });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [design, db, debounceMs, depictions, partLabels]);

  const fit = useCallback((): void => {
    const view = viewRef.current;
    const sheet = sheetRef.current;
    if (view === null || sheet === null) return;
    const sheetWidth = sheet.scrollWidth;
    const sheetHeight = sheet.scrollHeight;
    if (sheetWidth <= 0 || sheetHeight <= 0) return;
    const availableWidth = view.clientWidth - FIT_MARGIN * 2;
    const availableHeight = view.clientHeight - FIT_MARGIN * 2;
    if (availableWidth <= 0 || availableHeight <= 0) return;
    const next = Math.min(availableWidth / sheetWidth, availableHeight / sheetHeight, ZOOM_MAX);
    setZoom(Math.max(ZOOM_MIN, next));
    setPan({ x: 0, y: 0 });
  }, []);

  // fit once per drawing, so a new design opens legibly rather than at the
  // last design's zoom
  useEffect(() => {
    if ('svg' in result && result.svg !== '') fit();
  }, [result, fit]);

  // wheel zoom keeps the point under the cursor fixed on screen: the sheet's
  // untransformed (x, y) under the pointer is solved from the current
  // pan/zoom, then the new pan is chosen so that same point lands back under
  // the pointer at the new zoom.
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.001);
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
    const view = viewRef.current;
    if (view !== null && next !== zoom) {
      const rect = view.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const sheetX = (cursorX - pan.x) / zoom;
      const sheetY = (cursorY - pan.y) / zoom;
      setPan({ x: cursorX - sheetX * next, y: cursorY - sheetY * next });
    }
    setZoom(next);
  };

  /** Pan by keyboard-step CSS px, at the current zoom. */
  const nudgePan = (dx: number, dy: number): void => setPan((current) => ({ x: current.x + dx, y: current.y + dy }));

  const ZOOM_STEP = 1.25;
  const KEY_PAN_STEP = 80;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        nudgePan(KEY_PAN_STEP, 0);
        return;
      case 'ArrowRight':
        event.preventDefault();
        nudgePan(-KEY_PAN_STEP, 0);
        return;
      case 'ArrowUp':
        event.preventDefault();
        nudgePan(0, KEY_PAN_STEP);
        return;
      case 'ArrowDown':
        event.preventDefault();
        nudgePan(0, -KEY_PAN_STEP);
        return;
      case '+':
      case '=':
        event.preventDefault();
        setZoom((current) => Math.min(ZOOM_MAX, current * ZOOM_STEP));
        return;
      case '-':
      case '_':
        event.preventDefault();
        setZoom((current) => Math.max(ZOOM_MIN, current / ZOOM_STEP));
        return;
      case '0':
        event.preventDefault();
        fit();
        return;
      default:
        return;
    }
  };

  /**
   * "Copy text": the view keeps `user-select: none` so
   * a drag never turns into a selection, so this is how the sheet's text
   * (pin/pad labels, notes, everything else on it) gets to the clipboard —
   * read straight out of the drawn SVG, not the screen selection.
   */
  const copyText = useCallback((): void => {
    const svg = sheetRef.current?.querySelector('svg');
    if (svg === null || svg === undefined) return;
    const lines: string[] = [];
    for (const node of svg.querySelectorAll('text')) {
      const content = node.textContent?.trim();
      if (content !== undefined && content !== '') lines.push(content);
    }
    void navigator.clipboard?.writeText(lines.join('\n')).catch(() => {});
  }, []);

  // one object per drawing: React re-sets innerHTML whenever this prop's
  // identity changes, which would wipe the trace classes on every pan or zoom
  const html = useMemo(() => ({ __html: 'svg' in result ? result.svg : '' }), [result]);

  const pickAt = (pick: TracePick | undefined): TraceSummary | undefined =>
    pick === undefined ? undefined : traceFromPick(drawn.design, drawn.db, pick, nets);

  // a new drawing drops a trace whose nets it may no longer carry
  useEffect(() => {
    setTraced(undefined);
    setPreview(undefined);
  }, [drawn]);

  // light the trace: a class toggle on the sheet's own elements, no re-render
  const shown = preview ?? traced;
  useLayoutEffect(() => {
    const svg = sheetRef.current?.querySelector('svg');
    if (svg !== null && svg !== undefined) applyTrace(svg, shown?.nets);
  }, [shown, result]);

  useEffect(() => {
    if (traced === undefined) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTraced(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [traced]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const pick = pickOf(event.target);
    press.current = { x: event.clientX, y: event.clientY, ...(pick === undefined ? {} : { pick }) };
    drag.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const started = drag.current;
    if (started === null) {
      // Alt + hover previews a trace without committing it
      if (event.altKey) {
        const next = pickAt(pickOf(event.target));
        if (next?.start !== preview?.start || next?.nets.join() !== preview?.nets.join()) setPreview(next);
      } else if (preview !== undefined) {
        setPreview(undefined);
      }
      return;
    }
    setPan({
      x: started.panX + (event.clientX - started.startX),
      y: started.panY + (event.clientY - started.startY),
    });
  };

  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pressed = press.current;
    press.current = null;
    if (
      event.type === 'pointerup' &&
      pressed !== null &&
      Math.abs(event.clientX - pressed.x) < CLICK_SLOP &&
      Math.abs(event.clientY - pressed.y) < CLICK_SLOP
    ) {
      // a click: trace what was under it, or clear on empty paper
      setTraced(pickAt(pressed.pick));
      setPreview(undefined);
    }
    if (drag.current === null) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="cs-schematic">
      <div className="cs-schematic-toolbar" role="toolbar" aria-label="schematic tools">
        <button type="button" className="cs-schematic-btn" title="Fit the sheet to the window" onClick={fit}>
          Fit
        </button>
        <button
          type="button"
          className="cs-schematic-btn"
          title="Actual size — 1 CSS px per drawing px"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          100%
        </button>
        <span className="cs-schematic-zoom">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className={classes('cs-schematic-btn', partLabels && 'is-active')}
          aria-pressed={partLabels}
          title={
            partLabels
              ? 'Part labels — showing every populated part’s ref/value; hover a part for its details either way'
              : 'Part labels — hidden; hover a part for its ref/value/package'
          }
          aria-label="Part labels"
          onClick={onTogglePartLabels}
        >
          <IconTag size={13} />
        </button>
        <button
          type="button"
          className="cs-schematic-btn"
          title="Copy every label on the sheet as text — the sheet itself keeps text selection off so a drag always pans"
          aria-label="Copy text"
          onClick={copyText}
        >
          <IconClipboard size={13} />
        </button>
        {shown === undefined ? (
          <span className="cs-trace-hint" title="Click a pin, pad, wire or joint to trace its whole path · Alt+hover to preview · Esc clears">
            trace
          </span>
        ) : (
          <TraceChip
            trace={shown}
            {...(preview === undefined ? { onClear: () => setTraced(undefined) } : {})}
          />
        )}
      </div>
      <div
        className={dragging ? 'cs-schematic-view is-dragging' : 'cs-schematic-view'}
        ref={viewRef}
        tabIndex={0}
        role="application"
        aria-label="schematic sheet — arrow keys pan, +/- zoom, 0 fits"
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onPointerLeave={() => setPreview(undefined)}
      >
        {'error' in result ? (
          <p className="cs-error">renderer: {result.error}</p>
        ) : (
          <div
            className="cs-schematic-sheet"
            ref={sheetRef}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            // the renderer escapes its own text and emits no scripts or
            // external references — see `Preview.tsx`'s own note
            dangerouslySetInnerHTML={html}
          />
        )}
      </div>
    </div>
  );
}

/** The traced path, compactly: its ends, what it passes through, how much copper. */
function TraceChip({ trace, onClear }: { trace: TraceSummary; onClear?: () => void }): JSX.Element {
  const ends = trace.ends.length === 0 ? [trace.start] : trace.ends;
  const shownEnds = ends.length > 4 ? [...ends.slice(0, 3), `+${ends.length - 3}`] : ends;
  return (
    <span className="cs-trace-chip" role="status" aria-live="polite" title={trace.terminals.join('\n')}>
      <span className="cs-trace-ends">{shownEnds.join(' ↔ ')}</span>
      {trace.passages.length === 0 ? null : (
        <span className="cs-trace-via" title={trace.passages.join('\n')}>
          via {trace.passages.length === 1 ? trace.passages[0] : `${trace.passages.length} parts`}
        </span>
      )}
      <span className="cs-trace-count">
        {trace.nets.length} net{trace.nets.length === 1 ? '' : 's'} · {trace.terminals.length}
      </span>
      {onClear === undefined ? null : (
        <button type="button" className="cs-trace-clear" title="Clear trace (Esc)" aria-label="Clear trace" onClick={onClear}>
          <IconX size={12} stroke={2} />
        </button>
      )}
    </span>
  );
}
