/**
 * The design's required manufacturing processes (`@wirehub/model` `processes.ts`): the ones its
 * parts imply (derived, read-only, the matching parts on hover) and the ones declared by hand
 * (removable, with a note). Declared ones are picked from the hub's processes (Settings ›
 * Processes); each change is one undo step through `apply-design`.
 */

import { useMemo, useState, type JSX } from 'react';

import { processesInForce, requiredProcesses, type DeclaredProcess } from '@wirehub/model';

import { useEditorApi } from '../context.ts';
import type { EditorState } from '../store.ts';
import { Chip, Select } from '../ui/index.ts';

export function ProcessesFields({ state }: { state: EditorState }): JSX.Element | null {
  const { dispatch } = useEditorApi();
  const { design, db } = state;
  const inForce = useMemo(() => processesInForce(db), [db]);
  const required = useMemo(() => requiredProcesses(design, db).processes, [design, db]);
  const declared: DeclaredProcess[] = Array.isArray(design.processes) ? design.processes : [];
  const [noteFor, setNoteFor] = useState<string | undefined>(undefined);
  const [noteText, setNoteText] = useState('');
  if (inForce.size === 0 && required.length === 0) return null;

  const commit = (next: DeclaredProcess[], description: string): void => {
    const { processes: _was, ...rest } = design;
    dispatch({ type: 'apply-design', design: next.length === 0 ? rest : { ...rest, processes: next }, description });
  };
  const addable = [...inForce.values()].filter((p) => !declared.some((d) => d.id === p.id));

  return (
    <div className="cs-processes" role="group" aria-label="Required processes">
      <span className="cs-processes-label" title="Manufacturing processes this design needs. Derived ones come from its parts (Settings › Processes).">Processes</span>
      <div className="cs-processes-chips">
        {required.map((p) => {
          const own = declared.find((d) => d.id === p.id);
          const parts = (p.derived?.matches ?? []).map((m) => m.subject).join(', ') + ((p.derived?.more ?? 0) > 0 ? ` +${p.derived?.more}` : '');
          const title = [p.derived === undefined ? '' : `derived: ${parts}`, own?.note ?? '', p.known ? '' : 'not in this hub\'s processes', own === undefined ? '' : 'click for a note'].filter(Boolean).join(' · ');
          return (
            <Chip
              key={p.id}
              tone={p.known ? (p.source === 'derived' ? 'info' : 'neutral') : 'warn'}
              title={title || undefined}
              data-process={p.id}
              data-source={p.source}
              data-declared={own === undefined ? undefined : true}
              onClick={own === undefined ? undefined : () => { setNoteFor(p.id); setNoteText(own.note ?? ''); }}
              {...(own === undefined ? {} : { onRemove: () => commit(declared.filter((d) => d.id !== p.id), `removed process ${p.label}`), removeLabel: `Remove process ${p.label}` })}
            >
              {p.label}
              {p.source === 'declared' ? '' : ' (auto)'}
            </Chip>
          );
        })}
        {addable.length === 0 ? null : (
          <Select
            aria-label="Add a process"
            className="cs-processes-add"
            placeholder="add process…"
            value={undefined}
            options={addable.map((p) => ({ value: p.id, label: p.label }))}
            onValueChange={(id) => commit([...declared, { id }], `declared process ${inForce.get(id)?.label ?? id}`)}
          />
        )}
      </div>
      {noteFor === undefined ? null : (
        <input
          className="cs-input cs-processes-note"
          autoFocus
          aria-label={`note on process ${inForce.get(noteFor)?.label ?? noteFor}`}
          placeholder="note…"
          maxLength={500}
          value={noteText}
          onChange={(event) => setNoteText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setNoteFor(undefined);
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
          onBlur={() => {
            const id = noteFor;
            setNoteFor(undefined);
            const was = declared.find((d) => d.id === id);
            const note = noteText.trim();
            if (was === undefined || (was.note ?? '') === note) return;
            commit(declared.map((d) => (d.id === id ? { id, ...(note === '' ? {} : { note }) } : d)), `changed the note on process ${inForce.get(id)?.label ?? id}`);
          }}
        />
      )}
    </div>
  );
}
