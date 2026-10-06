// @vitest-environment jsdom
/** "Which cable do I need?" (`/resolver`): pick two devices, read the ranked options, create the design, and find its recipe in the editor. */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CableDesign, Db } from '@wirehub/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { LIMIT, PANEL, SUPPLY, USB_SUPPLY } from './resolver-flow.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry } = await import('../src/modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

function serve(): void {
  deps = { ...memoryWriteBackend(undefined, join(DATA, '..')).deps, loadPartNumberFiles: () => ({}) };
  const base = deps.loadDb;
  // the library with two devices and a recipe, as a pack would ship them
  deps.loadDb = async () => ({ ...(await base()), devices: [SUPPLY, PANEL, USB_SUPPLY], conditioningRecipes: [LIMIT] }) as Db;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleWorkbenchRequest(
      { method: init?.method ?? 'GET', path: String(input), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}), headers: Object.fromEntries(new Headers(init?.headers).entries()) },
      deps,
    );
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
}

const mount = (at: string) =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: [at] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe('which cable do I need', () => {
  it('ranks the options for two devices and creates the chosen one as a design with its recipe', async () => {
    serve();
    mount('/resolver');
    const from = await screen.findByLabelText('From device');
    await vi.waitFor(() => expect(within(from).getAllByRole('option').length).toBe(4));
    fireEvent.change(from, { target: { value: 'bench-supply' } });
    fireEvent.change(screen.getByLabelText('To device'), { target: { value: 'led-panel' } });
    const options = await screen.findByTestId('resolver-options');
    expect(options.textContent).toContain('LED current limit, 150 Ω');
    const preview = await screen.findByTestId('resolver-preview');
    expect(preview.textContent).toMatch(/2 plugs, 0 boards, 1 part/);
    fireEvent.click(screen.getByRole('button', { name: 'Create design' }));
    await vi.waitFor(async () => expect(await deps.designs.has('bench-supply-to-led-panel')).toBe(true));
    const saved = (await deps.designs.read('bench-supply-to-led-panel')) as CableDesign;
    expect(saved.recipe).toMatchObject({ source: { device: 'bench-supply' }, destination: { device: 'led-panel' } });
    // the editor opens on it, with a Recipe tab that says it is in step
    const tab = await screen.findByRole('tab', { name: /Recipe/ });
    fireEvent.click(tab);
    expect((await screen.findByTestId('recipe-panel')).textContent).toContain('In step with the recipe');
  }, 30_000);

  it('offers proposals for a pair nothing completes, and remembers a decline', async () => {
    serve();
    mount('/resolver');
    const from = await screen.findByLabelText('From device');
    await vi.waitFor(() => expect(within(from).getAllByRole('option').length).toBe(4));
    fireEvent.change(from, { target: { value: 'usb-supply' } });
    fireEvent.change(screen.getByLabelText('To device'), { target: { value: 'led-panel' } });
    const section = await screen.findByTestId('resolver-proposals');
    expect(section.textContent).toContain('Supply for');
    fireEvent.click(within(section).getAllByRole('button', { name: 'Decline' })[0]!);
    await vi.waitFor(async () => {
      const stored = (await handleWorkbenchRequest({ method: 'GET', path: '/api/proposals' }, deps)).body as { proposals: { state: string }[] };
      expect(stored.proposals.map((p) => p.state)).toEqual(['declined']);
    });
  }, 30_000);

  it('shares field edits with advanced JSON and saves unshown facts through the API', async () => {
    serve();
    mount('/resolver');
    fireEvent.click(await screen.findByRole('tab', { name: 'Devices and recipes' }));
    const section = await screen.findByTestId('resolver-devices');
    const row = section.querySelector('[data-record="bench-supply"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit…' }));
    await screen.findByTestId('device-fields');
    const json = screen.getByLabelText('Devices record') as HTMLTextAreaElement;
    const draft = JSON.parse(json.value);
    draft.note = 'Unshown device note';
    draft.ports[0].note = 'Unshown port note';
    draft.ports[0].pins['1'].note = 'Unshown pin note';
    fireEvent.change(json, { target: { value: JSON.stringify(draft) } });
    fireEvent.change(screen.getByLabelText('Device label'), { target: { value: 'Edited supply' } });
    fireEvent.change(screen.getByLabelText('Port 1 pin 1 direction'), { target: { value: 'passive' } });
    expect(JSON.parse(json.value)).toMatchObject({ label: 'Edited supply', note: draft.note, ports: [{ note: draft.ports[0].note, pins: { '1': { dir: 'passive', note: draft.ports[0].pins['1'].note, src: 'synthetic example' } } }] });
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(screen.queryByTestId('device-fields')).toBeNull());
    const request = vi.mocked(globalThis.fetch).mock.calls.find(([path, init]) => path === '/api/resolver/devices' && init?.method === 'PUT');
    const saved = JSON.parse(request![1]!.body as string).devices[0];
    expect(saved).toMatchObject({ label: 'Edited supply', note: draft.note, ports: [{ note: draft.ports[0].note, pins: { '1': { dir: 'passive', note: draft.ports[0].pins['1'].note } } }] });
  }, 30_000);

  it('says so when the library has no devices', async () => {
    serve();
    deps.loadDb = async () => ({ ...(await memoryWriteBackend(undefined, join(DATA, '..')).deps.loadDb()) }) as Db;
    mount('/resolver');
    expect((await screen.findByTestId('resolver-empty')).textContent).toContain('no device profiles');
  });
});
