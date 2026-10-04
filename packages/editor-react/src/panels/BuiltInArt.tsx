/**
 * The art the builder actually draws a connector with (:
 * "the artwork section appears empty … where are we deriving the current
 * wireframe/art to use in the builder? We should show that in the
 * connectors").
 *
 * The canvas never needed an uploaded picture for a connector whose family it
 * knows: `connector-art.ts` draws the mating face from the definition's own
 * pinout. This shows exactly that drawing — the same `ConnectorDrawing` the
 * canvas node paints — plus the solder side it implies (the face flipped
 * across its long axis, numbers kept readable), with the pin numbers and a
 * hover title per pin. Uploaded artwork is an optional extra beside it.
 */

import type { ConnectorBody, ConnectorDefinition } from '@wirehub/model';
import { useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react';

import { connectorArt, type ConnectorArt, type ConnectorPinArt } from '../connector-art.ts';
import { classes } from '../context.ts';
import { ConnectorDrawing } from '../nodes/ConnectorNode.tsx';

/**
 * The builder's drawing for a connector, or `undefined` when its family has
 * none. Given the body it is built on, the drawing is the body's — every
 * pinout on one body draws the same.
 */
export function builtInConnectorArt(def: ConnectorDefinition | undefined, body?: ConnectorBody): ConnectorArt | undefined {
  if (def === undefined) return undefined;
  try {
    return connectorArt({ def, facing: 'right', ...(body === undefined ? {} : { body }) });
  } catch {
    return undefined;
  }
}

/** How many of `terminals` the drawing places — the "derived" anchor count. */
export function drawnTerminals(art: ConnectorArt | undefined): Set<string> {
  return new Set(art === undefined ? [] : art.pins.map((pin) => pin.terminal));
}

const PAD = 6;

/** The screen size a pin number is printed at, CSS px. */
const NUMBER_PX = 10;

/** How wide a drawn pin is across, art units. */
function pinSpan(pin: ConnectorPinArt): { w: number; h: number } {
  if (pin.r !== undefined) return { w: pin.r * 2, h: pin.r * 2 };
  return { w: pin.width ?? 4, h: pin.height ?? 2 };
}

interface NumberPlace {
  x: number;
  y: number;
  size: number;
  anchor: 'start' | 'middle' | 'end';
}

/**
 * Where a pin's number goes (the canvas only prints a few; here every pin
 * gets one): inside the pin when it is big enough to hold a readable number
 * on screen, otherwise just outside it, away from the drawing's centre line
 * — so a two-row SCART or D-Sub reads its numbers down both outer edges.
 */
function placeNumber(pin: ConnectorPinArt, x: number, centreX: number, ppu: number): NumberPlace {
  const span = pinSpan(pin);
  const size = ppu > 0 ? NUMBER_PX / ppu : Math.max(2.4, Math.min(5, span.w * 0.62));
  if (ppu <= 0 || Math.min(span.w, span.h) * 0.75 >= size) {
    return { x, y: pin.y, size: ppu > 0 ? Math.min(size * 1.2, Math.min(span.w, span.h) * 0.62) : size, anchor: 'middle' };
  }
  const gap = 3 / ppu;
  const outward = x >= centreX ? 1 : -1;
  return {
    x: x + outward * (span.w / 2 + gap),
    y: pin.y,
    size,
    anchor: outward > 0 ? 'start' : 'end',
  };
}

/** CSS px per art unit of an SVG drawn with `preserveAspectRatio` meet. */
function usePixelsPerUnit(viewWidth: number, viewHeight: number): [RefObject<SVGSVGElement | null>, number] {
  const ref = useRef<SVGSVGElement>(null);
  const [ppu, setPpu] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setPpu(width > 0 && height > 0 ? Math.min(width / viewWidth, height / viewHeight) : 0);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewWidth, viewHeight]);
  return [ref, ppu];
}

function numberText(pin: ConnectorPinArt): string | undefined {
  if (pin.form === 'shell' || pin.terminal === 'shell') return undefined;
  return pin.terminal;
}

function Figure(props: {
  art: ConnectorArt;
  def: ConnectorDefinition;
  mirrored: boolean;
  caption: string;
  title: string;
}): JSX.Element {
  const { art, def, mirrored } = props;
  const pinLabel = useMemo(() => new Map(def.pins.map((pin) => [pin.id, pin.label])), [def.pins]);
  // the drawing flips; its numbers are placed on top, never drawn backwards
  const bare: ConnectorArt = useMemo(() => ({ ...art, labels: [] }), [art]);
  const px = (x: number): number => (mirrored ? art.width - x : x);
  // room either side for numbers printed outside narrow pins
  const side = PAD * 3;
  const [svgRef, ppu] = usePixelsPerUnit(art.width + side * 2, art.height + PAD * 2);
  return (
    <figure className="cs-builtin-figure" title={props.title}>
      <svg
        ref={svgRef}
        className="cs-builtin-svg"
        viewBox={`${-side} ${-PAD} ${art.width + side * 2} ${art.height + PAD * 2}`}
        role="img"
        aria-label={props.caption}
      >
        <g transform={mirrored ? `translate(${art.width} 0) scale(-1 1)` : undefined}>
          <ConnectorDrawing art={bare} paint={() => undefined} />
        </g>
        {art.pins.map((pin) => {
          const text = numberText(pin);
          if (text === undefined) return null;
          const at = placeNumber(pin, px(pin.x), art.width / 2, ppu);
          return (
            <text
              key={`n-${pin.terminal}`}
              className={classes('cs-builtin-num', at.anchor !== 'middle' && 'is-outside')}
              x={at.x}
              y={at.y}
              textAnchor={at.anchor}
              style={{ fontSize: `${at.size}px` }}
            >
              {text}
            </text>
          );
        })}
        {art.pins.map((pin) => (
          <circle
            key={pin.terminal}
            className="cs-builtin-hit"
            cx={px(pin.x)}
            cy={pin.y}
            r={Math.max(3, pin.r ?? Math.max(pin.width ?? 0, pin.height ?? 0) / 2)}
          >
            <title>
              {pin.terminal === 'shell' ? 'shell' : `pin ${pin.terminal}`}
              {pinLabel.get(pin.terminal) === undefined ? '' : ` — ${pinLabel.get(pin.terminal)}`}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption>{props.caption}</figcaption>
    </figure>
  );
}

export function BuiltInConnectorArt(props: {
  def: ConnectorDefinition;
  art: ConnectorArt;
  /** the body the drawing is keyed by */
  body?: ConnectorBody;
  /** every pinout on that body, by label — they all draw as this */
  sharedBy?: readonly string[];
}): JSX.Element {
  const { def, art, body } = props;
  const shared = props.sharedBy ?? [];
  const face = art.view === 'face';
  const missing = def.pins.filter((pin) => !art.pins.some((drawn) => drawn.terminal === pin.id));
  return (
    <section className="cs-builtin">
      <header className="cs-builtin-head">
        <strong title="What the canvas draws this connector as. Nothing to upload or place.">Builder art</strong>
        {body === undefined ? (
          <span className="cs-chip" title={`connector-art.ts draws ${art.short} from this definition's pin list`}>
            drawn from pinout · {art.short}
          </span>
        ) : (
          <span
            className="cs-chip"
            title={`The drawing belongs to the body ${body.id}; a pinout only relabels its pins.${
              shared.length > 1 ? ` Shared by: ${shared.join(', ')}.` : ''
            }`}
          >
            body · {art.short}
            {shared.length > 1 ? ` · ${shared.length} pinouts` : ''}
          </span>
        )}
        {art.approximate ? (
          <span
            className="cs-chip is-warn"
            title="Pin positions follow the family's general shape, not a mechanical drawing."
          >
            approximate
          </span>
        ) : null}
        {missing.length === 0 ? null : (
          <span className="cs-chip is-warn" title={`Not placed on the drawing: ${missing.map((pin) => pin.id).join(', ')}`}>
            {missing.length} not drawn
          </span>
        )}
      </header>
      <div className={classes('cs-builtin-figures', !face && 'is-profile')}>
        {face ? (
          <>
            <Figure art={art} def={def} mirrored={false} caption="Mating face" title="Seen head-on, as you plug it in" />
            <Figure
              art={art}
              def={def}
              mirrored
              caption="Solder side"
              title="The back, where you solder — the mating face flipped over"
            />
          </>
        ) : (
          <Figure art={art} def={def} mirrored={false} caption="Side profile" title="Solder lugs on the cable side" />
        )}
      </div>
    </section>
  );
}
