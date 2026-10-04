/**
 * How a wire reaches a pin on a connector drawn as itself.
 *
 * A connector block in the schematic draws the shared connector art — its
 * mating face, or a side profile — with every used pin's wire running in from
 * the block's cable edge and ending on the drawn pin. On a face, pins sit in
 * rows and columns, so a wire run straight in level with its pin would often
 * pass over a nearer pin on the way (the far row of a multi-out connector sits
 * right behind the near one; a mini-DIN's middle row is four pins abreast) and
 * read as landing there — or lie on top of that pin's own wire.
 *
 * So each used pin gets a **channel**: the level its wire runs in at, across
 * the drawing, before one short square turn onto the pin. The channel is the
 * pin's own level whenever that is clear; otherwise the nearest level that
 * passes no other pin, keeps clear of every other wire's channel, and crosses
 * no other wire's turn. Pure art-unit geometry, deterministic: pins are taken
 * nearest the cable edge first (they have the shortest, least negotiable
 * runs), candidates are tried nearest-first in a fixed order.
 */

import type { ConnectorArt, ConnectorPinArt } from './connector-art.ts';

/** One used pin's run, art units: in level at `channel`, then onto the pin. */
export interface PinLead {
  terminal: string;
  /** the pin, art units */
  x: number;
  y: number;
  /** the level the wire crosses the drawing at */
  channel: number;
  /**
   * Set when the run goes round the back of the pin field: on past the far
   * column to this x (art units), along it to the pin's level, and back onto
   * the pin from behind.
   */
  behind?: number;
  /** no clear level was found: the run passes over another pin or run */
  blocked: boolean;
}

export interface PinLeadOptions {
  /** the side of the drawing the wires come in from */
  side: 'left' | 'right';
  /** clear air a run keeps from any other pin, art units */
  clearance: number;
  /** least distance between two runs' channels, art units */
  gap: number;
  /** candidate channel step, art units */
  step: number;
}

/** Half extents of a drawn pin, art units. */
function halfSize(pin: ConnectorPinArt): { hw: number; hh: number } {
  if (pin.width !== undefined && pin.height !== undefined) return { hw: pin.width / 2, hh: pin.height / 2 };
  const r = pin.r ?? 1.5;
  return { hw: r, hh: r };
}

const between = (value: number, a: number, b: number): boolean => value > Math.min(a, b) && value < Math.max(a, b);

/**
 * The channel every used pin's wire runs in at. `used` is the set of pin ids a
 * wire lands on; a used id the drawing has no pin for is skipped (the caller
 * checks coverage before drawing at all).
 */
export function planPinLeads(art: ConnectorArt, used: ReadonlySet<string>, options: PinLeadOptions): PinLead[] {
  const edge = options.side === 'right' ? art.width : 0;
  const reach = (pin: { x: number }): number => Math.abs(edge - pin.x);
  const wanted = art.pins
    .filter((pin) => used.has(pin.terminal))
    .sort((a, b) => reach(a) - reach(b) || a.y - b.y || a.terminal.localeCompare(b.terminal));

  const direct = placeInFront(art, wanted, options);
  // a blocked pin with nothing behind it (an HD15's far row)
  // can be reached from the back of the field instead: plan every other pin
  // without it, bring it round, and keep whichever plan blocks fewer runs
  const farmost = (pin: ConnectorPinArt): boolean =>
    !art.pins.some((other) => other !== pin && reach(other) > reach(pin) + halfSize(pin).hw);
  const stuck = new Set(
    wanted
      .filter((pin) => direct.some((lead) => lead.terminal === pin.terminal && lead.blocked))
      .filter(farmost)
      .map((pin) => pin.terminal),
  );
  if (stuck.size === 0) return direct;
  let front = placeInFront(art, wanted.filter((pin) => !stuck.has(pin.terminal)), options);
  // with the others settled, a stuck pin may come in clear after all
  const behind: ConnectorPinArt[] = [];
  for (const pin of wanted.filter((item) => stuck.has(item.terminal))) {
    const tried = placeInFront(art, [pin], options, front);
    if (tried[tried.length - 1]!.blocked) behind.push(pin);
    else front = tried;
  }
  // the pin nearest the top or bottom of the field takes the innermost return
  // lane, so the lanes nest instead of crossing each other's stubs
  const top = Math.min(...art.pins.map((pin) => pin.y));
  const bottom = Math.max(...art.pins.map((pin) => pin.y));
  const edgeward = (pin: ConnectorPinArt): number => Math.min(pin.y - top, bottom - pin.y);
  behind.sort((a, b) => edgeward(a) - edgeward(b) || a.y - b.y);
  const round = placeBehind(art, behind, front, options);
  const blockedIn = (leads: readonly PinLead[]): number => leads.filter((lead) => lead.blocked).length;
  if (blockedIn(round) >= blockedIn(direct)) return direct;
  const byTerminal = new Map(round.map((lead) => [lead.terminal, lead]));
  return wanted.map((pin) => byTerminal.get(pin.terminal)!);
}

/** Each pin in `wanted`, in order: run in across the face, one turn onto it. */
function placeInFront(
  art: ConnectorArt,
  wanted: readonly ConnectorPinArt[],
  options: PinLeadOptions,
  prior: readonly PinLead[] = [],
): PinLead[] {
  const edge = options.side === 'right' ? art.width : 0;
  const reach = (pin: { x: number }): number => Math.abs(edge - pin.x);
  const placed: PinLead[] = [...prior];
  const low = Math.min(options.clearance, art.height / 2);
  const high = Math.max(art.height - options.clearance, art.height / 2);

  for (const pin of wanted) {
    const others = art.pins.filter((other) => other !== pin);
    const cost = (channel: number): number => {
      let penalty = Math.abs(channel - pin.y);
      // the run across: edge → above/below the pin, clear of every nearer pin
      for (const other of others) {
        const { hw, hh } = halfSize(other);
        const acrossX = Math.min(edge, pin.x) - hw < other.x && other.x < Math.max(edge, pin.x) + hw;
        const nearer = reach(other) < reach(pin) + hw;
        if (acrossX && nearer && Math.abs(channel - other.y) < hh + options.clearance) penalty += 1000;
        // the turn: along the pin's own column, clear of the pins in it
        if (
          channel !== pin.y &&
          Math.abs(other.x - pin.x) < hw + options.clearance &&
          other.y > Math.min(channel, pin.y) - hh - options.clearance &&
          other.y < Math.max(channel, pin.y) + hh + options.clearance
        ) {
          penalty += 1000;
        }
      }
      for (const lead of placed) {
        // every run starts at the edge, so any two share a stretch: keep apart
        // (two wires on one line are worse than one passing over a pin)
        if (Math.abs(channel - lead.channel) < options.gap) penalty += 5000;
        // a turn nearer the edge that this run would cut across
        if (reach(lead) < reach(pin) && between(channel, lead.channel, lead.y)) penalty += 500;
        // this run's turn cutting across a farther run
        if (channel !== pin.y && reach(lead) > reach(pin) && between(lead.channel, channel, pin.y)) penalty += 500;
        // two turns on one column, overlapping
        if (
          Math.abs(lead.x - pin.x) < options.clearance &&
          Math.max(Math.min(channel, pin.y), Math.min(lead.channel, lead.y)) <
            Math.min(Math.max(channel, pin.y), Math.max(lead.channel, lead.y))
        ) {
          penalty += 1000;
        }
      }
      return penalty;
    };

    let best = pin.y;
    let bestCost = cost(pin.y);
    const steps = Math.ceil(art.height / options.step);
    for (let k = 1; k <= steps && bestCost >= 1; k += 1) {
      for (const channel of [pin.y + k * options.step, pin.y - k * options.step]) {
        if (channel < low || channel > high) continue;
        const value = cost(channel);
        if (value < bestCost - 1e-9) {
          best = channel;
          bestCost = value;
        }
      }
      // a clear channel this close cannot be beaten further out
      if (bestCost < 1000 && bestCost <= (k + 1) * options.step) break;
    }
    placed.push({ terminal: pin.terminal, x: pin.x, y: pin.y, channel: Math.round(best * 100) / 100, blocked: bestCost >= 500 });
  }
  return placed;
}

/**
 * `stuck` pins (each with nothing behind it), after `placed`: each runs in at
 * a level clear of every pin, on past the far column to a return lane, along
 * it to the pin's level and back onto the pin. Lanes nest outward and are
 * charged for every crossing, so none cross. `placed` plus the new runs.
 */
function placeBehind(
  art: ConnectorArt,
  stuck: readonly ConnectorPinArt[],
  placed: readonly PinLead[],
  options: PinLeadOptions,
): PinLead[] {
  const edge = options.side === 'right' ? art.width : 0;
  const away = options.side === 'right' ? -1 : 1;
  const reach = (x: number): number => Math.abs(edge - x);
  const out = [...placed];
  const low = Math.min(options.clearance, art.height / 2);
  const high = Math.max(art.height - options.clearance, art.height / 2);
  const steps = Math.ceil(art.height / options.step);

  for (const pin of stuck) {
    const { hw } = halfSize(pin);
    const cost = (channel: number, back: number): number => {
      let penalty = Math.abs(channel - pin.y) + reach(back) - reach(pin.x);
      // the run in crosses the whole field: clear of every pin, its own too
      for (const other of art.pins) {
        if (Math.abs(channel - other.y) < halfSize(other).hh + options.clearance) penalty += 1000;
      }
      for (const lead of out) {
        if (Math.abs(channel - lead.channel) < options.gap) penalty += 5000;
        if (lead.behind === undefined) {
          // this run in crosses that run's turn onto its pin
          if (between(channel, lead.channel, lead.y)) penalty += 500;
          continue;
        }
        if (Math.abs(back - lead.behind) < options.clearance) penalty += 1000;
        const outer = reach(back) > reach(lead.behind);
        // a run in, or a stub back onto a pin, across the other's return lane
        if (outer && between(channel, lead.channel, lead.y)) penalty += 500;
        if (outer && between(pin.y, lead.channel, lead.y)) penalty += 500;
        if (!outer && between(lead.channel, channel, pin.y)) penalty += 500;
        if (!outer && between(lead.y, channel, pin.y)) penalty += 500;
      }
      return penalty;
    };

    let best = { channel: pin.y, back: pin.x + away * (hw + options.clearance), cost: Infinity };
    for (let lane = 0; lane < 4; lane += 1) {
      const back = pin.x + away * (hw + options.clearance + lane * options.gap);
      if (back < 0 || back > art.width) break;
      for (let k = 0; k <= steps; k += 1) {
        for (const channel of k === 0 ? [pin.y] : [pin.y - k * options.step, pin.y + k * options.step]) {
          if (channel < low || channel > high) continue;
          const value = cost(channel, back);
          if (value < best.cost - 1e-9) best = { channel, back, cost: value };
        }
      }
    }
    out.push({
      terminal: pin.terminal,
      x: pin.x,
      y: pin.y,
      channel: Math.round(best.channel * 100) / 100,
      behind: Math.round(best.back * 100) / 100,
      blocked: best.cost >= 500,
    });
  }
  return out;
}
