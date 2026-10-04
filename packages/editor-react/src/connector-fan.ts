/**
 * A connector face's exit fan.
 *
 * A mating face's pins sit on a circle or in rows, so several share a height:
 * the DIN-8's pins 1, 8 and 3; 4 and 5; 6 and 7. Leaving each pin level with
 * itself (e5c.30) draws those leads on top of one another, and the edges
 * leave the card bunched on a handful of heights. Instead every wired pin
 * gets its own **slot** on a fan column just clear of the drawing, on the
 * side its edges leave: the pin's lead runs straight to its slot, then level
 * with the slot to the card's edge, where its edge takes over. Slots are
 * stacked a fixed pitch apart, so no two leads — or the edges they become —
 * share a height, and they are assigned in the order that makes the fewest
 * leads cross each other (then the fewest that pass over another pin).
 *
 * Pure geometry in the drawing's own coordinates; `derive.ts` stores the
 * result on the node (`ConnectorNodeData.fan`), `breakout.ts` `anchorOf`
 * turns it into the pin's `slot`, and `nodes/ConnectorNode.tsx` draws the
 * leads along it — the same numbers, so the lead and its edge meet exactly.
 */

import { segmentsIntersect } from '@wirehub/render-svg';

import type { Facing } from './board-art.ts';
import type { ConnectorArtLayout, ConnectorPinArt } from './connector-art.ts';

export interface FanXY {
  x: number;
  y: number;
}

/** Every constant the fan is drawn with, in CSS pixels. */
export const FAN_LAYOUT = {
  /** the fan column: this far clear of the drawing's edge */
  gap: 12,
  /** slot pitch, when the art area has room (else its height is shared out) */
  pitch: 7,
  /** slots keep this clear of the art area's top and bottom */
  margin: 4,
  /** a lead passing within a pin's radius plus this is "over" that pin */
  graze: 1.2,
} as const;

const R = (value: number): number => Math.round(value * 100) / 100;

function distanceToSegment(p: FanXY, a: FanXY, b: FanXY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** How many pairs of leads cross, and how many (lead, other pin) pairs a lead passes over. */
export function fanCost(
  pins: readonly ConnectorPinArt[],
  leads: ReadonlyMap<string, FanXY>,
): { crossings: number; grazes: number } {
  const byTerminal = new Map(pins.map((pin) => [pin.terminal, pin]));
  const segments = [...leads].flatMap(([terminal, slot]) => {
    const pin = byTerminal.get(terminal);
    return pin === undefined ? [] : [{ terminal, a: { x: pin.x, y: pin.y }, b: slot }];
  });
  let crossings = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const p = segments[i]!;
      const q = segments[j]!;
      if (segmentsIntersect(p.a, p.b, q.a, q.b)) crossings += 1;
    }
  }
  let grazes = 0;
  for (const segment of segments) {
    for (const pin of pins) {
      if (pin.terminal === segment.terminal || pin.form === 'shell') continue;
      if (distanceToSegment(pin, segment.a, segment.b) < (pin.r ?? 2.5) + FAN_LAYOUT.graze) grazes += 1;
    }
  }
  return { crossings, grazes };
}

/**
 * The slot each of `wired` (pin terminals with an edge) leaves the face
 * through, drawing coordinates; `undefined` when none is wired or the face
 * has no such pins. `facing` is the side of the node the edges leave.
 */
export function connectorFan(
  layout: ConnectorArtLayout,
  wired: readonly string[],
  facing: Facing,
): Record<string, FanXY> | undefined {
  const art = layout.art;
  const want = new Set(wired);
  const pins = art.pins.filter((pin) => want.has(pin.terminal));
  if (pins.length === 0) return undefined;
  const dir = facing === 'right' ? 1 : -1;
  // the fan column: clear of the drawing, never past the card's own edge
  const edge = facing === 'right' ? layout.width - layout.ox : -layout.ox;
  const column =
    facing === 'right'
      ? Math.min(art.width + FAN_LAYOUT.gap, edge - 2)
      : Math.max(-FAN_LAYOUT.gap, edge + 2);

  // the slot heights: a pitch apart, centred on the pins, inside the area
  const top = -layout.oy + FAN_LAYOUT.margin;
  const bottom = layout.height - layout.oy - FAN_LAYOUT.margin;
  const room = Math.max(0, bottom - top);
  const n = pins.length;
  const pitch = n <= 1 ? 0 : Math.min(FAN_LAYOUT.pitch, room / (n - 1));
  const span = pitch * (n - 1);
  const centre = pins.reduce((sum, pin) => sum + pin.y, 0) / n;
  const first = Math.min(Math.max(centre - span / 2, top), Math.max(top, bottom - span));
  const heights = pins.map((_, index) => R(first + index * pitch));

  // the candidate orders: by height (ties nearest the exit first, or
  // farthest), and as seen from points out along the exit at a few distances
  const near = (pin: ConnectorPinArt): number => -dir * pin.x;
  const orders: ConnectorPinArt[][] = [
    [...pins].sort((p, q) => p.y - q.y || near(p) - near(q) || p.terminal.localeCompare(q.terminal)),
    [...pins].sort((p, q) => p.y - q.y || near(q) - near(p) || p.terminal.localeCompare(q.terminal)),
  ];
  for (const reach of [24, 48, 96]) {
    const focus = { x: column + dir * reach, y: centre };
    const angle = (pin: ConnectorPinArt): number => Math.atan2(pin.y - focus.y, dir * (focus.x - pin.x));
    orders.push([...pins].sort((p, q) => angle(p) - angle(q) || p.terminal.localeCompare(q.terminal)));
  }

  const scored = (order: readonly ConnectorPinArt[]): { map: Map<string, FanXY>; score: number } => {
    const map = new Map(order.map((pin, index) => [pin.terminal, { x: R(column), y: heights[index]! }]));
    const { crossings, grazes } = fanCost(art.pins, map);
    const drift = order.reduce((sum, pin, index) => sum + Math.abs(heights[index]! - pin.y), 0);
    return { map, score: crossings * 1000 + grazes * 10 + drift * 0.01 };
  };
  let best: { order: ConnectorPinArt[]; map: Map<string, FanXY>; score: number } | undefined;
  for (const order of orders) {
    const candidate = scored(order);
    if (best === undefined || candidate.score < best.score - 1e-9) best = { order, ...candidate };
  }
  if (best === undefined) return undefined;
  // then neighbouring slots swapped while that helps (bounded, deterministic)
  for (let pass = 0; pass < n; pass += 1) {
    let improved = false;
    for (let i = 0; i + 1 < n; i += 1) {
      const order: ConnectorPinArt[] = [...best.order];
      [order[i], order[i + 1]] = [order[i + 1]!, order[i]!];
      const candidate = scored(order);
      if (candidate.score < best.score - 1e-9) {
        best = { order, ...candidate };
        improved = true;
      }
    }
    if (!improved) break;
  }
  return Object.fromEntries(best.map);
}
