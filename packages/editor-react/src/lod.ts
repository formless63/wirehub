/**
 * Level of detail (spec: ui-redesign, Canvas v2 item 8).
 *
 * **Pins** is the canvas as `derive.ts` draws it: every pad, face and pin.
 * **Parts** collapses it: each part becomes a compact card (kind, id, part
 * number, one line of meta; a board keeps a thumbnail of its top face), a
 * docked connector folds into its board's card, and every edge between two
 * cards collapses into one **bundle** labelled with its joint count — the
 * breakout plan's links (`planBreakouts`, via the derived edges) grouped by
 * the pair of parts they join. Selecting a bundle selects its joints, which
 * is a connection to the inspector.
 *
 * Pure: a function of the derived flow. A card sits centred on the box its
 * part has in Pins, so switching detail moves nothing; `offsets` turns a
 * dragged card back into its part's position.
 */

import type { InstanceKind } from '@wirehub/model';
import type { Edge, Node } from '@xyflow/react';

import type { BoardViewArt } from './board-art.ts';
import type { EditorEdge, EditorNode, XY } from './derive.ts';
import { PART_CARD_LAYOUT, estimateNodeSize, nodeHeading, partCardSize, partCardThumbSize, type NodeSize } from './layout-size.ts';

export type CanvasDetail = 'parts' | 'pins';

/** Below this zoom the canvas draws Parts whatever the toggle says. */
export const LOD_ZOOM = 0.5;

export const CARD_LAYOUT = PART_CARD_LAYOUT;

export type CardNodeData = {
  kind: 'card';
  instanceId: string;
  part: InstanceKind | 'breakout';
  title: string;
  /** part number, definition id, or wire stock */
  partNumber: string;
  meta: string;
  missingDef: boolean;
  /** a board's top face, scaled into the card */
  thumb?: { view: BoardViewArt; width: number; height: number };
  /** connectors docked on this board, folded into its card */
  docked: string[];
};

export type CardNode = Node<CardNodeData, 'card'>;

export type BundleEdgeData = {
  /** every joint between the two parts */
  joints: number[];
  /** the first of them (what an edge click selects by, see `jointsOfEdge`) */
  jointIndex: number;
  count: number;
  partial?: boolean;
};

export type BundleEdge = Edge<BundleEdgeData, 'bundle'>;

export interface PartsFlow {
  nodes: CardNode[];
  edges: BundleEdge[];
  /** card position − part position, per card */
  offsets: Map<string, XY>;
}

function thumbOf(node: EditorNode): CardNodeData['thumb'] {
  if (node.data.kind !== 'pcba' || node.data.board === undefined) return undefined;
  const view = node.data.board.views.find((candidate) => candidate.side === 'top') ?? node.data.board.views[0];
  if (view === undefined || view.box.width <= 0 || view.box.height <= 0) return undefined;
  return { view, ...partCardThumbSize(view.box.width, view.box.height) };
}

/** What a part's card says. */
export function cardDataOf(node: EditorNode, docked: readonly string[] = []): CardNodeData {
  const data = node.data;
  const heading = nodeHeading(data);
  const base = { kind: 'card' as const, instanceId: data.instanceId, part: data.kind, missingDef: data.missingDef };
  const thumb = thumbOf(node);
  const withThumb = thumb === undefined ? {} : { thumb };
  switch (data.kind) {
    case 'connector':
      return { ...base, title: data.title, partNumber: data.def, meta: [heading.subtitle, data.role].filter(Boolean).join(' · '), docked: [] };
    case 'segment':
      return { ...base, title: data.title, partNumber: data.subtitle, meta: heading.meta ?? '', docked: [] };
    case 'component':
      return { ...base, title: heading.title, partNumber: data.def, meta: data.componentKind, docked: [] };
    case 'pcba':
      return {
        ...base,
        title: data.title,
        partNumber: data.def,
        meta: [data.subtitle, ...docked].filter(Boolean).join(' · '),
        docked: [...docked],
        ...withThumb,
      };
    case 'breakout':
      return { ...base, title: data.title, partNumber: data.instanceId, meta: data.subtitle, docked: [] };
    case 'subassembly':
      return { ...base, title: data.title, partNumber: data.partNumber ?? data.def, meta: [data.subtitle, data.role].filter(Boolean).join(' · '), docked: [] };
  }
}

/** The drawn size of a card — what `CardNode` renders at. */
export function cardSize(data: CardNodeData): NodeSize {
  return partCardSize(data);
}

/** The flow in Parts: one card per placed part, one bundle per pair of parts. */
export function partsFlow(flow: { nodes: readonly EditorNode[]; edges: readonly EditorEdge[] }): PartsFlow {
  const parent = new Map<string, string>();
  const docked = new Map<string, string[]>();
  for (const node of flow.nodes) {
    if (node.parentId === undefined) continue;
    parent.set(node.id, node.parentId);
    docked.set(node.parentId, [...(docked.get(node.parentId) ?? []), node.id]);
  }
  const own = (id: string): string => parent.get(id) ?? id;

  const nodes: CardNode[] = [];
  const offsets = new Map<string, XY>();
  const centres = new Map<string, number>();
  for (const node of flow.nodes) {
    if (node.parentId !== undefined) continue;
    const data = cardDataOf(node, docked.get(node.id));
    const full = estimateNodeSize(node.data);
    const card = cardSize(data);
    const offset = {
      x: Math.round(Math.max(0, full.width - card.width) / 2),
      y: Math.round(Math.max(0, full.height - card.height) / 2),
    };
    offsets.set(node.id, offset);
    const position = { x: node.position.x + offset.x, y: node.position.y + offset.y };
    centres.set(node.id, position.x + card.width / 2);
    nodes.push({
      id: node.id,
      type: 'card',
      position,
      data,
      selected: node.selected === true,
      dragHandle: '.cs-card',
      connectable: false,
    });
  }

  interface Pair {
    a: string;
    b: string;
    joints: Set<number>;
    members: number;
    chosen: number;
    partial: boolean;
  }
  const pairs = new Map<string, Pair>();
  for (const edge of flow.edges) {
    if (edge.hidden === true) continue;
    const s = own(edge.source);
    const t = own(edge.target);
    if (s === t) continue;
    const [a, b] = s < t ? [s, t] : [t, s];
    const key = `${a}\u0000${b}`;
    let pair = pairs.get(key);
    if (pair === undefined) {
      pair = { a, b, joints: new Set(), members: 0, chosen: 0, partial: false };
      pairs.set(key, pair);
    }
    for (const joint of edge.data?.joints ?? []) pair.joints.add(joint);
    pair.members += 1;
    if (edge.selected === true) pair.chosen += 1;
    if (edge.data?.partial === true) pair.partial = true;
  }

  const edges: BundleEdge[] = [];
  for (const pair of pairs.values()) {
    const joints = [...pair.joints].sort((p, q) => p - q);
    // a mould's runs are no joints (`moulds.ts`), but the bundle still says the parts are joined
    const mould = joints.length === 0;
    const first = joints[0] ?? -1;
    if (mould && pair.members === 0) continue;
    // the bundle runs left to right, card edge to card edge
    const [source, target] =
      (centres.get(pair.a) ?? 0) <= (centres.get(pair.b) ?? 0) ? [pair.a, pair.b] : [pair.b, pair.a];
    const all = pair.chosen === pair.members;
    edges.push({
      id: `bundle:${pair.a}|${pair.b}`,
      type: 'bundle',
      source,
      sourceHandle: 'r',
      target,
      targetHandle: 'l',
      selected: !mould && all,
      deletable: false,
      ...(mould ? { selectable: false } : {}),
      data: {
        joints,
        jointIndex: first,
        count: mould ? pair.members : joints.length,
        ...(!all && (pair.chosen > 0 || pair.partial) ? { partial: true } : {}),
      },
    });
  }
  return { nodes, edges, offsets };
}
