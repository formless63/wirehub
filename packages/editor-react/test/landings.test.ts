/**
 * Wire landings on the real boards: on every catalog
 * design, every edge that lands on a board's cable pad leaves that pad in the
 * pad's own outward direction — off the end of the pad, off the board edge —
 * and its run out to where the bend starts (the first segment, any lead, the
 * entry column) neither cuts back across the board outline nor runs over
 * another pad's copper.
 *
 * "Outward" is the catalog's `approach` (the pad's long axis, pointed off the
 * board by the Edge.Cuts outline), turned and mirrored exactly as the pad is.
 * A pad the board file gives no axis for (a round/square pad — a bodge pad,
 * or a family's V+/GND squares, whose rotation alone names an angle)
 * has no outward direction of its own; it is held to the no-crossing half
 * only. Stub edges (a mounted connector's shell legs) are not wires
 * and come in from the connector's side; they are left out.
 */

import { loadDb, loadDesign, type DepictionMeta } from '@wirehub/catalog';
import type { Db } from '@wirehub/model';
import { boardOutlineFromSvg, copperPads, padPolygon, segmentHitsPolygon, segmentsIntersect } from '@wirehub/render-svg';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { boardArt, rotateApproach, rotatePoint, type BoardArt } from '../src/board-art.ts';
import { anchorOf, edgeRoute, placedNode, routeLeadRun, type XY } from '../src/breakout.ts';
import { deriveFlow, type EditorNode } from '../src/derive.ts';
import { diskDepictions } from './fixture.ts';

const db: Db = loadDb();
const depictions = diskDepictions();
const DEPICTIONS = join(process.cwd(), '..', 'catalog', 'depictions');

const designs = readdirSync(join(process.cwd(), '..', 'catalog', 'data', 'designs'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .sort();

function absolute(nodes: EditorNode[], node: EditorNode): XY {
  const parent = node.parentId === undefined ? undefined : nodes.find((candidate) => candidate.id === node.parentId);
  return parent === undefined
    ? node.position
    : { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y };
}

function reflect(deg: number): number {
  const out = (Math.atan2(Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)) * 180) / Math.PI;
  return ((out % 360) + 360) % 360;
}

const outlines = new Map<string, XY[] | undefined>();
function outlineOf(defId: string): XY[] | undefined {
  if (!outlines.has(defId)) {
    let svg = '';
    try {
      svg = readFileSync(join(DEPICTIONS, defId, 'board-top.svg'), 'utf8');
    } catch {
      svg = '';
    }
    outlines.set(defId, boardOutlineFromSvg(svg));
  }
  return outlines.get(defId);
}

export interface Landing {
  design: string;
  board: string;
  handle: string;
  side: 'top' | 'bottom';
  /** the pad's own outward direction on screen, degrees (absent: no axis) */
  outward?: number;
  /** first segment, pad first */
  first: [XY, XY];
  /** the pad → leads → entry-column run */
  run: XY[];
  headsOutward: boolean | undefined;
  crossesOutline: boolean;
  overPad: string | undefined;
}

/** Every drawn edge end on a board cable pad, across every catalog design. */
export function landings(ids: readonly string[] = designs): Landing[] {
  const out: Landing[] = [];
  for (const id of ids) {
    const flow = deriveFlow(loadDesign(id), db, { depictions });
    const nodes = flow.nodes;
    const placed = new Map(nodes.map((node) => [node.id, placedNode(node.id, node.data, absolute(nodes, node))]));
    for (const edge of flow.edges) {
      // a stub is a mounted connector's own shell leg soldered through the
      // board, not a wire: it comes in from the connector's side
      if (edge.hidden === true || edge.data?.stub === true) continue;
      const sourceNode = placed.get(edge.source);
      const targetNode = placed.get(edge.target);
      const source = sourceNode === undefined ? undefined : anchorOf(sourceNode, edge.sourceHandle ?? '');
      const target = targetNode === undefined ? undefined : anchorOf(targetNode, edge.targetHandle ?? '');
      if (source === undefined || target === undefined) continue;
      const route = edgeRoute({
        source,
        target,
        sourceFacing: source.facing,
        targetFacing: target.facing,
        sourceEntryX: edge.data?.sourceEntryX,
        targetEntryX: edge.data?.targetEntryX,
        sourceEntryY: edge.data?.sourceEntryY,
        targetEntryY: edge.data?.targetEntryY,
        sourceClearX: edge.data?.sourceClearX,
        targetClearX: edge.data?.targetClearX,
        sourceApproach: edge.data?.sourceApproach,
        targetApproach: edge.data?.targetApproach,
        sourceApproachLead: edge.data?.sourceApproachLead,
        targetApproachLead: edge.data?.targetApproachLead,
        sourceSlot: edge.data?.sourceSlot,
        targetSlot: edge.data?.targetSlot,
      });
            for (const end of ['source', 'target'] as const) {
        const node = end === 'source' ? sourceNode : targetNode;
        const handleId = (end === 'source' ? edge.sourceHandle : edge.targetHandle) ?? '';
        if (node?.data.kind !== 'pcba' || node.data.board === undefined) continue;
        const art: BoardArt = node.data.board;
        const handle = art.handles.find((candidate) => candidate.id === handleId);
        if (handle === undefined || !handle.cableSide) continue;
        const meta = depictions.meta(art.defId) as DepictionMeta | undefined;
        const view = art.views.find((candidate) => candidate.side === handle.side);
        if (meta === undefined || view === undefined) continue;
        const anchor = end === 'source' ? source : target;
        // anchor frame (mm) → this canvas, through the face's own mirror and turn
        const ox = anchor.x - handle.x;
        const oy = anchor.y - handle.y;
        const toCanvas = (p: XY): XY => {
          const own = handle.side === 'top' ? p : { x: view.frame.width - p.x, y: p.y };
          const turned = rotatePoint(own, view.frame, view.rotation);
          return { x: ox + view.box.x + turned.x * view.scale, y: oy + view.box.y + turned.y * view.scale };
        };
        const pad = (meta.pinAnchors[handle.terminal]?.pads ?? []).find(
          (candidate) => candidate.ref === handle.ref && (candidate.side === handle.side || candidate.side === 'both'),
        );
        // a round/square pad has no axis of its own: no outward direction
        const axial = pad?.size === undefined || Math.abs(pad.size[0] - pad.size[1]) > 1e-6;
        const outward =
          pad?.approach === undefined || !axial
            ? undefined
            : rotateApproach(handle.side === 'top' ? pad.approach : reflect(pad.approach), view.rotation);
        // the run from the pad to where the bend starts: its leads, then the
        // entry column — everything drawn over (or just off) the board
        // as drawn: every lead corner rounded, arcs sampled
        const run: XY[] = routeLeadRun(route, end);
        const first: [XY, XY] = [run[0]!, run[1]!];
        const dx = first[1].x - first[0].x;
        const dy = first[1].y - first[0].y;
        const headsOutward =
          outward === undefined
            ? undefined
            : dx * Math.cos((outward * Math.PI) / 180) + dy * Math.sin((outward * Math.PI) / 180) > 0;
        const outline = outlineOf(art.defId)?.map(toCanvas);
        let crossings = 0;
        for (let k = 0; k + 1 < run.length; k += 1) {
          for (let i = 0; outline !== undefined && i < outline.length; i += 1) {
            if (segmentsIntersect(run[k]!, run[k + 1]!, outline[i]!, outline[(i + 1) % outline.length]!)) crossings += 1;
          }
        }
        const own = { x: handle.x + ox, y: handle.y + oy };
        const overPad = copperPads(meta, handle.side)
          .filter((other) => other.ref !== handle.ref || other.terminal !== handle.terminal)
          .find((other) => {
            const centre = toCanvas(other);
            if (Math.hypot(centre.x - own.x, centre.y - own.y) < 0.5) return false;
            const polygon = padPolygon(other).map(toCanvas);
            return run.some((point, k) => k + 1 < run.length && segmentHitsPolygon(point, run[k + 1]!, polygon));
          });
        out.push({
          design: id,
          board: art.defId,
          handle: handleId,
          side: handle.side,
          ...(outward === undefined ? {} : { outward }),
          first,
          run,
          headsOutward,
          crossesOutline: crossings > 1,
          overPad: overPad === undefined ? undefined : `${overPad.terminal}/${overPad.ref ?? ''}`,
        });
      }
    }
  }
  return out;
}

const describeLanding = (l: Landing): string =>
  `${l.design} ${l.board} ${l.side} ${l.handle}${l.outward === undefined ? '' : ` (${Math.round(l.outward)}°)`}`;

describe('every board cable-pad landing leaves the pad outward', () => {
  const all = landings();

  it('heads off every oriented pad in its own outward direction', () => {
    const wrong = all.filter((l) => l.headsOutward === false).map(describeLanding);
    expect(wrong).toEqual([]);
  });

  it('never cuts back across the board outline on the way out to the bend', () => {
    expect(all.filter((l) => l.crossesOutline).map(describeLanding)).toEqual([]);
  });

  it('never runs over another pad on the way out to the bend', () => {
    expect(all.filter((l) => l.overPad !== undefined).map((l) => `${describeLanding(l)} over ${l.overPad}`)).toEqual([]);
  });
});

/**
 * The face turn on every gerber board, whatever design (or no design yet)
 * uses it, wire on either side: each face whose cable row is a
 * straight one is turned so that row points at the wire. Guards the boards no
 * committed design lands on yet — PCA-00112-30, PCA-00120/016/017 — and a
 * wire drawn on the left.
 */
describe('every straight cable row faces the wire, on every board and both sides', () => {
  const ids = existsSync(DEPICTIONS) ? readdirSync(DEPICTIONS).sort() : [];
  const wrong: string[] = [];
  let checked = 0;
  for (const defId of ids) {
    const meta = depictions.meta(defId) as DepictionMeta | undefined;
    if (meta?.pinAnchors === undefined) continue;
    for (const facing of ['right', 'left'] as const) {
      const art = boardArt({ instanceId: 'u1', defId, terminals: Object.keys(meta.pinAnchors), cableFacing: facing, depictions });
      if (art === undefined) continue;
      for (const view of art.views) {
        // the on-screen outward of every axial primary cable pad on this face
        const outs = art.handles
          .filter((handle) => handle.side === view.side && handle.cableSide && handle.primary)
          .flatMap((handle) => {
            const pad = (meta.pinAnchors[handle.terminal]?.pads ?? []).find((p) => p.ref === handle.ref);
            if (pad?.approach === undefined || pad.size === undefined || Math.abs(pad.size[0] - pad.size[1]) < 1e-6) return [];
            const deg = rotateApproach(view.side === 'top' ? pad.approach : reflect(pad.approach), view.rotation);
            return [Math.round(deg) % 360];
          });
        const counts = new Map<number, number>();
        for (const deg of outs) counts.set(deg, (counts.get(deg) ?? 0) + 1);
        const [best, second] = [...counts.entries()].sort((p, q) => q[1] - p[1]);
        if (best === undefined || (second !== undefined && second[1] === best[1]) || best[0] % 90 !== 0) continue;
        checked += 1;
        const want = facing === 'right' ? 0 : 180;
        if (best[0] !== want) wrong.push(`${defId} ${view.side} wire ${facing}: row points ${best[0]}° (turn ${view.rotation})`);
      }
    }
  }

  it('turns each straight row to the wire', () => {
    expect(wrong).toEqual([]);
  });
});
