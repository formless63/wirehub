// @vitest-environment jsdom
/**
 * Portrait phone widths: jsdom does not evaluate the
 * stylesheet media queries that drive most of this (`max-sm:hidden`, the
 * `.cs-side`/`.cs-library` drawer rules in `editor.css`) — those are checked
 * visually, not here. What jsdom *can* prove is the JS-driven half: the
 * cable list actually renders a different structure at narrow widths
 * (`useIsNarrow`, `CablesRoute.tsx`'s `MobileRow`), and the mobile nav sheet
 * opens/closes. Same real-transport harness as `cables-list.dom.test.tsx`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeConnectors } from '@wirehub/model';
import type { CableDesign, Db, MechanicalDefinition, PcbaDefinition } from '@wirehub/model';
import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';

const seen = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));

vi.mock('@wirehub/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/editor-react')>();
  const react = await import('react');
  return {
    ...actual,
    CableEditor(props: Record<string, unknown>) {
      seen.props = props;
      const design = props['design'] as CableDesign;
      return react.createElement('div', { 'data-testid': 'editor' }, react.createElement('span', { 'data-testid': 'open-id' }, design.id));
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

const A = 'rs485-de9-terminal-board';
const IDS = [A];

const db: Db = loadDbFromDisk();
const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;
let files: Map<string, string>;

function serve(): void {
  const store: DesignStore = {
    list: () =>
      [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
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
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** Forces `useIsNarrow()` (`../src/hooks/useIsNarrow.ts`) to whichever side
 * of its `(max-width: 639px)` query the test wants, independent of jsdom's
 * own (unset) viewport. */
function stubNarrow(narrow: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: narrow && query.includes('639px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

function buildRouter(initialPath: string): ReturnType<typeof createStudioRouter> {
  return createStudioRouter(createMemoryHistory({ initialEntries: [initialPath] }));
}

beforeEach(() => {
  seen.props = undefined;
  files = new Map(IDS.map((id) => [id, formatDesignJson(loadDesign(id))]));
  serve();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});


describe('the mobile nav sheet', () => {
  it('opens from the hamburger button and closes on backdrop click', async () => {
    stubNarrow(true);
    render(<App router={buildRouter('/cables')} />);
    await waitFor(() => expect(screen.getAllByRole('link').length).toBeGreaterThan(0));

    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Navigation' }));
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  });
});
