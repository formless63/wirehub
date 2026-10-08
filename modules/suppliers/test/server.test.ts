import { describe, expect, it, vi } from 'vitest';
import type { JobQueueContext, ModuleJobs, ModuleSettings } from '@wirehub/modules';
import type { SupplierAdapter, SupplierOffer } from '../src/types.ts';
import { createSupplierIntegration, lookupRequest } from '../src/server.ts';
import { SupplierHttpError } from '../src/providers/http.ts';

const input = { provider: 'mouser', query: 'SYN-1/A', match: 'mpn', manufacturer: 'Synthetic', quantity: 10, currency: 'USD', country: 'US' };
// the module's declared settings, as the host's module API resolves them (by setting key)
const env = { providers: 'mouser', mouserKey: 'test-only-credential' };
const settingsOf = (values: Record<string, string | undefined>): ModuleSettings => ({ get: async (key) => values[key] });
const now = () => new Date('2026-01-02T03:04:05Z');
const offer: SupplierOffer = { provider: 'mouser', supplierNumber: 'SKU-1', mpn: 'SYN-1/A', manufacturer: 'Synthetic', currency: 'USD', unit: 'each', observedAt: now().toISOString(), stock: 0, breaks: [{ minQty: 1, unitPrice: 1.25 }] };
const job = { id: 'job-1', kind: 'suppliers:lookup', status: 'queued' };
const jobs = (): ModuleJobs => ({ enqueue: vi.fn(async () => job), get: vi.fn(async () => ({ ...job, steps: [] })) });
function setup(adapter: SupplierAdapter = async () => [offer], environment: Record<string, string | undefined> = env) {
  const integration = createSupplierIntegration({ settings: settingsOf(environment), now, adapters: { mouser: adapter } });
  const route = (method: string, path: string) => integration.routes!.find((r) => r.method === method && r.path === path)!.handle;
  const run = (request: Record<string, unknown>) => integration.queues![0]!.run({ request } as JobQueueContext);
  return { integration, route, run };
}

describe('supplier orchestration', () => {
  it('reports explicit enablement and credential presence, never secret values; reads settings lazily', async () => {
    const environment: Record<string, string | undefined> = { mouserKey: env.mouserKey };
    const { route, integration } = setup(undefined, environment);
    const config = async () => route('GET', 'config')({ query: new URLSearchParams() });
    expect(await config()).toEqual({ status: 200, body: { providers: [
      { id: 'mouser', label: 'Mouser', enabled: false, configured: true },
      { id: 'digikey', label: 'DigiKey', enabled: false, configured: false },
      { id: 'lcsc', label: 'LCSC', enabled: false, configured: false },
    ] } });
    environment.providers = 'mouser,unknown';
    expect(JSON.stringify(await config())).not.toContain(env.mouserKey);
    expect((await config()).body).toMatchObject({ providers: [{ id: 'mouser', enabled: true }, {}, {}] });
    // credentials come from the module settings the host resolves, never from the process environment
    expect(integration.env).toBeUndefined();
  });

  it.each([
    {}, { ...input, provider: 'other' }, { ...input, quantity: 0 }, { ...input, quantity: 1.5 },
    { ...input, currency: 'dollars' }, { ...input, country: 'USA' }, { ...input, query: 'A|B' },
    { ...input, query: 'x\nkey' }, { ...input, manufacturer: {} }, { ...input, match: 'fuzzy' },
  ])('rejects invalid input at route and queue without dispatch', async (invalid) => {
    const adapter = vi.fn(async () => [offer]);
    const { route, run } = setup(adapter);
    expect((await route('POST', 'lookup')({ body: invalid, query: new URLSearchParams(), jobs: jobs() })).status).toBe(400);
    await expect(run(invalid)).rejects.toThrow('Invalid supplier lookup request.');
    expect(adapter).not.toHaveBeenCalled();
  });

  it('normalizes only edge whitespace and code case, preserving meaningful punctuation', () => {
    expect(lookupRequest({ ...input, query: '  SYN-1/A  ', currency: 'usd', country: 'us' })).toEqual(input);
  });

  it('enqueues scoped normalized requests and fails cleanly when jobs are unavailable', async () => {
    const { route } = setup();
    const scope = jobs();
    expect(await route('POST', 'lookup')({ body: input, query: new URLSearchParams(), jobs: scope })).toEqual({ status: 202, body: { job } });
    expect(scope.enqueue).toHaveBeenCalledWith('lookup', input);
    expect((await route('POST', 'lookup')({ body: input, query: new URLSearchParams() })).status).toBe(501);
    expect((await route('GET', 'lookup')({ query: new URLSearchParams('id=job-1') })).status).toBe(501);
  });

  it('checks enablement and credentials again at execution time', async () => {
    const environment: Record<string, string | undefined> = { ...env };
    const adapter = vi.fn(async () => [offer]);
    const { route, run } = setup(adapter, environment);
    const scope = jobs();
    await route('POST', 'lookup')({ body: input, query: new URLSearchParams(), jobs: scope });
    environment.providers = '';
    expect((await route('POST', 'lookup')({ body: input, query: new URLSearchParams(), jobs: scope })).status).toBe(409);
    await expect(run(input)).rejects.toThrow('disabled or not configured');
    environment.providers = 'mouser';
    environment.mouserKey = '';
    await expect(run(input)).rejects.toThrow('disabled or not configured');
    expect(adapter).not.toHaveBeenCalled();
  });

  it('dispatches once, exact-filters identities/manufacturer, sanitizes and bounds offers', async () => {
    const adapter = vi.fn(async () => [
      { ...offer, mpn: 'SYN1A' }, { ...offer, mpn: 'SYN-1/A-EXTRA' }, { ...offer, manufacturer: 'Other' },
      { ...offer, description: `Text ${env.mouserKey}`, url: 'javascript:bad', stock: Number.NaN, orderMultiple: 0,
        breaks: [{ minQty: 1, unitPrice: Number.NaN }, { minQty: 2, unitPrice: 0 }, { minQty: -1, unitPrice: 2 }],
      },
    ]);
    const { run } = setup(adapter);
    const result = await run(input);
    expect(adapter).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ request: input, offers: [{ mpn: 'SYN-1/A', breaks: [{ minQty: 2, unitPrice: 0 }] }], observedAt: now().toISOString() });
    expect(JSON.stringify(result)).not.toContain(env.mouserKey);
    expect(JSON.stringify(result)).not.toContain('javascript');
    expect((result?.offers as SupplierOffer[])[0]).not.toHaveProperty('stock');
  });

  it('matches supplier identifiers independently from MPN and discards other currencies', async () => {
    const { run } = setup(async () => [{ ...offer, currency: 'EUR' }]);
    const result = await run({ ...input, match: 'supplier', query: 'SKU-1' });
    expect(result).toMatchObject({ offers: [{ supplierNumber: 'SKU-1', breaks: [], currency: 'USD' }] });
  });

  it('does not return another queue job or expose arbitrary job errors', async () => {
    const { route } = setup();
    const get = route('GET', 'lookup');
    expect((await get({ query: new URLSearchParams(), jobs: jobs() })).status).toBe(400);
    expect((await get({ query: new URLSearchParams('id=missing'), jobs: { ...jobs(), get: async () => undefined } })).status).toBe(404);
    expect((await get({ query: new URLSearchParams('id=other'), jobs: { ...jobs(), get: async () => ({ ...job, kind: 'suppliers:other', steps: [] }) } })).status).toBe(404);
    const response = await get({ query: new URLSearchParams('id=job-1'), jobs: { ...jobs(), get: async () => ({ ...job, status: 'failed', steps: [], error: `https://private.invalid?key=${env.mouserKey}` }) } });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response)).not.toContain(env.mouserKey);
    expect(JSON.stringify(response)).not.toContain('private.invalid');
  });

  it('omits contradictory prices at one quantity while deduplicating identical breaks', async () => {
    const result = await setup(async () => [{ ...offer, breaks: [{ minQty: 1, unitPrice: 1 }, { minQty: 1, unitPrice: 2 }, { minQty: 10, unitPrice: 0.5 }, { minQty: 10, unitPrice: 0.5 }] }]).run(input);
    expect(result).toMatchObject({ offers: [{ breaks: [{ minQty: 10, unitPrice: 0.5 }], warnings: ['Conflicting prices for the same quantity were omitted.'] }] });
  });

  it('dispatches each explicitly enabled provider with a valid default nonce', async () => {
    const environment = {
      ...env, providers: 'mouser,digikey,lcsc',
      digikeyClientId: 'synthetic-id', digikeyClientSecret: 'synthetic-secret',
      digikeyAccountId: 'synthetic-account',
      lcscKey: 'synthetic-key', lcscSecret: 'synthetic-secret',
    };
    for (const provider of ['mouser', 'digikey', 'lcsc'] as const) {
      const adapter = vi.fn(async (_request: Parameters<SupplierAdapter>[0], ctx: Parameters<SupplierAdapter>[1]) => {
        expect(ctx.nonce()).toMatch(/^[a-zA-Z0-9]{16}$/);
        return [{ ...offer, provider }];
      }) as SupplierAdapter;
      const integration = createSupplierIntegration({ settings: settingsOf(environment), now, adapters: { [provider]: adapter } });
      const result = await integration.queues![0]!.run({ request: { ...input, provider } } as unknown as JobQueueContext);
      expect(result).toMatchObject({ offers: [{ provider }] });
      expect(adapter).toHaveBeenCalledOnce();
    }
  });

  it('keeps the observation date stable across later polls and omits unrelated links', async () => {
    const { route } = setup();
    const scope: ModuleJobs = { ...jobs(), get: async () => ({ ...job, status: 'succeeded', steps: [], result: {
      request: input, offers: [{ ...offer, url: 'https://mouser.com.attacker.invalid/product' }], observedAt: '2020-01-01T00:00:00Z',
    } }) };
    const response = await route('GET', 'lookup')({ query: new URLSearchParams('id=job-1'), jobs: scope });
    expect(response).toMatchObject({ status: 200, body: { job: { result: { observedAt: '2020-01-01T00:00:00Z', offers: [{ observedAt: offer.observedAt }] } } } });
    expect(JSON.stringify(response)).not.toContain('attacker.invalid');
  });

  it('keeps only safe transport diagnostics and never arbitrary provider errors', async () => {
    await expect(setup(async () => { throw new Error(`private body ${env.mouserKey}`); }).run(input)).rejects.toThrow(/^Supplier lookup failed\.$/);
    await expect(setup(async () => { throw new SupplierHttpError('Supplier rate limit reached; retry after 2 seconds.'); }).run(input)).rejects.toThrow('retry after 2 seconds');
  });

  it('prefers the settings the host hands each request and job over any fallback', async () => {
    const adapter = vi.fn(async (_request: Parameters<SupplierAdapter>[0], ctx: Parameters<SupplierAdapter>[1]) => {
      expect(ctx.credentials.mouserKey).toBe('from-the-host');
      return [offer];
    }) as SupplierAdapter;
    const integration = createSupplierIntegration({ now, adapters: { mouser: adapter } });
    const config = integration.routes!.find((r) => r.path === 'config')!.handle;
    // no settings at all (an older host): everything off, nothing read from the environment
    expect((await config({ query: new URLSearchParams() })).body).toMatchObject({ providers: [{ id: 'mouser', enabled: false, configured: false }, {}, {}] });
    const host = settingsOf({ providers: 'mouser', mouserKey: 'from-the-host' });
    expect((await config({ query: new URLSearchParams(), settings: host })).body).toMatchObject({ providers: [{ id: 'mouser', enabled: true, configured: true }, {}, {}] });
    await integration.queues![0]!.run({ request: input, settings: host } as unknown as JobQueueContext);
    expect(adapter).toHaveBeenCalledOnce();
  });
});
