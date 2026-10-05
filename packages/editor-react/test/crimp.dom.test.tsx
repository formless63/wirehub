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
  toolsOfText,
  type ConnectorDraft,
  type MechanicalDraft,
} from '../src/library.ts';
import { bodyDraftOf, bodyOfDraft } from '../src/connector-journey.ts';
import { ConnectorEditor } from '../src/panels/ConnectorEditor.tsx';
import { ConnectorJourney } from '../src/panels/ConnectorJourney.tsx';
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

describe('a body\'s crimp housing (cs-5k1.27)', () => {
  const xh = db.bodies!.find((b) => b.id === 'jst-xh-2')!;

  it('a body keeps its housing through its draft, and the form edits it', () => {
    expect(xh.housing).toBeDefined();
    expect(bodyOfDraft(bodyDraftOf(xh)).housing).toEqual(xh.housing);
    const without = bodyOfDraft({ ...bodyDraftOf(xh), housing: undefined });
    expect('housing' in without).toBe(false);
  });

  it('the connector form shows the body\'s housing read-only while it has none of its own', () => {
    const connector = db.connectors.find((c) => c.body === 'jst-xh-2' && c.housing === undefined)!;
    render(<ConnectorEditor draft={connectorDraftOf(connector)} onChange={vi.fn()} idLocked bodyHousing={xh.housing!} />);
    const note = screen.getByTestId('body-housing');
    expect(note.textContent).toContain('xh-2-5');
    expect(note.textContent).toContain('unsealed');
    expect(note.textContent).toContain('Edit that on the body');
  });

  it('the journey edits the housing on the body and saves it with the body', () => {
    const { container } = render(<ConnectorJourney db={db} readOnly={false} takenIds={db.connectors.map((c) => c.id)} start={{ body: 'jst-xh-2' }} onSaved={() => undefined} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit body' }));
    // the body's own housing is on, with its systems
    expect((screen.getByLabelText('crimp housing') as HTMLInputElement).checked).toBe(true);
    const systems = container.querySelector<HTMLInputElement>('input[placeholder="sealed-1-5"]')!;
    expect(systems.value).toBe('xh-2-5');
    fireEvent.change(systems, { target: { value: 'xh-2-5, sealed-1-5' } });
    expect(systems.value).toBe('xh-2-5, sealed-1-5');
    fireEvent.click(screen.getByLabelText('crimp housing'));
    expect(container.querySelector('input[placeholder="sealed-1-5"]')).toBeNull();
  });
});

describe('per-tool crimp heights (cs-5k1.28)', () => {
  const contact = db.mechanicals!.find((m) => m.id === 'xh-contact-socket')!;
  const tools = [{ tool: 'xh-applicator-b', crimpHeights: [{ wireMm2: 0.205, heightMm: 1.2, widthMm: 1.6 }], stripMm: 3.5 }];
  const twoTools: Db = {
    ...db,
    mechanicals: [
      ...db.mechanicals!.map((m) => (m.id === contact.id ? { ...m, termination: { ...m.termination!, tools } } : m)),
      { id: 'xh-applicator-b', label: 'XH applicator B', kind: 'tool', src: 'synthetic example' },
    ],
  };

  it('the other-tools text round-trips through a contact\'s draft', () => {
    const edited = { ...contact, termination: { ...contact.termination!, tools } };
    expect(mechanicalOf(mechanicalDraftOf(edited)).termination?.tools).toEqual(tools);
    expect(toolsOfText('a: 0.5 1.2 1.7; 0.75 1.3\nb\n: junk\nc: strip 4; note bench 2')).toEqual([
      { tool: 'a', crimpHeights: [{ wireMm2: 0.5, heightMm: 1.2, widthMm: 1.7 }, { wireMm2: 0.75, heightMm: 1.3 }] },
      { tool: 'b' },
      { tool: 'c', stripMm: 4, note: 'bench 2' },
    ]);
  });

  it('the contact form edits the other tools', () => {
    let draft: MechanicalDraft = { ...blankMechanicalDraft(), kind: 'contact' };
    const onChange = vi.fn((next: MechanicalDraft) => {
      draft = next;
    });
    render(<MechanicalEditor draft={draft} onChange={onChange} idLocked={false} tools={[{ id: 'xh-applicator-b', label: 'XH applicator B' }]} />);
    fireEvent.change(screen.getByLabelText('other crimp tools'), { target: { value: 'xh-applicator-b: 0.205 1.2' } });
    expect(mechanicalOf({ ...draft, label: 'c', id: 'c', src: 's' }).termination?.tools).toEqual([{ tool: 'xh-applicator-b', crimpHeights: [{ wireMm2: 0.205, heightMm: 1.2 }] }]);
  });

  it('the Part tab offers a contact\'s tools per cavity and dispatches the pick', () => {
    const base = loadDesignFromDisk('dc-led-lead');
    const state = { ...initialEditorState(base, twoTools), selection: { kind: 'instance' as const, id: 'j2' } };
    const { dispatch, ui } = harness(state, <PartPanel state={state} />);
    render(ui);
    const select = screen.getByLabelText('tool for cavity 1') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options).map((o) => o.value)).toEqual([contact.termination!.tool, 'xh-applicator-b']);
    fireEvent.change(select, { target: { value: 'xh-applicator-b' } });
    const pick = dispatch.mock.calls[0]?.[0] as Extract<EditorAction, { type: 'apply-design' }>;
    expect(pick.design.instances.connectors[1]?.cavities?.[0]).toMatchObject({ pin: '1', tool: 'xh-applicator-b' });
  });

  it('shows no tool column when no contact has a choice', () => {
    const state = selected(loadDesignFromDisk('dc-led-lead'), 'j2');
    render(harness(state, <PartPanel state={state} />).ui);
    expect(screen.queryByLabelText('tool for cavity 1')).toBeNull();
  });
});
