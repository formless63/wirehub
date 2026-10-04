// @vitest-environment jsdom
/**
 * Quick open: Ctrl K
 * opens it from anywhere, typing filters the CABLES/LIBRARY/ACTIONS rows,
 * Enter opens the highlighted cable, `>` switches to commands only, and
 * selecting a command runs it. `command-registry.dom.test.tsx` covers the
 * shortcut-vs-typing-target rule in isolation; this file drives the palette
 * through the real shell, the same real-transport approach as
 * `shell.dom.test.tsx`/`routing.dom.test.tsx`.
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

vi.mock('@wirehub/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/editor-react')>();
  const react = await import('react');
  return {
    ...actual,
    CableEditor(props: Record<string, unknown>) {
      const design = props['design'] as CableDesign;
      return react.createElement('div', { 'data-testid': 'editor' }, react.createElement('span', { 'data-testid': 'open-id' }, design.id));
    },
    Library() {
      return react.createElement('div', { 'data-testid': 'library' }, 'library');
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

/** two designs with distinct ids and labels, nothing in common to search on */
const A = 'rs485-de9-terminal-board';
const B = 'xlr-mic-cable';
const IDS = [A, B];

const db: Db = loadDbFromDisk();
const realFetch = globalThis.fetch;
let files: Map<string, string>;

function serve(): void {
  const store: DesignStore = {
    list: () => [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
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
      { method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) },
      deps,
    );
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function seed(): void {
  files = new Map(IDS.map((id) => [id, formatDesignJson(loadDesign(id))]));
}

beforeEach(() => {
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

async function readyOnCables(): Promise<void> {
  render(<App router={buildRouter('/cables')} />);
  // the underlying /cables table has landed (rows are links) — a stable
  // "the shell finished its first load" signal before we start driving the palette
  await waitFor(() => expect(screen.getAllByRole('link').length).toBeGreaterThan(0));
}

async function openPalette(): Promise<HTMLElement> {
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  return screen.findByRole('dialog');
}

describe('opening the palette', () => {
  it('Ctrl K opens it', async () => {
    await readyOnCables();
    expect(screen.queryByRole('dialog')).toBeNull();
    const dialog = await openPalette();
    expect(within(dialog).getByPlaceholderText('Search…')).toBeDefined();
  });

  it('Ctrl K again closes it', async () => {
    await readyOnCables();
    await openPalette();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});


describe('finding a design by part number', () => {
  it("a part's PN finds the cables built from it, and the row shows the PN that matched", async () => {
    await readyOnCables();
    const dialog = await openPalette();
    fireEvent.change(within(dialog).getByPlaceholderText('Search…'), { target: { value: 'PCA-00001' } });
    await waitFor(() => expect(within(dialog).getByText('DE-9 RS-485 → terminal adapter board, terminated')).toBeDefined());
    expect(within(dialog).getByText(`PCA-00001 · ${A}`)).toBeDefined();
    expect(within(dialog).queryByText('XLR female → XLR male, balanced microphone cable, 5 m')).toBeNull();
  });
});


describe("the '>' prefix", () => {
  it('switches to commands only', async () => {
    await readyOnCables();
    const dialog = await openPalette();
    fireEvent.change(within(dialog).getByPlaceholderText('Search…'), { target: { value: '>library' } });

    await waitFor(() => expect(within(dialog).getByText('Go to Library')).toBeDefined());
    expect(within(dialog).queryByText(/RS-485 → terminal adapter/)).toBeNull();
    expect(within(dialog).queryByText(/balanced microphone cable/)).toBeNull();
  });
});

describe('running a command', () => {
  it('navigates when "Go to Library" is selected', async () => {
    await readyOnCables();
    const dialog = await openPalette();
    fireEvent.change(within(dialog).getByPlaceholderText('Search…'), { target: { value: '>library' } });
    const row = await within(dialog).findByText('Go to Library');

    fireEvent.click(row);

    await screen.findByTestId('library');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
