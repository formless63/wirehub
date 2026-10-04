// @vitest-environment jsdom
/**
 * The first-run setup page (`src/routes/SetupRoute.tsx`) through the real
 * router and the real API (over a temporary copy of the starter catalog): a
 * fresh hub that asks for setup opens on it, the bundled domain modules are
 * offered unticked, and finishing installs the chosen ones and moves on to
 * the cable list.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import { automotive } from '@wirehub/module-automotive';
import { avVideo } from '@wirehub/module-av-video';
import { createRegistry } from '@wirehub/modules';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { readSetup } from '../server/setup.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let dir = '';

function serve(prompt: boolean): void {
  const catalog = createCatalog(fsCatalogSource(dir));
  const deps: WorkbenchDeps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    loadDb: () => catalog.loadDb(),
    modules: createRegistry([avVideo, automotive]),
    setup: { dataDir: dir, prompt, now: () => '2026-10-04T12:00:00.000Z' },
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest(
      { method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) },
      deps,
    );
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirehub-setup-dom-'));
  cpSync(DATA, dir, { recursive: true });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const router = (path: string): ReturnType<typeof createStudioRouter> => createStudioRouter(createMemoryHistory({ initialEntries: [path] }));

describe('first-run setup', () => {
  it('opens a fresh hub on setup, and finishing installs the chosen modules', async () => {
    serve(true);
    const r = router('/');
    render(<App router={r} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Set up WireHub' })).toBeDefined());
    const av = await screen.findByRole('checkbox', { name: /AV \/ video/ });
    const auto = screen.getByRole('checkbox', { name: /Automotive/ });
    expect((av as HTMLInputElement).checked).toBe(false);
    expect((auto as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Pro audio/)).toBeDefined();

    fireEvent.click(av);
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(readSetup(dir)?.modules).toEqual(['av-video']));
    await waitFor(() => expect(r.state.location.pathname).toBe('/cables'));
  });

  it('does not bounce a hub that did not ask for the prompt', async () => {
    serve(false);
    const r = router('/');
    render(<App router={r} />);
    await waitFor(() => expect(r.state.location.pathname).toBe('/cables'));
  });
});
