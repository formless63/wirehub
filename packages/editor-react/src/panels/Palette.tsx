/**
 * The parts palette: everything the definition library knows about, filtered.
 * Drag onto the canvas (or click `+`) to add an instance — which is an edit
 * like any other, so it goes through the validator before it exists.
 */

import type { Db, InstanceKind } from '@wirehub/model';
import { wireDisplayName } from '@wirehub/docs';
import { useMemo, useState, type DragEvent, type JSX } from 'react';

import { useCoverSlot } from '../cover-slot.ts';
import { PALETTE_MECHANICAL_KINDS } from '../mechanical-add.ts';
import { useEditorApi } from '../context.ts';

export const PART_MIME = 'application/x-wirehub-part';

export interface PaletteEntry {
  kind: InstanceKind;
  def: string;
  label: string;
  detail: string;
}

/** A palette row: an instance kind, or `mechanical` — a shell or hardware part (no canvas node; BOM and device). */
export interface PaletteItem extends Omit<PaletteEntry, 'kind'> {
  kind: InstanceKind | 'mechanical';
}

/** Every definition in the library, flattened into palette entries. */
export function paletteEntries(db: Db): PaletteEntry[] {
  return [
    ...db.connectors.map((definition) => ({
      kind: 'connector' as const,
      def: definition.id,
      label: definition.label,
      detail: `${definition.family} · ${definition.pins.length} pins`,
    })),
    ...db.wires.map((definition) => ({
      kind: 'segment' as const,
      def: definition.id,
      // never the manufacturer — the maker stays in the Library's wire detail
      label: wireDisplayName(db, definition.id),
      detail: definition.partNumber ?? 'wire stock',
    })),
    ...db.components.map((definition) => ({
      kind: 'component' as const,
      def: definition.id,
      label: `${definition.label}${definition.value === undefined ? '' : ` — ${definition.value}`}`,
      detail: definition.kind,
    })),
    ...db.pcbas.map((definition) => ({
      kind: 'pcba' as const,
      def: definition.id,
      label: definition.partNumber || definition.label,
      detail: [definition.partNumber ? definition.label : undefined, definition.revision, definition.build].filter((w) => w !== undefined && w !== '').join(' · '),
    })),
  ];
}

/** Shells and hardware, for the palette only: they are no canvas node, so the node picker never offers them. */
export function mechanicalEntries(db: Db): PaletteItem[] {
  return (db.mechanicals ?? []).filter((definition) => PALETTE_MECHANICAL_KINDS.has(definition.kind)).map((definition) => ({
    kind: 'mechanical' as const,
    def: definition.id,
    label: definition.label,
    detail: [definition.kind, definition.partNumber].filter((w) => w !== undefined && w !== '').join(' · '),
  }));
}

export function matchesQuery(entry: PaletteItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return `${entry.def} ${entry.label} ${entry.detail} ${entry.kind}`
    .toLowerCase()
    .includes(needle);
}

const GROUPS: { kind: PaletteItem['kind']; title: string }[] = [
  { kind: 'connector', title: 'connectors' },
  { kind: 'segment', title: 'wire stock' },
  { kind: 'component', title: 'components' },
  { kind: 'pcba', title: 'PCBAs' },
  { kind: 'subassembly', title: 'sub-assemblies (designs)' },
  { kind: 'mechanical', title: 'shells & hardware' },
];

/** Other designs, as sub-assemblies to place (never the design itself). */
export function subassemblyEntries(designs: readonly { id: string; label: string }[], current?: string): PaletteEntry[] {
  return designs
    .filter((design) => design.id !== current)
    .map((design) => ({ kind: 'subassembly' as const, def: design.id, label: design.label, detail: 'design' }))
    .sort((a, b) => (a.def < b.def ? -1 : a.def > b.def ? 1 : 0));
}

export function Palette({ db, designs, current }: { db: Db; designs?: readonly { id: string; label: string }[] | undefined; current?: string }): JSX.Element {
  const { dispatch, placeSubassembly } = useEditorApi();
  const cover = useCoverSlot();
  const [query, setQuery] = useState('');
  const entries = useMemo((): PaletteItem[] => [...paletteEntries(db), ...subassemblyEntries(designs ?? [], current), ...mechanicalEntries(db)], [db, designs, current]);
  const visible = useMemo(
    () => entries.filter((entry) => matchesQuery(entry, query)),
    [entries, query],
  );

  const onDragStart = (entry: PaletteItem) => (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(
      PART_MIME,
      JSON.stringify({ kind: entry.kind, def: entry.def }),
    );
    event.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className="cs-panel cs-palette">
      <h2>parts</h2>
      <input
        className="cs-input"
        placeholder="filter definitions…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="cs-scroll">
        {GROUPS.map((group) => {
          const items = visible.filter((entry) => entry.kind === group.kind);
          if (items.length === 0) return null;
          return (
            <section key={group.kind}>
              <h3>
                {group.title} <span className="cs-count">{items.length}</span>
              </h3>
              {items.map((entry) => (
                <div
                  key={`${entry.kind}:${entry.def}`}
                  className={`cs-part-item cs-part-${entry.kind}${entry.kind === 'subassembly' && cover !== undefined ? ' has-cover' : ''}`}
                  draggable
                  onDragStart={onDragStart(entry)}
                  title={`${entry.def} — drag onto the canvas`}
                >
                  {entry.kind === 'subassembly' && cover !== undefined ? <span className="cs-part-cover">{cover('designs', entry.def, entry.label)}</span> : null}
                  <span className="cs-part-label">{entry.label}</span>
                  <span className="cs-part-detail">{entry.detail}</span>
                  <button
                    type="button"
                    className="cs-add"
                    onClick={() =>
                      entry.kind === 'mechanical'
                        ? dispatch({ type: 'add-mechanical', def: entry.def })
                        : entry.kind === 'subassembly' && placeSubassembly !== undefined
                          ? placeSubassembly(entry.def)
                          : dispatch({ type: 'add-instance', kind: entry.kind, def: entry.def })
                    }
                    title={`add ${entry.def}`}
                  >
                    +
                  </button>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
