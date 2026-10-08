import { describe, expect, it, vi } from 'vitest';
import type { LookupRequest, ProviderContext } from '../src/types.ts';
import { digiKeyAdapter } from '../src/providers/digikey.ts';

const request: LookupRequest = { provider: 'digikey', query: 'SYN-42/CT-ND', match: 'supplier', quantity: 20, currency: 'EUR', country: 'GB' };
const credentials = { digikeyClientId: 'synthetic-id', digikeyClientSecret: 'synthetic-secret', digikeyAccountId: '12345' };
const product = () => ({ SearchLocaleUsed: { Currency: 'EUR' }, Product: {
  ManufacturerProductNumber: 'SYN-42+', Manufacturer: { Name: 'Synthetic Components' },
  ProductUrl: 'https://www.digikey.com/en/products/detail/synthetic/42', Description: { ProductDescription: 'Synthetic part' },
  QuantityAvailable: 99999,
  ProductVariations: [
    { DigiKeyProductNumber: 'SYN-42/CT-ND', PackageType: { Name: 'Cut Tape (CT)' }, QuantityAvailableforPackageType: 48, MinimumOrderQuantity: 5, StandardPackage: 4000,
      StandardPricing: [{ BreakQuantity: 1, UnitPrice: 2.5 }, { BreakQuantity: 20, UnitPrice: 2 }], MyPricing: [{ BreakQuantity: 5, UnitPrice: 1.8 }] },
    { DigiKeyProductNumber: 'SYN-42/TR-ND', PackageType: { Name: 'Tape & Reel (TR)' }, QuantityAvailableforPackageType: 10000,
      StandardPricing: [{ BreakQuantity: 4000, UnitPrice: 1 }], MinimumOrderQuantity: 4000, DigiReelFee: 7 },
  ],
} });
function setup(response: unknown = product(), token: unknown = { access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 600 }) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json(token)).mockResolvedValueOnce(Response.json(response));
  const context: ProviderContext = { credentials, fetch, now: () => new Date('2026-01-01T00:00:00Z'), nonce: () => 'syntheticnonce01' };
  return { fetch, context };
}

describe('DigiKey V4 adapter', () => {
  it('uses client credentials, encoded ProductDetails and required account/locale headers', async () => {
    const { fetch, context } = setup(); const [offer] = await digiKeyAdapter(request, context);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.digikey.com/v1/oauth2/token');
    const token = fetch.mock.calls[0]![1]!;
    expect(token.method).toBe('POST');
    expect(new URLSearchParams(token.body as string).get('grant_type')).toBe('client_credentials');
    expect(new URLSearchParams(token.body as string).get('client_secret')).toBe('synthetic-secret');
    expect(fetch.mock.calls[1]![0]).toBe('https://api.digikey.com/products/v4/search/SYN-42%2FCT-ND/productdetails');
    const headers = new Headers(fetch.mock.calls[1]![1]!.headers);
    expect(headers.get('Authorization')).toBe('Bearer synthetic-token');
    expect(headers.get('X-DIGIKEY-Account-Id')).toBe('12345');
    expect(headers.get('X-DIGIKEY-Client-Id')).toBe('synthetic-id');
    expect(headers.get('X-DIGIKEY-Locale-Site')).toBe('UK');
    expect(headers.get('X-DIGIKEY-Locale-Currency')).toBe('EUR');
    expect(offer).toMatchObject({ provider: 'digikey', mpn: 'SYN-42+', stock: 48, moq: 5, currency: 'EUR', packaging: 'Cut Tape (CT)', unit: 'unknown', breaks: [{ minQty: 5, unitPrice: 1.8 }] });
    expect(offer).not.toHaveProperty('orderMultiple'); // StandardPackage is not a purchasing increment.
  });
  it('keeps packaging prices and stock separate for exact MPN matches', async () => {
    const { context } = setup();
    const offers = await digiKeyAdapter({ ...request, query: 'SYN-42+', match: 'mpn' }, context);
    expect(offers).toHaveLength(2); expect(offers[1]).toMatchObject({ stock: 10000, moq: 4000, breaks: [{ minQty: 4000, unitPrice: 1 }] });
    expect(offers[1]!.warnings).toContain('Additional reel fee is not included in unit prices.');
    const mismatch = setup();
    expect(await digiKeyAdapter({ ...request, query: 'SYN-42', match: 'mpn' }, mismatch.context)).toEqual([]);
    expect(await digiKeyAdapter({ ...request, manufacturer: 'Other Manufacturer' }, setup().context)).toEqual([]);
  });
  it('omits unknown stock/prices and refuses unsafe product links without using product totals', async () => {
    const p = product(); const variant = p.Product.ProductVariations[0]!;
    Object.assign(variant, { PackageType: { Name: 'Spool, 100 m' }, QuantityAvailableforPackageType: null, MinimumOrderQuantity: 0, MyPricing: [], StandardPricing: [{ BreakQuantity: 0, UnitPrice: 3 }, { BreakQuantity: 1, UnitPrice: 0 }] });
    p.Product.ProductUrl = 'https://www.digikey.com.evil.invalid/private';
    const [offer] = await digiKeyAdapter(request, setup(p).context);
    expect(offer!.unit).toBe('unknown'); expect(offer!.breaks).toEqual([]); expect(offer).not.toHaveProperty('stock'); expect(offer).not.toHaveProperty('moq'); expect(offer).not.toHaveProperty('url');
    delete (p as { SearchLocaleUsed?: unknown }).SearchLocaleUsed;
    Object.assign(variant, { StandardPricing: [{ BreakQuantity: 1, UnitPrice: 3 }] });
    expect((await digiKeyAdapter(request, setup(p).context))[0]!.breaks).toEqual([]);
  });
  it('records actual returned currency and never silently converts it', async () => {
    const p = product(); p.SearchLocaleUsed.Currency = 'USD';
    const [offer] = await digiKeyAdapter(request, setup(p).context);
    expect(offer!.currency).toBe('USD'); expect(offer!.warnings).toContain('Supplier returned a different currency; no conversion was applied.');
  });
  it('requires all credentials and sanitizes failed authentication and network bodies', async () => {
    const s = setup();
    await expect(digiKeyAdapter(request, { ...s.context, credentials: { ...credentials, digikeyAccountId: '' } })).rejects.toThrow('DigiKey credentials are not configured.');
    expect(s.fetch).not.toHaveBeenCalled();
    await expect(digiKeyAdapter(request, setup(undefined, { error: 'synthetic-secret' }).context)).rejects.toThrow('DigiKey lookup failed.');
    const bad = setup(); bad.fetch.mockReset().mockResolvedValue(Response.json({ error: 'synthetic-secret' }, { status: 401 }));
    await expect(digiKeyAdapter(request, bad.context)).rejects.toThrow('Supplier request failed.');
    const failed = setup(); failed.fetch.mockReset().mockRejectedValue(new Error('synthetic-secret'));
    await expect(digiKeyAdapter(request, failed.context)).rejects.toThrow('Supplier request failed.');
  });
});
