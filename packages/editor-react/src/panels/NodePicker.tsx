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
  IconBuildingStore,
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
import { Kbd } from '../ui/Kbd.tsx';
import { autoWireTerminal, rankDefinitions, rankTerminals } from '../picker.ts';
import { matchesQuery, paletteEntries, subassemblyEntries, type PaletteEntry } from './Palette.tsx';

/** One installable match the store offers for a search: the picker only links to its install drawer. */
export interface PartStoreMatch {
  id: string;
  label: string;
  /** a short secondary text (the pack's domain, its version) */
  detail?: string;
}

/** The host's store search, for the picker's "From the store" row. */
export interface PartStoreSource {
  search: (query: string) => Promise<readonly PartStoreMatch[]> | readonly PartStoreMatch[];
  /** opens the match's install drawer */
  open: (match: PartStoreMatch) => void;
}

export interface NodePickerProps {
  /** the free handle this was opened from — `undefined` for Tab-at-centre / "Add part…" */
  anchor?: TerminalRef;
  design: CableDesign;
  db: Db;
  /** the host's other designs, offered as sub-assemblies */
  designs?: readonly { id: string; label: string }[] | undefined;
  /** installable matches for the query, when the host has a store */
  store?: PartStoreSource | undefined;
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

/** The picker's groups, in order: a part's kind decides its group. */
const KIND_GROUPS: { kind: InstanceKind; title: string }[] = [
  { kind: 'connector', title: 'Connectors' },
  { kind: 'segment', title: 'Wire stocks' },
  { kind: 'component', title: 'Components' },
  { kind: 'pcba', title: 'Boards' },
  { kind: 'subassembly', title: 'Designs' },
];

type PickerItem = { type: 'part'; entry: PaletteEntry } | { type: 'store'; match: PartStoreMatch };
interface PickerSection {
  title: string;
  items: PickerItem[];
}

function PickerRow({
  entry,
  active,
  optionId,
  onChoose,
}: {
  entry: PaletteEntry;
  active: boolean;
  optionId: string;
  onChoose: () => void;
}): JSX.Element {
  return (
    <div
      id={optionId}
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

export function NodePicker({ anchor, design, db, designs, store, onClose }: NodePickerProps): JSX.Element {
  const { dispatch, ensureAssembly } = useEditorApi();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [storeMatches, setStoreMatches] = useState<readonly PartStoreMatch[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const allEntries = useMemo(() => [...paletteEntries(db), ...subassemblyEntries(designs ?? [], design.id)], [db, designs, design.id]);

  // ranked once per open against the same design/db/anchor; typing in the
  // search box only filters it
  const ranked = useMemo(
    () => (anchor === undefined ? undefined : rankDefinitions(design, db, anchor, allEntries)),
    [allEntries, design, db, anchor],
  );

  // the store is asked after the typing settles, and only for a real query; an
  // answer for an older query is dropped
  useEffect(() => {
    const text = query.trim();
    if (store === undefined || text.length < 2) {
      setStoreMatches([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void Promise.resolve(store.search(text)).then(
        (matches) => {
          if (live) setStoreMatches(matches.slice(0, 5));
        },
        () => {
          if (live) setStoreMatches([]);
        },
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [store, query]);

  const sections = useMemo(() => {
    const out: PickerSection[] = [];
    const fits = ranked === undefined ? [] : ranked.fits.filter((entry) => matchesQuery(entry, query));
    if (fits.length > 0) out.push({ title: 'Fits here', items: fits.map((entry) => ({ type: 'part' as const, entry })) });
    const fitted = new Set(fits);
    const rest = (ranked === undefined ? allEntries : ranked.other).filter((entry) => matchesQuery(entry, query) && !fitted.has(entry));
    for (const group of KIND_GROUPS) {
      const items = rest.filter((entry) => entry.kind === group.kind);
      if (items.length > 0) out.push({ title: group.title, items: items.map((entry) => ({ type: 'part' as const, entry })) });
    }
    if (storeMatches.length > 0) out.push({ title: 'From the store', items: storeMatches.map((match) => ({ type: 'store' as const, match })) });
    return out;
  }, [ranked, allEntries, query, storeMatches]);
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  // the active row survives a query edit only while it still points at
  // something on screen
  useEffect(() => {
    setActive((current) => (flat.length === 0 ? 0 : Math.min(current, flat.length - 1)));
  }, [flat.length]);

  const choose = (item: PickerItem): void => {
    if (item.type === 'store') {
      onClose();
      store?.open(item.match);
      return;
    }
    const entry = item.entry;
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
    } else if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, Math.max(flat.length - 1, 0)));
    } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = flat[active];
      if (item !== undefined) choose(item);
    }
  };

  // keep the active row on screen while arrowing through a long list
  useEffect(() => {
    document.querySelector('.cs-picker-row.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, flat.length]);

  let index = -1;
  return (
    <div className="cs-picker-scrim" onMouseDown={onClose}>
      <div className="cs-picker" role="dialog" aria-label="add a part" onMouseDown={(event) => event.stopPropagation()}>
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
            placeholder="Search parts"
            aria-label="search parts"
            role="combobox"
            aria-expanded="true"
            aria-controls="cs-picker-list"
            aria-activedescendant={flat.length === 0 ? undefined : `cs-picker-opt-${active}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="cs-picker-list" id="cs-picker-list" role="listbox" aria-label="parts">
          {flat.length === 0 ? <div className="cs-picker-empty">No matches</div> : null}
          {sections.map((section) => (
            <div key={section.title} role="group" aria-label={section.title}>
              <div className="cs-picker-group">{section.title}</div>
              {section.items.map((item) => {
                index += 1;
                const at = index;
                if (item.type === 'part') {
                  return <PickerRow key={`${section.title}:${item.entry.kind}:${item.entry.def}`} entry={item.entry} optionId={`cs-picker-opt-${at}`} active={at === active} onChoose={() => choose(item)} />;
                }
                return (
                  <div
                    key={`store:${item.match.id}`}
                    id={`cs-picker-opt-${at}`}
                    className={classes('cs-picker-row', at === active && 'is-active')}
                    role="option"
                    aria-selected={at === active}
                    data-picker-row={`store:${item.match.id}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(item);
                    }}
                  >
                    <span className="cs-picker-icon cs-picker-icon-store" aria-hidden="true">
                      <IconBuildingStore size={12} />
                    </span>
                    <span className="cs-picker-label">{item.match.label}</span>
                    <span className="cs-picker-id">{item.match.detail ?? 'install'}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cs-picker-foot" aria-hidden="true">
          <Kbd>↑↓</Kbd> move <Kbd>Enter</Kbd> add <Kbd>Esc</Kbd> close
        </div>
      </div>
    </div>
  );
}
