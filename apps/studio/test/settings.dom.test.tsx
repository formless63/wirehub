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
import { registeredBrandFont, registeredLogo, registeredTitleBlock } from '@wirehub/docs/src/drawing/assets.ts';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';
import { brandmark } from './migration-gaps-flow.ts';
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

const mount = (section = 'documents', history = createMemoryHistory({ initialEntries: [`/settings?section=${section}`] })) =>
  render(<App router={createStudioRouter(history)} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })} modules={registry} />);

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

  it('takes an SVG logo and a wire spec file prefix; the file names pick the prefix up (cs-vzv)', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Wire spec file prefix'), { target: { value: 'ACME-WS-' } });
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#c2602a"/></svg>'], 'logo.svg', { type: 'image/svg+xml' });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Logo file'), { target: { files: [svg] } });
    });
    await screen.findByAltText('Logo preview');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(registeredTitleBlock().filePrefix).toBe('ACME-WS-'));
    // saved as a PNG, whatever was uploaded
    await waitFor(() => expect(registeredLogo()?.pngBase64).toMatch(/^iVBOR/));
    const { wireSpecFileName } = await import('@wirehub/docs');
    expect(wireSpecFileName({ id: 'x', partNumber: 'WIR-00001' } as never)).toMatch(/^ACME-WS-/);
  });

  it('takes the title-block general note and tolerances, and the drawing prints them', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('General note line 1'), { target: { value: 'DIMS IN INCHES' } });
    fireEvent.change(screen.getByLabelText('Tolerance 1 label'), { target: { value: 'x.x' } });
    fireEvent.change(screen.getByLabelText('Tolerance 1 value'), { target: { value: '± 0.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(registeredTitleBlock().notes?.[0]).toBe('DIMS IN INCHES'));
    expect(registeredTitleBlock().tolerances).toEqual([['x.x', '± 0.25']]);
    const { renderDrawingSheet } = await import('@wirehub/docs');
    const { createCatalog, fsCatalogSource } = await import('@wirehub/catalog');
    const catalog = createCatalog(fsCatalogSource(DATA, 'the catalog'));
    const sheet = renderDrawingSheet(catalog.loadDesign('dc-led-lead'), catalog.loadDb());
    expect(sheet).toContain('DIMS IN INCHES');
    expect(sheet).toContain('± 0.25');
    expect(sheet).not.toContain('FRACTIONAL');
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
    mount('engineering');
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

  it('uploads a licensed font only once the licence is confirmed, and the documents are set in it after Save', async () => {
    mount();
    const upload = (await screen.findByRole('button', { name: 'Upload font' })) as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    const file = new File([new Uint8Array(brandmark(false))], 'Brandmark-Regular.ttf', { type: 'font/ttf' });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Font file'), { target: { files: [file] } });
    });
    // a file alone is not enough: the licence checkbox gates the upload
    expect(upload.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('I hold a licence for this font'));
    await waitFor(() => expect(upload.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(upload);
    });
    const regular = (await screen.findByLabelText('Regular typeface')) as HTMLSelectElement;
    await waitFor(() => expect(regular.value).not.toBe(''));
    expect(screen.getByText(/TrueType: set on every sheet and in every PDF/)).toBeTruthy();
    expect(registeredBrandFont()).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(registeredBrandFont()?.regular.family).toBe('Brandmark Sans1'));
    const stored = await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/branding' }, deps);
    expect((stored.body as { font: { regular: { family: string } } }).font.regular.family).toBe('Brandmark Sans1');
    // back to the standard sans
    fireEvent.change(await screen.findByLabelText('Regular typeface'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(registeredBrandFont()).toBeUndefined());
  });

  it('takes drawing art as JSON, refuses what is not JSON, and the art is in force after Save', async () => {
    mount();
    const box = (await screen.findByLabelText('Drawing art (JSON)')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/In force now:/).textContent).toContain('0 cutaways'));
    const cutaway = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 525 131"><rect id="dom-art" width="4" height="4"/></svg>', width: 525, height: 131 };
    fireEvent.change(box, { target: { value: JSON.stringify({ cutaways: { 'shielded-2pair-24awg': cutaway } }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/In force now:/).textContent).toContain('1 cutaways'));
    const { registeredCutaway } = await import('@wirehub/docs/src/drawing/assets.ts');
    expect(registeredCutaway('shielded-2pair-24awg')?.svg).toContain('dom-art');
  });
});

describe('Settings sections', () => {
  it.each(['stores', 'modules'])('opens %s directly and shows only the selected section', async (section) => {
    const { container } = mount(section);
    await screen.findByRole('navigation', { name: 'Settings sections' });
    await waitFor(() => {
      const visible = [...container.querySelectorAll<HTMLElement>('[data-settings-section]')].filter((panel) => !panel.hidden);
      expect(visible.map((panel) => panel.dataset.settingsSection)).toEqual([section]);
    });
    const name = section === 'stores' ? 'Catalog stores' : 'Code modules';
    expect(screen.getByRole('link', { name }).getAttribute('aria-current')).toBe('page');
  });

  it('keeps unsaved document and numbering drafts while switching sections and browser history', async () => {
    const history = createMemoryHistory({ initialEntries: ['/settings?section=documents'] });
    const { container } = mount('documents', history);
    const organisation = await screen.findByLabelText('Organisation name') as HTMLInputElement;
    fireEvent.change(organisation, { target: { value: 'Unsaved synthetic organisation' } });
    fireEvent.click(screen.getByRole('link', { name: 'Part numbering' }));
    await waitFor(() => expect(history.location.href).toContain('section=numbering'));
    const definition = await screen.findByLabelText('Scheme definition') as HTMLTextAreaElement;
    fireEvent.change(definition, { target: { value: '{ "type": "declarative", "draft": true }' } });
    fireEvent.change(screen.getByLabelText('Settings section'), { target: { value: 'documents' } });
    await waitFor(() => expect(container.querySelector<HTMLElement>('[data-settings-section="documents"]')!.hidden).toBe(false));
    expect(organisation.value).toBe('Unsaved synthetic organisation');
    history.back();
    await waitFor(() => expect(container.querySelector<HTMLElement>('[data-settings-section="numbering"]')!.hidden).toBe(false));
    expect(definition.value).toContain('"draft": true');
    expect((await handleWorkbenchRequest({ method: 'GET', path: '/api/settings/branding' }, deps)).body).not.toMatchObject({ organisation: 'Unsaved synthetic organisation' });
  });

  it('defaults an unknown section to documents and keeps viewer controls read-only after navigation', async () => {
    deps.localUser = { name: 'Synthetic viewer', source: 'local', role: 'viewer' };
    const { container } = mount('unknown');
    const organisation = await screen.findByLabelText('Organisation name') as HTMLInputElement;
    await waitFor(() => expect(organisation.disabled).toBe(true));
    expect(container.querySelector<HTMLElement>('[data-settings-section="documents"]')!.hidden).toBe(false);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Engineering' }));
    await waitFor(() => expect(container.querySelector<HTMLElement>('[data-settings-section="engineering"]')!.hidden).toBe(false));
    expect((screen.getByLabelText('Isolation test voltage (V DC)') as HTMLInputElement).disabled).toBe(true);
  });
});
