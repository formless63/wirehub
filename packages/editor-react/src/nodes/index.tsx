/**
 * The node types — the whole reason the authoring canvas is React Flow and not
 * the schematic renderer: a node **looks like the part**, and every terminal
 * the definition declares is an individually-addressable handle.
 *
 *   connector  of a known family: its mating face or side profile, a handle on
 *              every drawn pin (`ConnectorNode.tsx`), docked inside its board
 *              when mounted on one; otherwise pins in definition order, pin
 *              number + label, facing the cable
 *   pcba       with gerber artwork: both faces of the real board, a handle
 *              on every pad (`BoardNode.tsx`); otherwise cable-side pads on
 *              the wire's side, the connector it is sold soldered to opposite,
 *              titled with part number / revision / build
 *   segment    with a documented cut face: both ends as cutaways, a handle
 *              on every element of each (`WireNode.tsx`); otherwise one row
 *              per electrical element (conductor / shield / drain), painted
 *              the conductor's colour, with an `a` and a `b` handle
 *   component  a two-lead part with its value
 */

import { parseTerminalKey } from '@wirehub/model';
import { IconList, IconPlug } from '@tabler/icons-react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps, type NodeTypes, type Node } from '@xyflow/react';
import { useEffect, useMemo, useRef, type CSSProperties, type JSX, type MouseEvent, type ReactNode } from 'react';

import { classes, useEditorApi } from '../context.ts';
import type {
  ComponentNodeData,
  ConnectorNodeData,
  EditorNodeData,
  ElementRow,
  PcbaNodeData,
  SegmentNodeData,
  SubassemblyNodeData,
  TerminalRow,
} from '../derive.ts';
import { estimateNodeSize, nodeHeading } from '../layout-size.ts';
import { BoardArtNode } from './BoardNode.tsx';
import { BridgeBusOverlay } from './BridgeBus.tsx';
import { ConnectorArtNode, ConnectorThumb } from './ConnectorNode.tsx';
import { WireArtNode } from './WireNode.tsx';
import { CardNode } from './CardNode.tsx';
import { PinRow } from './PinRow.tsx';
import type { MouldNodeData } from '../moulds.ts';

interface ShellProps {
  data: EditorNodeData;
  selected: boolean;
  children: ReactNode;
  /** extra header content, after the title (a connector's face thumbnail and toggle) */
  adornment?: ReactNode;
}

/**
 * The frame every node draws in.
 *
 * Its header is the node's `dragHandle` (see `NODE_DRAG_HANDLE`): the one strip
 * of a node that is not a handle or a row, so grabbing a part there always
 * moves it. Its width is `estimateNodeSize`'s, which is the same number
 * `autoLayout` reserved — the drawn box and the placed box are one box.
 */
function NodeShell(props: ShellProps): JSX.Element {
  const { dispatch } = useEditorApi();
  const { data } = props;
  const heading = nodeHeading(data);
  const select = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'instance', id: data.instanceId } });
  };
  return (
    <div
      className={classes(
        'cs-node',
        `cs-node-${heading.badge}`,
        props.selected && 'is-selected',
        data.missingDef && 'is-broken',
      )}
      style={{ width: estimateNodeSize(data).width }}
      onClick={select}
    >
      <header className="cs-node-head" title={`drag ${data.instanceId} by this bar to move it`}>
        <span className="cs-badge">{heading.badge}</span>
        <span className="cs-instance">{data.instanceId}</span>
        <span className="cs-title" title={heading.title}>
          {heading.title}
        </span>
        <span className="cs-subtitle">{heading.subtitle}</span>
        {heading.meta === undefined ? null : <span className="cs-meta">{heading.meta}</span>}
        {props.adornment}
      </header>
      <div className="cs-node-body">{props.children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Connector
 * ------------------------------------------------------------------ */

export function ConnectorNode({
  id,
  data,
  selected,
}: NodeProps<Node<ConnectorNodeData, 'connector'>>): JSX.Element {
  const { dispatch } = useEditorApi();
  const face = data.face === true;
  const updateInternals = useUpdateNodeInternals();
  // the node changes size and its handles move when the face toggles: tell React Flow once it has painted
  const shown = useRef(face);
  useEffect(() => {
    if (shown.current === face) return;
    shown.current = face;
    updateInternals(id);
  }, [face, id, updateInternals]);
  // docked on a board or housed in a mould: the drawing is the node (no header, no list)
  if (data.art !== undefined && data.dock !== undefined) {
    return <ConnectorArtNode data={data} layout={data.art} selected={selected === true} />;
  }
  // the face view: the drawing with its pins as targets, on request only
  if (data.art !== undefined && face) {
    return (
      <div className="cs-conn-faceview">
        <ConnectorArtNode data={data} layout={data.art} selected={selected === true} />
        <button
          type="button"
          className="cs-conn-face-toggle is-on"
          aria-pressed="true"
          title="Back to the pin list"
          aria-label={`${data.instanceId} pin list`}
          onClick={() => dispatch({ type: 'set-face', id: data.instanceId, on: false })}
        >
          <IconList size={12} />
        </button>
      </div>
    );
  }
  // every connector is its pin list: number, name, direction, with a 16 px handle each
  return (
    <NodeShell
      data={data}
      selected={selected === true}
      adornment={
        data.art === undefined ? null : (
          <span className="cs-conn-adorn">
            <ConnectorThumb art={data.art.art} />
            <button
              type="button"
              className="cs-conn-face-toggle nodrag"
              aria-pressed="false"
              title="Show the face"
              aria-label={`${data.instanceId} face`}
              onClick={(event) => {
                event.stopPropagation();
                dispatch({ type: 'set-face', id: data.instanceId, on: true });
              }}
            >
              <IconPlug size={12} />
            </button>
          </span>
        )
      }
    >
      <div className="cs-pins">
        <PinListBus rows={data.rows} bridges={data.bridges} width={estimateNodeSize(data).width} />
        {data.rows.map((row) => (
          <PinRow key={row.key} row={row} nodeSelected={selected === true} />
        ))}
      </div>
    </NodeShell>
  );
}

/** A pin row's height (`.cs-row` in `editor.css`). */
const PIN_ROW = 19;

/**
 * A pin list's ground bus: a faint rail just inside
 * the handle side, a stub to each bridged row — under the rows' text.
 */
function PinListBus({
  rows,
  bridges,
  width,
}: {
  rows: readonly TerminalRow[];
  bridges: ConnectorNodeData['bridges'];
  width: number;
}): JSX.Element | null {
  const points = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    rows.forEach((row, index) => out.set(row.key, { x: row.side === 'left' ? 4 : width - 4, y: index * PIN_ROW + PIN_ROW / 2 }));
    return out;
  }, [rows, width]);
  const options = useMemo(() => ({ gap: 5, toward: { x: width / 2, y: 0 } }), [width]);
  if (bridges === undefined || bridges.length === 0) return null;
  return <BridgeBusOverlay width={width} height={rows.length * PIN_ROW} points={points} bridges={bridges} options={options} />;
}

/* ------------------------------------------------------------------ *
 * PCBA
 * ------------------------------------------------------------------ */

export function PcbaNode({
  data,
  selected,
}: NodeProps<Node<PcbaNodeData, 'pcba'>>): JSX.Element {
  // a board with gerber artwork draws as itself; everything else keeps the
  // pin list (see `BoardArtNode` and `board-art.ts`)
  if (data.board !== undefined) {
    return <BoardArtNode data={data} board={data.board} selected={selected === true} />;
  }
  return (
    <NodeShell data={data} selected={selected === true}>
      <div className="cs-board">
        {data.cableFacing === 'right' ? (
          <>
            <IntegratedColumn rows={data.integrated} nodeSelected={selected === true} />
            <PadColumn rows={data.pads} nodeSelected={selected === true} />
          </>
        ) : (
          <>
            <PadColumn rows={data.pads} nodeSelected={selected === true} />
            <IntegratedColumn rows={data.integrated} nodeSelected={selected === true} />
          </>
        )}
      </div>
    </NodeShell>
  );
}

/** The cable-side pads: the column on the wire's side of the node. */
function PadColumn({ rows, nodeSelected }: { rows: TerminalRow[]; nodeSelected: boolean }): JSX.Element {
  return (
    <div className="cs-board-side">
      <div className="cs-side-label">cable side</div>
      {rows.map((row) => (
        <PinRow key={row.key} row={row} nodeSelected={nodeSelected} />
      ))}
    </div>
  );
}

function IntegratedColumn({ rows, nodeSelected }: { rows: TerminalRow[]; nodeSelected: boolean }): JSX.Element {
  return (
    <div className="cs-board-side">
      <div className="cs-side-label">integrated connector</div>
      {rows.map((row) => (
        <PinRow key={row.key} row={row} nodeSelected={nodeSelected} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Wire segment
 * ------------------------------------------------------------------ */

function WireEndpoint({
  row,
  role,
  color,
  side,
  nodeSelected,
}: {
  row: TerminalRow;
  role: ElementRow['role'];
  color: string | undefined;
  side: 'left' | 'right';
  nodeSelected: boolean;
}): JSX.Element {
  const { dispatch, openPicker } = useEditorApi();
  const select = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatch({
      type: 'select',
      selection: { kind: 'terminal', ref: parseTerminalKey(row.key) },
    });
  };
  const add = (event: MouseEvent): void => {
    event.stopPropagation();
    openPicker(parseTerminalKey(row.key));
  };
  const handle = (
    <Handle
      type="source"
      position={side === 'left' ? Position.Left : Position.Right}
      id={row.key}
      className={classes('cs-handle', `cs-handle-${role}`)}
      style={{ '--handle-fill': color ?? 'var(--foil)' } as CSSProperties}
    />
  );
  return (
    <span className={classes('cs-endpoint', row.used && 'is-used')} onClick={select}>
      {side === 'left' ? handle : null}
      {row.end}
      {side === 'right' ? handle : null}
      {row.used ? null : (
        <button
          type="button"
          className={classes('cs-handle-add', nodeSelected && 'is-node-selected')}
          title={`add a part at ${row.key}`}
          aria-label={`add a part at ${row.key}`}
          onClick={add}
        >
          +
        </button>
      )}
    </span>
  );
}

/** One element: its two ends' handles either side — `a` left, unless the node is flipped. */
function WireElementRow({
  element,
  flipped,
  nodeSelected,
}: {
  element: ElementRow;
  flipped: boolean;
  nodeSelected: boolean;
}): JSX.Element {
  const highlighted = element.a.onSelectedNet || element.b.onSelectedNet;
  const selected = element.a.selected || element.b.selected;
  const [left, right] = flipped ? [element.b, element.a] : [element.a, element.b];
  return (
    <div
      className={classes(
        'cs-element',
        `cs-element-${element.role}`,
        highlighted && 'is-on-net',
        selected && 'is-selected',
      )}
      title={`${element.path}${element.label === undefined ? '' : ` — ${element.label}`}`}
    >
      <WireEndpoint row={left} role={element.role} color={element.color} side="left" nodeSelected={nodeSelected} />
      <span className="cs-conductor" style={{ background: element.color ?? 'var(--foil)' }} />
      <span className="cs-element-name">{element.path}</span>
      <WireEndpoint row={right} role={element.role} color={element.color} side="right" nodeSelected={nodeSelected} />
    </div>
  );
}

export function WireNode({
  data,
  selected,
}: NodeProps<Node<SegmentNodeData, 'segment'>>): JSX.Element {
  // a stock with a documented cut face draws both ends; everything else keeps
  // the element rows (see `WireArtNode` and `wire-art.ts`)
  if (data.wire !== undefined) {
    return <WireArtNode data={data} art={data.wire} selected={selected === true} />;
  }
  return (
    <NodeShell data={data} selected={selected === true}>
      <div className="cs-elements">
        {data.elements.map((element) => (
          <WireElementRow
            key={element.path}
            element={element}
            flipped={data.flipped === true}
            nodeSelected={selected === true}
          />
        ))}
      </div>
    </NodeShell>
  );
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function ComponentNode({
  data,
  selected,
}: NodeProps<Node<ComponentNodeData, 'component'>>): JSX.Element {
  return (
    <NodeShell data={data} selected={selected === true}>
      <div className={classes('cs-part', `cs-part-${data.componentKind}`)}>
        {data.rows.map((row) => (
          <PinRow key={row.key} row={row} nodeSelected={selected === true} />
        ))}
      </div>
    </NodeShell>
  );
}

/* ------------------------------------------------------------------ *
 * Breakout mould
 * ------------------------------------------------------------------ */

/**
 * A breakout mould: a compact block, one row per conductor of the trunk end
 * that enters it. A pass-through runs straight across (in on the left, out on
 * the right, the same colour all the way); a terminated one stops on a solder
 * dot inside — its joints leave from the right; an NC one is cut back and
 * says why. The leg ends' own spare cores are listed underneath.
 */
export function MouldNode({ data, selected }: NodeProps<Node<MouldNodeData, 'breakout'>>): JSX.Element {
  return (
    <NodeShell data={data} selected={selected === true}>
      <div className="cs-mould">
        {data.rows.map((row) => (
          <div
            key={row.key}
            className={classes('cs-mould-row', `is-${row.fate}`, `cs-mould-${row.role}`)}
            title={`${row.key} — ${row.fate === 'nc' ? `NC${row.reason === undefined ? '' : `: ${row.reason}`}` : row.fate}${row.detail === undefined ? '' : ` ${row.detail}`}`}
            data-terminal={row.key}
            style={row.color === undefined ? undefined : ({ '--run': row.color } as CSSProperties)}
          >
            {row.inHandle === undefined ? null : (
              <Handle type="source" position={Position.Left} id={row.inHandle} className="cs-handle cs-mould-handle" isConnectable={false} />
            )}
            <span className="cs-mould-run" aria-hidden="true" />
            {row.fate === 'terminated' && row.role !== 'pigtail' ? <span className="cs-mould-dot" aria-hidden="true" /> : null}
            <span className="cs-mould-label">{row.label}</span>
            <span className="cs-mould-fate">{row.fate === 'nc' ? 'NC' : row.fate === 'through' ? (row.detail ?? '') : (row.detail ?? '')}</span>
            {row.outHandle === undefined ? null : (
              <Handle type="source" position={Position.Right} id={row.outHandle} className="cs-handle cs-mould-handle" isConnectable={false} />
            )}
          </div>
        ))}
        {data.legNotes.map((note) => (
          <div key={note} className="cs-mould-note" title={note}>
            {note}
          </div>
        ))}
      </div>
    </NodeShell>
  );
}

/* ------------------------------------------------------------------ *
 * Sub-assembly
 * ------------------------------------------------------------------ */

/**
 * Another design placed as a part: a block with its free ends as rows —
 * its connectors' pins and its flying leads, a heading per end. Double-click
 * opens the design in its own editor (when the host can).
 */
export function SubassemblyNode({ data, selected }: NodeProps<Node<SubassemblyNodeData, 'subassembly'>>): JSX.Element {
  const { openDesign } = useEditorApi();
  return (
    <div onDoubleClick={openDesign === undefined ? undefined : () => openDesign(data.def)}>
      <NodeShell data={data} selected={selected === true}>
        <div className="cs-subassembly-ports">
          {data.groups.map((group) => (
            <div key={`${group.start}:${group.label}`} className="cs-subassembly-group">
              <div className="cs-side-label" title={group.label}>
                {group.label}
              </div>
              {data.rows.slice(group.start, group.start + group.count).map((row) => (
                <PinRow key={row.key} row={row} nodeSelected={selected === true} />
              ))}
            </div>
          ))}
        </div>
      </NodeShell>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export const nodeTypes = {
  connector: ConnectorNode,
  pcba: PcbaNode,
  segment: WireNode,
  component: ComponentNode,
  card: CardNode,
  breakout: MouldNode,
  subassembly: SubassemblyNode,
} as unknown as NodeTypes;
