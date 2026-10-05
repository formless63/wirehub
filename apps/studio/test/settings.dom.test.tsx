// @vitest-environment jsdom
/**
 * Hub settings page (cs-5k1.2): the organisation name, rights line and logo are
 * saved through the real API router, become the drawing art every document
 * reads, and a module's own title-block art still wins.
 */

import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { registerDrawingArt } from '@wirehub/docs';
import { registeredLogo, registeredTitleBlock } from '@wirehub/docs/src/drawing/assets.ts';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { makePng } from './png-fixture.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');
const { registry } = await import('../src/modules.browser.ts');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;

beforeEach(() => {
  clearOfflineCache();
  window.localStorage.clear();
  deps = memoryWriteBackend(undefined, join(DATA, '..')).deps;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), headers, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers ?? {}) } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const mount = () =>
  render(<App router={createStudioRouter(createMemoryHistory({ initialEntries: ['/settings'] }))} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

describe('Hub settings', () => {
  it('saves the organisation, rights line and logo, and the documents pick them up', async () => {
    mount();
    const org = (await screen.findByLabelText('Organisation name')) as HTMLInputElement;
    fireEvent.change(org, { target: { value: 'Acme Cable Co' } });
    fireEvent.change(screen.getByLabelText('Rights / confidentiality line'), { target: { value: 'Confidential - Acme' } });
    const file = new File([new Uint8Array(makePng(4, [{ type: 'tEXt', body: 'k\0v' }]))], 'logo.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Logo file'), { target: { files: [file] } });
    });
    await screen.findByAltText('Logo preview');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(registeredTitleBlock().organisation).toBe('Acme Cable Co'));
    expect(registeredTitleBlock().rights).toBe('Confidential - Acme');
    expect(registeredLogo()?.pngBase64).toMatch(/^iVBOR/);
    const stored = await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/branding' }, deps);
    expect((stored.body as { organisation: string }).organisation).toBe('Acme Cable Co');
  });

  it('a module\'s title-block art still wins over the setting', async () => {
    const off = registerDrawingArt({ titleBlock: { organisation: 'Module Org' } });
    try {
      mount();
      fireEvent.change(await screen.findByLabelText('Organisation name'), { target: { value: 'Setting Org' } });
      fireEvent.change(screen.getByLabelText('Rights / confidentiality line'), { target: { value: 'R' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(registeredTitleBlock().rights).toBe('R'));
      expect(registeredTitleBlock().organisation).toBe('Module Org');
    } finally {
      off();
    }
  });
});

describe('Engineering settings', () => {
  it('saves test defaults, electrical thresholds and approvals through the API', async () => {
    mount();
    const volts = (await screen.findByLabelText('Isolation test voltage (V DC)')) as HTMLInputElement;
    fireEvent.change(volts, { target: { value: '250' } });
    fireEvent.change(screen.getByLabelText('Largest voltage drop (V)'), { target: { value: '0.3' } });
    fireEvent.click(screen.getByLabelText('Approvals on'));
    fireEvent.click(screen.getByLabelText('Editors may approve'));
    fireEvent.click(screen.getByRole('button', { name: 'Save engineering settings' }));
    await waitFor(async () => {
      const stored = await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/engineering' }, deps);
      expect(stored.body).toMatchObject({ testDefaults: { isolationVolts: 250 }, electrical: { maxDropV: 0.3 }, approvals: { enabled: true, approverRoles: ['editor', 'owner'] } });
    });
  });
});
