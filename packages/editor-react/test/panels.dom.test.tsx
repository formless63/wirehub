// @vitest-environment jsdom
/**
 * Components, lightly. The panels are thin views over state that is tested
 * elsewhere, so this only checks that they render the model's own words and
 * that their controls dispatch the intended edit — no markup snapshots.
 */

import type { Db } from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditorContext } from '../src/context.ts';
import { deriveFlow, type EditorNode } from '../src/derive.ts';
import { diskDepictions, loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';
import { NotesPanel, floatingEndNote } from '../src/panels/Notes.tsx';
import { IssuesPanel, NetsPanel, TracePanel } from '../src/panels/Derived.tsx';
import { ConnectionPanel, PartPanel } from '../src/panels/Inspector.tsx';
import { Palette } from '../src/panels/Palette.tsx';
import { initialEditorState, type EditorAction, type EditorState } from '../src/store.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

function harness(state: EditorState, children: ReactNode): {
  dispatch: ReturnType<typeof vi.fn>;
  ui: JSX.Element;
} {
  const dispatch = vi.fn<(action: EditorAction) => void>();
  return {
    dispatch,
    ui: (
      <EditorContext.Provider value={{ dispatch, selection: state.selection, openPicker: vi.fn(), partLabelsVisible: false }}>
        {children}
      </EditorContext.Provider>
    ),
  };
}


describe('derived panels', () => {
  it('lists the nets core derived', () => {
    const state = initialEditorState(loadDesignFromDisk('de9-terminal-board'), db);
    const { ui } = harness(state, <NetsPanel state={state} />);
    render(ui);
    expect(screen.getByText('net-1')).toBeDefined();
    expect(screen.getAllByText(/^j1:/).length).toBeGreaterThan(0);
  });

  it('reports a clean design as clean and a broken one in the validator words', () => {
    const clean = initialEditorState(loadDesignFromDisk('de9-terminal-board'), db);
    render(harness(clean, <IssuesPanel state={clean} />).ui);
    expect(screen.getByText('clean')).toBeDefined();
    // no compatibility warnings either — nothing to group
    expect(screen.queryByText('Compatibility')).toBeNull();
    cleanup();

    const broken: EditorState = {
      ...clean,
      issues: [
        { code: 'unknown-def', severity: 'error', message: 'made up for the view', where: 'jX' },
      ],
    };
    render(harness(broken, <IssuesPanel state={broken} />).ui);
    expect(screen.getByText('unknown-def')).toBeDefined();
    expect(screen.getByText('made up for the view')).toBeDefined();
  });

  it('offers a design note as the fix for a floating end, naming the terminal', () => {
    const base = initialEditorState(loadDesignFromDisk('de9-terminal-board'), db);
    const state: EditorState = {
      ...base,
      issues: [
        {
          code: 'floating-conductor-end',
          severity: 'warning',
          message: 'made up for the view',
          where: 'w1:core-brown.center@b',
        },
      ],
    };
    const { dispatch, ui } = harness(state, <IssuesPanel state={state} />);
    render(ui);
    fireEvent.click(screen.getByRole('button', { name: 'add a design note naming w1:core-brown.center@b' }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'set-notes',
      notes: [...(base.design.notes ?? []), floatingEndNote('w1:core-brown.center@b')],
    });
  });

  it('edits design notes: add, change, remove', () => {
    const state = initialEditorState(loadDesignFromDisk('de9-terminal-board'), db);
    const notes = state.design.notes ?? [];
    const { dispatch, ui } = harness(state, <NotesPanel state={state} />);
    render(ui);
    fireEvent.click(screen.getByRole('button', { name: 'Add a design note' }));
    const fresh = screen.getByRole('textbox', { name: 'new design note' });
    fireEvent.blur(fresh, { target: { value: 'j1:10 unused on this build' } });
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'set-notes', notes: [...notes, 'j1:10 unused on this build'] });
    if (notes.length > 0) {
      fireEvent.click(screen.getByRole('button', { name: 'remove design note 1' }));
      expect(dispatch).toHaveBeenLastCalledWith({ type: 'set-notes', notes: notes.slice(1) });
      const first = screen.getByRole('textbox', { name: 'design note 1' });
      fireEvent.change(first, { target: { value: 'reworded' } });
      fireEvent.blur(first);
      expect(dispatch).toHaveBeenLastCalledWith({ type: 'set-notes', notes: ['reworded', ...notes.slice(1)] });
    }
  });

  it('traces from the selected terminal', () => {
    const base = initialEditorState(loadDesignFromDisk('de9-terminal-board'), db);
    const state: EditorState = {
      ...base,
      selection: { kind: 'terminal', ref: { instance: 'j1', terminal: '1' } },
    };
    const { ui } = harness(state, <TracePanel state={state} />);
    render(ui);
    expect(screen.getByText('j1:1')).toBeDefined();
    expect(screen.getAllByText(/reached/).length).toBeGreaterThan(0);
  });
});

describe('Palette', () => {
  it('filters the library and adds the part the user picked', () => {
    const state = initialEditorState(loadDesignFromDisk('de9-terminal-board'), db);
    const { dispatch, ui } = harness(state, <Palette db={db} />);
    render(ui);

    fireEvent.change(screen.getByPlaceholderText('filter definitions…'), {
      target: { value: 'jst-xh-2-dc' },
    });
    const add = screen.getAllByTitle('add jst-xh-2-dc');
    expect(add).toHaveLength(1);
    fireEvent.click(add[0] as HTMLElement);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'add-instance',
      kind: 'connector',
      def: 'jst-xh-2-dc',
    });
  });
});

describe('label text in the inspector (cs-5k1.20)', () => {
  it('edits a segment run label, its end text and a core label, and a connector label', () => {
    const design = loadDesignFromDisk('de9-crossover');
    const seg = design.instances.segments[0]!.id;
    const state: EditorState = { ...initialEditorState(design, db), selection: { kind: 'instance', id: seg } };
    const { dispatch, ui } = harness(state, <PartPanel state={state} />);
    render(ui);
    const run = screen.getByLabelText('run label');
    fireEvent.change(run, { target: { value: 'FEED-1' } });
    fireEvent.blur(run);
    expect(dispatch).toHaveBeenCalledWith({ type: 'update-instance', id: seg, patch: { label: 'FEED-1' } });
    const endA = screen.getByLabelText('end A text');
    fireEvent.change(endA, { target: { value: 'FEED-1 | to AMP' } });
    fireEvent.blur(endA);
    expect(dispatch).toHaveBeenCalledWith({ type: 'update-instance', id: seg, patch: { endLabels: { a: ['FEED-1', 'to AMP'] } } });
    const core = screen.getAllByLabelText(/^core /)[0]!;
    fireEvent.change(core, { target: { value: 'sync' } });
    fireEvent.blur(core);
    const call = dispatch.mock.calls.map((c) => c[0]).find((a) => a.type === 'update-instance' && 'coreLabels' in a.patch);
    expect(call).toBeDefined();

    cleanup();
    const cstate: EditorState = { ...initialEditorState(design, db), selection: { kind: 'instance', id: 'j1' } };
    const second = harness(cstate, <PartPanel state={cstate} />);
    render(second.ui);
    fireEvent.change(screen.getByLabelText('label'), { target: { value: 'SOURCE' } });
    expect(second.dispatch).toHaveBeenCalledWith({ type: 'update-instance', id: 'j1', patch: { label: 'SOURCE' } });
  });
});
