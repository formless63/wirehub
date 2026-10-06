// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CableDesign, Db } from '@wirehub/model';
import type { ModuleApi, PanelProps } from '@wirehub/modules';
import { DocumentsPanel, LibraryPanel, ProcurementPage, SettingsPanel } from '../../../modules/suppliers/src/ui.ts';
import type { LookupRequest, LookupResult, SupplierOffer } from '../../../modules/suppliers/src/types.ts';

const providers = [{ id: 'mouser', label: 'Mouser', enabled: true, configured: true }, { id: 'digikey', label: 'DigiKey', enabled: true, configured: true }, { id: 'lcsc', label: 'LCSC', enabled: false, configured: true }];
const db = { connectors: [], wires: [], pcbas: [], components: [
  { id: 'first', label: 'Synthetic component', manufacturer: 'Synthetic maker', mpn: 'PART-1', suppliers: [{ supplier: 'Mouser', number: 'SKU-1' }, { supplier: 'Digi-Key', number: 'DK-1' }] },
  { id: 'second', label: 'Other component', manufacturer: 'Other maker', mpn: 'PART-2', suppliers: [{ supplier: 'Mouser', number: 'SKU-2' }] },
] } as unknown as Db;
const offer = (over: Partial<SupplierOffer> = {}): SupplierOffer => ({ provider: 'mouser', supplierNumber: 'SKU-1', mpn: 'PART-1', manufacturer: 'Synthetic maker', observedAt: '2020-01-01T00:00:00Z', currency: 'USD', unit: 'each', packaging: 'reel', stock: 42, moq: 5, orderMultiple: 5, breaks: [{ minQty: 1, unitPrice: 2.5 }, { minQty: 10, unitPrice: 2 }], url: 'https://www.mouser.com/ProductDetail/synthetic', ...over });
const result = (request: LookupRequest, offers = [offer()]): LookupResult => ({ request, offers, observedAt: '2020-01-01T00:00:00Z' });
const props = (api: ModuleApi, id = 'first', readOnly = false): PanelProps => ({ module: 'suppliers', slot: 'library-detail', record: { kind: 'components', id }, readOnly, db, api });
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function successApi(offers = [offer()]) {
  let request!: LookupRequest;
  return vi.fn<ModuleApi>(async (method, path, body) => {
    if (path === 'config') return { status: 200, body: { providers } };
    if (method === 'POST') { request = body as LookupRequest; return { status: 202, body: { job: { id: 'job-1', status: 'queued', kind: 'suppliers:lookup' } } }; }
    return { status: 200, body: { job: { id: 'job-1', status: 'succeeded', result: result(request, offers) } } };
  });
}
async function ready(): Promise<void> { await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh quote' }) as HTMLButtonElement).disabled).toBe(false)); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('optional supplier UI', () => {
  it('prefills exact supplier SKUs, submits edited quantity/locality, displays offers and downloads CSV and a reviewed quote', async () => {
    const api = successApi();
    const create = vi.fn(() => 'blob:synthetic'); const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<LibraryPanel {...props(api)} />); await ready();
    expect((screen.getByLabelText('Part number') as HTMLInputElement).value).toBe('SKU-1');
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'digikey' } });
    expect((screen.getByLabelText('Part number') as HTMLInputElement).value).toBe('DK-1');
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'mouser' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'eur' } });
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'de' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' }));
    expect(await screen.findByText('42')).toBeTruthy();
    expect(api.mock.calls.find(([method]) => method === 'POST')?.[2]).toEqual({ provider: 'mouser', query: 'SKU-1', match: 'supplier', manufacturer: 'Synthetic maker', quantity: 10, currency: 'EUR', country: 'DE' });
    expect(screen.getByText('5 / 5')).toBeTruthy(); expect(screen.getByText('reel / each')).toBeTruthy(); expect(screen.getByText('10+: 2 USD / each')).toBeTruthy();
    expect(screen.getByText(/more than 24 hours old/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download offer CSV' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download reviewed quote' }));
    expect(create).toHaveBeenCalledTimes(2); expect(click).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Library → Import/)).toBeTruthy();
    expect(api.mock.calls.every(([, path]) => path === 'config' || path === 'lookup' || path.startsWith('lookup?id='))).toBe(true);
  });

  it.each(['succeeded', 'failed'])('discards old %s responses when the query, quantity or record changes', async (oldStatus) => {
    const old = deferred<{ status: number; body: unknown }>();
    let request!: LookupRequest; let job = 0;
    const api = vi.fn<ModuleApi>(async (method, path, body) => {
      if (path === 'config') return { status: 200, body: { providers } };
      if (method === 'POST') { request = body as LookupRequest; job += 1; return { status: 202, body: { job: { id: String(job), status: 'queued' } } }; }
      if (path === 'lookup?id=1') return old.promise;
      return { status: 200, body: { job: { status: 'succeeded', result: result(request, [offer({ supplierNumber: 'NEW-SKU' })]) } } };
    });
    const mounted = render(<LibraryPanel {...props(api)} />); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('GET', 'lookup?id=1'));
    fireEvent.change(screen.getByLabelText('Part number'), { target: { value: 'NEW-SKU' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' })); await screen.findByRole('link', { name: 'NEW-SKU' });
    await act(async () => old.resolve({ status: 200, body: { job: { status: oldStatus, error: 'old failure', result: result(request, [offer({ supplierNumber: 'OLD-SKU' })]) } } }));
    expect(screen.queryByText('old failure')).toBeNull(); expect(screen.queryByRole('link', { name: 'OLD-SKU' })).toBeNull(); expect(screen.getByRole('link', { name: 'NEW-SKU' })).toBeTruthy();
    mounted.rerender(<LibraryPanel {...props(api, 'second')} />);
    expect((screen.getByLabelText('Part number') as HTMLInputElement).value).toBe('SKU-2'); expect(screen.queryByRole('link', { name: 'NEW-SKU' })).toBeNull();
  });

  it('cancels polling on unmount and ignores a late configuration for the old record', async () => {
    const config = deferred<{ status: number; body: unknown }>();
    const api = vi.fn<ModuleApi>(async (_method, path) => path === 'config' ? config.promise : path === 'lookup' ? { status: 202, body: { job: { id: 'slow' } } } : { status: 200, body: { job: { status: 'queued' } } });
    const mounted = render(<LibraryPanel {...props(api)} />);
    mounted.rerender(<LibraryPanel {...props(api, 'second')} />);
    await act(async () => config.resolve({ status: 200, body: { providers } })); await ready();
    expect((screen.getByLabelText('Part number') as HTMLInputElement).value).toBe('SKU-2');
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' })));
    expect(api).toHaveBeenCalledWith('GET', 'lookup?id=slow');
    mounted.unmount(); const count = api.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(api.mock.calls.length).toBe(count);
  });

  it('blocks disabled providers/invalid quantities and shows failures without inventing prices', async () => {
    const api = successApi(); render(<LibraryPanel {...props(api)} />); await ready();
    expect((screen.getByRole('option', { name: 'LCSC (disabled)' }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'lcsc' } });
    expect((screen.getByRole('button', { name: 'Refresh quote' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'mouser' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '0' } });
    expect((screen.getByRole('button', { name: 'Refresh quote' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1.5' } });
    expect((screen.getByRole('button', { name: 'Refresh quote' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.mock.calls.some(([method]) => method === 'POST')).toBe(false);
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
    api.mockImplementation(async (_method, path) => path === 'lookup' ? { status: 503, body: { error: 'Supplier unavailable' } } : { status: 200, body: { providers } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' })); expect(await screen.findByText('Supplier unavailable')).toBeTruthy(); expect(screen.queryByText('0 USD')).toBeNull();
  });

  it('keeps read-only and unknown-unit quotes unadoptable and rejects unsafe supplier links', async () => {
    const api = successApi([offer({ url: 'javascript:alert(1)', unit: 'unknown', breaks: [] })]);
    render(<LibraryPanel {...props(api, 'first', true)} />); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' }));
    expect(await screen.findByText('Price unavailable')).toBeTruthy(); expect(screen.queryByRole('link')).toBeNull();
    expect((screen.getByRole('button', { name: 'Download reviewed quote' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This record is read-only.')).toBeTruthy(); expect((screen.getByLabelText('Pricing basis for SKU-1') as HTMLSelectElement).disabled).toBe(true); expect(screen.getByText(/supplier did not confirm purchasing units/)).toBeTruthy();
  });

  it('requires explicit user confirmation of an unknown pricing basis before a priced quote download', async () => {
    const api = successApi([offer({ unit: 'unknown', moq: 1, orderMultiple: 1 })]);
    const create = vi.fn((_blob: Blob) => 'blob:confirmed'); vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<LibraryPanel {...props(api)} />); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' })); await screen.findByText('reel / unknown');
    const adopt = screen.getByRole('button', { name: 'Download reviewed quote' }) as HTMLButtonElement; expect(adopt.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Pricing basis for SKU-1'), { target: { value: 'each' } }); expect(adopt.disabled).toBe(false);
    expect(screen.getByText('reel / unknown')).toBeTruthy();
    fireEvent.click(adopt); expect(create).toHaveBeenCalledOnce();
    const contents = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(create.mock.calls[0]![0] as unknown as Blob); });
    expect(JSON.parse(contents).offer).toMatchObject({ unit: 'each', warnings: ['Pricing basis confirmed by user.'] });
    fireEvent.change(screen.getByLabelText('Pricing basis for SKU-1'), { target: { value: '' } }); expect(adopt.disabled).toBe(true);
    expect(api.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('downloads model-derived purchasing requirements for an explicit build quantity, including on a read-only design', async () => {
    const create = vi.fn(() => 'blob:requirements'); vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const design: CableDesign = { schemaVersion: 4, id: 'synthetic-cable', label: 'Synthetic cable', instances: { connectors: [], segments: [], components: [], pcbas: [] }, joints: [], src: 'synthetic example' };
    render(<DocumentsPanel {...props(successApi(), 'first', true)} slot="cable-documents" design={design} />);
    fireEvent.change(screen.getByLabelText('Build quantity'), { target: { value: '0' } });
    expect((screen.getByRole('button', { name: 'Download purchasing requirements' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Build quantity'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download purchasing requirements' })); expect(create).toHaveBeenCalledOnce();
    expect(screen.getByText(/PCBAs remain whole assemblies/)).toBeTruthy();
  });

  it('shows deployment configuration without credential fields, and supports a procurement lookup page', async () => {
    const api = successApi(); const settings = render(<SettingsPanel {...props(api)} />);
    expect(await screen.findByText('Mouser: ready')).toBeTruthy(); expect(screen.getByText('LCSC: disabled')).toBeTruthy(); expect(screen.queryByRole('textbox')).toBeNull();
    settings.unmount(); render(<ProcurementPage module="suppliers" path="quotes" db={db} api={api} />);
    expect(screen.getByRole('heading', { name: 'Supplier quotes' })).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Part number'), { target: { value: 'MANUAL-PART' } }); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' })); await screen.findByText('42');
    expect((screen.getByRole('button', { name: 'Download reviewed quote' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
