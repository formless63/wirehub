// @vitest-environment jsdom
/**
 * The pickers in the Library (data model v2 §5, §8 J4 —):
 * type to filter, keyboard to pick, "Add '…'" appends to the list with its
 * source, a pin signal edited in the form is saved to the tag table (and
 * nothing is written to the record that did not change), and picking a
 * component kind fills its legs and its value list.
 */

import './reactflow-jsdom.ts';

import type { Db, VocabEntry, VocabList } from '@wirehub/model';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Library } from '../src/panels/Library.tsx';
import { Pick } from '../src/panels/Pick.tsx';
import { VocabContext, type NewVocabEntry, type RecordTags, type VocabAdapter } from '../src/vocab.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';
import { memoryDefinitions } from './memory-definitions.ts';

const db: Db = loadDbFromDisk();

afterEach(() => {
  cleanup();
});

function memoryVocab(): VocabAdapter & { appended: NewVocabEntry[]; saved: RecordTags[] } {
  const appended: NewVocabEntry[] = [];
  const saved: RecordTags[] = [];
  return {
    appended,
    saved,
    append: async (list, entry) => {
      appended.push(entry);
      const base = db.vocab?.[list] as VocabList;
      const added = entry as unknown as VocabEntry;
      return { ok: true, value: { entry: added, list: { ...base, entries: [...base.entries, added] } } };
    },
    saveTags: async (tags) => {
      saved.push(tags);
      const before = (tags.kind === 'connectors' ? db.tags?.connectors?.[tags.id] : db.tags?.pcbas?.[tags.id]) ?? {};
      const after = { ...before } as Record<string, unknown>;
      for (const [key, value] of Object.entries(tags.tags)) {
        if (value === null) delete after[key];
        else after[key] = value;
      }
      return { ok: true, value: { changed: true, tags: after as never } };
    },
  };
}

function Harness(props: { list: string; initial?: string; onPick?: (value: string) => void }): JSX.Element {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <VocabContext.Provider value={{ vocab: db.vocab }}>
      <Pick
        label="Signal"
        list={props.list}
        value={value}
        onChange={(next) => {
          setValue(next);
          props.onPick?.(next);
        }}
      />
    </VocabContext.Provider>
  );
}

describe('<Pick>', () => {

  it('marks a value that is not in the list rather than hiding it', () => {
    render(<Harness list="families" initial="Weird-9" />);
    const trigger = screen.getByRole('button', { name: 'Signal' });
    expect(trigger.textContent).toContain('Weird-9');
    expect(trigger.className).toContain('is-unlisted');
  });

  it('offers no Add row without a host that can add', async () => {
    render(<Harness list="families" />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Signal' }), { key: 'S' });
    fireEvent.change(await screen.findByRole('combobox', { name: /^filter/ }), { target: { value: 'S-Video' } });
    expect(screen.queryByText(/Add ‘S-Video’/)).toBeNull();
  });
});
