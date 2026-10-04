/**
 * Board components on a depiction: the parts a build has on its board, for
 * the two-faced board depictions to draw over the bare copper. The parts are
 * stored in the depiction's manifest (`meta.components`), in the anchor
 * frame; `componentsFor` places them on one view (mirrored for the bottom
 * face). Pure.
 */

import { round, type BoardPart, type DepictionMeta } from './model.ts';

/**
 * The parts drawn on `view`: the anchor frame's own face shows the top-side
 * parts as stored, the face that mirrors it shows the bottom-side parts
 * reflected; any other view has none (`undefined`).
 */
export function componentsFor(meta: DepictionMeta, view: string): BoardPart[] | undefined {
  const components = meta.components;
  const asset = meta.views[view];
  if (components === undefined || asset === undefined) return undefined;
  if (view === meta.anchorFrame && asset.mirrorOf === undefined) {
    return components.parts.filter((p) => p.side === 'top').map((p) => ({ ...p }));
  }
  if (asset.mirrorOf !== meta.anchorFrame) return undefined;
  const source = meta.views[asset.mirrorOf];
  const width = asset.widthUnits ?? source?.widthUnits;
  const height = asset.heightUnits ?? source?.heightUnits;
  if (width === undefined || height === undefined) return undefined;
  const axis = asset.mirrorAxis ?? 'x';
  const f = ([x, y]: readonly [number, number]): [number, number] => [
    round(axis === 'x' ? width - x : x),
    round(axis === 'y' ? height - y : y),
  ];
  return components.parts
    .filter((p) => p.side === 'bottom')
    .map((p) => {
      const [x, y] = f([p.x, p.y]);
      return {
        ...p,
        x,
        y,
        outline: p.outline.map(f),
        ...(p.pin1 === undefined ? {} : { pin1: f(p.pin1) }),
      };
    });
}
