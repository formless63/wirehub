// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { Db } from '@wirehub/model';
import type { ModuleApi, PanelProps } from '@wirehub/modules';
import { AssetDiscoveryPanel } from '../src/ui.ts';
import { candidatesFromTree } from '../src/discovery.ts';

const db = { connectors: [{ id: 'plug', label: 'RJ45 cable plug' }, { id: 'sensor', label: 'Sensor housing' }], components: [] } as unknown as Db;
const props = (api: ModuleApi, id = 'plug'): PanelProps => ({ module: 'catalog-assets', slot: 'library-detail', db, record: { kind: 'connectors', id }, readOnly: true, api });
const candidate = candidatesFromTree([{ type: 'blob', name: 'RJ45_Socket.step', path: 'Connector_RJ.3dshapes/RJ45_Socket.step' }], 'Connector_RJ.3dshapes', '')[0]!;

afterEach(cleanup);

describe('CAD discovery panel', () => {
  it('opens without any provider request and presents visible named external controls', () => {
    const api = vi.fn<ModuleApi>();
    render(createElement(AssetDiscoveryPanel, props(api)));
    expect(api).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Manufacturer part number or search terms')).toHaveProperty('value', 'RJ45 cable plug');
    expect(screen.getByText(/No manufacturer part number is recorded/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Search SnapMagic Search ↗' }).className).toBe('cs-ui-btn');
    expect(screen.getByRole('button', { name: 'Browse KiCad models' }).className).toBe('cs-ui-btn');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows a candidate and citation after an explicit read, with download separate from attachment', async () => {
    const api = vi.fn<ModuleApi>().mockResolvedValue({ status: 200, body: { candidates: [candidate], page: 1, hasMore: false } });
    render(createElement(AssetDiscoveryPanel, props(api)));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Browse KiCad models' })));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]?.[0]).toBe('GET');
    expect(screen.getByRole('link', { name: 'Download STEP from KiCad ↗' }).getAttribute('href')).toBe(candidate.url);
    expect(screen.getByText(candidate.source)).toBeTruthy();
    expect(screen.getByText(candidate.license)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Attach|Replace/ })).toBeNull();
  });

  it('drops a delayed reply after selecting a different Library part', async () => {
    let resolve!: (value: { status: number; body: unknown }) => void;
    const api = vi.fn<ModuleApi>().mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(createElement(AssetDiscoveryPanel, props(api)));
    fireEvent.click(screen.getByRole('button', { name: 'Browse KiCad models' }));
    view.rerender(createElement(AssetDiscoveryPanel, props(api, 'sensor')));
    await act(async () => resolve({ status: 200, body: { candidates: [candidate], page: 1, hasMore: false } }));
    expect(screen.getByLabelText('Manufacturer part number or search terms')).toHaveProperty('value', 'Sensor housing');
    expect(screen.queryByText(candidate.name)).toBeNull();
    expect(screen.getByRole('button', { name: 'Browse KiCad models' }).hasAttribute('disabled')).toBe(false);
  });

  it('clears old results when changing a category or page filter', async () => {
    const api = vi.fn<ModuleApi>().mockResolvedValue({ status: 200, body: { candidates: [candidate], page: 1, hasMore: true } });
    render(createElement(AssetDiscoveryPanel, props(api)));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Browse KiCad models' })));
    fireEvent.change(screen.getByLabelText('Filter file names on this page'), { target: { value: 'Cable' } });
    expect(screen.queryByText(candidate.name)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'TE-Connectivity' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Browse KiCad models' })));
    expect(api.mock.calls[1]?.[1]).toContain('directory=Connector_TE-Connectivity.3dshapes');
    expect(api.mock.calls[1]?.[1]).toContain('q=Cable');
  });
});
