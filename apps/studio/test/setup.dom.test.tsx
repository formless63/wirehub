// @vitest-environment jsdom
/**
 * The first-run setup page (`src/routes/SetupRoute.tsx`) through the real
 * router and the real API (over a temporary copy of the starter catalog): a
 * fresh hub that asks for setup opens on it, the bundled domain modules are
 * offered unticked, and finishing installs the chosen ones and moves on to
 * the cable list. Packs land in a packs directory beside the catalog copy.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { readSetup } from '../server/setup.ts';
import { modules as manifest } from '../modules.config.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let root = '';
let dir = '';
let packs = '';

function serve(prompt: boolean, extra: { code?: string; suggested?: string[] } = {}): void {
  const catalog = createCatalog(catalogWithPacksSource(dir, packs));
  const deps: WorkbenchDeps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    loadDb: () => catalog.loadDb(),
    modules: createRegistry(manifest),
    setup: { dataDir: dir, packsDir: packs, prompt, now: () => '2026-10-04T12:00:00.000Z', ...extra },
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
  root = mkdtempSync(join(tmpdir(), 'wirehub-setup-dom-'));
  dir = join(root, 'catalog');
  packs = join(root, 'packs');
  cpSync(DATA, dir, { recursive: true });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

const router = (path: string): ReturnType<typeof createStudioRouter> => createStudioRouter(createMemoryHistory({ initialEntries: [path] }));

describe('first-run setup', () => {
  it('opens a fresh hub on setup, every module unticked, and finishing installs the chosen ones', async () => {
    serve(true);
    const r = router('/');
    render(<App router={r} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Set up WireHub' })).toBeDefined());
    const av = await screen.findByRole('checkbox', { name: /AV \/ video/ });
    const networking = screen.getByRole('checkbox', { name: /Networking/ });
    for (const name of [/PC & serial/, /Networking/, /Pro audio/, /AV \/ video/, /Automotive/]) {
      expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked, String(name)).toBe(false);
    }
    // a domain with no module yet is only mentioned
    expect(screen.getByText(/Fieldbus/)).toBeDefined();
    // no code configured: none asked
    expect(screen.queryByPlaceholderText('XXXX-XXXX-XXXX')).toBeNull();

    fireEvent.click(av);
    fireEvent.click(networking);
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect([...(readSetup(packs)?.modules ?? [])].sort()).toEqual(['av-video', 'networking']));
    await waitFor(() => expect(r.state.location.pathname).toBe('/cables'));
  });

  it('pre-ticks the deployment\'s suggestions and asks for the setup code', async () => {
    serve(true, { code: 'ABCD-EFGH-JKMN', suggested: ['pc-serial', 'pro-audio'] });
    const r = router('/setup');
    render(<App router={r} />);
    await screen.findByRole('checkbox', { name: /PC & serial/ });
    expect((screen.getByRole('checkbox', { name: /PC & serial/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Pro audio/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Networking/ }) as HTMLInputElement).checked).toBe(false);
    const finish = screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    const input = screen.getByPlaceholderText('XXXX-XXXX-XXXX');
    fireEvent.change(input, { target: { value: 'wrong-code-0000' } });
    fireEvent.click(finish);
    await screen.findByText(/That is not the setup code/);
    expect(readSetup(packs)).toBeUndefined();
    fireEvent.change(input, { target: { value: 'abcd-efgh-jkmn' } });
    fireEvent.click(finish);
    await waitFor(() => expect(readSetup(packs)?.modules).toEqual(['pc-serial', 'pro-audio']));
  });

  it('stands alone: no rail, no Offline chip, no workbench probe, and the setup code comes right after the admin', async () => {
    serve(true, { code: 'ABCD-EFGH-JKMN' });
    const inner = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input));
      return inner(input, init);
    }) as unknown as typeof fetch;
    render(<App router={router('/setup')} />);
    await screen.findByPlaceholderText('XXXX-XXXX-XXXX');
    expect(screen.queryByText('Offline')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(asked.filter((u) => /designs/.test(u))).toEqual([]);
    const legends = [...document.querySelectorAll('legend')].map((l) => l.textContent);
    expect(legends.indexOf('Setup code')).toBeLessThan(legends.indexOf('Domains'));
    expect(screen.getByRole('button', { name: /Copy the command/ })).toBeDefined();
  });

  it('does not bounce a hub that did not ask for the prompt', async () => {
    serve(false);
    const r = router('/');
    render(<App router={r} />);
    await waitFor(() => expect(r.state.location.pathname).toBe('/cables'));
  });

  it('on a hub with no organisation, also asks for the organisation, the admin and the catalog', async () => {
    const posted: unknown[] = [];
    const catalog = createCatalog(catalogWithPacksSource(dir, packs));
    const deps: WorkbenchDeps = {
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
      loadDb: () => catalog.loadDb(),
      modules: createRegistry(manifest),
      setup: {
        dataDir: dir,
        prompt: true,
        now: () => '2026-10-04T12:00:00.000Z',
        create: async (request) => {
          if (request.method === 'POST') {
            posted.push(request.body);
            return { status: 200, body: { needed: false, completed: true, domains: [], suggestions: [], created: { org: 'example-shop' } } };
          }
          return { status: 200, body: { needed: true, completed: false, codeRequired: false, domains: [], suggestions: [], create: { catalogs: ['starter', 'empty'], admin: 'none', minPassword: 12 } } };
        },
      },
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await handleWorkbenchRequest(
        { method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) },
        deps,
      );
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    render(<App router={router('/setup')} />);
    const name = await screen.findByPlaceholderText('Example Shop');
    const finish = screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Example Shop' } });
    expect((screen.getByPlaceholderText('example-shop') as HTMLInputElement).value).toBe('example-shop');
    fireEvent.click(screen.getByRole('radio', { name: /Empty catalog/ }));
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ modules: [], org: { name: 'Example Shop', slug: 'example-shop' }, catalog: 'empty' });
  });

  it('offers the part-number scheme, and sends it only when edited', async () => {
    const posted: unknown[] = [];
    const catalog = createCatalog(catalogWithPacksSource(dir, packs));
    const prefixes = { connector: 'CON', component: 'CMP', wire: 'WIR' };
    const deps: WorkbenchDeps = {
      designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
      loadDb: () => catalog.loadDb(),
      modules: createRegistry(manifest),
      setup: {
        dataDir: dir,
        packsDir: packs,
        prompt: true,
        now: () => '2026-10-04T12:00:00.000Z',
        create: async (request) => {
          if (request.method === 'POST') {
            posted.push(request.body);
            return { status: 200, body: { needed: false, completed: true, domains: [], suggestions: [], created: { org: 'x' } } };
          }
          return { status: 200, body: { needed: true, completed: false, codeRequired: false, domains: [], suggestions: [], create: { catalogs: ['starter', 'empty'], admin: 'none', minPassword: 12, partNumbers: { scheme: 'prefix', kinds: ['connector', 'component', 'wire'], prefixes, digits: 5, example: 'CON-00001' } } } };
        },
      },
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    render(<App router={router('/setup')} />);
    fireEvent.change(await screen.findByPlaceholderText('Example Shop'), { target: { value: 'Pn Shop' } });
    expect((screen.getByLabelText('Prefix for connector') as HTMLInputElement).value).toBe('CON');
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(posted.length).toBe(1));
    // untouched: nothing about part numbers is sent
    expect(posted[0]).not.toHaveProperty('partNumbers');
    cleanup();
    posted.length = 0;
    render(<App router={router('/setup')} />);
    fireEvent.change(await screen.findByPlaceholderText('Example Shop'), { target: { value: 'Pn Shop' } });
    fireEvent.change(screen.getByLabelText('Prefix for connector'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ partNumbers: { prefixes: { connector: 'K', component: 'CMP', wire: 'WIR' }, digits: 5 } });
  });
});
