/**
 * One addressable terminal: a React Flow handle, the pin number the shop reads
 * off the part, and the definition's own label. Dragging from the handle starts
 * a joint; clicking the row selects the terminal for the trace readout.
 */

import { parseTerminalKey } from '@wirehub/model';
import { Handle, Position } from '@xyflow/react';
import type { JSX, MouseEvent } from 'react';

import { classes, useEditorApi } from '../context.ts';
import type { TerminalRow } from '../derive.ts';

/**
 * @param nodeSelected the containing node is selected — one of the two ways
 *   (the other is `:hover`, CSS-only) this row's own `+` becomes visible when
 *   it is free. See `editor.css`'s `.cs-handle-add` rules.
 */
export function PinRow({ row, nodeSelected }: { row: TerminalRow; nodeSelected?: boolean }): JSX.Element {
  const { dispatch, openPicker } = useEditorApi();
  const onLeft = row.side === 'left';

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

  return (
    <div
      className={classes(
        'cs-row',
        onLeft ? 'cs-row-left' : 'cs-row-right',
        row.used && 'is-used',
        row.onSelectedNet && 'is-on-net',
        row.selected && 'is-selected',
      )}
      title={`${row.key}${row.label === undefined ? '' : ` — ${row.label}`}`}
      data-terminal={row.key}
      onClick={select}
    >
      <Handle
        type="source"
        position={onLeft ? Position.Left : Position.Right}
        id={row.key}
        className={classes('cs-handle', `cs-handle-${row.role}`)}
        style={row.color === undefined ? undefined : { background: row.color }}
      />
      <span className="cs-pin">{row.terminal}</span>
      {row.end === undefined ? null : <span className="cs-end">{row.end}</span>}
      <span className="cs-label">{row.label ?? ''}</span>
      {row.used ? null : (
        <button
          type="button"
          className={classes('cs-handle-add', nodeSelected === true && 'is-node-selected')}
          title={`add a part at ${row.key}`}
          aria-label={`add a part at ${row.key}`}
          onClick={add}
        >
          +
        </button>
      )}
    </div>
  );
}
