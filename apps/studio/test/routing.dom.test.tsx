// @vitest-environment jsdom
/**
 * Routing itself ('s acceptance criteria): a deep link
 * opens the right cable and view, an unknown id is a compact not-found state
 * rather than a crash, a reload keeps you where you were, and browser
 * back/forward work. `shell.dom.test.tsx` covers the lifecycle underneath
 * (draft buffers, catalog changes) — this file is the router surface only.
 *
 * The real editor is stubbed exactly as in `shell.dom.test.tsx`, and the
 * transport is the real workbench API router over an in-memory store — see
 * that file's header for why.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeConnectors } from '@cable-studio/model';
import type { CableDesign, Db, MechanicalDefinition, PcbaDefinition } from '@cable-studio/model';
import { createCatalog, fsCatalogSource } from '@cable-studio/catalog';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';

const seen = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
  libraryProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@cable-studio/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cable-studio/editor-react')>();
  const react = await import('react');
  return {
    ...actual,
    CableEditor(props: Record<string, unknown>) {
      seen.props = props;
      const design = props['design'] as CableDesign;
      return react.createElement(
        'div',
        { 'data-testid': 'editor' },
        react.createElement('span', { 'data-testid': 'open-id' }, design.id),
        react.createElement('span', { 'data-testid': 'open-view' }, String(props['view'])),
      );
    },
    Library(props: Record<string, unknown>) {
      seen.libraryProps = props;
      return react.createElement(
        'div',
        { 'data-testid': 'library' },
        'library',
        react.createElement('span', { 'data-testid': 'library-kind' }, String(props['kind'])),
        react.createElement('span', { 'data-testid': 'library-id' }, String(props['selectedId'])),
      );
    },
  };
});

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
function read<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(DATA, ...parts), 'utf8')) as T;
}
function loadDbFromDisk(): Db {
  return createCatalog(fsCatalogSource(DATA, 'the catalog')).loadDb();
}
const loadDesign = (id: string): CableDesign => read<CableDesign>('designs', `${id}.json`);

const IDS = ['rs485-de9-terminal-board', 'xlr-mic-cable'];
const db: Db = loadDbFromDisk();
const realFetch = globalThis.fetch;
let files: Map<string, string>;

function serve(): void {
  const store: DesignStore = {
    list: () =>
      [...files.keys()].sort().map((id) => ({
        id,
        label: (JSON.parse(files.get(id) as string) as CableDesign).label,
      })),
    has: (id) => files.has(id),
    read: (id) => {
      const text = files.get(id);
      return text === undefined ? undefined : (JSON.parse(text) as CableDesign);
    },
    write: (id, design) => {
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
  const deps: WorkbenchDeps = { designs: store, loadDb: () => db };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest(
      {
        method: init?.method ?? 'GET',
        path: String(input),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      },
      deps,
    );
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function seed(): void {
  files = new Map(IDS.map((id) => [id, formatDesignJson(loadDesign(id))]));
}

beforeEach(() => {
  seen.props = undefined;
  seed();
  serve();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function buildRouter(initialPath: string): ReturnType<typeof createStudioRouter> {
  return createStudioRouter(createMemoryHistory({ initialEntries: [initialPath] }));
}

describe('deep links', () => {
  it('opens the right cable at the default (build) view', async () => {
    render(<App router={buildRouter(`/cables/${IDS[0]}`)} />);
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe(IDS[0]));
    expect(screen.getByTestId('open-view').textContent).toBe('canvas');
  });

  it('opens the right view: schematic and documents', async () => {
    render(<App router={buildRouter(`/cables/${IDS[0]}?view=schematic`)} />);
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe(IDS[0]));
    //: the editor's own `schematic` view, full size
    expect(screen.getByTestId('open-view').textContent).toBe('schematic');

    cleanup();
    render(<App router={buildRouter(`/cables/${IDS[1]}?view=documents`)} />);
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe(IDS[1]));
    expect(screen.getByTestId('open-view').textContent).toBe('documents');
  });

  it('an unknown view search param falls back to build rather than crashing', async () => {
    render(<App router={buildRouter(`/cables/${IDS[0]}?view=nonsense`)} />);
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe(IDS[0]));
    expect(screen.getByTestId('open-view').textContent).toBe('canvas');
  });
});

describe('an unknown cable id', () => {
  it('shows a compact not-found state instead of crashing', async () => {
    render(<App router={buildRouter('/cables/does-not-exist-anywhere')} />);
    await waitFor(() => expect(screen.getByText(/No cable/)).toBeDefined());
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Cables' })).toBeDefined();
  });
});

describe('reload', () => {
  it('a fresh router pointed at the same deep link opens the same place', async () => {
    // a reload is a fresh JS context handed the same URL — modelled here by
    // building an unrelated second router at the same path, rather than the
    // first router's (now-mutated) state
    const path = `/cables/${IDS[1]}?view=documents`;
    render(<App router={buildRouter(path)} />);
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe(IDS[1]));
    cleanup();

    render(<App router={buildRouter(path)} />);
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe(IDS[1]));
    expect(screen.getByTestId('open-view').textContent).toBe('documents');
  });
});

describe('back and forward', () => {
  it('back returns to the cables list, forward returns to the cable', async () => {
    const testRouter = buildRouter('/cables');
    render(<App router={testRouter} />);
    await waitFor(() => expect(screen.getAllByRole('link').length).toBeGreaterThan(0));

    await act(async () => {
      await testRouter.navigate({ to: '/cables/$id', params: { id: IDS[0] as string } });
    });
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe(IDS[0]));

    await act(async () => {
      testRouter.history.back();
    });
    await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull());

    await act(async () => {
      testRouter.history.forward();
    });
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe(IDS[0]));
  });
});

describe('the index and library routes', () => {
  it('/ redirects to /cables', async () => {
    render(<App router={buildRouter('/')} />);
    await waitFor(() => expect(screen.getAllByRole('link').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('/library redirects to the first kind (connectors)', async () => {
    render(<App router={buildRouter('/library')} />);
    await waitFor(() => expect(screen.getByTestId('library')).toBeDefined());
    expect(screen.getByTestId('library-kind').textContent).toBe('connectors');
    expect(screen.getByTestId('library-id').textContent).toBe('undefined');
  });

  it('/library/$kind and /library/$kind/$id both render the Library view, kind and id passed through', async () => {
    render(<App router={buildRouter('/library/wires')} />);
    await waitFor(() => expect(screen.getByTestId('library')).toBeDefined());
    expect(screen.getByTestId('library-kind').textContent).toBe('wires');
    expect(screen.getByTestId('library-id').textContent).toBe('undefined');
    // the top bar names the section on a kind's list, not only on an item
    expect(screen.queryByTestId('section-title')?.textContent).toBe('Library');
    cleanup();

    render(<App router={buildRouter('/library/connectors/db23-male')} />);
    await waitFor(() => expect(screen.getByTestId('library')).toBeDefined());
    expect(screen.getByTestId('library-kind').textContent).toBe('connectors');
    expect(screen.getByTestId('library-id').textContent).toBe('db23-male');
  });

});

describe('search params that look like numbers', () => {
  it('a hand-typed board import link keeps its part number (PCA-00106 is not scientific notation)', async () => {
    const router = buildRouter('/library/boards/import?pn=PCA-00106&rev=Rev1');
    await router.load();
    expect(router.state.location.search).toMatchObject({ pn: 'PCA-00106', rev: 'Rev1' });
  });

  it('a link the router wrote itself round-trips the same part number', async () => {
    const router = buildRouter('/cables');
    await router.load();
    await router.navigate({ to: '/library/boards/import', search: { pn: 'PCA-00106' } });
    expect(router.state.location.search).toMatchObject({ pn: 'PCA-00106' });
    const again = buildRouter(router.state.location.href);
    await again.load();
    expect(again.state.location.search).toMatchObject({ pn: 'PCA-00106' });
  });
});
