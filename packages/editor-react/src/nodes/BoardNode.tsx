/**
 * A PCBA drawn as the real board: both faces stacked, top over bottom, each
 * turned so its cable edge faces the wire, with a handle on every pad.
 *
 * All geometry comes from `board-art.ts` via the node data — this component
 * only paints it. Each face is the depiction's own SVG, inlined through
 * render-svg's inliner with an id prefix per instance and side, so two copies
 * of one board keep separate masks and clip paths. The board keeps its
 * fabrication colours in both themes; only the chrome uses tokens.
 */

import { parseTerminalKey } from '@cable-studio/model';
import { inlineVectorAsset } from '@cable-studio/render-svg';
import { IconCpu } from '@tabler/icons-react';
import { Handle, Position } from '@xyflow/react';
import { useMemo, type JSX, type MouseEvent } from 'react';

import {
  boardIdPrefix,
  stripSvgCaptions,
  type BoardArt,
  type BoardHandleArt,
  type BoardPartArt,
  type BoardPartDetail,
  type BoardViewArt,
} from '../board-art.ts';
import { CONNECTOR_LAYOUT, dockCaption } from '../connector-art.ts';
import { classes, useEditorApi } from '../context.ts';
import type { IntegratedArt, PcbaNodeData, TerminalRow } from '../derive.ts';
import { ConnectorDrawing } from './ConnectorNode.tsx';
import { BridgeBusOverlay } from './BridgeBus.tsx';
import { boardHeadMeta, estimateNodeSize } from '../layout-size.ts';

const SIDE_CAPTION = { top: 'TOP', bottom: 'BOTTOM' } as const;

/**
 * A part's real top-down body — chip/MLCC/tantalum/
 * electrolytic/IC/diode shapes, or a bridged/open solder jumper — or nothing
 * for an unrecognised package / an unset jumper, in which case the caller's
 * plain outlined box is what draws.
 */
function PartDetail({ detail }: { detail: BoardPartDetail }): JSX.Element {
  switch (detail.shape) {
    case 'polygon':
      return <polygon className={`cs-pt-${detail.tone}`} points={detail.points} />;
    case 'circle':
      return <circle className={`cs-pt-${detail.tone}`} cx={detail.cx} cy={detail.cy} r={detail.r} />;
    case 'text':
      return (
        <text className={`cs-pt-${detail.tone}`} x={detail.cx} y={detail.cy}>
          {detail.value}
        </text>
      );
    case 'multi':
      return <path className={`cs-pt-${detail.tone}`} d={detail.d} />;
  }
}

/**
 * The build's mounted parts over one face: a real
 * top-down body per part (y1u.18) — or, for a part the importer did not
 * classify, a translucent body in the component tone, so the copper, pads
 * and handles stay visible through it; solder jumpers as bridged / open /
 * unset; and, with `labels`, the ref and value. The card thumbnail (Parts
 * detail) draws bodies only.
 */
export function BoardParts({ parts, labels }: { parts: readonly BoardPartArt[]; labels: boolean }): JSX.Element | null {
  if (parts.length === 0) return null;
  return (
    <g className="cs-board-parts">
      {parts.map((part) => (
        <g
          key={part.ref}
          className={classes('cs-board-part', `is-${part.kind}`, `is-${part.state}`)}
          data-ref={part.ref}
          data-state={part.state}
        >
          <title>{part.title}</title>
          {part.detail.length > 0 ? (
            part.detail.map((detail, i) => <PartDetail key={i} detail={detail} />)
          ) : (
            <polygon className="cs-board-part-box" points={part.points} />
          )}
          {part.pin1 === undefined ? null : <circle className="cs-board-part-pin1" cx={part.pin1.x} cy={part.pin1.y} r={1.4} />}
        </g>
      ))}
      {!labels
        ? null
        : parts.map((part) =>
            part.text === undefined ? null : (
              <text
                key={`${part.ref}-label`}
                className={classes('cs-board-part-label', `is-${part.state}`)}
                x={part.text.x}
                y={part.text.y}
              >
                {part.text.value}
              </text>
            ),
          )}
    </g>
  );
}

function BoardFace({ instanceId, view }: { instanceId: string; view: BoardViewArt }): JSX.Element {
  const { partLabelsVisible } = useEditorApi();
  const markup = useMemo(
    () => stripSvgCaptions(inlineVectorAsset(view.source, boardIdPrefix(instanceId, view.side))),
    [view.source, instanceId, view.side],
  );
  return (
    <>
      <span
        className="cs-board-caption"
        style={{ left: view.label.x, top: view.label.y }}
      >
        {SIDE_CAPTION[view.side]}
      </span>
      <svg
        className="cs-board-face"
        data-side={view.side}
        data-rotation={view.rotation}
        width={view.box.width}
        height={view.box.height}
        viewBox={`0 0 ${view.box.width} ${view.box.height}`}
        style={{ left: view.box.x, top: view.box.y }}
        aria-hidden="true"
      >
        <g transform={view.transform} dangerouslySetInnerHTML={{ __html: markup }} />
        <BoardParts parts={view.parts} labels={partLabelsVisible} />
      </svg>
    </>
  );
}

function padTitle(handle: BoardHandleArt, row: TerminalRow | undefined): string {
  const label = row?.label === undefined ? '' : ` — ${row.label}`;
  const pad = handle.ref === undefined ? '' : ` · ${handle.ref}${handle.pad === undefined ? '' : `.${handle.pad}`}`;
  const through = row?.through === undefined ? '' : ' · landed through the carrier hole above it';
  return `${handle.terminal}${label} · ${handle.side}${pad}${through}`;
}

function PadHandle({
  handle,
  row,
  nodeSelected,
}: {
  handle: BoardHandleArt;
  row: TerminalRow | undefined;
  nodeSelected: boolean;
}): JSX.Element {
  const { openPicker } = useEditorApi();
  // only the primary handle of a terminal opens the picker: a secondary pad
  // (GND on both faces) resolves to the same terminal key, and a `+` there
  // would offer to wire the same thing twice
  const free = handle.primary && row?.used !== true;
  return (
    <>
      <Handle
        type="source"
        position={handle.facing === 'right' ? Position.Right : Position.Left}
        id={handle.id}
        className={classes(
          'cs-pad-handle',
          handle.cableSide ? 'is-cable' : 'is-connector',
          !handle.primary && 'is-secondary',
          row?.used === true && 'is-used',
          row?.through !== undefined && 'is-through',
          row?.onSelectedNet === true && 'is-on-net',
          row?.selected === true && 'is-selected',
        )}
        style={{
          left: handle.x,
          top: handle.y,
          // a pad landed through a carrier hole (e5c.37) shows its net's paint
          ...(row?.through === undefined || row.through === '' ? {} : { ['--pad-through' as string]: row.through }),
        }}
        data-terminal={handle.key}
        data-side={handle.side}
        title={padTitle(handle, row)}
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
          title={`add a part at ${handle.key}`}
          aria-label={`add a part at ${handle.key}`}
          onClick={(event) => {
            event.stopPropagation();
            openPicker(parseTerminalKey(handle.key));
          }}
        >
          +
        </button>
      )}
    </>
  );
}

/**
 * A connector the board is sold with, drawn in its dock the way a docked
 * connector node draws itself — its pins' handles stay on the board's pads.
 */
function IntegratedDock({
  item,
  dock,
  rows,
  instanceId,
  facing,
}: {
  item: IntegratedArt;
  dock: BoardArt['docks'][number];
  rows: ReadonlyMap<string, TerminalRow>;
  instanceId: string;
  facing: BoardArt['cableFacing'];
}): JSX.Element {
  const pad = CONNECTOR_LAYOUT.dockPad;
  // a pin the board carries through to the cable is painted its signal's
  // colour, the way a soldered pin of a docked connector is
  const paint = (terminal: string): { used: boolean; color?: string | undefined } | undefined => {
    const row = rows.get(`${instanceId}:${item.prefix}.${terminal}`);
    if (row === undefined) return undefined;
    return { used: row.used || row.color !== undefined, color: row.color };
  };
  return (
    <div
      className="cs-board-dock"
      data-dock={item.id}
      style={{ left: dock.x, top: dock.y, width: dock.width, height: dock.height }}
    >
      <svg
        className="cs-conn-svg"
        width={item.art.width}
        height={item.art.height}
        viewBox={`0 0 ${item.art.width} ${item.art.height}`}
        style={{ left: (dock.width - item.art.width) / 2, top: pad }}
        aria-hidden="true"
      >
        <ConnectorDrawing art={item.art} paint={paint} />
      </svg>
      <span className="cs-dock-caption" style={{ top: pad + item.art.height + 1, width: dock.width }}>
        {dockCaption(item.art)}
      </span>
      <span
        className={classes('cs-dock-mark', facing === 'right' ? 'is-right' : 'is-left')}
        style={{ top: pad + 4, height: Math.max(0, item.art.height - 8) }}
        aria-hidden="true"
      />
    </div>
  );
}

export function BoardArtNode({
  data,
  board,
  selected,
}: {
  data: PcbaNodeData;
  board: BoardArt;
  selected: boolean;
}): JSX.Element {
  const { dispatch } = useEditorApi();
  const size = estimateNodeSize(data);
  const rows = useMemo(() => {
    const map = new Map<string, TerminalRow>();
    for (const row of [...data.pads, ...data.integrated]) map.set(row.key, row);
    return map;
  }, [data.pads, data.integrated]);
  const meta = boardHeadMeta(data);
  // a bridge between two of its own pads draws as the board's ground bus,
  // pad to pad over the artwork, under the handles
  const busPoints = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    for (const handle of board.handles) if (handle.primary && !out.has(handle.key)) out.set(handle.key, { x: handle.x, y: handle.y });
    return out;
  }, [board.handles]);
  const busOptions = useMemo(() => ({ gap: 5, toward: { x: board.width / 2, y: board.height / 2 } }), [board.width, board.height]);
  const select = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'instance', id: data.instanceId } });
  };
  return (
    <div
      className={classes('cs-node', 'cs-node-pcba', 'cs-board-node', selected && 'is-selected')}
      style={{ width: size.width, height: size.height }}
      data-board={board.defId}
      onClick={select}
    >
      <header className="cs-node-head cs-board-head" title={`drag ${data.instanceId} by this bar to move it`}>
        <span className="cs-board-chip" aria-hidden="true">
          <IconCpu size={12} stroke={1.8} />
        </span>
        <span className="cs-instance">{data.instanceId}</span>
        <span className="cs-title" title={[data.title, data.subtitle].filter((part) => part !== '').join(' · ')}>
          {data.title}
        </span>
        {meta === '' ? null : <span className="cs-meta">{meta}</span>}
      </header>
      <div className="cs-board-art" style={{ width: board.width, height: board.height }}>
        {board.views.map((view) => (
          <BoardFace key={view.side} instanceId={data.instanceId} view={view} />
        ))}
        {(data.integratedArt ?? []).map((item) => {
          const dock = board.docks.find((candidate) => candidate.id === item.id);
          return dock === undefined ? null : (
            <IntegratedDock
              key={item.id}
              item={item}
              dock={dock}
              rows={rows}
              instanceId={data.instanceId}
              facing={board.cableFacing}
            />
          );
        })}
        <BridgeBusOverlay
          width={board.width}
          height={board.height}
          points={busPoints}
          bridges={data.bridges}
          options={busOptions}
        />
        {board.handles.map((handle) => (
          <PadHandle key={handle.id} handle={handle} row={rows.get(handle.key)} nodeSelected={selected} />
        ))}
      </div>
    </div>
  );
}
