/**
 * Net paint: the colour a terminal's signal is carried
 * in, so a joint between two parts that no wire element touches — a plug pin
 * into a carrier board, a carrier's slot pad onto the console board — is
 * drawn in the colour of the conductor that signal reaches the cable on,
 * rather than one undifferentiated grey.
 *
 * The rule, per galvanic net (`deriveNets`: joints, wire copper, plain board
 * links — a component or a `via` link is a boundary):
 *
 *  - a screen, drain, bare conductor or pigtail anywhere on the net → ground;
 *  - otherwise exactly one insulated conductor colour on the net → that
 *    colour (the +5 V net carried on brown is brown, as its wire is);
 *  - several colours → ambiguous, no paint;
 *  - no wire element at all → walk out through the net's passages (the
 *    termination resistor, the sync filter, a `via` link), nearest nets
 *    first, and take the first depth that reaches any wire: its one paint if
 *    every net found there agrees, else ambiguous.
 *
 * No paint (`undefined`) is drawn grey — reserved for nets no conductor
 * reaches and nets the rule cannot call. The connector face's pins
 * (`derive.ts` `pinColours`) are painted by the same rule, so a pin, its
 * lead and the edge leaving it always agree.
 */

import { buildGraph, deriveNets, type CableDesign, type Db } from '@cable-studio/model';

export type NetPaint = { kind: 'conductor'; colorName: string } | { kind: 'ground' };

/** How many passages out a net with no wire of its own looks for one. */
const PASSAGE_HOPS = 4;

type Verdict = NetPaint | 'ambiguous' | undefined;

function same(a: NetPaint, b: NetPaint): boolean {
  return a.kind === b.kind && (a.kind === 'ground' || (b.kind === 'conductor' && a.colorName === b.colorName));
}

/**
 * The paint of every terminal key's net, computed once for a design. The
 * returned function answers `undefined` for a key on no net, an ambiguous
 * net, or a net no conductor reaches.
 */
export function netPainter(design: CableDesign, db: Db): (key: string) => NetPaint | undefined {
  const cached = cache.get(design)?.get(db);
  if (cached !== undefined) return cached;
  const painter = computePainter(design, db);
  let byDb = cache.get(design);
  if (byDb === undefined) {
    byDb = new WeakMap();
    cache.set(design, byDb);
  }
  byDb.set(db, painter);
  return painter;
}

/** One painter per design and db: nodes and edges of one derivation share it. */
const cache = new WeakMap<CableDesign, WeakMap<Db, (key: string) => NetPaint | undefined>>();

function computePainter(design: CableDesign, db: Db): (key: string) => NetPaint | undefined {
  const nets = deriveNets(design, db);
  const netOf = new Map<string, number>();
  nets.forEach((net, index) => {
    for (const terminal of net.terminals) netOf.set(terminal.key, index);
  });

  // each net's own wire elements
  const own: Verdict[] = nets.map((net) => {
    const colours = new Set<string>();
    let ground = false;
    for (const terminal of net.terminals) {
      if (terminal.pigtail !== undefined) ground = true;
      const element = terminal.element;
      if (element === undefined) continue;
      if (element.kind === 'shield' || (element.kind === 'conductor' && element.bare === true)) ground = true;
      else if (element.kind === 'conductor' && element.color !== undefined) colours.add(element.color.toLowerCase());
    }
    if (ground) return { kind: 'ground' };
    if (colours.size === 1) return { kind: 'conductor', colorName: [...colours][0]! };
    return colours.size > 1 ? 'ambiguous' : undefined;
  });

  // the nets one passage apart
  const beside = nets.map(() => new Set<number>());
  for (const edge of buildGraph(design, db).edges) {
    if (edge.passage === undefined) continue;
    const a = netOf.get(edge.a.key);
    const b = netOf.get(edge.b.key);
    if (a === undefined || b === undefined || a === b) continue;
    beside[a]!.add(b);
    beside[b]!.add(a);
  }

  const memo = new Map<number, NetPaint | undefined>();
  const paintOf = (start: number): NetPaint | undefined => {
    if (memo.has(start)) return memo.get(start);
    let result: NetPaint | undefined;
    const first = own[start];
    if (first === 'ambiguous') result = undefined;
    else if (first !== undefined) result = first;
    else {
      const seen = new Set([start]);
      let frontier = [start];
      for (let depth = 0; depth < PASSAGE_HOPS && frontier.length > 0; depth += 1) {
        const next: number[] = [];
        for (const at of frontier) {
          for (const to of beside[at] ?? []) {
            if (seen.has(to)) continue;
            seen.add(to);
            next.push(to);
          }
        }
        const found = next.map((index) => own[index]).filter((verdict) => verdict !== undefined);
        if (found.length > 0) {
          const [head, ...rest] = found;
          result =
            head === 'ambiguous' || head === undefined || rest.some((other) => other === 'ambiguous' || !same(head, other))
              ? undefined
              : head;
          break;
        }
        frontier = next;
      }
    }
    memo.set(start, result);
    return result;
  };

  return (key: string) => {
    const index = netOf.get(key);
    return index === undefined ? undefined : paintOf(index);
  };
}
