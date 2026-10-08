// @vitest-environment jsdom
/**
 * Module UI in the studio SPA (`docs/modules.md`): the example module's
 * contributions mounted from a registry — panels in the editor's and the
 * Library's slots, a UI route with its rail entry, the settings page, the
 * importer's review-and-accept flow against a real backend, exporters, and the
 * commit hook installed into the editor store. The editor and the Library are
 * stubbed as in `shell.dom.test.tsx` (their own mounting of the slots is
 * `packages/editor-react/test/extensions.dom.test.tsx`); the transport is the
 * real API router over the in-memory commit tree, the same one Postgres uses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import { example } from '@wirehub/module-example';
import type { CableDesign, Db } from '@wirehub/model';
import { createRegistry, EMPTY_REGISTRY } from '@wirehub/modules';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';
import { toasts } from './toast-spy.ts';

vi.mock('sonner', async () => (await import('./toast-spy.ts')).sonnerMock);

const seen = vi.hoisted(() => ({ editor: undefined as Record<string, unknown> | undefined, library: undefined as Record<string, unknown> | undefined }));

vi.mock('@wirehub/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/editor-react')>();
  const react = await import('react');
  const h = react.createElement;
  return {
    ...actual,
    // the stub draws what the real editor draws from `extensions`: the two panel slots and the export buttons
    CableEditor(props: Record<string, unknown>) {
      seen.editor = props;
      const design = props['design'] as CableDesign;
      const db = props['db'] as Db;
      const ext = props['extensions'] as import('@wirehub/editor-react').EditorExtensions | undefined;
      return h(
        'div',
        { 'data-testid': 'editor' },
        h('span', { 'data-testid': 'open-id' }, design.id),
        h('div', { 'data-testid': 'inspector-slot' }, ext?.inspector?.({ design, db, readOnly: false })),
        h('div', { 'data-testid': 'documents-slot' }, ext?.documents?.({ design, db, readOnly: false })),
        ...(ext?.exporters ?? []).map((e) =>
          h('button', { key: e.id, 'data-testid': `export-${e.id}`, onClick: async () => void ((window as unknown as { exported: unknown }).exported = await e.render(design, db)) }, e.label),
        ),
      );
    },
    Library(props: Record<string, unknown>) {
      seen.library = props;
      const detail = props['detailExtras'] as ((r: { kind: string; id: string }) => unknown) | undefined;
      const actions = props['listActions'] as Record<string, unknown> | undefined;
      const moduleExtras = props['moduleExtras'] as ((r: { kind: string; id: string }) => unknown) | undefined;
      // the real Library puts module panels after everything it shows for the record
      return h('div', { 'data-testid': 'library' }, h('div', { 'data-testid': 'list-actions' }, actions?.['components'] as never), h('div', { 'data-testid': 'detail' }, detail?.({ kind: 'components', id: 'r-150' }) as never, moduleExtras?.({ kind: 'components', id: 'r-150' }) as never));
    },
  };
});

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { editorReducer, initialEditorState } = await import('@wirehub/editor-react');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const loadDesign = (id: string): CableDesign => JSON.parse(readFileSync(join(DATA, 'designs', `${id}.json`), 'utf8')) as CableDesign;
const fileDb = (): Db => createCatalog(fsCatalogSource(DATA, 'the catalog')).loadDb();

const registry = createRegistry([example]);
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

function serve(): void {
  deps = memoryWriteBackend(registry, join(DATA, '..')).deps;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const ifMatch = headers.get('if-match');
    const response = await handleWorkbenchRequest(
      { method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}), ...(ifMatch === null ? {} : { headers: { 'if-match': ifMatch } }) },
      deps,
    );
    return new Response(response.bytes !== undefined ? (response.bytes as unknown as BodyInit) : JSON.stringify(response.body), { status: response.status, headers: { 'content-type': response.contentType ?? 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}

/** module panels sit in a collapsed ModuleSlot: open the one inside `container` */
const openSlot = (container: HTMLElement): void => {
  const toggle = container.querySelector('.cs-module-slot-toggle');
  if (toggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
};

const queryClient = (): QueryClient => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const mount = (path: string, modules = registry) => render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [path] }))} queryClient={queryClient()} modules={modules} />);

beforeEach(() => {
  clearOfflineCache();
  seen.editor = undefined;
  seen.library = undefined;
  serve();
  window.localStorage.clear();
  toasts.length = 0;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('cable panels and exports', () => {
  it('mounts the inspector and documents panels from the registry, with the live design', async () => {
    mount('/cables/de9-crossover');
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe('de9-crossover'));
    expect(within(screen.getByTestId('inspector-slot')).getByTestId('example-inspector').textContent).toContain('No edits recorded yet');
    // the Documents panel is framed (ModuleSlot) and collapsed until opened
    expect(within(screen.getByTestId('documents-slot')).queryByTestId('example-documents')).toBeNull();
    expect(screen.getByTestId('documents-slot').querySelector('[data-module-slot="cable-documents/example"]')?.textContent).toContain('module');
    openSlot(screen.getByTestId('documents-slot'));
    const docs = within(screen.getByTestId('documents-slot')).getByTestId('example-documents');
    expect(docs.textContent).toMatch(/Example: \d+ joints/);
    // the panel called the module's own server route through the host's api helper
    await waitFor(() => expect(docs.textContent).toContain('server says example'));
    expect(document.querySelector('[data-module="example"][data-panel="inspector"]')).not.toBeNull();
  });

  it('offers the exporters as downloads that render the design on screen', async () => {
    mount('/cables/de9-crossover');
    await waitFor(() => expect(screen.getByTestId('export-example/joints-csv')).toBeTruthy());
    fireEvent.click(screen.getByTestId('export-example/joints-csv'));
    await waitFor(() => expect((window as unknown as { exported?: { fileName: string } }).exported?.fileName).toBe('de9-crossover-joints.csv'));
    expect(String((window as unknown as { exported: { body: string } }).exported.body)).toMatch(/^a,b,note\n/);
  });

  it('a tester exporter gets the continuity data, derived by the host from the design', async () => {
    mount('/cables/de9-crossover');
    await waitFor(() => expect(screen.getByTestId('export-example/tester-netlist')).toBeTruthy());
    fireEvent.click(screen.getByTestId('export-example/tester-netlist'));
    await waitFor(() => expect((window as unknown as { exported?: { fileName: string } }).exported?.fileName).toBe('de9-crossover-tester.net'));
    expect(String((window as unknown as { exported: { body: string } }).exported.body)).toMatch(/^; de9-crossover — EXAMPLE tester format\nCONT_MAX 5\n.*\nNET net-1 j1\.1 j1\.4 j1\.6\n/s);
  });

  it('mounts the same panels and exporters over a saved revision (frozen design, read-only)', async () => {
    const saved = await handleWorkbenchRequest({ method: 'POST', path: '/api/designs/de9-crossover/versions', body: { note: 'First release' } }, deps);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    mount('/cables/de9-crossover?rev=0');
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe('de9-crossover'));
    expect(screen.getByTestId('version-banner').textContent).toContain('Rev 0');
    expect(within(screen.getByTestId('inspector-slot')).getByTestId('example-inspector')).toBeTruthy();
    openSlot(screen.getByTestId('documents-slot'));
    expect(within(screen.getByTestId('documents-slot')).getByTestId('example-documents').textContent).toMatch(/Example: \d+ joints/);
    // the editor is the revision's: read-only while it is locked
    expect(seen.editor?.['readOnly']).toBe(true);
    fireEvent.click(screen.getByTestId('export-example/joints-csv'));
    await waitFor(() => expect((window as unknown as { exported?: { fileName: string } }).exported?.fileName).toBe('de9-crossover-joints.csv'));
  });

  it('adds nothing to the editor when no module contributes', async () => {
    mount('/cables/de9-crossover', EMPTY_REGISTRY);
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe('de9-crossover'));
    expect(seen.editor?.['extensions']).toBeUndefined();
    expect(screen.queryByTestId('example-inspector')).toBeNull();
  });
});

describe('the Library', () => {
  it('mounts the library-detail panel for the open record', async () => {
    mount('/library/components/r-150');
    // collapsed by default, after the record's own content
    await screen.findByTestId('detail');
    expect(screen.queryByTestId('example-library')).toBeNull();
    const slot = screen.getByTestId('detail').querySelector('[data-module-slot="library-detail/example"]') as HTMLElement;
    expect(slot).not.toBeNull();
    expect(screen.getByTestId('detail').lastElementChild).toBe(slot);
    openSlot(slot);
    const detail = await screen.findByTestId('example-library');
    expect(detail.textContent).toBe('Example: components/r-150');
  });

  it('imports through a module importer: review the proposal, accept it, and the records are stored', async () => {
    mount('/library/components');
    const input = (await screen.findByTestId('module-import-file')) as HTMLInputElement;
    const csv = 'id,label,value\nex-r-1k,Example resistor 1 kΩ,1 kΩ\nbad line\n';
    const file = new File([csv], 'parts.csv', { type: 'text/csv' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    const review = await screen.findByRole('dialog', { name: 'Review import' });
    expect(review.textContent).toContain('1 new components: ex-r-1k');
    expect(review.textContent).toContain('Check: line 3');
    // nothing is written before Accept
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/components/ex-r-1k' }, deps)).status).toBe(404);
    fireEvent.click(within(review).getByRole('button', { name: 'Add 1 record' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review import' })).toBeNull());
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/components/ex-r-1k' }, deps)).status).toBe(200);
    // the commit also recomputed the module's derived record
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/docs/data/derived/example/summary.json' }, deps)).status).toBe(200);
  });

  it('says so when a file has no importer', async () => {
    mount('/library/components');
    const input = (await screen.findByTestId('module-import-file')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'parts.xyz')] } });
    });
    await waitFor(() => expect(toasts.map((t) => t.title).join(' ')).toContain('No importer takes parts.xyz'));
  });

  it('shows no Import button (only Browse store) and no panels with no modules', async () => {
    mount('/library/components', EMPTY_REGISTRY);
    await screen.findByTestId('library');
    // each kind's list actions: [the Import menu (renders nothing without importers), Browse store]
    expect(screen.queryByTestId('library-import-menu')).toBeNull();
    expect(screen.getByTestId('browse-store')).toBeTruthy();
    // the record's History is the base's own; no module panel beside it
    const detail = await screen.findByTestId('detail');
    expect(within(detail).getByTestId('history-button')).toBeDefined();
    expect(within(detail).queryByTestId('example-library')).toBeNull();
  });
});

describe('module pages', () => {
  it('keeps a UI route out of the rail, lists it on the Modules page and renders its component at /m/<module>/<path>', async () => {
    mount('/cables');
    await screen.findByRole('navigation', { name: 'sections' });
    // no placement and no owner allowance: no rail item (the rail stays the hub's own)
    expect(screen.queryByRole('link', { name: 'Example status' })).toBeNull();
    cleanup();
    mount('/modules');
    const link = await screen.findByRole('link', { name: /Example status/ });
    expect(link.getAttribute('href')).toBe('/m/example/status');
    fireEvent.click(link);
    const page = await screen.findByTestId('example-page');
    expect(page.textContent).toContain('Example module status');
    await waitFor(() => expect(page.textContent).toContain('"ok":true'));
    expect(page.textContent).toMatch(/\d+ connectors in the library/);
  });

  it('answers a path no module owns with the not-found view', async () => {
    mount('/m/example/nope');
    expect(await screen.findByText('No module page lives at that address.')).toBeTruthy();
  });

  it('lists the modules and their settings panels at /modules', async () => {
    mount('/modules');
    expect(await screen.findByTestId('example-settings')).toBeTruthy();
    expect(screen.getByText(/Example module \(reference implementation/)).toBeTruthy();
  });

  it('shows no module entries in the rail of a plain deployment', async () => {
    mount('/cables', EMPTY_REGISTRY);
    await screen.findByRole('navigation', { name: 'sections' });
    expect(screen.queryByRole('link', { name: 'Example status' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Modules' })).toBeNull();
  });
});

describe('the commit hook', () => {
  const add = (design: CableDesign, db: Db) => editorReducer(initialEditorState(design, db), { type: 'add-instance', kind: 'component', def: 'r-150' });

  it('is installed into the editor store from the registry, and removed when the app unmounts', async () => {
    const db = fileDb();
    const design = loadDesign('dc-led-lead');
    expect(add(design, db).design.extensions).toBeUndefined();
    const { unmount } = mount('/cables');
    await screen.findByRole('navigation', { name: 'sections' });
    const edited = add(design, db);
    expect(edited.design.extensions?.['example']).toMatchObject({ schema: 1, edits: 1 });
    expect(edited.design.instances.components.length).toBe(design.instances.components.length + 1);
    unmount();
    expect(add(design, db).design.extensions).toBeUndefined();
  });

  it('is not installed by a registry without one', async () => {
    mount('/cables', EMPTY_REGISTRY);
    await screen.findByRole('navigation', { name: 'sections' });
    expect(add(loadDesign('dc-led-lead'), fileDb()).design.extensions).toBeUndefined();
  });
});
