// @vitest-environment jsdom
/**
 * "Install pack…" and the pack list on the modules page (`src/modules/PacksPanel.tsx`),
 * over the real API handler on temporary directories: upload a JSON bundle, see the
 * diff, install, then see it listed, and disable it (refused while something uses it).
 */

import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { catalogWithPacksSource, createCatalog, installedAcross } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { PacksPanel } from '../src/modules/PacksPanel.tsx';

const src = 'synthetic example: panel test';
const bundle = (r: string) => ({
  format: 1,
  manifest: { format: 1, id: 'panel', name: 'Panel', version: '1.0.0', license: 'CC0-1.0' },
  files: { 'components.json': [{ id: 'pn-r', label: `${r} resistor`, kind: 'resistor', value: r, terminals: [{ id: 'a' }, { id: 'b' }], src }] },
});

let root = '';
let dir = '';
let packs = '';
let deps: WorkbenchDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirehub-panel-'));
  dir = join(root, 'catalog');
  packs = join(root, 'packs');
  cpSync(join(process.cwd(), '../../packages/catalog/data'), dir, { recursive: true });
  const hub = () => createCatalog(catalogWithPacksSource(dir, packs));
  deps = {
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: false }), remove: () => undefined },
    loadDb: () => hub().loadDb(),
    modules: createRegistry([]),
    installedPacks: () => ({ src: 'x', packs: installedAcross(dir, packs).packs }),
    setup: { dataDir: dir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
  };
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string; body?: string }) => {
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: input, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('a viewer', () => {
  it('sees the installed packs but no Install pack…, update or disable', async () => {
    deps = { ...deps, localUser: { name: 'Vera', source: 'session', role: 'viewer' } };
    render(<PacksPanel />);
    await screen.findByText('No packs are installed.');
    await waitFor(() => expect(screen.queryByLabelText('Pack file')).toBeNull());
    expect(screen.queryByText('Install pack…')).toBeNull();
  });
});

describe('Install pack…', () => {
  it('previews an uploaded bundle with its diff, installs it, lists it, and disables it', async () => {
    render(<PacksPanel />);
    await screen.findByText('No packs are installed.');
    const file = new File([JSON.stringify(bundle('10 Ω'))], 'panel.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Pack file'), { target: { files: [file] } });
    const pending = await screen.findByTestId('pack-pending');
    expect(pending.textContent).toContain('Install panel 1.0.0');
    expect((await screen.findByTestId('pack-diff')).textContent).toContain('added components pn-r');
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await screen.findByText('Installed panel.json.');
    await screen.findByText(/panel/, { selector: 'b' });
    expect(createCatalog(catalogWithPacksSource(dir, packs)).loadDb().components.some((c) => c.id === 'pn-r')).toBe(true);

    // something outside the pack uses it: disable is refused and lists the use
    const kits = JSON.parse(readFileSync(join(dir, 'kits.json'), 'utf8')) as unknown[];
    writeFileSync(join(dir, 'kits.json'), `${JSON.stringify([...kits, { id: 'kit-pn', label: 'K', sku: 'KIT-7', contents: [{ part: { kind: 'component', def: 'pn-r' }, qty: 1, src }], src }], null, 2)}\n`);
    fireEvent.click(screen.getByRole('button', { name: 'Disable…' }));
    expect((await screen.findByTestId('pack-references')).textContent).toContain('kits kit-pn uses pn-r');
    expect((screen.getByRole('button', { name: 'Disable pack' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // remove the use, then disable
    writeFileSync(join(dir, 'kits.json'), `${JSON.stringify(kits, null, 2)}\n`);
    fireEvent.click(screen.getByRole('button', { name: 'Disable…' }));
    await screen.findByText('1 records would be removed.');
    fireEvent.click(screen.getByRole('button', { name: 'Disable pack' }));
    await screen.findByText('Disabled panel.');
    await waitFor(() => expect(screen.queryByText('No packs are installed.')).not.toBeNull());
  });

  it('shows the problems of a pack that fails verification and offers no install', async () => {
    render(<PacksPanel />);
    await screen.findByText('No packs are installed.');
    const bad = bundle('10 Ω');
    delete (bad.files['components.json'][0] as { src?: string }).src;
    fireEvent.change(screen.getByLabelText('Pack file'), { target: { files: [new File([JSON.stringify(bad)], 'bad.json')] } });
    await screen.findByText(/has no src/);
    expect(screen.queryByTestId('pack-pending')).toBeNull();
  });
});
