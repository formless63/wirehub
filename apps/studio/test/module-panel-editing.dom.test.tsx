// @vitest-environment jsdom
import '../../../packages/editor-react/test/reactflow-jsdom.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import { CableEditor, EditSessionContext } from '@wirehub/editor-react';
import type { CableDesign } from '@wirehub/model';
import { createRegistry, defineModule, type PanelProps } from '@wirehub/modules';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { editorExtensions, ModulePanels } from '../src/modules/slots.tsx';
import { memoryPersistence } from '../../../packages/editor-react/test/memory-persistence.ts';

const data = join(process.cwd(), '../../packages/catalog/data');
const db = createCatalog(fsCatalogSource(data)).loadDb();
const design = JSON.parse(readFileSync(join(data, 'designs/de9-terminal-board.json'), 'utf8')) as CableDesign;
let observed: PanelProps | undefined;
function EditablePanel(props: PanelProps) {
  observed = props;
  const d = props.design;
  return <div>
    <output data-testid="panel-label">{d?.label}</output>
    <output data-testid="panel-minutes">{String((d?.extensions?.['synthetic-panel'] as { minutes?: number } | undefined)?.minutes ?? 0)}</output>
    <button disabled={props.onChange === undefined} onClick={() => d === undefined ? undefined : props.onChange?.({ ...d, extensions: { ...d.extensions, 'synthetic-panel': { minutes: 15 } } }, 'set panel minutes')}>Apply panel minutes</button>
    <button disabled={props.onChange === undefined} onClick={() => d === undefined ? undefined : props.onChange?.({ ...d, instances: { ...d.instances, connectors: [...d.instances.connectors, d.instances.connectors[0]!] } }, 'invalid panel edit')}>Invalid panel edit</button>
  </div>;
}
const registry = createRegistry([defineModule({ id: 'synthetic-panel', label: 'Synthetic panel', version: '1.0.0', panels: [{ id: 'edit', label: 'Edit panel', slot: 'cable-inspector', component: EditablePanel }, { id: 'documents', label: 'Document panel', slot: 'cable-documents', component: EditablePanel }] })]);
const extensions = editorExtensions(registry);
const tree = (locked = false, selected = design, readOnly = false) => <EditSessionContext.Provider value={{ locked }}><CableEditor design={selected} db={db} readOnly={readOnly} extensions={extensions} /></EditSessionContext.Provider>;
afterEach(() => { cleanup(); observed = undefined; });
/** Documents frames module panels in a collapsed ModuleSlot: open it */
async function openDocumentsSlot(): Promise<void> {
  const toggle = await waitFor(() => { const found = document.querySelector('.cs-module-slot-toggle'); if (found === null) throw new Error('no slot yet'); return found; });
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
}

describe('editable module panel host seam', () => {
  it('edits the working draft from Documents and rejects callbacks after leaving that view', async () => {
    const mounted = render(<CableEditor design={design} db={db} extensions={extensions} view="documents" />);
    await openDocumentsSlot();
    await screen.findByRole('button', { name: 'Apply panel minutes' });
    expect(observed!.onChange).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Apply panel minutes' }));
    expect(screen.getByTestId('panel-minutes').textContent).toBe('15');
    const retained = observed!.onChange!;
    const base = observed!.design!;
    mounted.rerender(<CableEditor design={design} db={db} extensions={extensions} view="canvas" />);
    act(() => retained({ ...base, label: 'Stale document edit' }));
    expect(screen.getByTestId('panel-label').textContent).toBe(design.label);
    expect(screen.getByTestId('panel-minutes').textContent).toBe('15');
  });

  it('applies a panel draft through history, undo/redo and the normal validated Save', async () => {
    const persistence = memoryPersistence(db, [design]);
    render(<StrictMode><CableEditor design={design} savedDesign={design} db={db} extensions={extensions} persistence={persistence} /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: 'Apply panel minutes' }));
    expect(screen.getByTestId('panel-minutes').textContent).toBe('15');
    expect(persistence.stored.get(design.id)?.extensions?.['synthetic-panel']).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Undo: set panel minutes' }));
    expect(screen.getByTestId('panel-minutes').textContent).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Redo: set panel minutes' }));
    expect(screen.getByTestId('panel-minutes').textContent).toBe('15');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(persistence.stored.get(design.id)?.extensions?.['synthetic-panel']).toEqual({ minutes: 15 }));
  });

  it('rejects invalid panel changes through model validation and rejects two stale replacements in one batch', () => {
    render(tree());
    fireEvent.click(screen.getByRole('button', { name: 'Invalid panel edit' }));
    expect(screen.getByText(/invalid panel edit rejected/)).toBeTruthy();
    expect(screen.getByTestId('panel-minutes').textContent).toBe('0');
    const onChange = observed!.onChange!; const base = observed!.design!;
    act(() => { onChange({ ...base, label: 'First panel change' }, 'first'); onChange({ ...base, label: 'Stale second change' }, 'second'); });
    expect(screen.getByTestId('panel-label').textContent).toBe('First panel change');
  });

  it('withholds callbacks while locked/read-only and ignores retained callbacks after locking or changing cables', () => {
    const mounted = render(tree()); const old = observed!.onChange!; const base = observed!.design!;
    mounted.rerender(tree(true)); expect(observed!.onChange).toBeUndefined();
    expect((screen.getByRole('button', { name: 'Apply panel minutes' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => old({ ...base, label: 'Must not apply' })); expect(screen.getByTestId('panel-label').textContent).toBe(design.label);
    mounted.rerender(tree(false)); act(() => old({ ...base, label: 'Still stale after unlock' })); expect(screen.getByTestId('panel-label').textContent).toBe(design.label);
    const current = observed!.onChange!;
    const other = { ...design, id: 'other-synthetic-cable', label: 'Other synthetic cable' };
    mounted.rerender(tree(false, other)); act(() => current({ ...base, label: 'Wrong cable' })); expect(screen.getByTestId('panel-label').textContent).toBe(other.label);
    const sameIdCallback = observed!.onChange!;
    const reloaded = { ...other, label: 'Reloaded same cable' };
    mounted.rerender(tree(false, reloaded)); act(() => sameIdCallback({ ...other, label: 'Old same-id draft' })); expect(screen.getByTestId('panel-label').textContent).toBe(reloaded.label);
    mounted.rerender(tree(false, other));
    const beforeReadOnly = observed!.onChange!;
    mounted.rerender(tree(false, other, true));
    act(() => beforeReadOnly({ ...other, label: 'Read-only bypass' }));
    mounted.rerender(tree(false, other)); expect(screen.getByTestId('panel-label').textContent).toBe(other.label);
    const beforeUnmount = observed!.onChange!; mounted.unmount(); act(() => beforeUnmount({ ...other, label: 'Unmounted edit' }));
  });

  it('omits callbacks for printed revisions and for slot contexts without an editable design', async () => {
    const revision = { ...design, label: 'Saved revision' };
    render(<CableEditor design={design} db={db} extensions={extensions} view="documents" release={{ revisions: [1], showing: { kind: 'working', unreleased: true }, load: async () => ({ design: revision, db }) }} />);
    await openDocumentsSlot();
    await waitFor(() => expect(screen.getByTestId('panel-label').textContent).toBe('Saved revision'));
    expect(observed!.readOnly).toBe(true); expect(observed!.onChange).toBeUndefined();
    cleanup();
    const noop = () => {};
    render(<ModulePanels registry={registry} slot="cable-inspector" context={{ db, readOnly: false, onChange: noop }} />);
    expect(observed!.onChange).toBeUndefined();
    cleanup();
    render(<ModulePanels registry={registry} slot="cable-inspector" context={{ db, design, readOnly: true, onChange: noop }} />);
    expect(observed!.onChange).toBeUndefined();
  });
});
