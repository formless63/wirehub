/**
 * The node picker ( spec: ui-redesign Canvas v2 item 7):
 * a search popover that inserts a part — and, when there is one obvious way
 * to wire it, wires it in the same step.
 *
 * Opened from a free handle's `+`, from Tab on the canvas (a terminal
 * selected anchors it; a node or nothing selected does not — see
 * `CableEditor`'s Tab handler), or from the app's "Add part…" command. With
 * an anchor, definitions split into **Fits here** (at least one terminal core
 * allows onto the anchor, likeliest first — `picker.ts`'s `rankDefinitions`,
 * computed once per open and cached against `[design, db, anchor]`, not per
 * keystroke) and **Other**; without one, every definition lists together.
 */

import type { CableDesign, Db, InstanceKind, TerminalRef } from '@wirehub/model';
import {
  IconCircuitResistor,
  IconCpu,
  IconStack2,
  IconPlug,
  IconTarget,
} from '@tabler/icons-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type JSX,
  type KeyboardEvent,
} from 'react';

import { classes, useEditorApi } from '../context.ts';
import { autoWireTerminal, rankDefinitions, rankTerminals } from '../picker.ts';
import { matchesQuery, paletteEntries, subassemblyEntries, type PaletteEntry } from './Palette.tsx';

export interface NodePickerProps {
  /** the free handle this was opened from — `undefined` for Tab-at-centre / "Add part…" */
  anchor?: TerminalRef;
  design: CableDesign;
  db: Db;
  /** the host's other designs, offered as sub-assemblies */
  designs?: readonly { id: string; label: string }[] | undefined;
  onClose: () => void;
}

const KIND_ICON: Record<InstanceKind, ComponentType<{ size?: number }>> = {
  connector: IconPlug,
  segment: IconTarget,
  component: IconCircuitResistor,
  pcba: IconCpu,
  subassembly: IconStack2,
};

function KindIcon({ kind }: { kind: InstanceKind }): JSX.Element {
  const Icon = KIND_ICON[kind];
  return (
    <span className={classes('cs-picker-icon', `cs-picker-icon-${kind}`)} aria-hidden="true">
      <Icon size={12} />
    </span>
  );
}

function PickerRow({
  entry,
  active,
  onChoose,
}: {
  entry: PaletteEntry;
  active: boolean;
  onChoose: () => void;
}): JSX.Element {
  return (
    <div
      className={classes('cs-picker-row', active && 'is-active')}
      role="option"
      aria-selected={active}
      data-picker-row={`${entry.kind}:${entry.def}`}
      // mousedown, not click: the search input keeps focus, so a pointer
      // choice and Enter go through the exact same `choose`
      onMouseDown={(event) => {
        event.preventDefault();
        onChoose();
      }}
    >
      <KindIcon kind={entry.kind} />
      <span className="cs-picker-label">{entry.label}</span>
      <span className="cs-picker-id">{entry.def}</span>
    </div>
  );
}

export function NodePicker({ anchor, design, db, designs, onClose }: NodePickerProps): JSX.Element {
  const { dispatch, ensureAssembly } = useEditorApi();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const allEntries = useMemo(() => [...paletteEntries(db), ...subassemblyEntries(designs ?? [], design.id)], [db, designs, design.id]);

  // ranked once per open against the same design/db/anchor; typing in the
  // search box only filters it
  const ranked = useMemo(
    () => (anchor === undefined ? undefined : rankDefinitions(design, db, anchor, allEntries)),
    [allEntries, design, db, anchor],
  );

  const filtered = useMemo(
    () => allEntries.filter((entry) => matchesQuery(entry, query)),
    [allEntries, query],
  );
  const fitsList = useMemo(
    () => (ranked === undefined ? [] : ranked.fits.filter((entry) => matchesQuery(entry, query))),
    [ranked, query],
  );
  const otherList = useMemo(
    () => (ranked === undefined ? filtered : ranked.other.filter((entry) => matchesQuery(entry, query))),
    [ranked, filtered, query],
  );
  const flat = ranked === undefined ? filtered : [...fitsList, ...otherList];

  // the active row survives a query edit only while it still points at
  // something on screen
  useEffect(() => {
    setActive((current) => (flat.length === 0 ? 0 : Math.min(current, flat.length - 1)));
  }, [flat.length]);

  const choose = (entry: PaletteEntry): void => {
    const place = (rankDb: Db): void => {
      let wireTerminal: { terminal: string; end?: 'a' | 'b' } | undefined;
      if (anchor !== undefined) {
        // only an unambiguous best terminal is wired; a tie places + selects
        wireTerminal = autoWireTerminal(rankTerminals(design, rankDb, anchor, entry.kind, entry.def));
      }
      dispatch({
        type: 'add-instance-near',
        kind: entry.kind,
        def: entry.def,
        ...(anchor === undefined ? {} : { anchor }),
        ...(wireTerminal === undefined ? {} : { wireTerminal }),
      });
    };
    onClose();
    if (entry.kind === 'subassembly' && ensureAssembly !== undefined) {
      // the design's ports must be known before ranking and before the edit is validated
      void ensureAssembly(entry.def).then(place);
    } else {
      place(db);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, Math.max(flat.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = flat[active];
      if (entry !== undefined) choose(entry);
    }
  };

  return (
    <div className="cs-picker-scrim" onMouseDown={onClose}>
      <div
        className="cs-picker"
        role="dialog"
        aria-label="add a part"
        title="↑↓ move · Enter add · Esc close"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cs-picker-search">
          {anchor === undefined ? null : (
            <span className="cs-picker-anchor">
              {anchor.instance} · {anchor.terminal}
              {anchor.end === undefined ? '' : `@${anchor.end}`}
            </span>
          )}
          <input
            ref={inputRef}
            className="cs-picker-input"
            type="text"
            placeholder="search parts…"
            aria-label="search parts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="cs-picker-list" role="listbox" aria-label="parts">
          {flat.length === 0 ? <div className="cs-picker-empty">no matches</div> : null}
          {ranked === undefined
            ? filtered.map((entry, index) => (
                <PickerRow
                  key={`${entry.kind}:${entry.def}`}
                  entry={entry}
                  active={index === active}
                  onChoose={() => choose(entry)}
                />
              ))
            : (
                <>
                  {fitsList.length === 0 ? null : <div className="cs-picker-group">Fits here</div>}
                  {fitsList.map((entry, index) => (
                    <PickerRow
                      key={`${entry.kind}:${entry.def}`}
                      entry={entry}
                      active={index === active}
                      onChoose={() => choose(entry)}
                    />
                  ))}
                  {otherList.length === 0 ? null : <div className="cs-picker-group">Other</div>}
                  {otherList.map((entry, index) => (
                    <PickerRow
                      key={`${entry.kind}:${entry.def}`}
                      entry={entry}
                      active={fitsList.length + index === active}
                      onChoose={() => choose(entry)}
                    />
                  ))}
                </>
              )}
        </div>
      </div>
    </div>
  );
}
