/**
 * A connector drawn as itself: its mating face or side profile, with a handle
 * on every drawn pin (faces) or solder lug (profiles).
 *
 * All geometry comes from `connector-art.ts` via the node data — this module
 * only paints it, in theme tokens. A pin the design solders to is painted the
 * colour its signal reaches the cable in (`derive.ts`'s `pinColours`); an
 * RCA's or TRS's band takes its tip's.
 *
 * Docked (`data.dock`): the node sits inside its board's node, against the
 * edge away from the wire, with no header — the drawing, a caption and a dock
 * mark on the board side. Its joints to the board draw no edge.
 */

import { parseTerminalKey } from '@wirehub/model';
import { IconPlug } from '@tabler/icons-react';
import { Handle, Position } from '@xyflow/react';
import { useMemo, type JSX, type MouseEvent, type ReactNode } from 'react';

import type { Facing } from '../board-art.ts';
import { dockCaption, type ArtShape, type ConnectorArt, type ConnectorPinArt } from '../connector-art.ts';
import { classes, useEditorApi } from '../context.ts';
import { BridgeBusPaths } from './BridgeBus.tsx';
import { GROUND_CSS, type ConnectorNodeData, type TerminalRow } from '../derive.ts';
import { BOX, estimateNodeSize } from '../layout-size.ts';

/** What the drawing needs to know about one pin. */
export interface PinPaint {
  used: boolean;
  color?: string | undefined;
}

function Shape({ shape, band }: { shape: ArtShape; band: (terminal: string) => string | undefined }): JSX.Element {
  const className = `cs-art-t-${shape.tone}`;
  switch (shape.el) {
    case 'path':
      return <path className={className} d={shape.d} />;
    case 'circle':
      return <circle className={className} cx={shape.cx} cy={shape.cy} r={shape.r} />;
    case 'rect': {
      const fill = shape.band === undefined ? undefined : band(shape.band);
      return (
        <rect
          className={className}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.rx}
          style={fill === undefined ? undefined : { fill }}
        />
      );
    }
  }
}

function PinShape({ pin, paint }: { pin: ConnectorPinArt; paint: PinPaint | undefined }): JSX.Element | null {
  const used = paint?.used === true;
  const color = used ? (paint?.color ?? 'var(--copper)') : undefined;
  const className = classes('cs-art-pin', `is-${pin.form}`, used && 'is-used');
  switch (pin.form) {
    case 'pin':
      return <circle className={className} cx={pin.x} cy={pin.y} r={pin.r ?? 2.5} style={color === undefined ? undefined : { fill: color }} />;
    case 'socket':
      return (
        <circle className={className} cx={pin.x} cy={pin.y} r={pin.r ?? 2.5} style={color === undefined ? undefined : { stroke: color }} />
      );
    case 'lug':
      return (
        <circle className={className} cx={pin.x} cy={pin.y} r={pin.r ?? 2.5} style={color === undefined ? undefined : { fill: color }} />
      );
    case 'blade':
    case 'finger': {
      const w = pin.width ?? 4;
      const h = pin.height ?? 2;
      return (
        <rect
          className={className}
          x={pin.x - w / 2}
          y={pin.y - h / 2}
          width={w}
          height={h}
          rx={Math.min(w, h) * 0.2}
          style={color === undefined ? undefined : { fill: color }}
        />
      );
    }
    case 'shell':
      return used ? <circle className={className} cx={pin.x} cy={pin.y} r={2.4} style={{ fill: color }} /> : null;
  }
}

/** One wired pin's lead: from the card's edge, where its edge disappears under the part, to the pin. */
export interface PinLead {
  /** the pin's terminal key */
  key: string;
  /** SVG path, art coordinates */
  d: string;
  color?: string | undefined;
  ground: boolean;
  /** no colour: the pin's net reaches no conductor, or is ambiguous */
  plain: boolean;
  onNet: boolean;
  selected: boolean;
}

/**
 * Every wired pin's lead. An edge to a pin runs level
 * with the pin from the card's edge (`breakout.ts` `anchorOf`: the entry
 * column at the pin's own height), and the card is drawn over it so it cannot
 * be mistaken for a wire across the other pins. This draws that last stretch
 * again, thin, *between* the face and its pins: a pin it passes is painted
 * over it, and it ends on its own pin — so each edge reads right into the pin
 * it lands on. `edgeX` is the card edge in art coordinates. On a fanned
 * face (`fan`) the lead runs level with the pin's own
 * exit slot instead, then straight from the slot to the pin, exactly the
 * route its edge takes (`breakout.ts` `anchorOf`'s `slot`).
 */
export function pinLeads(
  art: ConnectorArt,
  rows: readonly TerminalRow[],
  edgeX: number,
  fan?: Readonly<Record<string, { x: number; y: number }>>,
): PinLead[] {
  const pins = new Map(art.pins.map((pin) => [pin.terminal, pin]));
  const r = (value: number): number => Math.round(value * 100) / 100;
  return rows.flatMap((row) => {
    const pin = pins.get(row.terminal);
    // a pin soldered only by the part's own bridges has no edge to lead in:
    // its ground bus reaches it instead
    if (pin === undefined || !row.used || row.bridgedOnly === true || pin.form === 'shell') return [];
    return [
      {
        key: row.key,
        // on a fanned face (e5c.35): level with its own exit slot from the
        // card's edge to the fan column, then straight to the pin
        d:
          fan?.[row.terminal] === undefined
            ? `M${r(edgeX)} ${pin.y} H${pin.x}`
            : `M${r(edgeX)} ${fan[row.terminal]!.y} H${fan[row.terminal]!.x} L${pin.x} ${pin.y}`,
        color: row.color,
        // a pin on no conductor's net (or an ambiguous one) draws plain
        // grey, like the edge leaving it — not as ground (e5c.35)
        ground: row.color === GROUND_CSS,
        plain: row.color === undefined,
        onNet: row.onSelectedNet,
        selected: row.selected,
      },
    ];
  });
}

/**
 * The drawing itself — shapes, the ground bus, leads, pins, numbers — in art
 * coordinates. `bus` is drawn over the body but under
 * everything that says where a signal goes.
 */
export function ConnectorDrawing({
  art,
  paint,
  bus,
  leads = [],
}: {
  art: ConnectorArt;
  paint: (terminal: string) => PinPaint | undefined;
  bus?: ReactNode;
  /** the edges' last stretch, over the card to each wired pin (e5c.30) */
  leads?: readonly PinLead[];
}): JSX.Element {
  const band = (terminal: string): string | undefined => paint(terminal)?.color;
  return (
    <g className="cs-art-drawing" data-view={art.view}>
      {art.shapes.map((shape, index) => (
        <Shape key={index} shape={shape} band={band} />
      ))}
      {bus}
      {leads.length === 0 ? null : (
        <g className="cs-pin-leads">
          {leads.map((lead) => (
            <g
              key={lead.key}
              className={classes('cs-lead', 'is-pin', lead.ground && 'is-ground', lead.plain && 'is-plain', lead.onNet && 'is-on-net', lead.selected && 'is-selected')}
              data-lead={lead.key}
            >
              <path className="cs-lead-outline" d={lead.d} />
              <path className="cs-lead-line" d={lead.d} style={lead.color === undefined ? undefined : { stroke: lead.color }} />
            </g>
          ))}
        </g>
      )}
      {art.pins.map((pin) => (
        <PinShape key={pin.terminal} pin={pin} paint={paint(pin.terminal)} />
      ))}
      {art.labels.map((label) => (
        <text key={`${label.text}@${label.x},${label.y}`} className="cs-art-num" x={label.x} y={label.y} textAnchor={label.anchor}>
          {label.text}
        </text>
      ))}
    </g>
  );
}

function PinHandle({
  pin,
  row,
  facing,
  x,
  y,
  nodeSelected,
}: {
  pin: ConnectorPinArt;
  row: TerminalRow;
  facing: Facing;
  x: number;
  y: number;
  nodeSelected: boolean;
}): JSX.Element {
  const { dispatch, openPicker } = useEditorApi();
  const select = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'terminal', ref: parseTerminalKey(row.key) } });
  };
  return (
    <>
      <Handle
        type="source"
        position={facing === 'right' ? Position.Right : Position.Left}
        id={row.key}
        className={classes(
          'cs-pin-handle',
          `is-${pin.form}`,
          row.used && 'is-used',
          row.onSelectedNet && 'is-on-net',
          row.selected && 'is-selected',
        )}
        style={{ left: x, top: y }}
        data-terminal={row.key}
        title={`${row.terminal}${row.label === undefined ? '' : ` — ${row.label}`}`}
        onClick={select}
      />
      {row.used ? null : (
        <button
          type="button"
          className={classes(
            'cs-handle-add',
            facing === 'right' ? 'is-right' : 'is-left',
            nodeSelected && 'is-node-selected',
          )}
          style={{ left: x, top: y }}
          title={`add a part at ${row.key}`}
          aria-label={`add a part at ${row.key}`}
          onClick={(event) => {
            event.stopPropagation();
            openPicker(parseTerminalKey(row.key));
          }}
        >
          +
        </button>
      )}
    </>
  );
}

export function ConnectorArtNode({
  data,
  layout,
  selected,
}: {
  data: ConnectorNodeData;
  layout: NonNullable<ConnectorNodeData['art']>;
  selected: boolean;
}): JSX.Element {
  const { dispatch } = useEditorApi();
  const size = estimateNodeSize(data);
  const art = layout.art;
  const rows = useMemo(() => new Map(data.rows.map((row) => [row.terminal, row])), [data.rows]);
  const paint = (terminal: string): PinPaint | undefined => {
    const row = rows.get(terminal);
    return row === undefined ? undefined : { used: row.used, color: row.color };
  };
  const facing: Facing = data.dock?.facing ?? data.rows[0]?.side ?? 'right';
  const select = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'instance', id: data.instanceId } });
  };
  // a docked connector's joints to its board draw no edge at all: no leads
  const leads = useMemo(
    () =>
      data.dock === undefined
        ? pinLeads(art, data.rows, facing === 'right' ? size.width - BOX.border - layout.ox : -BOX.border - layout.ox, data.fan)
        : [],
    [art, data.rows, data.dock, data.fan, facing, size.width, layout.ox],
  );
  // the ground bus joins the pins its bridges common
  const busPoints = useMemo(() => {
    const at = new Map(art.pins.map((pin) => [pin.terminal, pin]));
    const out = new Map<string, { x: number; y: number }>();
    for (const row of data.rows) {
      const pin = at.get(row.terminal);
      if (pin !== undefined) out.set(row.key, { x: pin.x, y: pin.y });
    }
    return out;
  }, [art.pins, data.rows]);
  const busOptions = useMemo(() => ({ gap: 4, toward: { x: art.width / 2, y: art.height / 2 } }), [art.width, art.height]);
  const describe = [data.title, data.subtitle, data.role, art.approximate ? 'pin positions approximate' : undefined]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');

  const area = (
    <div className="cs-conn-art" style={{ width: layout.width, height: layout.height }}>
      <svg
        className="cs-conn-svg"
        width={art.width}
        height={art.height}
        viewBox={`0 0 ${art.width} ${art.height}`}
        style={{ left: layout.ox, top: layout.oy }}
        aria-hidden="true"
      >
        <ConnectorDrawing
          art={art}
          paint={paint}
          bus={<BridgeBusPaths points={busPoints} bridges={data.bridges} options={busOptions} />}
          leads={leads}
        />
      </svg>
      {art.pins.map((pin) => {
        const row = rows.get(pin.terminal);
        if (row === undefined) return null;
        return (
          <PinHandle
            key={row.key}
            pin={pin}
            row={row}
            facing={facing}
            x={layout.ox + pin.x}
            y={layout.oy + pin.y}
            nodeSelected={selected}
          />
        );
      })}
      {data.dock === undefined ? null : (
        <>
          <span
            className="cs-dock-caption"
            style={{ top: layout.oy + art.height + 1, width: layout.width }}
            title={describe}
          >
            {dockCaption(art, data.instanceId)}
          </span>
          <span
            className={classes('cs-dock-mark', data.dock.facing === 'right' ? 'is-right' : 'is-left')}
            style={{ top: layout.oy + 4, height: Math.max(0, art.height - 8) }}
            aria-hidden="true"
          />
        </>
      )}
    </div>
  );

  if (data.dock !== undefined) {
    return (
      <div
        className={classes('cs-node', 'cs-node-connector', 'cs-conn-node', 'cs-conn-docked', selected && 'is-selected')}
        style={{ width: size.width, height: size.height }}
        data-connector={data.def}
        data-docked={data.dock.board}
        title={describe}
        onClick={select}
      >
        {area}
      </div>
    );
  }

  return (
    <div
      className={classes('cs-node', 'cs-node-connector', 'cs-conn-node', selected && 'is-selected', data.missingDef && 'is-broken')}
      style={{ width: size.width, height: size.height }}
      data-connector={data.def}
      onClick={select}
    >
      <header className="cs-node-head cs-art-head" title={`drag ${data.instanceId} by this bar to move it`}>
        <span className="cs-art-chip cs-conn-chip" aria-hidden="true">
          <IconPlug size={12} stroke={1.8} />
        </span>
        <span className="cs-instance">{data.instanceId}</span>
        <span className="cs-title" title={describe}>
          {data.title}
        </span>
      </header>
      {area}
    </div>
  );
}
