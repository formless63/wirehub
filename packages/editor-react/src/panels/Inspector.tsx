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
  cavityRows,
  contactTools,
  fillCavities,
  fitsHousing,
  housingOf,
  setCavity,
  terminationParts,
  wireRangeText,
  insulationRangeText,
  breakoutAt,
  elementPaths,
  connectorMountingOfInstance,
  designInstances,
  jointCompatibility,
  parseTerminalKey,
  findComponent,
  findConnector,
  findInstance,
  findPcba,
  findWire,
  isFullyBonded,
  portsOfSubassembly,
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
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';

import { classes, useEditorApi } from '../context.ts';
import { Combobox } from '../ui/Combobox.tsx';
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
import { versionsOf } from '../assemblies.ts';

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
      // never the manufacturer here — it stays inside the Library's wire detail
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
    case 'subassembly': {
      const d = db.assemblies?.working.find((candidate) => candidate.id === def);
      return d === undefined ? undefined : { label: d.label, ...(d.productRef === undefined ? {} : { partNumber: d.productRef }) };
    }
  }
}

/**
 * A placed design: open it in its own editor, pin it to a saved version (or
 * let it follow the working copy), and the free ends it exposes.
 */
export function SubassemblySection({ state, id }: { state: EditorState; id: string }): JSX.Element | null {
  const { dispatch, openDesign } = useEditorApi();
  const sub = (state.design.instances.subassemblies ?? []).find((s) => s.id === id);
  if (sub === undefined) return null;
  const versions = versionsOf(state.db.assemblies, sub.def);
  const ports = portsOfSubassembly(state.design, state.db, id);
  const value = sub.rev === undefined ? '' : String(sub.rev);
  return (
    <section className="cs-subassembly">
      <h3>sub-assembly</h3>
      {openDesign === undefined ? null : (
        <button type="button" className="cs-link" onClick={() => openDesign(sub.def)} title={`open ${sub.def} in its own editor`}>
          open {sub.def} in its own editor
        </button>
      )}
      <label className="cs-field">
        <span>version</span>
        <select
          className="cs-input"
          aria-label="pinned version"
          value={value}
          onChange={(event) =>
            dispatch({ type: 'update-instance', id, patch: { rev: event.target.value === '' ? undefined : Number(event.target.value) } })
          }
        >
          <option value="">working copy (frozen when this cable's version is saved)</option>
          {versions.map((v) => (
            <option key={v.rev} value={String(v.rev)}>
              Rev {v.rev}
              {v.released ? '' : ' (not released)'}
            </option>
          ))}
          {sub.rev !== undefined && !versions.some((v) => v.rev === sub.rev) ? <option value={value}>Rev {sub.rev} (not found)</option> : null}
        </select>
      </label>
      <InstanceField label="role" value={sub.role ?? ''} onChange={(v) => dispatch({ type: 'update-instance', id, patch: { role: v } })} />
      <InstanceField label="label" value={sub.label ?? ''} onChange={(v) => dispatch({ type: 'update-instance', id, patch: { label: v } })} placeholder={id} />
      <InstanceField label="note" value={sub.note ?? ''} onChange={(v) => dispatch({ type: 'update-instance', id, patch: { note: v } })} />
      <h4>
        free ends <span className="cs-count">{ports?.length ?? 0}</span>
      </h4>
      {ports === undefined ? (
        <p className="cs-empty">the placed design could not be opened — see Issues</p>
      ) : (
        <ul className="cs-list cs-subassembly-ports">
          {ports.map((port) => (
            <li key={port.id}>
              <span className="cs-mono">{port.id}</span> <span className="cs-meta">{port.groupLabel} · {port.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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

/** A search-as-you-type pick over terminals (the ui `Combobox`): type to filter, Up/Down, Enter picks. */
function TerminalCombobox({
  id,
  placeholder,
  options,
  value,
  onChange,
}: {
  id: string;
  placeholder: string;
  options: readonly ResolvedTerminal[];
  value: string | null;
  onChange: (terminal: string) => void;
}): JSX.Element {
  const items = useMemo(
    () => options.map((option) => ({ value: option.terminal, label: option.terminal, ...(option.label === undefined || option.label === option.terminal ? {} : { hint: option.label }) })),
    [options],
  );
  return (
    <Combobox
      id={id}
      aria-label={placeholder}
      placeholder={placeholder}
      options={items}
      value={value}
      onValueChange={onChange}
      disabled={options.length === 0}
      emptyText="none free"
      className="cs-conn-combo"
    />
  );
}

/** Focus the element with this id once React has painted it (the combobox that just opened or was just filled). */
function focusSoon(id: string): void {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/**
 * The free pads and conductors of a connection. `except` lets an edited row keep its own
 * terminals in the lists, so the row's current value stays pickable.
 */
function useFreeTerminals(design: CableDesign, db: Db, connection: Connection): { pads: ResolvedTerminal[]; wires: ResolvedTerminal[]; usedPads: ReadonlySet<string>; usedWires: ReadonlySet<string> } {
  const usedPads = useMemo(() => new Set(connectionRows(design, db, connection).map((row) => row.padId)), [design, db, connection]);
  const usedWires = useMemo(() => new Set(connectionRows(design, db, connection).map((row) => row.wireId)), [design, db, connection]);
  const pads = useMemo(() => terminalsOf(design, db, connection.a.instance).filter((t) => t.end === connection.a.end), [design, db, connection]);
  const wires = useMemo(() => terminalsOf(design, db, connection.b.instance).filter((t) => t.end === connection.b.end), [design, db, connection]);
  return { pads, wires, usedPads, usedWires };
}

/**
 * Add a joint to this connection from the keyboard: focus the pad field, type, Enter; the conductor
 * field takes the focus, type, Enter; the joint is made and the focus comes back to the pad field
 * for the next one. Pad and conductor can be picked in either order, with the mouse as well.
 */
function AddJointRow({ design, db, connection, focusRequest, onFocusHandled, onLeave }: { design: CableDesign; db: Db; connection: Connection; focusRequest: boolean; onFocusHandled: () => void; onLeave: () => void }): JSX.Element {
  const { dispatch } = useEditorApi();
  const uid = useId();
  const padId = `${uid}-pad`;
  const wireId = `${uid}-conductor`;
  const [padChoice, setPadChoice] = useState<string | null>(null);
  const [wireChoice, setWireChoice] = useState<string | null>(null);
  const free = useFreeTerminals(design, db, connection);
  const padOptions = useMemo(() => free.pads.filter((t) => !free.usedPads.has(t.terminal)), [free]);
  const wireOptions = useMemo(() => free.wires.filter((t) => !free.usedWires.has(t.terminal)), [free]);

  useEffect(() => {
    if (!focusRequest) return;
    focusSoon(padId);
    onFocusHandled();
  }, [focusRequest, onFocusHandled, padId]);

  const make = (pad: string, wire: string): void => {
    const a: TerminalRef = { instance: connection.a.instance, terminal: pad, ...(connection.a.end === undefined ? {} : { end: connection.a.end }) };
    const b: TerminalRef = { instance: connection.b.instance, terminal: wire, ...(connection.b.end === undefined ? {} : { end: connection.b.end }) };
    dispatch({ type: 'add-joint', a, b });
    setPadChoice(null);
    setWireChoice(null);
    focusSoon(padId);
  };
  const pickPad = (terminal: string): void => {
    if (wireChoice !== null) make(terminal, wireChoice);
    else {
      setPadChoice(terminal);
      focusSoon(wireId);
    }
  };
  const pickWire = (terminal: string): void => {
    if (padChoice !== null) make(padChoice, terminal);
    else {
      setWireChoice(terminal);
      focusSoon(padId);
    }
  };

  return (
    <div
      className="cs-conn-add-row"
      data-conn-add
      onKeyDownCapture={(event) => {
        // Escape steps back to the table, even from an open list
        if (event.key === 'Escape') {
          event.preventDefault();
          onLeave();
        }
      }}
    >
      <TerminalCombobox id={padId} placeholder="pad" options={padOptions} value={padChoice} onChange={pickPad} />
      <TerminalCombobox id={wireId} placeholder="conductor" options={wireOptions} value={wireChoice} onChange={pickWire} />
    </div>
  );
}

/**
 * A terminal with no joint yet: pick what to solder it to, from the keyboard. The list is every
 * terminal of another part the compatibility rules allow, so one Enter makes the first joint and
 * the connection's own table (and its add row) takes over.
 */
function ConnectTerminal({ design, db, from, focusRequest, onFocusHandled, onJoined }: { design: CableDesign; db: Db; from: TerminalRef; focusRequest: boolean; onFocusHandled: () => void; onJoined: () => void }): JSX.Element {
  const { dispatch } = useEditorApi();
  const id = useId();
  const options = useMemo(() => {
    const here = profileDesignTerminal(design, db, from);
    if (here === undefined) return [];
    const out: ResolvedTerminal[] = [];
    for (const instance of designInstances(design)) {
      if (instance.id === from.instance) continue;
      for (const t of terminalsOf(design, db, instance.id)) {
        const there = profileDesignTerminal(design, db, { instance: t.instance, terminal: t.terminal, ...(t.end === undefined ? {} : { end: t.end }) });
        if (there !== undefined && jointCompatibility(here, there).ok) out.push(t);
      }
    }
    return out;
  }, [design, db, from]);
  useEffect(() => {
    if (!focusRequest) return;
    focusSoon(id);
    onFocusHandled();
  }, [focusRequest, onFocusHandled, id]);
  const items = useMemo(() => options.map((t) => ({ value: t.key, label: t.key, ...(t.label === undefined ? {} : { hint: t.label }) })), [options]);
  return (
    <div className="cs-conn-add-row cs-conn-connect-row" data-conn-add>
      <Combobox
        id={id}
        aria-label={`connect ${terminalKey(from)} to`}
        placeholder={`connect ${terminalKey(from)} to…`}
        options={items}
        value={null}
        onValueChange={(key) => {
          onJoined();
          dispatch({ type: 'add-joint', a: from, b: parseTerminalKey(key) });
        }}
        emptyText="nothing compatible"
        className="cs-conn-combo"
      />
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

/**
 * A joint whose ends are being edited: the pad and the conductor become search fields. The row's
 * current terminal heads each list, so Enter keeps it and moves on; picking another re-lands that
 * end (one undoable edit). Escape, or Enter on the conductor field, goes back to the row.
 */
function EditEndsRow({
  row,
  design,
  db,
  connection,
  onMove,
  onDone,
}: {
  row: ConnectionRow;
  design: CableDesign;
  db: Db;
  connection: Connection;
  onMove: (which: 'pad' | 'wire', terminal: string) => void;
  onDone: () => void;
}): JSX.Element {
  const uid = useId();
  const padField = `${uid}-pad`;
  const wireField = `${uid}-wire`;
  const free = useFreeTerminals(design, db, connection);
  const withCurrent = (all: ResolvedTerminal[], used: ReadonlySet<string>, current: string): ResolvedTerminal[] => {
    const mine = all.find((t) => t.terminal === current);
    return [...(mine === undefined ? [] : [mine]), ...all.filter((t) => t.terminal !== current && !used.has(t.terminal))];
  };
  useEffect(() => focusSoon(padField), [padField]);
  return (
    <div
      className="cs-conn-row is-editing"
      data-conn-row={row.jointIndex}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onDone();
        }
      }}
    >
      <TerminalCombobox
        id={padField}
        placeholder="pad"
        options={withCurrent(free.pads, free.usedPads, row.padId)}
        value={row.padId}
        onChange={(terminal) => {
          if (terminal !== row.padId) onMove('pad', terminal);
          focusSoon(wireField);
        }}
      />
      <TerminalCombobox
        id={wireField}
        placeholder="conductor"
        options={withCurrent(free.wires, free.usedWires, row.wireId)}
        value={row.wireId}
        onChange={(terminal) => {
          if (terminal !== row.wireId) onMove('wire', terminal);
          onDone();
        }}
      />
    </div>
  );
}

function Row({
  row,
  selected,
  editingNote,
  onSelect,
  onStartEdit,
  onStartEditEnds,
  onCommitNote,
  onDelete,
  onNavigate,
  indent,
}: {
  row: ConnectionRow;
  selected: boolean;
  editingNote: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onStartEditEnds: () => void;
  onCommitNote: (value: string) => void;
  onDelete: () => void;
  onNavigate: (from: HTMLElement, to: 'next' | 'previous' | 'first' | 'last') => void;
  indent?: boolean;
}): JSX.Element {
  return (
    <div
      className={classes('cs-conn-row', selected && 'is-selected', indent === true && 'is-member')}
      data-conn-row={row.jointIndex}
      tabIndex={0}
      aria-label={`${row.padId} to ${row.wireId}`}
      aria-keyshortcuts="ArrowUp ArrowDown Enter Delete N"
      onClick={onSelect}
      onFocus={(event) => {
        if (event.target === event.currentTarget && !selected) onSelect();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
        const go = (to: 'next' | 'previous' | 'first' | 'last'): void => {
          event.preventDefault();
          onNavigate(event.currentTarget, to);
        };
        if (event.key === 'ArrowDown') go('next');
        else if (event.key === 'ArrowUp') go('previous');
        else if (event.key === 'Home') go('first');
        else if (event.key === 'End') go('last');
        else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          onDelete();
        } else if (event.key === 'Enter' || event.key === 'F2' || event.key === 'e') {
          event.preventDefault();
          onStartEditEnds();
        } else if (event.key === 'n') {
          event.preventDefault();
          onStartEdit();
        }
      }}
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
          tabIndex={-1}
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
          tabIndex={-1}
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
  onNavigate,
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
  onNavigate: (from: HTMLElement, to: 'next' | 'previous' | 'first' | 'last') => void;
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
        data-conn-row={group.rows[0]?.jointIndex}
        tabIndex={0}
        aria-label={`pigtail ${pigtail.id}`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            onNavigate(event.currentTarget, event.key === 'ArrowDown' ? 'next' : event.key === 'ArrowUp' ? 'previous' : event.key === 'Home' ? 'first' : 'last');
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            onDelete();
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
            onToggle();
          }
        }}
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
  const landingId = useId();
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
        <TerminalCombobox id={`${landingId}-lands`} placeholder="lands on" options={grounds} value={landingChoice ?? null} onChange={setLandingChoice} />
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

const NOOP = (): void => undefined;

export function ConnectionPanel({
  state,
  nodes,
  focusRequest = false,
  onFocusHandled = NOOP,
}: {
  state: EditorState;
  nodes: readonly EditorNode[];
  /** the host asks the keyboard to land here (Enter on the canvas): the add row's pad field, or the connect field of an unjointed pin */
  focusRequest?: boolean;
  onFocusHandled?: () => void;
}): JSX.Element {
  const { dispatch } = useEditorApi();
  const { design, db } = state;
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [editingIndex, setEditingIndex] = useState<number | undefined>(undefined);
  const [editingEnds, setEditingEnds] = useState<number | undefined>(undefined);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<{ row: number } | { add: true } | { joint: number } | undefined>(undefined);
  // after an edit that rebuilt the table, put the keyboard back where it was working
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted === undefined) return;
    pendingFocus.current = undefined;
    const table = tableRef.current;
    if (table === null) return;
    const rows = [...table.querySelectorAll<HTMLElement>('[data-conn-row]')];
    const add = table.querySelector<HTMLElement>('[data-conn-add] input');
    const target = 'joint' in wanted ? rows.find((el) => el.dataset['connRow'] === String(wanted.joint)) : 'row' in wanted ? rows[Math.min(wanted.row, rows.length - 1)] : add;
    (target ?? add)?.focus();
  });
  const moveFocus = (from: HTMLElement, to: 'next' | 'previous' | 'first' | 'last'): void => {
    const table = tableRef.current;
    if (table === null) return;
    const rows = [...table.querySelectorAll<HTMLElement>('[data-conn-row]')];
    const at = rows.indexOf(from);
    const target = to === 'first' ? rows[0] : to === 'last' ? rows[rows.length - 1] : rows[at + (to === 'next' ? 1 : -1)];
    if (target !== undefined) target.focus();
    else if (to === 'next') table.querySelector<HTMLElement>('[data-conn-add] input')?.focus();
  };

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
          {state.selection?.kind !== 'terminal' ? null : (
            <ConnectTerminal design={design} db={db} from={state.selection.ref} focusRequest={focusRequest} onFocusHandled={onFocusHandled} onJoined={() => { pendingFocus.current = { add: true }; }} />
          )}
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
    pendingFocus.current = { joint: jointIndex };
  };

  /** re-land one end of a joint on another terminal: one undoable edit */
  const moveEnd = (row: ConnectionRow, which: 'pad' | 'wire', terminal: string): void => {
    const ref = which === 'pad' ? row.pad : row.wire;
    const joint = design.joints[row.jointIndex];
    if (joint === undefined) return;
    const side = terminalKey(joint.a) === terminalKey(ref) ? 'a' : 'b';
    dispatch({ type: 'move-joint-ends', moves: [{ index: row.jointIndex, side, to: { ...ref, terminal } }] });
  };
  const entryIndexOf = (jointIndex: number): number => grouped.findIndex((entry) => ('kind' in entry ? entry.rows.some((r) => r.jointIndex === jointIndex) : entry.jointIndex === jointIndex));
  const deleteJoint = (jointIndex: number): void => {
    pendingFocus.current = { row: entryIndexOf(jointIndex) };
    dispatch({ type: 'delete-joint', index: jointIndex });
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
      <div className="cs-scroll cs-conn-scroll" ref={tableRef}>
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
              onDelete={() => {
                pendingFocus.current = { row: entryIndexOf(entry.rows[0]?.jointIndex ?? -1) };
                dispatch({ type: 'delete-joints', indices: entry.rows.map((row) => row.jointIndex) });
              }}
              onEdit={edit}
              onNavigate={moveFocus}
            />
          ) : editingEnds === entry.jointIndex ? (
            <EditEndsRow
              key={entry.jointIndex}
              row={entry}
              design={design}
              db={db}
              connection={connection}
              onMove={(which, terminal) => moveEnd(entry, which, terminal)}
              onDone={() => {
                setEditingEnds(undefined);
                pendingFocus.current = { joint: entry.jointIndex };
              }}
            />
          ) : (
            <Row
              key={entry.jointIndex}
              row={entry}
              selected={selectedJoints.has(entry.jointIndex)}
              editingNote={editingIndex === entry.jointIndex}
              onSelect={() => selectRow(entry.jointIndex)}
              onStartEdit={() => setEditingIndex(entry.jointIndex)}
              onStartEditEnds={() => setEditingEnds(entry.jointIndex)}
              onCommitNote={(value) => commitNote(entry.jointIndex, value)}
              onDelete={() => deleteJoint(entry.jointIndex)}
              onNavigate={moveFocus}
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
        <AddJointRow
          design={design}
          db={db}
          connection={connection}
          focusRequest={focusRequest}
          onFocusHandled={onFocusHandled}
          onLeave={() => {
            const rowsEls = tableRef.current?.querySelectorAll<HTMLElement>('[data-conn-row]');
            rowsEls?.[rowsEls.length - 1]?.focus();
          }}
        />
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

/** A text field that commits on blur or Enter, so a label can be typed in pieces (`a | b` is two lines). */
function LabelField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
}): JSX.Element {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (): void => {
    if (text !== value) onCommit(text);
  };
  return (
    <label className="cs-field">
      <span>{label}</span>
      <input
        className="cs-input"
        aria-label={label}
        value={text}
        placeholder={placeholder ?? ''}
        maxLength={130}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

/** The marker text of one wire run: its designation, the text at each end, and a label per core. */
function SegmentLabels({ state, id }: { state: EditorState; id: string }): JSX.Element | null {
  const { dispatch } = useEditorApi();
  const { design, db } = state;
  const segment = design.instances.segments.find((s) => s.id === id);
  const wire = segment === undefined ? undefined : findWire(db, segment.def);
  if (segment === undefined) return null;
  const cores = wire === undefined ? [] : elementPaths(wire.structure).filter((e) => e.element.kind === 'conductor' && e.element.bare !== true).map((e) => e.path);
  const lines = (end: 'a' | 'b'): string => (segment.endLabels?.[end] ?? []).join(' | ');
  const setEnd = (end: 'a' | 'b', text: string): void =>
    dispatch({ type: 'update-instance', id, patch: { endLabels: { ...(segment.endLabels ?? {}), [end]: text.split('|').slice(0, 3).map((l) => l.trim().slice(0, 40)) } } });
  return (
    <div data-testid="segment-labels">
      <h3>labels</h3>
      <LabelField label="run label" value={segment.label ?? ''} placeholder="W1 (generated)" onCommit={(v) => dispatch({ type: 'update-instance', id, patch: { label: v.trim() } })} />
      <LabelField label="end A text" value={lines('a')} placeholder="generated; lines separated by |" onCommit={(v) => setEnd('a', v)} />
      <LabelField label="end B text" value={lines('b')} placeholder="generated; lines separated by |" onCommit={(v) => setEnd('b', v)} />
      {cores.map((path) => (
        <LabelField
          key={path}
          label={`core ${path}`}
          value={segment.coreLabels?.[path] ?? ''}
          placeholder="printed at both ends"
          onCommit={(v) => dispatch({ type: 'update-instance', id, patch: { coreLabels: { ...(segment.coreLabels ?? {}), [path]: v } } })}
        />
      ))}
    </div>
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

/**
 * A crimp housing's cavities: per cavity, the wire landed in it and the
 * contact, seal or plug it takes, picked from the library's parts that fit the
 * housing; "fill all by wire gauge" chooses every one from the wires
 * (`fillCavities`). Shown for a connector whose housing the catalog knows, or
 * that already has cavities recorded. Every edit is one undoable step.
 */
export function CavitiesSection({ state, id }: { state: EditorState; id: string }): JSX.Element | null {
  const { dispatch } = useEditorApi();
  const { design, db } = state;
  const instance = design.instances.connectors.find((c) => c.id === id);
  const connector = instance === undefined ? undefined : findConnector(db, instance.def);
  const rows = useMemo(() => cavityRows(design, db, id), [design, db, id]);
  if (instance === undefined || connector === undefined || rows.length === 0) return null;
  const housing = housingOf(connector, db);
  const optionsFor = (kind: 'contact' | 'seal' | 'plug') =>
    terminationParts(db, kind).filter((p) => fitsHousing(p, connector, db) !== false);
  const contacts = optionsFor('contact');
  const seals = optionsFor('seal');
  const plugs = optionsFor('plug');
  const showSeals = housing?.sealing === 'per-wire' || rows.some((r) => r.seal !== undefined);
  const showPlugs = housing?.plugUnused === true || rows.some((r) => r.plug !== undefined);
  const apply = (next: typeof design, description: string): void => dispatch({ type: 'apply-design', design: next, description, record: true });
  // a contact with more than one applicator lets each cavity say which crimps it
  const showTools = rows.some((r) => contactTools(r.contact).length > 1 || r.assignment?.tool !== undefined);
  const pick = (pin: string, slot: 'contact' | 'seal' | 'plug' | 'tool', value: string): void =>
    apply(
      // another contact may not be crimped by the tool the last one was
      setCavity(design, id, pin, { [slot]: value === '' ? undefined : value, ...(slot === 'contact' ? { tool: undefined } : {}) }),
      `set ${slot} in ${id}:${pin}`,
    );
  const toolChoice = (row: (typeof rows)[number]): JSX.Element => {
    const ids = contactTools(row.contact);
    const current = row.assignment?.tool ?? row.contact?.termination?.tool ?? '';
    return (
      <select
        className="cs-input"
        aria-label={`tool for cavity ${row.pin}`}
        value={current}
        disabled={row.contact === undefined || ids.length < 2}
        onChange={(event) => pick(row.pin, 'tool', event.target.value === row.contact?.termination?.tool ? '' : event.target.value)}
      >
        {ids.length === 0 ? <option value="">—</option> : null}
        {ids.map((toolId) => (
          <option key={toolId} value={toolId}>
            {(db.mechanicals ?? []).find((m) => m.id === toolId)?.label ?? toolId}
          </option>
        ))}
      </select>
    );
  };
  const choice = (
    pin: string,
    slot: 'contact' | 'seal' | 'plug',
    current: string | undefined,
    parts: ReturnType<typeof optionsFor>,
    describe: (p: (typeof parts)[number]) => string | undefined,
  ): JSX.Element => {
    const known = current === undefined || parts.some((p) => p.id === current);
    return (
      <select className="cs-input" aria-label={`${slot} for cavity ${pin}`} value={current ?? ''} onChange={(event) => pick(pin, slot, event.target.value)}>
        <option value="">—</option>
        {known ? null : <option value={current}>{current} (does not fit)</option>}
        {parts.map((p) => {
          const extra = describe(p);
          return (
            <option key={p.id} value={p.id}>
              {p.label}
              {extra === undefined ? '' : ` · ${extra}`}
            </option>
          );
        })}
      </select>
    );
  };
  return (
    <section className="cs-cavities" aria-label="cavities">
      <h3>
        cavities <span className="cs-count">{rows.length}</span>
      </h3>
      <table className="cs-cavity-table">
        <thead>
          <tr>
            <th>cavity</th>
            <th>wire</th>
            <th>contact</th>
            {showTools ? <th>tool</th> : null}
            {showSeals ? <th>seal</th> : null}
            {showPlugs ? <th>plug</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.pin}>
              <td className="cs-mono">{row.pin}</td>
              <td className="cs-mono" title={row.wires.map((w) => `${w.segment}.${w.path}@${w.end}`).join(' + ')}>
                {row.wires.length === 0
                  ? row.used
                    ? 'landed'
                    : 'unused'
                  : row.wires.map((w) => (w.areaMm2 === undefined ? w.path : `${w.areaMm2} mm²`)).join(' + ')}
              </td>
              <td>{choice(row.pin, 'contact', row.assignment?.contact, contacts, (p) => wireRangeText(p.termination))}</td>
              {showTools ? <td>{toolChoice(row)}</td> : null}
              {showSeals ? <td>{choice(row.pin, 'seal', row.assignment?.seal, seals, (p) => insulationRangeText(p.termination))}</td> : null}
              {showPlugs ? <td>{choice(row.pin, 'plug', row.assignment?.plug, plugs, () => undefined)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cs-cavity-actions">
        <button
          type="button"
          className="cs-quiet"
          disabled={contacts.length === 0 && plugs.length === 0}
          title={contacts.length === 0 ? 'No contact in the library fits this housing yet' : 'Pick each cavity\'s contact (and seal, and plug) from the wire landed in it'}
          onClick={() => apply(fillCavities(design, db, id), `fill the cavities of ${id} by wire gauge`)}
        >
          fill all by wire gauge
        </button>
        {(instance.cavities ?? []).length === 0 ? null : (
          <button type="button" className="cs-quiet" onClick={() => apply({ ...design, instances: { ...design.instances, connectors: design.instances.connectors.map((c) => (c.id === id ? (({ cavities: _c, ...rest }) => rest)(c) : c)) } }, `clear the cavities of ${id}`)}>
            clear
          </button>
        )}
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
  const subassembly = (design.instances.subassemblies ?? []).find((i) => i.id === id);
  const instance = connector ?? segment ?? component ?? pcba ?? subassembly;

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
        : pcba !== undefined
          ? 'pcba'
          : 'subassembly';
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
            <InstanceField label="label" value={connector.label ?? ''} onChange={(v) => dispatch({ type: 'update-instance', id, patch: { label: v } })} placeholder={`${id.toUpperCase()} (used on the wire labels)`} />
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
            <SegmentLabels state={state} id={id} />
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
              placeholder="source-hood | dest-head | inline"
            />
            <InstanceField label="note" value={component.note ?? ''} onChange={(v) => patch('note', v)} />
          </>
        )}
        {pcba === undefined ? null : (
          <InstanceField label="note" value={pcba.note ?? ''} onChange={(v) => patch('note', v)} />
        )}
        {subassembly === undefined ? null : <SubassemblySection state={state} id={id} />}

        {connector === undefined ? null : <CavitiesSection state={state} id={id} />}
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
