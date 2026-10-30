/** On a board's record: the enclosures that hold it, and "New enclosure" (a shell with this board placed once). */
import { useState, type JSX } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Section, type DefinitionsAdapter } from '@wirehub/editor-react';
import type { Db, MechanicalDefinition, PcbaDefinition } from '@wirehub/model';

import { useSectionAdd } from '../shell/RecordSections.tsx';

export function enclosuresOf(db: Db, pcba: string): MechanicalDefinition[] {
  return (db.mechanicals ?? []).filter((m) => m.enclosure?.boards.some((b) => b.pcba === pcba) === true);
}

/** A new shell holding each of `boards` once (a design's boards: one occurrence per placement). */
export function newEnclosureRecord(db: Db, boards: readonly PcbaDefinition[]): MechanicalDefinition {
  const first = boards[0]!;
  const taken = new Set((db.mechanicals ?? []).map((m) => m.id));
  let id = `${first.id}-enclosure`;
  for (let n = 2; taken.has(id); n += 1) id = `${first.id}-enclosure-${n}`;
  const label = boards.map((b) => b.label).filter((l, i, all) => all.indexOf(l) === i).join(' + ');
  const n = new Map<string, number>();
  const occurrences = boards.map((b) => {
    const k = (n.get(b.id) ?? 0) + 1;
    n.set(b.id, k);
    return { id: `${b.id.split('-').slice(0, 2).join('-')}-${k}`, pcba: b.id };
  });
  return {
    id, label: `${label} enclosure`, kind: 'shell',
    src: `Enclosure design parameters for ${label}; the solids are generated from them (WireHub enclosure tool pack).`,
    enclosure: { boards: [...new Map(boards.map((b) => [b.id, { pcba: b.id, geometry: 'native' as const }])).values()], occurrences },
  };
}

export function BoardEnclosures({ board, db, definitions, onCreated, onOpen, readOnly }: {
  board: PcbaDefinition; db: Db; definitions: DefinitionsAdapter | undefined; onCreated: () => void; onOpen: (id: string) => void; readOnly: boolean;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const list = enclosuresOf(db, board.id);
  const create = async (): Promise<void> => {
    if (definitions === undefined) return;
    const record = newEnclosureRecord(db, [board]);
    const id = record.id;
    setBusy(true);
    setError(undefined);
    try {
      const out = await definitions.create('mechanicals', record);
      if (!out.ok) { setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`); return; }
      onCreated();
      onOpen(id);
    } finally {
      setBusy(false);
    }
  };
  const empty = list.length === 0;
  const hosted = useSectionAdd('enclosures', 'Enclosure', empty && !readOnly && definitions !== undefined, () => void create());
  if (hosted && empty) return error === undefined ? null : <span role="alert" className="text-xs text-err">{error}</span>;
  return (
    <Section id="enclosures" title="Enclosures" testId="board-enclosures" summary={empty ? 'none' : `${list.length}`}
      actions={<>
        <Link to="/explore" search={{ board: board.id }} className="cs-ui-btn no-underline" data-variant="ghost" data-size="xs">Explore</Link>
        {readOnly || definitions === undefined ? null : <Button size="xs" disabled={busy} loading={busy} onClick={() => void create()}>New enclosure</Button>}
      </>}>
      {empty && error === undefined ? null : <div className="flex flex-wrap items-center gap-1">
        {list.map((m) => <Button key={m.id} size="xs" variant="ghost" onClick={() => onOpen(m.id)}>{m.label}</Button>)}
        {error === undefined ? null : <span role="alert" className="text-err">{error}</span>}
      </div>}
    </Section>
  );
}
