/**
 * The quiet ground bus a part draws for its own same-part bridges
 * (`bridge-bus.ts`): a faint rectilinear line network
 * under the pins, leads and labels. It is never a pointer target — a click
 * there is a click on the part — and it comes up when the part is hovered or
 * selected (`editor.css`, `.cs-bridge-bus`).
 */

import { useMemo, type JSX } from 'react';

import { busPaths, type Bridge, type BusOptions } from '../bridge-bus.ts';
import { classes } from '../context.ts';
import type { XY } from '../derive.ts';

/** The bus paths as an SVG group, in the points' own coordinates. */
export function BridgeBusPaths({
  points,
  bridges,
  options,
}: {
  points: ReadonlyMap<string, XY>;
  bridges: readonly Bridge[] | undefined;
  options?: BusOptions;
}): JSX.Element | null {
  const paths = useMemo(
    () => (bridges === undefined || bridges.length === 0 ? [] : busPaths(points, bridges, options)),
    [points, bridges, options],
  );
  if (paths.length === 0) return null;
  return (
    <g className="cs-bridge-bus" aria-hidden="true">
      {paths.map((path) => (
        <path
          key={path.keys.join('|')}
          className={classes('cs-bus-line', path.selected && 'is-selected')}
          d={path.d}
          data-bus={path.keys.join(' ')}
          data-joints={path.joints.join(' ')}
        />
      ))}
    </g>
  );
}

/**
 * A standalone overlay: an absolutely positioned SVG of `width` × `height`
 * (a board's artwork area, a pin list) holding the bus — for parts whose
 * art is not one SVG the bus can join.
 */
export function BridgeBusOverlay({
  width,
  height,
  left = 0,
  top = 0,
  ...rest
}: {
  width: number;
  height: number;
  left?: number;
  top?: number;
  points: ReadonlyMap<string, XY>;
  bridges: readonly Bridge[] | undefined;
  options?: BusOptions;
}): JSX.Element | null {
  if (rest.bridges === undefined || rest.bridges.length === 0) return null;
  return (
    <svg
      className="cs-bridge-bus-layer"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ left, top }}
      aria-hidden="true"
    >
      <BridgeBusPaths {...rest} />
    </svg>
  );
}
