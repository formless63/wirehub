// @vitest-environment jsdom
/**
 * Crimp contacts in the editor: the Part tab lists a crimp housing's cavities
 * and assigns contacts (one at a time or "fill all by wire gauge"), the issues
 * panel shows the cavity warnings, and the Library edits a contact's
 * termination block and a connector's housing.
 */

import { withCavities, type CableDesign, type Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditorContext } from '../src/context.ts';
import {
  blankMechanicalDraft,
  connectorDraftOf,
  connectorOf,
  draftFieldIssues,
  mechanicalDraftOf,
  mechanicalOf,
  type ConnectorDraft,
  type MechanicalDraft,
} from '../src/library.ts';
import { ConnectorEditor } from '../src/panels/ConnectorEditor.tsx';
import { IssuesPanel } from '../src/panels/Derived.tsx';
import { PartPanel } from '../src/panels/Inspector.tsx';
import { MechanicalEditor } from '../src/panels/MechanicalEditor.tsx';
import { initialEditorState, type EditorAction, type EditorState } from '../src/store.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

function harness(state: EditorState, children: ReactNode): { dispatch: ReturnType<typeof vi.fn>; ui: JSX.Element } {
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

function selected(design: CableDesign, id: string): EditorState {
  return { ...initialEditorState(design, db), selection: { kind: 'instance', id } };
}

describe('the Part tab cavities', () => {
  it('lists the cavities of a crimp housing with their wire and contact', () => {
    const state = selected(loadDesignFromDisk('dc-led-lead'), 'j2');
    render(harness(state, <PartPanel state={state} />).ui);
    const select = screen.getByLabelText('contact for cavity 1') as HTMLSelectElement;
    expect(select.value).toBe('xh-contact-socket');
    expect(screen.getAllByText('0.205 mm²')).toHaveLength(2);
  });

  it('shows no cavities for a solder-cup or screw-terminal part', () => {
    const state = selected(loadDesignFromDisk('dc-led-lead'), 'j1');
    render(harness(state, <PartPanel state={state} />).ui);
    expect(screen.queryByLabelText('cavities')).toBeNull();
  });

  it('a pick and "fill all by wire gauge" dispatch one undoable design edit each', () => {
    const bare = withCavities(loadDesignFromDisk('dc-led-lead'), 'j2', []);
    const state = selected(bare, 'j2');
    const { dispatch, ui } = harness(state, <PartPanel state={state} />);
    render(ui);
    fireEvent.change(screen.getByLabelText('contact for cavity 2'), { target: { value: 'xh-contact-socket' } });
    const pick = dispatch.mock.calls[0]?.[0] as Extract<EditorAction, { type: 'apply-design' }>;
    expect(pick.type).toBe('apply-design');
    expect(pick.design.instances.connectors[1]?.cavities).toEqual([{ pin: '2', contact: 'xh-contact-socket' }]);
    fireEvent.click(screen.getByText('fill all by wire gauge'));
    const fill = dispatch.mock.calls[1]?.[0] as Extract<EditorAction, { type: 'apply-design' }>;
    expect(fill.design.instances.connectors[1]?.cavities).toEqual([
      { pin: '1', contact: 'xh-contact-socket' },
      { pin: '2', contact: 'xh-contact-socket' },
    ]);
  });

  it('the issues panel names a cavity with no contact', () => {
    const state = initialEditorState(withCavities(loadDesignFromDisk('dc-led-lead'), 'j2', []), db);
    render(harness(state, <IssuesPanel state={state} />).ui);
    expect(screen.getAllByText(/cavity j2:1 takes a wire but has no contact/).length).toBeGreaterThan(0);
  });
});

describe('the Library edits contacts and housings', () => {
  it('a contact round-trips through its draft', () => {
    const contact = db.mechanicals!.find((m) => m.id === 'xh-contact-socket')!;
    expect(mechanicalOf(mechanicalDraftOf(contact))).toEqual(contact);
    const housing = { ...db.connectors.find((c) => c.id === 'jst-xh-2-dc')!, housing: { systems: ['xh-2-5'], sealing: 'none' as const } };
    expect(connectorOf(connectorDraftOf(housing)).housing).toEqual(housing.housing);
  });

  it('the mechanical editor shows the termination form for a contact and checks its numbers', () => {
    let draft: MechanicalDraft = { ...blankMechanicalDraft(), kind: 'contact' };
    const onChange = vi.fn((next: MechanicalDraft) => {
      draft = next;
    });
    render(<MechanicalEditor draft={draft} onChange={onChange} idLocked={false} tools={[{ id: 'xh-crimp-tool', label: 'XH tool' }]} />);
    fireEvent.change(screen.getByLabelText('Wire from (mm²)'), { target: { value: '0.5' } });
    expect(draft.termination?.wireMinMm2).toBe('0.5');
    expect(screen.getByRole('option', { name: 'XH tool' })).toBeDefined();
    const bad: MechanicalDraft = { ...draft, termination: { ...draft.termination!, wireMinMm2: '1', wireMaxMm2: '0.5' } };
    expect(draftFieldIssues({ kind: 'mechanicals', value: bad }).map((i) => i.where)).toEqual(['wire range']);
    expect(mechanicalOf({ ...bad, label: 'c', id: 'c', src: 's' }).termination).toEqual({ wireMinMm2: 1, wireMaxMm2: 0.5 });
  });

  it('a shell shows no termination form', () => {
    render(<MechanicalEditor draft={blankMechanicalDraft()} onChange={vi.fn()} idLocked={false} />);
    expect(screen.queryByText('What it fits')).toBeNull();
  });

  it('the connector editor turns a crimp housing on and sets its sealing', () => {
    let draft: ConnectorDraft = connectorDraftOf(db.connectors.find((c) => c.id === 'jst-xh-2-dc')!);
    const onChange = vi.fn((next: ConnectorDraft) => {
      draft = next;
    });
    const { rerender } = render(<ConnectorEditor draft={draft} onChange={onChange} idLocked />);
    fireEvent.click(screen.getByLabelText('crimp housing'));
    rerender(<ConnectorEditor draft={draft} onChange={onChange} idLocked />);
    fireEvent.click(screen.getByLabelText('plug unused cavities'));
    expect(connectorOf(draft).housing).toEqual({ plugUnused: true });
  });
});
