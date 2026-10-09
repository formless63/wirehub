// @vitest-environment jsdom
/**
 * Sub-assembly workflow in the studio: a "Place in…" action on the cable
 * list rows (it opens the chosen cable and the workspace places the lead
 * there) and the workspace's "Used in" panel (GET /api/designs/:id/used-in).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeConnectors } from '@wirehub/model';
import type { CableDesign, Db, MechanicalDefinition, PcbaDefinition } from '@wirehub/model';
import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';

const seen = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
  libraryProps: undefined as Record<string, unknown> | undefined,
  placed: [] as string[],
}));

vi.mock('@wirehub/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/editor-react')>();
  const react = await import('react');
  return {
    ...actual,
    CableEditor: react.forwardRef(function CableEditor(props: Record<string, unknown>, ref: React.Ref<unknown>) {
      seen.props = props;
      react.useImperativeHandle(ref, () => ({ placeSubassembly: (def: string) => void seen.placed.push(def) }), []);
      const design = props['design'] as CableDesign;
      return react.createElement(
        'div',
        { 'data-testid': 'editor' },
        react.createElement('span', { 'data-testid': 'open-id' }, design.id),
        react.createElement('span', { 'data-testid': 'open-view' }, String(props['view'])),
      );
    }),
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

const IDS = ['de9-terminal-board', 'dc-pigtail-lead', 'dc-y-from-leads'];
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
  seen.placed = [];
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


describe('Place in… on the cable list', () => {
  it('opens the chosen cable with the lead to place, and the workspace places it once', async () => {
    const router = buildRouter('/cables');
    render(<App router={router} />);
    const rowLink = await screen.findByRole('link', { name: /DC pigtail lead/ });
    fireEvent.click(rowLink.closest('tr')!);
    const button = await screen.findByLabelText('Place dc-pigtail-lead in…');
    fireEvent.click(button);
    // not itself; the other cables are offered
    const choices = await screen.findByRole('group', { name: 'designs to place it in' });
    const options = within(choices).getAllByRole('button');
    expect(options.map((o) => o.textContent)).not.toContain('dc-pigtail-lead');
    fireEvent.click(options.find((o) => o.textContent?.includes('dc-y-from-leads'))!);
    await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe('dc-y-from-leads'));
    await waitFor(() => expect(seen.placed).toEqual(['dc-pigtail-lead']));
    // the parameter is dropped, so a reload does not place it again
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('place'));
    expect(seen.placed).toHaveLength(1);
  });
});

describe('the Used in panel', () => {
  it('lists the designs that place this cable', async () => {
    render(<App router={buildRouter('/cables/dc-pigtail-lead')} />);
    const panel = await screen.findByTestId('used-in');
    expect(panel.textContent).toContain('Used in');
    expect(panel.textContent).toContain('dc-y-from-leads');
  });

  it('is absent when nothing places it', async () => {
    render(<App router={buildRouter('/cables/dc-y-from-leads')} />);
    await screen.findByTestId('editor');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('used-in')).toBeNull();
  });
});
