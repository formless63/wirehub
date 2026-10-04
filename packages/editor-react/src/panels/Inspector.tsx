/**
 * The right panel's two selection-driven tabs (spec: ui-redesign, Canvas v2
 * item 6): **Connection** — the wire list for whatever connection is
 * selected, with inline add/edit/delete of its joints — and **Part** — the
 * selected instance's own facts plus the connections it takes part in.
 *
 * Every edit here writes through `dispatch`, never the design directly: an
 * edit that would break the design comes back as `state.rejection`, which
 * `CableEditor` already turns into a toast (`chrome="host"`) or the in-canvas
 * alert (`chrome="full"`) — nothing in this file handles a rejection itself.
 */

import {
  breakoutAt,
  connectorMountingOfInstance,
  findComponent,
  findConnector,
  findInstance,
  findPcba,
  findWire,
  isFullyBonded,
  profileDesignTerminal,
  terminalKey,
  terminalsOf,
  type CableDesign,
  type Db,
  type InstanceKind,
  type ResolvedTerminal,
  type TerminalRef,
} from '@wirehub/model';
import { wireDisplayName } from '@wirehub/docs';
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { Popover } from 'radix-ui';
import { useMemo, useState, type JSX } from 'react';

import { classes, useEditorApi } from '../context.ts';
import {
  connectionForSelection,
  connectionsOfInstance,
  isSegmentInstance,
  type Connection,
  type ConnectionEnd,
} from '../connection.ts';
import type { EditorNode, SegmentNodeData } from '../derive.ts';
import type { EditorState, InstancePatch } from '../store.ts';
import {
  connectionRows,
  groupGroundRows,
  looseScreens,
  type ConnectionRow,
  type GroundGroup,
} from './connection-rows.ts';
import type { PigtailEdit } from '../pigtail-edit.ts';
import { BreakoutPanel, SegmentBreakoutSection } from './BreakoutPanel.tsx';
import { SegmentModel3d } from './SegmentModel3d.tsx';

/* ------------------------------------------------------------------ *
 * Small shared bits
 * ------------------------------------------------------------------ */

function endChip(end: ConnectionEnd): JSX.Element {
  return (
    <span className="cs-conn-chip">
      {end.instance}
      {end.end === undefined ? null : <span className="cs-conn-chip-end">· end {end.end}</span>}
    </span>
  );
}

function definitionFacts(
  db: Db,
  kind: InstanceKind,
  def: string,
): { label: string; partNumber?: string; revision?: string } | undefined {
  switch (kind) {
    case 'connector': {
      const d = findConnector(db, def);
      return d === undefined ? undefined : { label: d.label, ...(d.partNumber === undefined ? {} : { partNumber: d.partNumber }) };
    }
    case 'segment': {
      const d = findWire(db, def);
      // never the manufacturer here (owner 2026-09-25/26) — it stays inside the Library's wire detail
      return d === undefined ? undefined : { label: wireDisplayName(db, def), ...(d.partNumber === undefined ? {} : { partNumber: d.partNumber }) };
    }
    case 'component': {
      const d = findComponent(db, def);
      return d === undefined ? undefined : { label: d.label, ...(d.partNumber === undefined ? {} : { partNumber: d.partNumber }) };
    }
    case 'pcba': {
      const d = findPcba(db, def);
      return d === undefined
        ? undefined
        : { label: d.label, partNumber: d.partNumber, revision: d.revision };
    }
  }
}

/** The short subtitle text for one side of a connection: part number + rev
 * when it is a PCBA, its definition's label otherwise. */
function subtitlePart(design: CableDesign, db: Db, end: ConnectionEnd): string {
  const instance = findInstance(design, end.instance);
  if (instance === undefined) return end.instance;
  const facts = definitionFacts(db, instance.kind, instance.def);
  if (facts === undefined) return instance.def;
  if (instance.kind === 'pcba' && facts.partNumber !== undefined && facts.revision !== undefined) {
    return `${facts.partNumber} ${facts.revision}`;
  }
  return facts.label;
}

/* ------------------------------------------------------------------ *
 * The add-joint comboboxes
 * ------------------------------------------------------------------ */

function TerminalCombobox({
  placeholder,
  options,
  value,
  onChange,
}: {
  placeholder: string;
  options: ResolvedTerminal[];
  value: string | undefined;
  onChange: (terminal: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return options;
    return options.filter(
      (option) =>
        option.terminal.toLowerCase().includes(needle) ||
        (option.label ?? '').toLowerCase().includes(needle),
    );
  }, [options, filter]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter('');
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className="cs-conn-combo" disabled={options.length === 0}>
          <span className={classes('cs-mono', value === undefined && 'cs-conn-combo-placeholder')}>
            {value ?? placeholder}
          </span>
          <IconChevronDown size={11} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="cs-popover cs-conn-combo-popover" sideOffset={4} align="start">
          <input
            className="cs-input"
            placeholder={`filter ${placeholder}…`}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            autoFocus
          />
          <ul className="cs-usage-list cs-conn-combo-list">
            {matches.length === 0 ? (
              <li className="cs-empty">none free</li>
            ) : (
              matches.map((option) => (
                <li key={option.key}>
                  <button
                    type="button"
                    className="cs-link"
                    onClick={() => {
                      onChange(option.terminal);
                      setOpen(false);
                      setFilter('');
                    }}
                  >
                    <span className="cs-mono">{option.terminal}</span>
                    {option.label === undefined ? null : (
                      <span className="cs-conn-combo-label">{option.label}</span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AddJointRow({ design, db, connection }: { design: CableDesign; db: Db; connection: Connection }): JSX.Element {
  const { dispatch } = useEditorApi();
  const [padChoice, setPadChoice] = useState<string | undefined>(undefined);
  const [wireChoice, setWireChoice] = useState<string | undefined>(undefined);

  const usedPadIds = useMemo(
    () => new Set(connectionRows(design, db, connection).map((row) => row.padId)),
    [design, db, connection],
  );
  const usedWireIds = useMemo(
    () => new Set(connectionRows(design, db, connection).map((row) => row.wireId)),
    [design, db, connection],
  );
  const padOptions = useMemo(
    () =>
      terminalsOf(design, db, connection.a.instance).filter(
        (t) => t.end === connection.a.end && !usedPadIds.has(t.terminal),
      ),
    [design, db, connection, usedPadIds],
  );
  const wireOptions = useMemo(
    () =>
      terminalsOf(design, db, connection.b.instance).filter(
        (t) => t.end === connection.b.end && !usedWireIds.has(t.terminal),
      ),
    [design, db, connection, usedWireIds],
  );

  const add = (): void => {
    if (padChoice === undefined || wireChoice === undefined) return;
    const a: TerminalRef = {
      instance: connection.a.instance,
      terminal: padChoice,
      ...(connection.a.end === undefined ? {} : { end: connection.a.end }),
    };
    const b: TerminalRef = {
      instance: connection.b.instance,
      terminal: wireChoice,
      ...(connection.b.end === undefined ? {} : { end: connection.b.end }),
    };
    dispatch({ type: 'add-joint', a, b });
    setPadChoice(undefined);
    setWireChoice(undefined);
  };

  return (
    <div className="cs-conn-row cs-conn-add-row">
      <TerminalCombobox placeholder="pad" options={padOptions} value={padChoice} onChange={setPadChoice} />
      <span />
      <TerminalCombobox placeholder="conductor" options={wireOptions} value={wireChoice} onChange={setWireChoice} />
      <button
        type="button"
        className="cs-conn-icon-btn cs-conn-add-btn"
        title="add joint"
        aria-label="add joint"
        disabled={padChoice === undefined || wireChoice === undefined}
        onClick={add}
      >
        <IconPlus size={15} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

function sideLabel(side: ConnectionRow['padSide']): string {
  if (side === undefined) return '';
  if (side === 'bottom') return 'btm';
  return side;
}

function swatch(row: ConnectionRow): JSX.Element {
  if (row.ground) return <span className="cs-conn-swatch is-ground" aria-hidden="true" />;
  if (row.colorName === undefined) return <span className="cs-conn-swatch is-none" aria-hidden="true" />;
  return (
    <span
      className="cs-conn-swatch"
      style={{ background: `var(--cond-${row.colorName.toLowerCase()})` }}
      aria-hidden="true"
    />
  );
}

function NoteCell({
  row,
  editing,
  onStartEdit,
  onCommit,
}: {
  row: ConnectionRow;
  editing: boolean;
  onStartEdit: () => void;
  onCommit: (value: string) => void;
}): JSX.Element {
  const text = row.jointNote ?? row.note ?? '';
  if (editing) {
    return (
      <input
        className="cs-input cs-conn-note-input"
        defaultValue={row.jointNote ?? ''}
        autoFocus
        placeholder="note…"
        onBlur={(event) => onCommit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') onCommit(row.jointNote ?? '');
        }}
      />
    );
  }
  return (
    <span className="cs-conn-note" title={text} onClick={onStartEdit}>
      {text}
    </span>
  );
}

function Row({
  row,
  selected,
  editingNote,
  onSelect,
  onStartEdit,
  onCommitNote,
  onDelete,
  indent,
}: {
  row: ConnectionRow;
  selected: boolean;
  editingNote: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onCommitNote: (value: string) => void;
  onDelete: () => void;
  indent?: boolean;
}): JSX.Element {
  return (
    <div
      className={classes('cs-conn-row', selected && 'is-selected', indent === true && 'is-member')}
      onClick={onSelect}
    >
      <span className="cs-mono cs-conn-pad">{row.padId}</span>
      <span className="cs-mono cs-conn-side">{sideLabel(row.padSide)}</span>
      <span className="cs-conn-conductor">
        {swatch(row)}
        <span className="cs-mono cs-conn-wire-id">{row.wireId}</span>
        <NoteCell row={row} editing={editingNote} onStartEdit={onStartEdit} onCommit={onCommitNote} />
      </span>
      <span className="cs-conn-row-actions">
        <button
          type="button"
          className="cs-conn-icon-btn"
          title="edit note"
          aria-label={`edit note for ${row.padId}`}
          onClick={(event) => {
            event.stopPropagation();
            onStartEdit();
          }}
        >
          <IconPencil size={13} />
        </button>
        <button
          type="button"
          className="cs-conn-icon-btn"
          title="unsolder"
          aria-label={`unsolder ${row.padId}`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <IconTrash size={13} />
        </button>
      </span>
    </div>
  );
}

/**
 * One pigtail: `rgb → GND · GND2 ▾  ×3`, expanding to the screens twisted
 * into it. Members can be ticked and split off into a new pigtail, moved one
 * by one to a sibling pigtail, or the whole pigtail merged into another on the
 * same terminal. A mass pigtail (a bonded stock) has no member list.
 */
function GroupRow({
  group,
  siblings,
  expanded,
  onToggle,
  selected,
  onSelect,
  onDelete,
  onEdit,
}: {
  group: GroundGroup;
  /** the other pigtails at the same wire end, with the terminal each lands on */
  siblings: readonly { id: string; padId: string; mass: boolean }[];
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onEdit: (edit: PigtailEdit) => void;
}): JSX.Element {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const { pigtail } = group;
  const row = group.rows[0];
  const at = { segment: pigtail.segment, end: pigtail.end };
  const movable = siblings.filter((sibling) => !sibling.mass);
  const mergeable = siblings.filter((sibling) => sibling.padId === group.padId && sibling.mass === pigtail.mass);
  const summary = pigtail.mass ? `shield mass · ${pigtail.members.length} screens` : pigtail.members.join(', ');
  return (
    <>
      <div
        className={classes('cs-conn-row', 'cs-conn-group', selected && 'is-selected')}
        onClick={() => {
          onSelect();
          onToggle();
        }}
        data-pigtail={`${pigtail.segment}:${pigtail.id}@${pigtail.end}`}
      >
        <span className="cs-mono cs-conn-pad">{group.padId}</span>
        <span className="cs-mono cs-conn-side">{sideLabel(group.padSide)}</span>
        <span className="cs-conn-conductor">
          <span className="cs-conn-swatch is-ground" aria-hidden="true" />
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          <span className="cs-mono cs-conn-wire-id">
            {pigtail.id} ×{pigtail.members.length}
          </span>
          {row?.pads === undefined ? null : (
            <select
              className="cs-input cs-conn-pad-select"
              aria-label={`pad for pigtail ${pigtail.id}`}
              value={row.landingPad ?? ''}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                onEdit({ op: 'pad', ...at, id: pigtail.id, ...(event.currentTarget.value === '' ? {} : { pad: event.currentTarget.value }) })
              }
            >
              <option value="">any pad</option>
              {row.pads.map((pad) => (
                <option key={pad.ref} value={pad.ref}>
                  {pad.ref}
                  {pad.side === undefined ? '' : ` (${pad.side})`}
                </option>
              ))}
            </select>
          )}
          <span className="cs-conn-note" title={pigtail.note ?? summary}>
            {pigtail.note ?? summary}
          </span>
        </span>
        <span className="cs-conn-row-actions">
          <button
            type="button"
            className="cs-conn-icon-btn"
            title="unsolder the pigtail"
            aria-label={`unsolder pigtail ${pigtail.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <IconTrash size={13} />
          </button>
        </span>
      </div>
      {!expanded ? null : pigtail.mass ? (
        <div className="cs-conn-row is-member cs-conn-mass">
          <span />
          <span />
          <span className="cs-conn-note">
            one bonded shield mass — all {pigtail.members.length} screens, no member list
          </span>
          <span />
        </div>
      ) : (
        <>
          {pigtail.members.map((member) => (
            <div key={member} className="cs-conn-row is-member" data-member={member}>
              <span>
                <input
                  type="checkbox"
                  aria-label={`tick ${member}`}
                  checked={ticked.has(member)}
                  onChange={() =>
                    setTicked((current) => {
                      const next = new Set(current);
                      if (next.has(member)) next.delete(member);
                      else next.add(member);
                      return next;
                    })
                  }
                />
              </span>
              <span />
              <span className="cs-conn-conductor">
                <span className="cs-conn-swatch is-ground" aria-hidden="true" />
                <span className="cs-mono cs-conn-wire-id">{member}</span>
              </span>
              <span className="cs-conn-row-actions">
                {movable.length === 0 ? null : (
                  <select
                    className="cs-input cs-conn-move-select"
                    aria-label={`move ${member} to`}
                    value=""
                    onChange={(event) => {
                      const to = event.currentTarget.value;
                      if (to !== '') onEdit({ op: 'move', ...at, member, from: pigtail.id, to });
                    }}
                  >
                    <option value="">move to…</option>
                    {movable.map((sibling) => (
                      <option key={sibling.id} value={sibling.id}>
                        {sibling.id}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            </div>
          ))}
          <div className="cs-conn-row is-member cs-conn-pigtail-tools">
            <span />
            <span />
            <span className="cs-conn-conductor">
              <button
                type="button"
                className="cs-conn-text-btn"
                disabled={ticked.size === 0 || ticked.size === pigtail.members.length}
                onClick={() => {
                  onEdit({ op: 'split', ...at, id: pigtail.id, members: [...ticked] });
                  setTicked(new Set());
                }}
              >
                Split ticked
              </button>
              {mergeable.length === 0 ? null : (
                <select
                  className="cs-input cs-conn-merge-select"
                  aria-label={`merge pigtail ${pigtail.id} into`}
                  value=""
                  onChange={(event) => {
                    const into = event.currentTarget.value;
                    if (into !== '') onEdit({ op: 'merge', ...at, from: pigtail.id, into });
                  }}
                >
                  <option value="">merge into…</option>
                  {mergeable.map((sibling) => (
                    <option key={sibling.id} value={sibling.id}>
                      {sibling.id}
                    </option>
                  ))}
                </select>
              )}
            </span>
            <span />
          </div>
        </>
      )}
    </>
  );
}

/**
 * The pigtail tools that are not about one pigtail: twist the ticked loose
 * screens into a new one, or — on a bonded stock — add another ground
 * connection from the mass ("Ground connections at this end: 1 [+]").
 */
function PigtailBar({
  design,
  db,
  connection,
  rows,
  pigtails,
  onEdit,
}: {
  design: CableDesign;
  db: Db;
  connection: Connection;
  rows: readonly ConnectionRow[];
  pigtails: number;
  onEdit: (edit: PigtailEdit) => void;
}): JSX.Element | null {
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [landingChoice, setLandingChoice] = useState<string | undefined>(undefined);
  const end = connection.b.end;
  const segment = design.instances.segments.find((s) => s.id === connection.b.instance);
  const wire = segment === undefined ? undefined : findWire(db, segment.def);
  const grounds = useMemo(
    () =>
      terminalsOf(design, db, connection.a.instance).filter(
        (t) => t.end === connection.a.end && profileDesignTerminal(design, db, t)?.profile.ground === true,
      ),
    [design, db, connection],
  );
  if (end === undefined || segment === undefined || wire === undefined) return null;
  const loose = looseScreens(rows);
  const landingOf = (terminal: string): TerminalRef => ({
    instance: connection.a.instance,
    terminal,
    ...(connection.a.end === undefined ? {} : { end: connection.a.end }),
  });

  if (isFullyBonded(wire)) {
    return (
      <div className="cs-conn-row cs-conn-pigtail-bar">
        <span className="cs-conn-note">Ground connections at this end: {pigtails}</span>
        <span />
        <TerminalCombobox placeholder="lands on" options={grounds} value={landingChoice} onChange={setLandingChoice} />
        <button
          type="button"
          className="cs-conn-icon-btn"
          title="add a ground connection from the shield mass"
          aria-label="add ground connection"
          disabled={landingChoice === undefined}
          onClick={() => {
            if (landingChoice === undefined) return;
            onEdit({ op: 'new', segment: segment.id, end, landing: landingOf(landingChoice) });
            setLandingChoice(undefined);
          }}
        >
          <IconPlus size={15} />
        </button>
      </div>
    );
  }
  if (loose.length === 0) return null;
  return (
    <div className="cs-conn-pigtail-bar">
      {loose.map((row) => (
        <label key={row.jointIndex} className="cs-conn-row is-member">
          <span>
            <input
              type="checkbox"
              aria-label={`tick ${row.wireId}`}
              checked={ticked.has(row.jointIndex)}
              onChange={() =>
                setTicked((current) => {
                  const next = new Set(current);
                  if (next.has(row.jointIndex)) next.delete(row.jointIndex);
                  else next.add(row.jointIndex);
                  return next;
                })
              }
            />
          </span>
          <span className="cs-mono">{row.padId}</span>
          <span className="cs-mono cs-conn-wire-id">{row.wireId}</span>
          <span />
        </label>
      ))}
      <div className="cs-conn-row">
        <span />
        <span />
        <button
          type="button"
          className="cs-conn-text-btn"
          disabled={ticked.size === 0}
          onClick={() => {
            const picked = loose.filter((row) => ticked.has(row.jointIndex));
            const first = picked[0];
            if (first === undefined) return;
            onEdit({
              op: 'new',
              segment: segment.id,
              end,
              members: picked.map((row) => row.wireId),
              landing: landingOf(first.padId),
            });
            setTicked(new Set());
          }}
        >
          New pigtail from ticked screens
        </button>
        <span />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Connection tab
 * ------------------------------------------------------------------ */

function rotationFooter(design: CableDesign, nodes: readonly EditorNode[], connection: Connection): JSX.Element | null {
  const wireEnd = isSegmentInstance(design, connection.a.instance)
    ? connection.a
    : isSegmentInstance(design, connection.b.instance)
      ? connection.b
      : undefined;
  if (wireEnd === undefined) return null;
  const node = nodes.find((candidate) => candidate.id === wireEnd.instance);
  const data = node?.data.kind === 'segment' ? (node.data as SegmentNodeData) : undefined;
  const breakout = data?.breakout;
  if (breakout === undefined) return null;
  return (
    <div className="cs-conn-footer">
      <IconCheck size={13} className="cs-conn-footer-ok" />
      <span>
        Ends auto-turned to meet their pads · {breakout.rotation.a}° / {breakout.rotation.b}°
      </span>
    </div>
  );
}

export function ConnectionPanel({
  state,
  nodes,
}: {
  state: EditorState;
  nodes: readonly EditorNode[];
}): JSX.Element {
  const { dispatch } = useEditorApi();
  const { design, db } = state;
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [editingIndex, setEditingIndex] = useState<number | undefined>(undefined);

  const connection = useMemo(
    () => connectionForSelection(design, state.selection),
    [design, state.selection],
  );

  // a breakout mould: what becomes of each conductor in it
  const mould =
    state.selection?.kind === 'instance' && (design.instances.breakouts ?? []).some((b) => b.id === (state.selection as { id: string }).id)
      ? state.selection.id
      : undefined;
  if (mould !== undefined) {
    return (
      <div className="cs-panel cs-conn-panel">
        <div className="cs-scroll">
          <BreakoutPanel state={state} id={mould} />
        </div>
      </div>
    );
  }

  if (connection === undefined) {
    const floating =
      state.selection?.kind === 'terminal' ? terminalKey(state.selection.ref) : undefined;
    return (
      <div className="cs-panel cs-conn-panel">
        <div className="cs-scroll">
          <p className="cs-empty">
            {floating === undefined ? 'select a connection' : `${floating} — nothing jointed`}
          </p>
        </div>
      </div>
    );
  }

  const rows = connectionRows(design, db, connection, state.depictions);

  const selection = state.selection;
  const selectedJoints = new Set(
    selection?.kind === 'joint'
      ? [selection.index]
      : selection?.kind === 'joints'
        ? selection.indices
        : selection?.kind === 'terminal'
          ? rows
              .filter(
                (row) =>
                  terminalKey(row.pad) === terminalKey(selection.ref) ||
                  terminalKey(row.wire) === terminalKey(selection.ref),
              )
              .map((row) => row.jointIndex)
          : [],
  );
  const grouped = groupGroundRows(rows);
  const groups = grouped.filter((entry): entry is GroundGroup => 'kind' in entry);
  const edit = (pigtailEdit: PigtailEdit): void => dispatch({ type: 'edit-pigtails', edit: pigtailEdit });

  const selectRow = (jointIndex: number): void => {
    dispatch({ type: 'select', selection: { kind: 'joint', index: jointIndex } });
  };

  const toggleGroup = (key: string): void => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const groupKey = (group: GroundGroup): string =>
    `${group.pigtail.segment}:${group.pigtail.id}@${group.pigtail.end}`;

  const commitNote = (jointIndex: number, value: string): void => {
    setEditingIndex(undefined);
    const trimmed = value.trim();
    dispatch({ type: 'update-joint', index: jointIndex, patch: { note: trimmed === '' ? undefined : trimmed } });
  };

  return (
    <div className="cs-panel cs-conn-panel">
      <div className="cs-conn-header">
        <div className="cs-conn-header-line">
          {endChip(connection.a)}
          <span className="cs-conn-arrow">→</span>
          {endChip(connection.b)}
          <span className="cs-spacer" />
          <span className="cs-conn-counts">
            {connection.joints.length} joint{connection.joints.length === 1 ? '' : 's'} · {grouped.length} row
            {grouped.length === 1 ? '' : 's'}
          </span>
        </div>
        <div
          className="cs-conn-subtitle"
          title={`${subtitlePart(design, db, connection.a)} → ${subtitlePart(design, db, connection.b)}`}
        >
          {subtitlePart(design, db, connection.a)} → {subtitlePart(design, db, connection.b)}
        </div>
      </div>
      <div className="cs-conn-columns" aria-hidden="true">
        <span>PAD</span>
        <span>SIDE</span>
        <span>CONDUCTOR</span>
        <span />
      </div>
      <div className="cs-scroll cs-conn-scroll">
        {grouped.map((entry) =>
          'kind' in entry ? (
            <GroupRow
              key={`group:${groupKey(entry)}`}
              group={entry}
              siblings={groups
                .filter((other) => other !== entry)
                .map((other) => ({ id: other.pigtail.id, padId: other.padId, mass: other.pigtail.mass }))}
              expanded={expandedGroups.has(groupKey(entry))}
              onToggle={() => toggleGroup(groupKey(entry))}
              selected={entry.rows.some((row) => selectedJoints.has(row.jointIndex))}
              onSelect={() => {
                const first = entry.rows[0];
                if (first !== undefined) selectRow(first.jointIndex);
              }}
              onDelete={() =>
                dispatch({ type: 'delete-joints', indices: entry.rows.map((row) => row.jointIndex) })
              }
              onEdit={edit}
            />
          ) : (
            <Row
              key={entry.jointIndex}
              row={entry}
              selected={selectedJoints.has(entry.jointIndex)}
              editingNote={editingIndex === entry.jointIndex}
              onSelect={() => selectRow(entry.jointIndex)}
              onStartEdit={() => setEditingIndex(entry.jointIndex)}
              onCommitNote={(value) => commitNote(entry.jointIndex, value)}
              onDelete={() => dispatch({ type: 'delete-joint', index: entry.jointIndex })}
            />
          ),
        )}
        <PigtailBar
          design={design}
          db={db}
          connection={connection}
          rows={rows}
          pigtails={groups.length}
          onEdit={edit}
        />
        <AddJointRow design={design} db={db} connection={connection} />
        {/* the wire end of this connection: its breakout, or split it into one */}
        {[connection.a, connection.b]
          .filter((end) => end.end !== undefined && isSegmentInstance(design, end.instance))
          .map((end) => {
            const at = breakoutAt(design, end.instance, end.end!);
            return at === undefined ? (
              <SegmentBreakoutSection key={`${end.instance}@${end.end}`} state={state} segment={end.instance} />
            ) : (
              <BreakoutPanel key={`${end.instance}@${end.end}`} state={state} id={at.breakout.id} />
            );
          })}
      </div>
      {rotationFooter(design, nodes, connection)}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Part tab
 * ------------------------------------------------------------------ */

function InstanceField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number';
  placeholder?: string;
}): JSX.Element {
  return (
    <label className="cs-field">
      <span>{label}</span>
      <input
        className="cs-input"
        type={type}
        value={value}
        placeholder={placeholder ?? ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/**
 * A part's own bridges: joints between two of its own
 * pins or pads — the HD15's ground returns bridged in the head, a SCART's
 * commoned grounds. The canvas draws them as the part's faint ground bus, not
 * as wires, so this is where they are edited on purpose: listed, each one
 * selectable (its bus lights up) and removable, and a new one added from two
 * of the part's terminals.
 */
export function BridgesSection({ state, id }: { state: EditorState; id: string }): JSX.Element {
  const { dispatch } = useEditorApi();
  const { design, db, selection } = state;
  const bridges = design.joints.flatMap((joint, index) =>
    joint.a.instance === id && joint.b.instance === id ? [{ joint, index }] : [],
  );
  const terminals = useMemo(() => terminalsOf(design, db, id), [design, db, id]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const refOf = (key: string): TerminalRef | undefined => {
    const t = terminals.find((candidate) => candidate.key === key);
    return t === undefined ? undefined : { instance: t.instance, terminal: t.terminal, ...(t.end === undefined ? {} : { end: t.end }) };
  };
  const a = refOf(from);
  const b = refOf(to);
  const selected = new Set(
    selection?.kind === 'joint' ? [selection.index] : selection?.kind === 'joints' ? selection.indices : [],
  );
  return (
    <section className="cs-bridges" aria-label="bridges">
      <h3>
        bridges <span className="cs-count">{bridges.length}</span>
      </h3>
      {bridges.length === 0 ? (
        <p className="cs-empty">no pins bridged on this part</p>
      ) : (
        <ul className="cs-list cs-bridge-list">
          {bridges.map(({ joint, index }) => (
            <li key={index} className={classes(selected.has(index) && 'is-selected')} title={joint.note ?? ''}>
              <button
                type="button"
                className="cs-link cs-mono"
                onClick={() => dispatch({ type: 'select', selection: { kind: 'joint', index } })}
              >
                {joint.a.terminal} ↔ {joint.b.terminal}
              </button>
              <button
                type="button"
                className="cs-icon-button cs-bridge-remove"
                aria-label={`remove bridge ${joint.a.terminal} ↔ ${joint.b.terminal}`}
                title="remove bridge"
                onClick={() => dispatch({ type: 'delete-joint', index })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="cs-bridge-add">
        <select className="cs-input" aria-label="bridge from" value={from} onChange={(event) => setFrom(event.target.value)}>
          <option value="">pin…</option>
          {terminals.map((t) => (
            <option key={t.key} value={t.key}>
              {t.terminal}
              {t.label === undefined ? '' : ` ${t.label}`}
            </option>
          ))}
        </select>
        <span aria-hidden="true">↔</span>
        <select className="cs-input" aria-label="bridge to" value={to} onChange={(event) => setTo(event.target.value)}>
          <option value="">pin…</option>
          {terminals.map((t) => (
            <option key={t.key} value={t.key}>
              {t.terminal}
              {t.label === undefined ? '' : ` ${t.label}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="cs-quiet"
          disabled={a === undefined || b === undefined || from === to}
          onClick={() => {
            if (a === undefined || b === undefined) return;
            dispatch({ type: 'add-joint', a, b });
            setFrom('');
            setTo('');
          }}
        >
          add bridge
        </button>
      </div>
    </section>
  );
}

export function PartPanel({ state }: { state: EditorState }): JSX.Element {
  const { dispatch, requestDelete, stripPractice } = useEditorApi();
  const stripPracticeOf = stripPractice ?? [];
  const { design, db, selection } = state;

  if (selection?.kind !== 'instance') {
    return (
      <div className="cs-panel cs-part-panel">
        <div className="cs-scroll">
          <p className="cs-empty">select a part</p>
        </div>
      </div>
    );
  }

  const id = selection.id;
  if ((design.instances.breakouts ?? []).some((b) => b.id === id)) {
    return (
      <div className="cs-panel cs-part-panel">
        <div className="cs-scroll">
          <BreakoutPanel state={state} id={id} />
        </div>
      </div>
    );
  }
  const connector = design.instances.connectors.find((i) => i.id === id);
  const segment = design.instances.segments.find((i) => i.id === id);
  const component = design.instances.components.find((i) => i.id === id);
  const pcba = design.instances.pcbas.find((i) => i.id === id);
  const instance = connector ?? segment ?? component ?? pcba;

  if (instance === undefined) {
    return (
      <div className="cs-panel cs-part-panel">
        <div className="cs-scroll">
          <p className="cs-empty">instance {id} is gone</p>
        </div>
      </div>
    );
  }

  const kind: InstanceKind = connector !== undefined
    ? 'connector'
    : segment !== undefined
      ? 'segment'
      : component !== undefined
        ? 'component'
        : 'pcba';
  const facts = definitionFacts(db, kind, instance.def);
  const jointCount = design.joints.filter((joint) => joint.a.instance === id || joint.b.instance === id).length;
  const connections = connectionsOfInstance(design, id);
  // mounting: direct-solder vs board-straddle — stored
  // on the instance when it can't be derived, else derived from its joints
  const mounting = connector === undefined ? undefined : connectorMountingOfInstance(design, id, connector);
  const mountingStored = connector?.mounting !== undefined;

  const patch = (key: 'role' | 'note' | 'location', value: string): void => {
    const update: InstancePatch =
      key === 'role' ? { role: value } : key === 'note' ? { note: value } : { location: value };
    dispatch({ type: 'update-instance', id, patch: update });
  };

  return (
    <div className="cs-panel cs-part-panel">
      <div className="cs-scroll">
        <dl className="cs-facts">
          <dt>instance</dt>
          <dd className="cs-mono">{id}</dd>
          <dt>kind</dt>
          <dd>{kind}</dd>
          <dt>definition</dt>
          <dd className="cs-mono">{instance.def}</dd>
          {facts === undefined ? null : (
            <>
              <dt>label</dt>
              <dd>{facts.label}</dd>
              {facts.partNumber === undefined ? null : (
                <>
                  <dt>part no.</dt>
                  <dd className="cs-mono">{facts.partNumber}</dd>
                </>
              )}
              {facts.revision === undefined ? null : (
                <>
                  <dt>rev</dt>
                  <dd className="cs-mono">{facts.revision}</dd>
                </>
              )}
            </>
          )}
          <dt>joints</dt>
          <dd>{jointCount}</dd>
          {mounting === undefined ? null : (
            <>
              <dt>mounting</dt>
              <dd>
                {mounting} <span className="cs-meta">{mountingStored ? '(set)' : '(derived)'}</span>
              </dd>
            </>
          )}
        </dl>

        {connector === undefined ? null : (
          <>
            <InstanceField label="role" value={connector.role ?? ''} onChange={(v) => patch('role', v)} />
            <InstanceField label="note" value={connector.note ?? ''} onChange={(v) => patch('note', v)} />
          </>
        )}
        {segment === undefined ? null : (
          <>
            <InstanceField label="role" value={segment.role ?? ''} onChange={(v) => patch('role', v)} />
            <InstanceField
              label="length (mm)"
              type="number"
              value={segment.lengthMm === undefined ? '' : String(segment.lengthMm)}
              onChange={(value) =>
                dispatch({
                  type: 'update-instance',
                  id,
                  patch: { lengthMm: value === '' ? undefined : Number(value) },
                })
              }
            />
            <SegmentBreakoutSection state={state} segment={id} />
            <SegmentModel3d design={design} db={db} segment={id} practice={stripPracticeOf} />
          </>
        )}
        {component === undefined ? null : (
          <>
            <InstanceField
              label="location"
              value={component.location ?? ''}
              onChange={(v) => patch('location', v)}
              placeholder="source-hood | scart-head | inline"
            />
            <InstanceField label="note" value={component.note ?? ''} onChange={(v) => patch('note', v)} />
          </>
        )}
        {pcba === undefined ? null : (
          <InstanceField label="note" value={pcba.note ?? ''} onChange={(v) => patch('note', v)} />
        )}

        {connector === undefined && pcba === undefined ? null : <BridgesSection state={state} id={id} />}

        <h3>
          connections <span className="cs-count">{connections.length}</span>
        </h3>
        {connections.length === 0 ? (
          <p className="cs-empty">nothing jointed</p>
        ) : (
          <ul className="cs-list cs-part-connections">
            {connections.map((connection) => {
              const other = connection.a.instance === id ? connection.b : connection.a;
              return (
                <li key={`${other.instance}${other.end ?? ''}`}>
                  <button
                    type="button"
                    className="cs-link"
                    onClick={() =>
                      dispatch({
                        type: 'select',
                        selection: { kind: 'joint', index: connection.joints[0] ?? 0 },
                      })
                    }
                  >
                    {other.instance}
                    {other.end === undefined ? '' : ` · end ${other.end}`}
                  </button>
                  <span className="cs-count">{connection.joints.length}</span>
                </li>
              );
            })}
          </ul>
        )}

        <button
          type="button"
          className="cs-danger"
          onClick={() => (requestDelete === undefined ? dispatch({ type: 'delete-instance', id }) : requestDelete([id]))}
        >
          delete instance ({jointCount} joint{jointCount === 1 ? '' : 's'} go with it)
        </button>
      </div>
    </div>
  );
}
