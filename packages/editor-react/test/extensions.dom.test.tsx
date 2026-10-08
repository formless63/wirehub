// @vitest-environment jsdom
/**
 * What a host adds through `extensions` (`src/extensions.ts`): a panel in the
 * inspector column, a panel and export buttons in the Documents view, and a
 * detail panel in the Library — rendered by the real editor with the live
 * design, and absent when the host adds nothing.
 */

import './reactflow-jsdom.ts';

import type { CableDesign, Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import type { EditorExtensions } from '../src/extensions.ts';
import { Library } from '../src/panels/Library.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const design: CableDesign = loadDesignFromDisk('de9-terminal-board');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const extensions = (render = vi.fn(() => ({ mimeType: 'text/csv', fileName: 'x.csv', body: 'a,b\n' }))): EditorExtensions => ({
  inspector: ({ design: d, readOnly }) => createElement('div', { 'data-testid': 'ext-inspector' }, `${d.id} readOnly=${readOnly}`),
  documents: ({ design: d }) => createElement('div', { 'data-testid': 'ext-documents' }, `${d.joints.length} joints`),
  exporters: [{ id: 'csv', label: 'Joints CSV', description: 'one row per joint', render }],
});

describe('<CableEditor extensions>', () => {
  it('draws the inspector slot in the right-hand column with the live design', () => {
    const { container } = render(<CableEditor design={design} db={db} extensions={extensions()} />);
    const slot = screen.getByTestId('ext-inspector');
    expect(slot.textContent).toBe(`${design.id} readOnly=false`);
    expect(slot.closest('.cs-extension-slot')?.getAttribute('data-slot')).toBe('cable-inspector');
    expect(slot.closest('.cs-side')).not.toBeNull();
    expect(container.querySelector('.cs-documents')).toBeNull();
  });

  it('draws the documents slot and the export buttons in the Documents view, and downloads what an exporter renders', async () => {
    const renderExport = vi.fn(() => ({ mimeType: 'text/csv', fileName: 'joints.csv', body: 'a,b\n' }));
    const created: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => (created.push(b), 'blob:test');
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('joints.csv');
    });
    render(<CableEditor design={design} db={db} extensions={extensions(renderExport)} view="documents" />);
    expect((await screen.findByTestId('ext-documents')).textContent).toBe(`${design.joints.length} joints`);
    // the module slot comes after the sheet, and exporters live in the Tools menu, not on the toolbar
    const body = document.querySelector('.cs-doc-body') as HTMLElement;
    const slot = document.querySelector('.cs-documents > .cs-extension-slot') as HTMLElement;
    expect(body.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Joints CSV/ })).toBeNull();
    fireEvent.click(screen.getByTestId('documents-tools'));
    const button = await screen.findByRole('menuitem', { name: /Joints CSV/ });
    expect(button.getAttribute('title')).toBe('one row per joint');
    fireEvent.click(button);
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(renderExport).toHaveBeenCalledWith(expect.objectContaining({ id: design.id }), expect.anything());
    expect(created[0]?.type).toBe('text/csv');
    expect(await created[0]?.text()).toBe('a,b\n');
  });

  it('says so in the toolbar when an exporter throws', async () => {
    render(<CableEditor design={design} db={db} extensions={extensions(vi.fn(() => { throw new Error('no joints'); }))} view="documents" />);
    fireEvent.click(await screen.findByTestId('documents-tools'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Joints CSV/ }));
    expect(await screen.findByText(/Joints CSV: no joints/)).toBeTruthy();
  });

  it('reports an exporter failure to the host, with its detail, instead of writing inline', async () => {
    const report = vi.fn();
    render(<CableEditor design={design} db={db} extensions={extensions(vi.fn(() => { throw new Error('no joints'); }))} onDocumentReport={report} view="documents" />);
    fireEvent.click(await screen.findByTestId('documents-tools'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Joints CSV/ }));
    await waitFor(() => expect(report).toHaveBeenCalledWith({ kind: 'error', message: 'Joints CSV failed.', detail: 'no joints' }));
    expect(screen.queryByText(/Joints CSV: no joints/)).toBeNull();
  });

  it('lists module pages in the Tools menu and has no Tools button when there is nothing to list', async () => {
    const open = vi.fn();
    const { unmount } = render(<CableEditor design={design} db={db} extensions={{ toolLinks: [{ id: 'm/page', label: 'Cost report', open }] }} view="documents" />);
    fireEvent.click(await screen.findByTestId('documents-tools'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Cost report/ }));
    expect(open).toHaveBeenCalledTimes(1);
    unmount();
    render(<CableEditor design={design} db={db} view="documents" />);
    await screen.findByRole('button', { name: /Print/ });
    expect(screen.queryByTestId('documents-tools')).toBeNull();
  });

  it('is the plain editor without extensions', async () => {
    const { container } = render(<CableEditor design={design} db={db} />);
    expect(container.querySelector('.cs-extension-slot')).toBeNull();
  });
});

describe('<Library detailExtras>', () => {
  it('draws the host panel under the open record, with its kind and id', () => {
    const detail = vi.fn(({ kind, id }: { kind: string; id: string }) => createElement('div', { 'data-testid': 'ext-detail' }, `${kind}/${id}`));
    const connector = db.connectors[0];
    if (connector === undefined) throw new Error('the starter has connectors');
    render(<Library db={db} kind="connectors" selectedId={connector.id} detailExtras={detail} />);
    expect(screen.getByTestId('ext-detail').textContent).toBe(`connectors/${connector.id}`);
  });

  it('draws moduleExtras after everything else the Library shows for the record', () => {
    const extra = vi.fn(({ kind, id }: { kind: string; id: string }) => createElement('div', { 'data-testid': 'ext-module' }, `${kind}/${id}`));
    const connector = db.connectors[0];
    if (connector === undefined) throw new Error('the starter has connectors');
    const { container } = render(<Library db={db} kind="connectors" selectedId={connector.id} moduleExtras={extra} detailExtras={() => createElement('div', { 'data-testid': 'ext-detail' }, 'core')} />);
    const slot = screen.getByTestId('ext-module').closest('.cs-extension-slot') as HTMLElement;
    expect(slot.getAttribute('data-slot')).toBe('library-detail');
    const detail = screen.getByTestId('ext-detail');
    expect(detail.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // last in the detail pane
    expect(container.querySelector('.cs-extension-slot[data-slot="library-detail"]:last-child')).toBe(slot);
  });
});
