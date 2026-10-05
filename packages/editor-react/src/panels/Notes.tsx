/**
 * Design-level notes: the build-level annotations a
 * design carries (`design.notes` — drain policy, why a pin is left open). A
 * note that names a terminal (`w1:core-brown.center@b`) also silences that
 * terminal's floating-end warning (`noteReferencesTerminal`), which is why
 * the Issues tab can add one in a click.
 *
 * Each note commits on blur, one undo step per edit, through the store's
 * `set-notes` action; joint notes are edited in the Connection tab.
 */

import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useEffect, useState, type JSX } from 'react';

import { classes, useEditorApi } from '../context.ts';
import type { EditorState } from '../store.ts';

/** The note the Issues tab's one-click fix adds for a floating end. */
export function floatingEndNote(where: string): string {
  return `${where}: left unconnected at this end on purpose.`;
}

export function NotesPanel({ state }: { state: EditorState }): JSX.Element {
  const { dispatch } = useEditorApi();
  const notes = state.design.notes ?? [];
  // drafts, so typing does not commit (and validate) per keystroke
  const [drafts, setDrafts] = useState<string[]>(notes);
  const [adding, setAdding] = useState(false);
  const [tagText, setTagText] = useState((state.design.tags ?? []).join(', '));
  useEffect(() => setTagText((state.design.tags ?? []).join(', ')), [state.design.tags]);
  const [labour, setLabour] = useState(state.design.labourMinutes === undefined ? '' : String(state.design.labourMinutes));
  useEffect(() => setLabour(state.design.labourMinutes === undefined ? '' : String(state.design.labourMinutes)), [state.design.labourMinutes]);
  useEffect(() => {
    setDrafts(state.design.notes ?? []);
  }, [state.design.notes]);

  const commit = (next: string[]): void => dispatch({ type: 'set-notes', notes: next });

  return (
    <div className="cs-panel cs-notes">
      <h2>
        notes <span className="cs-count">{notes.length}</span>
        <button
          type="button"
          className="cs-icon-btn cs-notes-add"
          title="Add a design note"
          aria-label="Add a design note"
          onClick={() => setAdding(true)}
        >
          <IconPlus size={14} />
        </button>
      </h2>
      <div className="cs-scroll">
        {notes.length === 0 && !adding ? <p className="cs-empty">no design notes</p> : null}
        <ol className="cs-notes-list">
          {drafts.map((draft, index) => (
            <li key={index} className="cs-note-row">
              <span className="cs-note-n">{index + 1}</span>
              <textarea
                className="cs-input cs-note-input"
                rows={Math.min(6, Math.max(1, Math.ceil(draft.length / 44)))}
                value={draft}
                aria-label={`design note ${index + 1}`}
                onChange={(event) => {
                  const value = event.target.value;
                  setDrafts((was) => was.map((note, i) => (i === index ? value : note)));
                }}
                onBlur={() => {
                  if (draft !== notes[index]) commit(drafts);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setDrafts(notes);
                    (event.target as HTMLTextAreaElement).blur();
                  }
                }}
              />
              <button
                type="button"
                className="cs-icon-btn"
                title="Remove this note"
                aria-label={`remove design note ${index + 1}`}
                onClick={() => commit(notes.filter((_, i) => i !== index))}
              >
                <IconTrash size={13} />
              </button>
            </li>
          ))}
          {adding ? (
            <li className={classes('cs-note-row', 'is-new')}>
              <span className="cs-note-n">{notes.length + 1}</span>
              <textarea
                className="cs-input cs-note-input"
                rows={2}
                autoFocus
                placeholder="note…"
                aria-label="new design note"
                onBlur={(event) => {
                  const text = event.target.value.trim();
                  setAdding(false);
                  if (text !== '') commit([...notes, text]);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    (event.target as HTMLTextAreaElement).value = '';
                    (event.target as HTMLTextAreaElement).blur();
                  }
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    (event.target as HTMLTextAreaElement).blur();
                  }
                }}
              />
            </li>
          ) : null}
        </ol>
        <label className="cs-field" title="Free tags (comma-separated) the hub's validation rules can select designs by, such as mil-spec or export.">
          <span>Design tags</span>
          <input
            className="cs-input"
            aria-label="design tags"
            placeholder="mil-spec, export"
            value={tagText}
            onChange={(event) => setTagText(event.target.value)}
            onBlur={() => dispatch({ type: 'set-tags', tags: tagText.split(',') })}
          />
        </label>
        <label className="cs-field" title="Hand labour to build one cable, in minutes. The BOM prices it at the hub's labour rate (engineering settings).">
          <span>Build labour (min)</span>
          <input
            className="cs-input cs-mono"
            inputMode="decimal"
            aria-label="build labour minutes"
            value={labour}
            onChange={(event) => setLabour(event.target.value)}
            onBlur={() => {
              const text = labour.trim();
              const minutes = text === '' ? undefined : Number(text);
              if (minutes !== undefined && !(Number.isFinite(minutes) && minutes >= 0)) {
                setLabour(state.design.labourMinutes === undefined ? '' : String(state.design.labourMinutes));
                return;
              }
              dispatch({ type: 'set-labour', minutes });
            }}
          />
        </label>
      </div>
    </div>
  );
}
