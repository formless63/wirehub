/**
 * A board's gerber art, top and bottom, with its pads drawn on it — and the
 * pads are the controls.
 *
 * Click a pad to pick it; the host shows what it can change about the pad
 * (terminal, pad role, signal) beside the art. The pads that still need a
 * person (`uncertain`) are drawn in the warning tone, and the keyboard steps
 * through them: with the art focused, `n` / `p` go to the next / previous
 * uncertain pad, `↓` / `↑` (or `j` / `k`) to the next / previous pad of all,
 * `Enter` hands focus to the host's first control, `Esc` clears the pick.
 *
 * Shared by the import review (a draft's pads, in KiCad millimetres) and
 * the Library's board page (a depiction's anchors): both hand in pads in the
 * `board-top` frame; a bottom pad is drawn mirrored on the bottom face,
 * exactly as the gerber render mirrors it. An optional `overlay` draws over
 * each face at its on-screen scale (the build editor's parts).
 */

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

import { classes } from '../context.ts';

export type PadTone = 'ok' | 'warn' | 'err' | 'dim' | 'accent';

export interface ArtPad {
  /** unique per physical pad (`Pad4#1`) */
  key: string;
  /** board-top frame, frame units (mm) */
  x: number;
  y: number;
  side: 'top' | 'bottom' | 'both';
  /** what is written beside it */
  label?: string;
  /** pads that belong together (one terminal): picking one rings them all */
  group?: string;
  tone: PadTone;
  /** hover text */
  title?: string;
}

export interface PadMapArtProps {
  /** the board-top frame, frame units */
  frame: { width: number; height: number };
  /** image hrefs (data URIs) for each face; a face without one draws its pads on a blank board */
  top?: string;
  bottom?: string;
  pads: readonly ArtPad[];
  selected?: string;
  onSelect: (key: string | undefined) => void;
  /** keys of the pads that need a person, in stepping order */
  uncertain?: readonly string[];
  /** extra drawing per face, at `scale` px per frame unit */
  overlay?: (side: 'top' | 'bottom', scale: number) => ReactNode;
  /** Enter on the art: the host moves focus into its controls */
  onEnter?: () => void;
  /** accessible name */
  label?: string;
  /** which faces to show (default both) */
  faces?: readonly ('top' | 'bottom')[];
}

/** Width of an element, tracked. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function Face(props: PadMapArtProps & { side: 'top' | 'bottom'; art: string | undefined }): JSX.Element {
  const [box, measured] = useWidth();
  const { frame, side } = props;
  // px per frame unit: the face fills its column, but never taller than 340px
  const fit = measured > 0 ? measured / frame.width : 12;
  const scale = Math.max(4, Math.min(fit, 340 / frame.height));
  const w = frame.width * scale;
  const h = frame.height * scale;
  const on = props.pads.filter((p) => p.side === side || p.side === 'both');
  const picked = props.pads.find((p) => p.key === props.selected);
  const r = Math.max(4, Math.min(8, scale * 0.45));
  return (
    <figure className="cs-padart-face" ref={box}>
      <figcaption>{side}</figcaption>
      <svg
        className="cs-padart-svg"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="group"
        aria-label={`board ${side}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onSelect(undefined);
        }}
      >
        {props.art === undefined ? (
          <rect className="cs-padart-blank" x={0} y={0} width={w} height={h} rx={4} />
        ) : (
          <image href={props.art} x={0} y={0} width={w} height={h} preserveAspectRatio="none" />
        )}
        {props.overlay?.(side, scale)}
        {on.map((p) => {
          const x = (side === 'bottom' ? frame.width - p.x : p.x) * scale;
          const y = p.y * scale;
          const isPicked = p.key === props.selected;
          const inGroup = !isPicked && picked?.group !== undefined && picked.group === p.group;
          return (
            <g
              key={p.key}
              className={classes('cs-padart-pad', `is-${p.tone}`, isPicked && 'is-picked', inGroup && 'is-group')}
              data-pad={p.key}
              onClick={(event) => {
                event.stopPropagation();
                props.onSelect(p.key);
              }}
            >
              {p.title === undefined ? null : <title>{p.title}</title>}
              <circle className="cs-padart-hit" cx={x} cy={y} r={r + 5} />
              <circle className="cs-padart-dot" cx={x} cy={y} r={isPicked ? r * 1.35 : r} />
              {p.label === undefined || p.label === '' ? null : (
                <text className="cs-padart-label" x={x + r + 3} y={y + 4}>
                  {p.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function PadMapArt(props: PadMapArtProps): JSX.Element {
  const order = useMemo(() => props.pads.map((p) => p.key), [props.pads]);
  const uncertain = props.uncertain ?? [];
  const step = (list: readonly string[], by: 1 | -1): void => {
    if (list.length === 0) return;
    const at = props.selected === undefined ? -1 : list.indexOf(props.selected);
    const next = at === -1 ? (by === 1 ? 0 : list.length - 1) : (at + by + list.length) % list.length;
    props.onSelect(list[next]);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    const key = event.key;
    if (key === 'n' || key === 'p') {
      event.preventDefault();
      step(uncertain.length > 0 ? uncertain : order, key === 'n' ? 1 : -1);
    } else if (key === 'ArrowDown' || key === 'ArrowRight' || key === 'j') {
      event.preventDefault();
      step(order, 1);
    } else if (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'k') {
      event.preventDefault();
      step(order, -1);
    } else if (key === 'Enter' && props.selected !== undefined) {
      event.preventDefault();
      props.onEnter?.();
    } else if (key === 'Escape') {
      props.onSelect(undefined);
    }
  };
  const faces = props.faces ?? ['top', 'bottom'];
  return (
    <div
      className="cs-padart"
      tabIndex={0}
      role="application"
      aria-label={props.label ?? 'board pads'}
      title="Click a pad to pick it · n / p: next / previous pad to check · ↑ ↓: every pad · Enter: edit · Esc: clear"
      onKeyDown={onKey}
    >
      {faces.map((side) => (
        <Face key={side} {...props} side={side} art={side === 'top' ? props.top : props.bottom} />
      ))}
    </div>
  );
}
