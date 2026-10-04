/**
 * A board's mounted parts over its artwork.
 *
 * The same data the canvas draws — the catalog's per-build `components`,
 * resolved into the depicted view by `layout` (`DiagramDepiction.parts`) —
 * printed in the depiction's own units, inside its transform: a translucent
 * body per part (outline only for an open or unset solder jumper, solid for a
 * bridged one) and an upright `ref value` label where it fits without
 * touching another. Deterministic, like everything the renderer emits.
 */

import type { BoardPart } from '@cable-studio/catalog';
import { textWidth } from '@cable-studio/layout';

import { partBodyShapes, type PartDetailShape } from './part-body.ts';
import { fmt, leaf, node, text, tooltip } from './svg.ts';

/** Label size in artwork units (×2 on the page at the usual magnification). */
export const PART_LABEL_SIZE = 1.1;
/** The longest value printed beside a ref; longer part numbers stay in the tooltip. */
const MAX_VALUE = 10;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function bounds(part: BoardPart): Box {
  const xs = part.outline.map((p) => p[0]);
  const ys = part.outline.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Where each part's label goes (largest body first), or nothing when it fits nowhere. */
export function placePartLabels(
  parts: readonly BoardPart[],
  size: number = PART_LABEL_SIZE,
): Map<BoardPart, { value: string; x: number; y: number }> {
  const out = new Map<BoardPart, { value: string; x: number; y: number }>();
  const taken: Box[] = [];
  const height = size * 1.15;
  const order = [...parts].sort((a, b) => {
    const ba = bounds(a);
    const bb = bounds(b);
    const area = (bb.x1 - bb.x0) * (bb.y1 - bb.y0) - (ba.x1 - ba.x0) * (ba.y1 - ba.y0);
    return area !== 0 ? area : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });
  for (const part of order) {
    const box = bounds(part);
    const values = [
      ...(part.label === undefined || part.label.length > MAX_VALUE ? [] : [`${part.ref} ${part.label}`]),
      part.ref,
    ];
    const spots = [part.y, box.y0 - height / 2 - 0.1, box.y1 + height / 2 + 0.1];
    search: for (const value of values) {
      const half = textWidth(value, size) / 2;
      for (const y of spots) {
        const label = { x0: part.x - half, x1: part.x + half, y0: y - height / 2, y1: y + height / 2 };
        if (taken.some((other) => overlaps(label, other))) continue;
        taken.push(label);
        out.set(part, { value, x: part.x, y });
        break search;
      }
    }
  }
  return out;
}

function title(part: BoardPart): string {
  const value = part.value ?? part.label;
  return `${part.ref}${value === undefined ? '' : ` ${value}`} · ${part.kind}${part.state === 'fitted' ? '' : ` · ${part.state}`}`;
}

function pointsAttr(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');
}

/** One subpath per group (`M…Z`), all in one `<path>` — a lead comb in one element. */
function multiPath(groups: readonly (readonly [number, number])[][]): string {
  return groups.map((group) => `M${group.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}Z`).join(' ');
}

/** The real top-down body shapes, or nothing for an
 * unrecognised package / an unset jumper — the caller draws the plain box. */
function detailMarkup(shapes: readonly PartDetailShape[]): string {
  return shapes
    .map((s) => {
      switch (s.shape) {
        case 'polygon':
          return leaf('polygon', { class: `pt-${s.tone}`, points: pointsAttr(s.points) });
        case 'circle':
          return leaf('circle', { class: `pt-${s.tone}`, cx: s.cx, cy: s.cy, r: s.r });
        case 'text':
          return text(s.value, { class: `pt-${s.tone}`, x: s.cx, y: s.cy });
        case 'multi':
          return leaf('path', { class: `pt-${s.tone}`, d: multiPath(s.groups) });
      }
    })
    .join('');
}

export interface BoardPartsOptions {
  /** label size in artwork units (default `PART_LABEL_SIZE`) */
  labelSize?: number;
  /** part ref → the nets its board links join, emitted as `data-net` for trace highlighting */
  partNets?: Readonly<Record<string, readonly string[]>>;
  /**
   * Print each part's ref/value over the artwork.
   * Default `false`: a printed build sheet's BOM already lists every part,
   * and the schematic panel's own "Part labels" toggle opts in for the
   * screen. Every part still carries its ref/value/state as a `<title>`
   * tooltip regardless — `renderBoardParts` never omits that.
   */
  labels?: boolean;
}

/** The parts layer, in artwork units — empty string when there are none. */
export function renderBoardParts(
  parts: readonly BoardPart[] | undefined,
  options: BoardPartsOptions = {},
): string {
  if (parts === undefined || parts.length === 0) return '';
  const size = options.labelSize ?? PART_LABEL_SIZE;
  const labels = options.labels === true ? placePartLabels(parts, size) : new Map<BoardPart, { value: string; x: number; y: number }>();
  const bodies = parts
    .map((part) => {
      const shapes = partBodyShapes(part);
      const body = shapes.length > 0 ? detailMarkup(shapes) : leaf('polygon', { class: 'board-part-box', points: pointsAttr(part.outline) });
      return node(
        'g',
        {
          class: `board-part is-${part.state}`,
          'data-ref': part.ref,
          'data-net': options.partNets?.[part.ref]?.join(' '),
        },
        tooltip(title(part)) +
          body +
          (part.pin1 === undefined ? '' : leaf('circle', { class: 'board-part-pin1', cx: part.pin1[0], cy: part.pin1[1], r: 0.25 })),
      );
    })
    .join('');
  const texts = parts
    .map((part) => {
      const label = labels.get(part);
      return label === undefined
        ? ''
        : text(label.value, {
            class: 'board-part-label',
            x: label.x,
            y: label.y,
            'data-ref': part.ref,
            'data-net': options.partNets?.[part.ref]?.join(' '),
            // inline style: the stylesheet's own size would win over an attribute
            ...(size === PART_LABEL_SIZE
              ? {}
              : { style: `font-size:${fmt(size)}px;stroke-width:${fmt(size * 0.27)}px` }),
          });
    })
    .join('');
  return node('g', { class: 'board-parts' }, bodies + texts);
}
