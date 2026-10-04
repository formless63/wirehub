/**
 * The canvas edge: one per distinct pair of handles (`derive.ts`), routed by
 * `breakout.ts`'s `edgeRoute` — a straight lead to each end's entry column,
 * one horizontal-tangent bend between — so edges between the same two
 * columns keep their order.
 *
 * Conductors take their colour (white and black over an outline, so both
 * read in both themes); grounds are dashed, a bundle carrying its `×n` badge
 * at the port it leaves. A ground edge leaving a wire's pigtail shares its
 * hover with it: over the edge or its badge, the members light up on the
 * face and are listed there.
 */

import { BaseEdge, Position, getBezierPath, type EdgeProps, type Edge, type EdgeTypes } from '@xyflow/react';
import { useMemo, type JSX } from 'react';

import type { Facing } from './board-art.ts';
import { edgeRoute, isPortHandle, routePath } from './breakout.ts';
import { classes } from './context.ts';
import type { EditorEdgeData } from './derive.ts';
import { useHoveredPort, useHoverStore } from './hover.ts';
import type { BundleEdgeData } from './lod.ts';

const facingOf = (position: Position): Facing => (position === Position.Left ? 'left' : 'right');

/**
 * React Flow's `reconnectRadius`: its invisible grab circle for a wire's end
 * sits this far out from the handle, on the edge's side, with this radius.
 * The visible grip (`cs-edge-grip`) is drawn on exactly that circle, so what
 * the user sees is what they can grab.
 */
export const REPIN_GRIP_RADIUS = 8;

/** Where React Flow centres an end's reconnect circle. */
function gripCentre(x: number, y: number, position: Position): { x: number; y: number } {
  if (position === Position.Left) return { x: x - REPIN_GRIP_RADIUS, y };
  if (position === Position.Right) return { x: x + REPIN_GRIP_RADIUS, y };
  if (position === Position.Top) return { x, y: y - REPIN_GRIP_RADIUS };
  return { x, y: y + REPIN_GRIP_RADIUS };
}

export function BreakoutEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  interactionWidth,
  sourceHandleId,
}: EdgeProps<Edge<EditorEdgeData, 'breakout'>>): JSX.Element {
  const route = edgeRoute({
    source: { x: sourceX, y: sourceY },
    target: { x: targetX, y: targetY },
    sourceFacing: facingOf(sourcePosition),
    targetFacing: facingOf(targetPosition),
    sourceEntryX: data?.sourceEntryX,
    targetEntryX: data?.targetEntryX,
    sourceEntryY: data?.sourceEntryY,
    targetEntryY: data?.targetEntryY,
    sourceClearX: data?.sourceClearX,
    targetClearX: data?.targetClearX,
    sourceApproach: data?.sourceApproach,
    targetApproach: data?.targetApproach,
    sourceApproachLead: data?.sourceApproachLead,
    targetApproachLead: data?.targetApproachLead,
    sourceSlot: data?.sourceSlot,
    targetSlot: data?.targetSlot,
  });
  // a docked connector's pin to its board's pad right beside it: a straight
  // stub, not a bend out and round the node
  const d = data?.stub === true ? `M ${sourceX} ${sourceY} L ${targetX} ${targetY}` : routePath(route);
  const kind = data?.kind ?? 'plain';
  const count = data?.count ?? 1;
  const emphasis = selected === true || data?.partial === true;
  const dir = sourcePosition === Position.Left ? -1 : 1;
  const badge = kind === 'ground' && count > 1;
  const badgeX = sourceX + dir * 6 - (dir < 0 ? 20 : 0);
  const hover = useHoverStore();
  // a pigtail's braids share one hover id (its terminal key): over any of
  // them, the whole twist lights, on the face and along every braid
  const port =
    data?.braid?.pigtail ??
    (kind === 'ground' && sourceHandleId != null && isPortHandle(sourceHandleId) ? sourceHandleId : undefined);
  const ids = useMemo(() => new Set(port === undefined ? [] : [port]), [port]);
  const lit = useHoveredPort(ids) !== undefined;
  return (
    <g
      className={classes(
        'cs-edge',
        `is-${kind}`,
        data?.net !== undefined && `is-net-${data.net}`,
        data?.braid !== undefined && 'is-braid',
        emphasis && 'is-emphasis',
        selected === true && 'is-selected',
        lit && 'is-lit',
      )}
      data-pigtail={data?.braid?.pigtail}
      data-edge={id}
      data-joints={data?.joints.join(' ')}
      {...(port === undefined
        ? {}
        : { onMouseEnter: () => hover.set(port), onMouseLeave: () => hover.set(undefined) })}
    >
      {data?.outlined === true ? <path className="cs-edge-outline" d={d} /> : null}
      <BaseEdge
        path={d}
        interactionWidth={interactionWidth ?? 12}
        style={data?.paint === undefined ? undefined : { stroke: data.paint }}
      />
      {data?.grips === undefined
        ? null
        : (['source', 'target'] as const)
            .filter((end) => data.grips === 'both' || data.grips === end)
            .map((end) => {
              const at =
                end === 'source' ? gripCentre(sourceX, sourceY, sourcePosition) : gripCentre(targetX, targetY, targetPosition);
              return (
                <g key={end} className="cs-edge-grip" data-grip={end}>
                  <line
                    x1={end === 'source' ? sourceX : targetX}
                    y1={end === 'source' ? sourceY : targetY}
                    x2={at.x}
                    y2={at.y}
                  />
                  <circle cx={at.x} cy={at.y} r={5} />
                </g>
              );
            })}
      {badge ? (
        <g className="cs-edge-badge" transform={`translate(${badgeX} ${sourceY - 6})`}>
          <rect width={20} height={12} rx={6} />
          <text x={10} y={9}>
            ×{count}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/**
 * Parts detail (`lod.ts`): every joint between two parts as one edge, as
 * heavy as it is full, with its joint count on it. Clicking it selects the
 * joints — a connection, to the inspector.
 */
export function BundleEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<Edge<BundleEdgeData, 'bundle'>>): JSX.Element {
  const [d, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const count = data?.count ?? 1;
  const width = Math.min(6, 1.5 + Math.log2(count));
  const label = String(count);
  const chip = 10 + label.length * 6;
  return (
    <g
      className={classes('cs-edge', 'cs-bundle', selected === true && 'is-selected', data?.partial === true && 'is-emphasis')}
      data-edge={id}
      data-joints={data?.joints.join(' ')}
    >
      <BaseEdge path={d} interactionWidth={16} style={{ strokeWidth: width }} />
      <g className="cs-bundle-count" transform={`translate(${labelX - chip / 2} ${labelY - 8})`}>
        <title>{`${count} joint${count === 1 ? '' : 's'}`}</title>
        <rect width={chip} height={16} rx={8} />
        <text x={chip / 2} y={11.5}>
          {label}
        </text>
      </g>
    </g>
  );
}

export const edgeTypes = { breakout: BreakoutEdge, bundle: BundleEdge } as unknown as EdgeTypes;
