/**
 * A part at Parts detail (`lod.ts`): a compact card — kind icon, id, title,
 * part number and one line of meta; a board keeps a thumbnail of its top
 * face. Two hidden handles, one per side, for the bundle edges.
 */

import { inlineVectorAsset } from '@wirehub/render-svg';
import { IconArrowsSplit, IconCircuitResistor, IconCpu, IconPlug, IconStack2, IconTarget } from '@tabler/icons-react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { useMemo, type JSX, type MouseEvent } from 'react';

import { boardIdPrefix, stripSvgCaptions } from '../board-art.ts';
import { classes, useEditorApi } from '../context.ts';
import { cardSize, type CardNodeData } from '../lod.ts';
import { BoardParts } from './BoardNode.tsx';

const ICONS = {
  connector: IconPlug,
  segment: IconTarget,
  component: IconCircuitResistor,
  pcba: IconCpu,
  breakout: IconArrowsSplit,
  subassembly: IconStack2,
} as const;

function Thumb({ instanceId, thumb }: { instanceId: string; thumb: NonNullable<CardNodeData['thumb']> }): JSX.Element {
  const { view } = thumb;
  const markup = useMemo(
    () => stripSvgCaptions(inlineVectorAsset(view.source, `${boardIdPrefix(instanceId, view.side)}card-`)),
    [view.source, instanceId, view.side],
  );
  return (
    <svg
      className="cs-card-thumb"
      width={thumb.width}
      height={thumb.height}
      viewBox={`0 0 ${view.box.width} ${view.box.height}`}
      aria-hidden="true"
    >
      <g transform={view.transform} dangerouslySetInnerHTML={{ __html: markup }} />
      <BoardParts parts={view.parts} labels={false} />
    </svg>
  );
}

export function CardNode({ data, selected }: NodeProps<Node<CardNodeData, 'card'>>): JSX.Element {
  const { dispatch } = useEditorApi();
  const Icon = ICONS[data.part];
  const size = cardSize(data);
  const select = (event: MouseEvent): void => {
    event.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'instance', id: data.instanceId } });
  };
  return (
    <div
      className={classes('cs-card', `cs-card-${data.part}`, selected === true && 'is-selected', data.missingDef && 'is-broken')}
      style={{ width: size.width, height: size.height }}
      title={`${data.instanceId} · ${data.partNumber}`}
      onClick={select}
    >
      <Handle type="source" position={Position.Left} id="l" isConnectable={false} className="cs-card-handle" />
      <Handle type="source" position={Position.Right} id="r" isConnectable={false} className="cs-card-handle" />
      <div className="cs-card-head">
        <span className="cs-card-icon">
          <Icon size={13} stroke={1.8} />
        </span>
        <span className="cs-card-id">{data.instanceId}</span>
        <span className="cs-card-title">{data.title}</span>
      </div>
      <div className="cs-card-meta">
        <span className="cs-card-pn">{data.partNumber}</span>
        {data.meta === '' ? null : <span className="cs-card-extra">{data.meta}</span>}
      </div>
      {data.thumb === undefined ? null : (
        <div className="cs-card-thumbs">
          <Thumb instanceId={data.instanceId} thumb={data.thumb} />
        </div>
      )}
    </div>
  );
}
