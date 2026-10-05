/**
 * A wire segment drawn as its two cut ends: end `a` (source) on the left, end
 * `b` (destination) on the right (the other way round when `wire.flipped`),
 * joined by the jacket run, with a handle on every electrical element of each
 * face.
 *
 * All geometry comes from `wire-art.ts` via the node data — this component
 * only paints it. Conductors take their domain colour (white and black
 * outlined), dielectric, foil and jacket take tokens. An element with no joint
 * at an end is dimmed there; a drain the design leaves unconnected at an end
 * is marked as cut.
 *
 * Breakouts (`breakout.ts`, via `data.breakout`): each end's port column sits
 * in the clear band outside its face, one handle per port for the edges, and
 * every conductor reaches its port along a stub painted *beneath* the faces,
 * so it appears from under the jacket's edge. A pigtail's braids do the same,
 * each on its own (drawn as braid), converging only at the pad they land on;
 * its members are tinted on the face, hovering any
 * braid lights and lists the whole twist, clicking one selects its landing.
 */

import { parseTerminalKey, terminalKey } from '@wirehub/model';
import { conductorPaint } from '@wirehub/render-svg';
import { IconTarget } from '@tabler/icons-react';
import { Handle, NodeToolbar, Position } from '@xyflow/react';
import { useId, useMemo, type JSX, type MouseEvent } from 'react';

import { classes, useEditorApi } from '../context.ts';
import type { BreakoutPort, Pigtail, PortStub } from '../breakout.ts';
import { useHoveredPort, useHoverStore } from '../hover.ts';
import type { SegmentNodeData, TerminalRow } from '../derive.ts';
import { estimateNodeSize, wireHeadMeta } from '../layout-size.ts';
import {
  WIRE_LAYOUT,
  type WireArt,
  type WireCoreArt,
  type WireFaceArt,
  type WireHandleArt,
  type WireRingArt,
} from '../wire-art.ts';

const OUTLINED = new Set(['white', 'black']);

/** A conductor's domain colour: the token when there is one, render-svg's paint otherwise. */
export function conductorFill(colorName: string | undefined): string {
  if (colorName === undefined) return 'var(--copper)';
  const name = colorName.toLowerCase();
  return `var(--cond-${name}, ${conductorPaint(name)})`;
}

const SHIELD_DASH: Record<string, string | undefined> = {
  braid: undefined,
  spiral: '1.6 1.1',
  foil: '2.5 2',
  tape: '2.5 2',
};

type Used = (key: string) => boolean;

/** A face element's bond: `bonded` when it is a member of a pigtail, `lit` when that pigtail is hovered or selected. */
type BondOf = (key: string) => { bonded: boolean; lit: boolean };

const NO_BOND = { bonded: false, lit: false };

function RingShape({
  ring,
  cx,
  cy,
  used,
  keyOf,
  bondOf,
}: {
  ring: WireRingArt;
  cx: number;
  cy: number;
  used: Used;
  keyOf: (path: string) => string;
  bondOf: BondOf;
}): JSX.Element | null {
  const bond = ring.kind === 'insulation' ? NO_BOND : bondOf(keyOf(ring.path));
  switch (ring.kind) {
    case 'insulation':
      return (
        <circle
          className={classes(
            'cs-face-insulation',
            ring.colorName === undefined && 'is-dielectric',
            OUTLINED.has(ring.colorName ?? '') && 'is-outlined',
          )}
          cx={cx}
          cy={cy}
          r={ring.r}
          style={ring.colorName === undefined ? undefined : { fill: conductorFill(ring.colorName) }}
        />
      );
    case 'shield':
      return (
        <circle
          className={classes(
            'cs-face-shield',
            !used(keyOf(ring.path)) && 'is-unused',
            bond.bonded && 'is-bonded',
            bond.lit && 'is-lit',
          )}
          data-element={ring.path}
          cx={cx}
          cy={cy}
          r={(ring.r + ring.rInner) / 2}
          strokeWidth={Math.max(1, ring.r - ring.rInner)}
          strokeDasharray={ring.construction === undefined ? undefined : SHIELD_DASH[ring.construction]}
        />
      );
    case 'conductor': {
      const unused = !used(keyOf(ring.path));
      if (ring.bare === true) {
        return (
          <circle
            className={classes('cs-face-drain', unused && 'is-unused', bond.bonded && 'is-bonded', bond.lit && 'is-lit')}
            data-element={ring.path}
            cx={cx}
            cy={cy}
            r={Math.max(ring.r, WIRE_LAYOUT.minDrain)}
          />
        );
      }
      return (
        <circle
          className={classes(
            'cs-face-conductor',
            OUTLINED.has(ring.colorName ?? '') && 'is-outlined',
            unused && 'is-unused',
          )}
          data-element={ring.path}
          cx={cx}
          cy={cy}
          r={Math.max(ring.r, WIRE_LAYOUT.minDot)}
          style={{ fill: conductorFill(ring.colorName) }}
        />
      );
    }
  }
}

function CoreShape({
  core,
  used,
  keyOf,
  bondOf,
}: {
  core: WireCoreArt;
  used: Used;
  keyOf: (path: string) => string;
  bondOf: BondOf;
}): JSX.Element {
  // no joint on any of its elements at this end: a spare
  const spare = core.keys.length > 0 && core.keys.every((key) => !used(key));
  // outermost first, so each ring paints over the one outside it
  const rings = [...core.rings].reverse();
  const drain = core.layIndex === -2;
  const cut = drain && spare;
  const mark = WIRE_LAYOUT.minDrain + 1.2;
  return (
    <g
      className={classes('cs-face-core', spare && !drain && 'is-spare')}
      data-core={core.path}
      data-spare={spare ? 'true' : undefined}
    >
      {rings.map((ring, index) => (
        <RingShape
          key={`${ring.path}#${index}`}
          ring={ring}
          cx={core.x}
          cy={core.y}
          used={used}
          keyOf={keyOf}
          bondOf={bondOf}
        />
      ))}
      {cut ? (
        <path
          className="cs-face-cut"
          data-cut={core.path}
          d={`M${core.x - mark} ${core.y - mark}l${mark * 2} ${mark * 2}M${core.x + mark} ${core.y - mark}l${-mark * 2} ${mark * 2}`}
        />
      ) : null}
    </g>
  );
}

function Face({
  face,
  instanceId,
  used,
  bondOf,
}: {
  face: WireFaceArt;
  instanceId: string;
  used: Used;
  bondOf: BondOf;
}): JSX.Element {
  const keyOf = (path: string): string =>
    terminalKey({ instance: instanceId, terminal: path, end: face.end });
  const shield = face.overallShield;
  const shieldBond = shield === undefined ? NO_BOND : bondOf(keyOf(shield.path));
  return (
    <g className="cs-face" data-end={face.end} data-reading={face.reading} data-rotation={face.rotationDeg}>
      <text className="cs-face-caption" x={face.captionX} y={face.captionY + 9}>
        {face.caption}
      </text>
      {face.outline === undefined ? (
        <circle className="cs-face-jacket" cx={face.cx} cy={face.cy} r={face.jacket.r} />
      ) : (
        // a figure-8: two jacketed legs moulded together, not one round jacket
        <path className="cs-face-jacket is-figure8" d={face.outline} />
      )}
      {shield === undefined ? null : (
        <circle
          className={classes(
            'cs-face-overall',
            !used(keyOf(shield.path)) && 'is-unused',
            shieldBond.bonded && 'is-bonded',
            shieldBond.lit && 'is-lit',
          )}
          data-element={shield.path}
          cx={face.cx}
          cy={face.cy}
          r={(shield.r + shield.rInner) / 2}
          strokeWidth={Math.max(1, Math.min(1.6, shield.r - shield.rInner))}
          strokeDasharray={shield.construction === 'braid' ? undefined : '2.5 2'}
        />
      )}
      {face.cores.map((core) => (
        <CoreShape key={core.path} core={core} used={used} keyOf={keyOf} bondOf={bondOf} />
      ))}
    </g>
  );
}

function JacketRun({ art }: { art: WireArt }): JSX.Element {
  const { run } = art;
  const hatch: string[] = [];
  const lean = 5;
  for (let x = run.x + 6; x + lean < run.x + run.width - 2; x += 9) {
    hatch.push(`M${x} ${run.y + 2}l${lean} ${run.height - 4}`);
  }
  return (
    <g className="cs-wire-run">
      <rect x={run.x - 2} y={run.y} width={run.width + 4} height={run.height} />
      <path d={hatch.join('')} />
    </g>
  );
}

function Stub({ stub, port, lit }: { stub: PortStub; port: BreakoutPort; lit: boolean }): JSX.Element {
  if (port.pigtail !== undefined) return <BraidStub stub={stub} port={port} pigtail={port.pigtail} lit={lit} />;
  const ground = port.kind === 'ground';
  const outlined = !ground && OUTLINED.has(port.colorName ?? '');
  return (
    <g
      className={classes('cs-stub', ground ? 'is-ground' : 'is-conductor', port.selected && 'is-selected')}
      data-stub={stub.key}
      data-lead={stub.key}
    >
      {outlined ? <path className="cs-stub-outline" d={stub.d} /> : null}
      <path
        className="cs-stub-line"
        d={stub.d}
        style={ground ? undefined : { stroke: conductorFill(port.colorName) }}
      />
    </g>
  );
}

/**
 * One braid of a ground pigtail, from its element on the face to its own
 * port — every braid of the twist runs on its own and they converge at the
 * pad. Hovering any braid lights the whole twist (the
 * pigtail's terminal key is the hover id they share); clicking selects its
 * landing joint.
 */
function BraidStub({
  stub,
  port,
  pigtail,
  lit,
}: {
  stub: PortStub;
  port: BreakoutPort;
  pigtail: Pigtail;
  lit: boolean;
}): JSX.Element {
  const { dispatch } = useEditorApi();
  const hover = useHoverStore();
  const select = (event: MouseEvent): void => {
    event.stopPropagation();
    const [index] = port.joints;
    if (index === undefined) return;
    dispatch({
      type: 'select',
      selection: port.joints.length === 1 ? { kind: 'joint', index } : { kind: 'joints', indices: port.joints },
    });
  };
  return (
    <g
      className={classes('cs-pigtail', port.selected && 'is-selected', lit && 'is-lit')}
      data-pigtail={pigtail.key}
      data-pigtail-id={pigtail.id}
      data-braid={stub.key}
      data-lead={stub.key}
      data-end={port.end}
      data-members={pigtail.members.length}
    >
      <path className="cs-pigtail-core" d={stub.d} />
      <path className="cs-pigtail-braid" d={stub.d} />
      <path
        className="cs-pigtail-hit"
        d={stub.d}
        onMouseEnter={() => hover.set(pigtail.key)}
        onMouseLeave={() => hover.set(undefined)}
        onClick={select}
      />
    </g>
  );
}

/**
 * The stubs' last stretch, over the face: each stub runs
 * beneath the face from its element to its port, so on its own it stops at the
 * jacket's edge. Here the same path is drawn again, clipped to the jacket, as
 * a thin line in the conductor's colour over the cutaway — from the jacket's
 * edge into the very core (a braid: its own screen ring), so every edge reads
 * all the way from the pad or pin into the cable.
 */
function FaceLeads({
  faces,
  ports,
  clipId,
  hovered,
}: {
  faces: readonly WireFaceArt[];
  ports: readonly BreakoutPort[];
  clipId: string;
  hovered: string | undefined;
}): JSX.Element | null {
  if (ports.length === 0) return null;
  return (
    <g className="cs-face-leads">
      <defs>
        {faces.map((face) => (
          <clipPath key={face.end} id={`${clipId}-${face.end}`}>
            <circle cx={face.cx} cy={face.cy} r={face.jacket.r} />
          </clipPath>
        ))}
      </defs>
      {faces.map((face) => (
        <g key={face.end} clipPath={`url(#${clipId}-${face.end})`}>
          {ports
            .filter((port) => port.end === face.end)
            .flatMap((port) =>
              port.stubs.map((stub) => {
                const braid = port.pigtail !== undefined;
                const ground = port.kind === 'ground';
                const lit = braid && port.pigtail?.key === hovered;
                return (
                  <g
                    key={`${port.id}|${stub.key}`}
                    className={classes(
                      'cs-lead',
                      braid ? 'is-braid' : ground ? 'is-ground' : 'is-conductor',
                      (port.selected || lit) && 'is-selected',
                    )}
                    data-lead={stub.key}
                  >
                    {!ground && OUTLINED.has(port.colorName ?? '') ? <path className="cs-lead-outline" d={stub.d} /> : null}
                    <path
                      className="cs-lead-line"
                      d={stub.d}
                      style={ground ? undefined : { stroke: conductorFill(port.colorName) }}
                    />
                  </g>
                );
              }),
            )}
        </g>
      ))}
    </g>
  );
}

/** What a hovered pigtail bonds: its members and the pad they land on. */
function PigtailTip({ port }: { port: BreakoutPort }): JSX.Element {
  // above the node (whose box clips), at the side of the end it leaves
  return (
    <NodeToolbar
      isVisible
      position={Position.Top}
      align={port.facing === 'left' ? 'start' : 'end'}
      offset={6}
      className="cs-pigtail-tip"
      role="tooltip"
      data-pigtail-tip={port.pigtail?.key ?? port.id}
    >
      <div className="cs-pigtail-tip-head">
        {port.pigtail === undefined
          ? `${port.target} ×${port.members.length}`
          : `${port.pigtail.id} → ${port.pigtail.landing} ×${port.pigtail.members.length}`}
      </div>
      <ul>
        {(port.pigtail?.members ?? port.members).map((member) => (
          <li key={member.key} data-member={member.key}>
            {member.label !== undefined && /^shields · /.test(member.label) ? member.label : member.terminal}
          </li>
        ))}
      </ul>
    </NodeToolbar>
  );
}

function PortHandle({ port }: { port: BreakoutPort }): JSX.Element {
  const members = port.members.map((member) => member.terminal).join(', ');
  return (
    <Handle
      type="source"
      position={port.facing === 'right' ? Position.Right : Position.Left}
      id={port.id}
      isConnectable={false}
      className={classes('cs-port-handle', `is-${port.kind}`, port.selected && 'is-selected')}
      style={{ left: port.x, top: port.y }}
      data-port={port.id}
      data-end={port.end}
      title={`${members} @${port.end}`}
    />
  );
}

function handleTitle(handle: WireHandleArt, row: TerminalRow | undefined): string {
  const label = row?.label === undefined ? '' : ` — ${row.label}`;
  return `${handle.terminal} @${handle.end}${label}`;
}

function ElementHandle({
  handle,
  row,
  nodeSelected,
}: {
  handle: WireHandleArt;
  row: TerminalRow | undefined;
  nodeSelected: boolean;
}): JSX.Element {
  const { dispatch, openPicker } = useEditorApi();
  const select = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'terminal', ref: parseTerminalKey(handle.id) } });
  };
  const free = row?.used !== true;
  return (
    <>
      <Handle
        type="source"
        position={handle.facing === 'right' ? Position.Right : Position.Left}
        id={handle.id}
        className={classes(
          'cs-wire-handle',
          `is-${handle.role}`,
          row?.used === true && 'is-used',
          row?.onSelectedNet === true && 'is-on-net',
          row?.selected === true && 'is-selected',
        )}
        style={{ left: handle.x, top: handle.y }}
        data-terminal={handle.id}
        data-end={handle.end}
        title={handleTitle(handle, row)}
        onClick={select}
      />
      {!free ? null : (
        <button
          type="button"
          className={classes(
            'cs-handle-add',
            handle.facing === 'right' ? 'is-right' : 'is-left',
            nodeSelected && 'is-node-selected',
          )}
          style={{ left: handle.x, top: handle.y }}
          title={`add a part at ${handle.id}`}
          aria-label={`add a part at ${handle.id}`}
          onClick={(event) => {
            event.stopPropagation();
            openPicker(parseTerminalKey(handle.id));
          }}
        >
          +
        </button>
      )}
    </>
  );
}

export function WireArtNode({
  data,
  art,
  selected,
}: {
  data: SegmentNodeData;
  art: WireArt;
  selected: boolean;
}): JSX.Element {
  const { dispatch } = useEditorApi();
  const size = estimateNodeSize(data);
  const rows = useMemo(() => {
    const map = new Map<string, TerminalRow>();
    for (const element of data.elements) {
      map.set(element.a.key, element.a);
      map.set(element.b.key, element.b);
    }
    return map;
  }, [data.elements]);
  const used: Used = (key) => rows.get(key)?.used === true;
  const meta = wireHeadMeta(data);
  const ports = useMemo(
    () => (data.breakout?.ends ?? []).flatMap((end) => end.ports),
    [data.breakout],
  );
  // ground members → the pigtail that bonds them (its terminal key is the
  // hover id every one of its braids shares)
  const pigtails = useMemo(() => {
    const byMember = new Map<string, BreakoutPort>();
    const ids = new Set<string>();
    for (const port of ports) {
      if (port.pigtail === undefined) continue;
      ids.add(port.pigtail.key);
      for (const member of port.members) byMember.set(member.key, port);
    }
    return { byMember, ids };
  }, [ports]);
  const hovered = useHoveredPort(pigtails.ids);
  // a pigtail's members light while it is hovered or selected
  const bondOf: BondOf = (key) => {
    const port = pigtails.byMember.get(key);
    return port === undefined ? NO_BOND : { bonded: true, lit: port.pigtail?.key === hovered || port.selected };
  };
  const hoveredPort = hovered === undefined ? undefined : ports.find((port) => port.pigtail?.key === hovered);
  const select = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'instance', id: data.instanceId } });
  };
  const titleText = [data.title, data.subtitle, data.role].filter((part) => part !== undefined && part !== '').join(' · ');
  const clipId = `cs-jacket-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div
      className={classes('cs-node', 'cs-node-segment', 'cs-wire-node', selected && 'is-selected')}
      style={{ width: size.width, height: size.height }}
      data-wire={art.wire}
      data-rotation-a={data.breakout?.rotation.a}
      data-rotation-b={data.breakout?.rotation.b}
      data-flipped={art.flipped ? 'true' : undefined}
      onClick={select}
    >
      <header className="cs-node-head cs-art-head" title={`drag ${data.instanceId} by this bar to move it`}>
        <span className="cs-art-chip cs-wire-chip" aria-hidden="true">
          <IconTarget size={12} stroke={1.8} />
        </span>
        <span className="cs-instance">{data.instanceId}</span>
        <span className="cs-title" title={titleText}>
          {data.title}
        </span>
        {meta === '' ? null : <span className="cs-meta">{meta}</span>}
      </header>
      <div className="cs-wire-art" style={{ width: art.width, height: art.height }}>
        <svg
          className="cs-wire-svg"
          width={art.width}
          height={art.height}
          viewBox={`0 0 ${art.width} ${art.height}`}
          aria-hidden="true"
        >
          <g className="cs-stubs">
            {ports.flatMap((port) =>
              port.stubs.map((stub) => (
                <Stub
                  key={`${port.id}|${stub.key}`}
                  stub={stub}
                  port={port}
                  lit={port.pigtail !== undefined && port.pigtail.key === hovered}
                />
              )),
            )}
          </g>
          <JacketRun art={art} />
          {art.faces.map((face) => (
            <Face key={face.end} face={face} instanceId={data.instanceId} used={used} bondOf={bondOf} />
          ))}
          <FaceLeads faces={art.faces} ports={ports} clipId={clipId} hovered={hovered} />
          <text className="cs-wire-label" x={art.labelX} y={art.labelY + 10}>
            {art.label}
          </text>
        </svg>
        {art.handles.map((handle) => (
          <ElementHandle key={handle.id} handle={handle} row={rows.get(handle.id)} nodeSelected={selected} />
        ))}
        {ports.map((port) => (
          <PortHandle key={port.id} port={port} />
        ))}
        {hoveredPort?.pigtail === undefined ? null : <PigtailTip port={hoveredPort} />}
      </div>
    </div>
  );
}
