/// <reference path="./elk-worker.d.ts" />
/**
 * ELK, run synchronously.
 *
 * elkjs's public API is a promise over a (web or fake) worker — even its
 * bundled build answers through `setTimeout`. Auto-arrange is a reducer action
 * and the first open of a design is `initialEditorState`, and both are pure
 * and synchronous; an async layout would mean a second dispatch, a frame of
 * the old arrangement, and an undo step that raced the user. So this module
 * drives elkjs's in-process engine directly: the same `Dispatcher` the fake
 * worker wraps, called without the `setTimeout`. The engine is plain
 * computation (no timers, no I/O), so the answer is there when the call
 * returns — and, with a fixed `randomSeed`, the same answer every time.
 *
 * Nothing here knows about cables: `derive.ts` builds the graph (node sizes
 * from `layout-size.ts`, ports from the handles' real positions) and reads
 * the node positions back.
 */

import engineModule from 'elkjs/lib/elk-worker.min.js';

export interface ElkPortSpec {
  id: string;
  /** relative to the node's top-left corner */
  x: number;
  y: number;
  side: 'WEST' | 'EAST';
}

export interface ElkNodeSpec {
  id: string;
  width: number;
  height: number;
  ports: ElkPortSpec[];
}

export interface ElkEdgeSpec {
  id: string;
  /** a port id, or a node id for an edge with no handle geometry */
  source: string;
  target: string;
}

export interface ElkGraphSpec {
  nodes: ElkNodeSpec[];
  edges: ElkEdgeSpec[];
}

/** Every option the canvas lays out with; see `elkLayout`. */
export const ELK_OPTIONS: Readonly<Record<string, string>> = {
  'elk.algorithm': 'layered',
  // end `a` on the left, end `b` on the right
  'elk.direction': 'RIGHT',
  // clear air between two parts in one column, and between two columns
  'elk.spacing.nodeNode': '40',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.spacing.edgeNode': '16',
  'elk.layered.spacing.edgeNodeBetweenLayers': '16',
  'elk.spacing.componentComponent': '96',
  // the canvas draws its own edges: routing only has to leave room for them
  'elk.edgeRouting': 'POLYLINE',
  // straight runs from pad to port where the columns allow it
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.randomSeed': '1',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
};

type Message = { id: number; data?: unknown; error?: unknown };
interface Engine {
  onmessage: (event: { data: Message }) => void;
  dispatcher: { saveDispatch: (event: { data: Record<string, unknown> }) => void };
}
type EngineConstructor = new () => Engine;

function engineConstructor(): EngineConstructor {
  const candidates: unknown[] = [];
  const module = engineModule as unknown;
  if (typeof module === 'function') candidates.push(module);
  if (typeof module === 'object' && module !== null) {
    const record = module as Record<string, unknown>;
    candidates.push(record['Worker'], record['default']);
    const inner = record['default'];
    if (typeof inner === 'object' && inner !== null) {
      candidates.push((inner as Record<string, unknown>)['Worker'], (inner as Record<string, unknown>)['default']);
    }
  }
  const found = candidates.find((candidate) => typeof candidate === 'function');
  if (found === undefined) throw new Error('elkjs: in-process layout engine not found');
  return found as EngineConstructor;
}

let engine: { run: (message: Record<string, unknown>) => unknown } | undefined;

function elk(): { run: (message: Record<string, unknown>) => unknown } {
  if (engine !== undefined) return engine;
  const worker = new (engineConstructor())();
  let answer: Message | undefined;
  worker.onmessage = (event) => {
    answer = event.data;
  };
  let id = 0;
  const run = (message: Record<string, unknown>): unknown => {
    answer = undefined;
    id += 1;
    worker.dispatcher.saveDispatch({ data: { ...message, id } });
    const reply = answer as Message | undefined;
    if (reply === undefined) throw new Error('elkjs: no synchronous answer');
    if (reply.error !== undefined) {
      const error = reply.error as { message?: string } | string;
      throw new Error(`elkjs: ${typeof error === 'string' ? error : (error.message ?? 'layout failed')}`);
    }
    return reply.data;
  };
  run({ cmd: 'register', algorithms: ['layered'] });
  engine = { run };
  return engine;
}

interface ElkOut {
  children?: { id: string; x?: number; y?: number }[];
}

/**
 * Lay `graph` out with ELK layered, left to right, every port where its
 * handle is (`FIXED_POS`). Returns each node's top-left corner, rounded to
 * whole pixels.
 */
export function elkLayout(graph: ElkGraphSpec): Record<string, { x: number; y: number }> {
  const input = {
    id: 'root',
    layoutOptions: { ...ELK_OPTIONS },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: node.ports.map((port) => ({
        id: port.id,
        x: port.x,
        y: port.y,
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': port.side },
      })),
    })),
    edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
  const out = elk().run({ cmd: 'layout', graph: input, layoutOptions: {}, options: {} }) as ElkOut;
  const positions: Record<string, { x: number; y: number }> = {};
  for (const child of out.children ?? []) {
    positions[child.id] = { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) };
  }
  return positions;
}
