/**
 * The vocabulary as a read-only browse list: one controlled list at a time
 * (signals, connector families, colour codes …), a search, and a compact
 * table — label, aliases, kind, and where the entry comes from. Ids are the
 * label's tooltip. Editing stays where each list is used (pickers add
 * entries); this page is for looking a word up.
 */

import type { Vocab, VocabEntry } from '@wirehub/model';
import { useMemo, useState, type JSX } from 'react';

import { Select } from '../ui/index.ts';

/** the lists people look up most, first; the rest follow in the order the vocabulary has them */
const FIRST = ['signals', 'families', 'colour-codes', 'levels', 'lanes'];

export function VocabularyBrowse(props: { vocab: Vocab | undefined }): JSX.Element {
  const lists = useMemo(() => {
    const ids = Object.keys(props.vocab ?? {}).filter((id) => (props.vocab?.[id]?.entries.length ?? 0) > 0);
    return [...FIRST.filter((id) => ids.includes(id)), ...ids.filter((id) => !FIRST.includes(id)).sort()];
  }, [props.vocab]);
  const [list, setList] = useState<string>(FIRST[0]!);
  const [query, setQuery] = useState('');
  const current = props.vocab?.[lists.includes(list) ? list : (lists[0] ?? '')];
  const needle = query.trim().toLowerCase();
  const rows = (current?.entries ?? [])
    .filter((e) => e.pending !== true && e.deprecatedBy === undefined)
    .filter((e) => needle === '' || [e.id, e.label, ...(e.aliases ?? [])].some((t) => t.toLowerCase().includes(needle)));
  const hasKind = rows.some((e) => typeof (e as VocabEntry & { kind?: unknown }).kind === 'string');
  return (
    <div className="cs-vocab-browse" data-testid="vocabulary-browse">
      <div className="cs-vocab-bar">
        <Select
          aria-label="Vocabulary list"
          className="cs-vocab-pick"
          value={current === undefined ? '' : (lists.find((id) => props.vocab?.[id] === current) ?? '')}
          onValueChange={setList}
          options={lists.map((id) => ({ value: id, label: props.vocab?.[id]?.label ?? id }))}
        />
        <input className="cs-input" type="search" aria-label="search the list" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="cs-count">{rows.length}</span>
      </div>
      <table className="cs-vocab-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Also</th>
            {hasKind ? <th>Kind</th> : null}
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => (
            <tr key={entry.id}>
              <td title={entry.id}>{entry.label}</td>
              <td className="is-dim">{(entry.aliases ?? []).join(', ')}</td>
              {hasKind ? <td className="is-dim">{String((entry as VocabEntry & { kind?: unknown }).kind ?? '')}</td> : null}
              <td className="is-dim" title={entry.src}>{entry.src}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
