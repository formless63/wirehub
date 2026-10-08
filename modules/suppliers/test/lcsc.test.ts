import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { LookupRequest, ProviderContext } from '../src/types.ts';
import { lcscAdapter } from '../src/providers/lcsc.ts';

const request: LookupRequest = { provider: 'lcsc', query: 'C123456', match: 'supplier', quantity: 25, currency: 'USD', country: 'US' };
const credentials = { lcscKey: 'synthetic-key', lcscSecret: 'synthetic-secret' };
const product = () => ({ lcscProductNumber: 'C123456', manufacturerProductNumber: 'SYN-42+', manufacturer: { name: 'Synthetic Components' },
  productDetailURL: 'https://www.lcsc.com/product-detail/C123456.html', packageType: 'Tape & Reel (TR)', quantityAvailable: '540', minimumOrderQuantity: 5, incrementQuantity: 5, manufacturerStandardPackageQuantity: 4000,
  productPrice: { currency: 'USD', standardPricing: [{ breakQuantity: 5, unitPrice: 0.4 }, { breakQuantity: 100, unitPrice: 0.3 }], lcscReelFee: 2 },
});
function setup(result: unknown = product(), overrides: Record<string, unknown> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ success: true, code: 200, result, ...overrides }));
  const context: ProviderContext = { credentials, fetch, now: () => new Date('2026-01-01T00:00:00Z'), nonce: () => 'abcdefghijklmnop' };
  return { fetch, context };
}

describe('LCSC approved partner API v3.4 adapter', () => {
  it('uses the current production details endpoint with SHA256 auth headers over sorted business params', async () => {
    const { fetch, context } = setup(); const [offer] = await lcscAdapter(request, context);
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://api.lcsc.com/rest/api/agent/product/v1/productdetails');
    expect(url.search).toBe('?currency=USD&lcscProductNumber=C123456&returnInformation=All');
    expect(url.searchParams.has('secret')).toBe(false); expect(url.searchParams.has('key')).toBe(false);
    const h = new Headers(fetch.mock.calls[0]![1]!.headers);
    expect(h.get('key')).toBe('synthetic-key'); expect(h.get('nonce')).toBe('abcdefghijklmnop'); expect(h.get('timestamp')).toBe('1767225600');
    const signed = 'key=synthetic-key&nonce=abcdefghijklmnop&secret=synthetic-secret&timestamp=1767225600&currency=USD&lcscProductNumber=C123456&returnInformation=All';
    expect(h.get('signature')).toBe(createHash('sha256').update(signed).digest('hex'));
    expect(h.get('signature')).toHaveLength(64); expect(Array.from(h.values()).join(' ')).not.toContain('synthetic-secret');
    expect(offer).toMatchObject({ supplierNumber: 'C123456', mpn: 'SYN-42+', stock: 540, moq: 5, orderMultiple: 5, unit: 'unknown', breaks: [{ minQty: 5, unitPrice: 0.4 }, { minQty: 100, unitPrice: 0.3 }] });
  });
  it('signs quote_plus punctuation correctly and filters fuzzy search results to exact MPN/manufacturer', async () => {
    const exact = product(); exact.manufacturerProductNumber = "SYN-42+ /'!()";
    const other = product(); other.manufacturerProductNumber = 'SYN-42';
    const { fetch, context } = setup({ products: [other, exact] });
    const offers = await lcscAdapter({ ...request, match: 'mpn', query: exact.manufacturerProductNumber, manufacturer: 'Synthetic Components' }, context);
    expect(offers).toHaveLength(1);
    const url = new URL(String(fetch.mock.calls[0]![0])); expect(url.pathname).toMatch(/\/keywordsearch$/);
    expect(url.searchParams.get('limit')).toBe('30'); expect(url.searchParams.get('offset')).toBe('0');
    const query = "currency=USD&keyword=SYN-42%2B+%2F%27%21%28%29&language=EN&limit=30&offset=0&returnInformation=All";
    expect(url.search.slice(1)).toBe(query);
    const h = new Headers(fetch.mock.calls[0]![1]!.headers);
    expect(h.get('signature')).toBe(createHash('sha256').update(`key=synthetic-key&nonce=abcdefghijklmnop&secret=synthetic-secret&timestamp=1767225600&${query}`).digest('hex'));
    expect(await lcscAdapter({ ...request, manufacturer: 'Other Manufacturer' }, setup().context)).toEqual([]);
  });
  it('rejects mismatched supplier numbers and conservatively omits unknown quantities/prices/links', async () => {
    expect(await lcscAdapter({ ...request, query: 'C000000' }, setup().context)).toEqual([]);
    const p = product(); Object.assign(p, { packageType: 'Spool, 100 m', quantityAvailable: '', minimumOrderQuantity: null, incrementQuantity: null, productDetailURL: 'http://www.lcsc.com/product-detail/C123456.html' });
    Object.assign(p.productPrice, { standardPricing: [{ breakQuantity: 1, unitPrice: 0 }, { breakQuantity: 0, unitPrice: 2 }] });
    const [offer] = await lcscAdapter(request, setup(p).context);
    expect(offer!.unit).toBe('unknown'); expect(offer!.breaks).toEqual([]); expect(offer).not.toHaveProperty('stock'); expect(offer).not.toHaveProperty('moq'); expect(offer).not.toHaveProperty('orderMultiple'); expect(offer).not.toHaveProperty('url');
    Object.assign(p.productPrice, { currency: '', standardPricing: [{ breakQuantity: 1, unitPrice: 2 }] });
    expect((await lcscAdapter(request, setup(p).context))[0]!.breaks).toEqual([]);
  });
  it('uses actual returned currency because All may ignore requested currency', async () => {
    const [offer] = await lcscAdapter({ ...request, currency: 'EUR' }, setup().context);
    expect(offer!.currency).toBe('USD'); expect(offer!.warnings).toContain('Supplier returned a different currency; no conversion was applied.');
  });
  it('uses one separately signed pricing-only call for missing/requested currency and joins exact identity', async () => {
    for (const initialCurrency of ['USD', '']) {
      const p = product(); p.productPrice.currency = initialCurrency;
      const s = setup(p);
      s.fetch.mockReset().mockResolvedValueOnce(Response.json({ success: true, code: 200, result: p })).mockResolvedValueOnce(Response.json({ success: true, code: 200, result: {
        productPrice: { lcscProductNumber: p.lcscProductNumber, manufacturerProductNumber: p.manufacturerProductNumber, manufacturer: p.manufacturer, currency: 'EUR', quantityAvailable: '123', standardPricing: [{ breakQuantity: 5, unitPrice: 0.35 }] },
      } }));
      const nonce = vi.fn().mockReturnValueOnce('abcdefghijklmnop').mockReturnValueOnce('qrstuvwxyzabcdef');
      const [offer] = await lcscAdapter({ ...request, currency: 'EUR' }, { ...s.context, nonce });
      expect(s.fetch).toHaveBeenCalledTimes(2); expect(nonce).toHaveBeenCalledTimes(2);
      const url = new URL(String(s.fetch.mock.calls[1]![0]));
      expect(url.searchParams.get('returnInformation')).toBe('ProductPricing'); expect(url.searchParams.get('currency')).toBe('EUR');
      const h = new Headers(s.fetch.mock.calls[1]![1]!.headers);
      expect(h.get('nonce')).toBe('qrstuvwxyzabcdef');
      expect(h.get('signature')).toBe(createHash('sha256').update(`key=synthetic-key&nonce=qrstuvwxyzabcdef&secret=synthetic-secret&timestamp=1767225600&${url.search.slice(1)}`).digest('hex'));
      expect(offer).toMatchObject({ currency: 'EUR', stock: 123, moq: 5, orderMultiple: 5, packaging: 'Tape & Reel (TR)', unit: 'unknown', breaks: [{ minQty: 5, unitPrice: 0.35 }] });
      expect(offer!.warnings).not.toContain('Supplier returned a different currency; no conversion was applied.');
      expect(offer!.warnings).not.toContain('Pricing currency was not supplied; prices were omitted.');
    }
  });
  it('joins pricing-only keyword results by full identity rather than row position or fuzzy MPN', async () => {
    const p = product();
    const price = { lcscProductNumber: p.lcscProductNumber, manufacturerProductNumber: p.manufacturerProductNumber, manufacturer: p.manufacturer, currency: 'EUR', standardPricing: [{ breakQuantity: 5, unitPrice: 0.35 }] };
    const s = setup();
    s.fetch.mockReset().mockResolvedValueOnce(Response.json({ success: true, code: 200, result: { products: [p] } })).mockResolvedValueOnce(Response.json({ success: true, code: 200, result: { products: [
      { productPrice: { ...price, lcscProductNumber: 'C999999' } }, { productPrice: price },
    ] } }));
    const [offer] = await lcscAdapter({ ...request, query: p.manufacturerProductNumber, match: 'mpn', currency: 'EUR' }, s.context);
    expect(offer!.breaks).toEqual([{ minQty: 5, unitPrice: 0.35 }]); expect(s.fetch).toHaveBeenCalledTimes(2);
    for (const patch of [{ lcscProductNumber: 'C999999' }, { manufacturerProductNumber: 'SYN-42' }, { manufacturer: { name: 'Another manufacturer' } }, { currency: 'USD' }, { manufacturer: undefined }]) {
      const bad = setup(); bad.fetch.mockReset().mockResolvedValueOnce(Response.json({ success: true, code: 200, result: p })).mockResolvedValueOnce(Response.json({ success: true, code: 200, result: { productPrice: { ...price, ...patch } } }));
      const [unjoined] = await lcscAdapter({ ...request, currency: 'EUR' }, bad.context);
      expect(unjoined!.currency).toBe('USD'); expect(unjoined!.breaks).toEqual(p.productPrice.standardPricing.map(b => ({ minQty: b.breakQuantity, unitPrice: b.unitPrice })));
      expect(bad.fetch).toHaveBeenCalledTimes(2);
    }
  });
  it('does not fan out or retry ambiguous/malformed pricing-only results', async () => {
    const p = product(); const price = { lcscProductNumber: p.lcscProductNumber, manufacturerProductNumber: p.manufacturerProductNumber, manufacturer: p.manufacturer, currency: 'EUR', standardPricing: [{ breakQuantity: 5, unitPrice: 0.35 }] };
    const s = setup(); s.fetch.mockReset().mockResolvedValueOnce(Response.json({ success: true, code: 200, result: p })).mockResolvedValueOnce(Response.json({ success: true, code: 200, result: { productPrice: [price, price] } }));
    expect((await lcscAdapter({ ...request, currency: 'EUR' }, s.context))[0]!.currency).toBe('USD'); expect(s.fetch).toHaveBeenCalledTimes(2);
    const unchanged = setup(); await lcscAdapter(request, unchanged.context); expect(unchanged.fetch).toHaveBeenCalledTimes(1);
    const noMatch = setup({ products: [] }); await lcscAdapter({ ...request, match: 'mpn' }, noMatch.context); expect(noMatch.fetch).toHaveBeenCalledTimes(1);
  });
  it('sanitizes pricing-only failures and makes no further requests', async () => {
    const s = setup(); s.fetch.mockReset().mockResolvedValueOnce(Response.json({ success: true, code: 200, result: product() })).mockResolvedValueOnce(Response.json({ message: 'synthetic-secret' }, { status: 401 }));
    await expect(lcscAdapter({ ...request, currency: 'EUR' }, s.context)).rejects.toThrow('Supplier request failed.');
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it('fails absent credentials/invalid nonce without fetching and never reflects provider error payloads', async () => {
    const s = setup();
    await expect(lcscAdapter(request, { ...s.context, credentials: {} })).rejects.toThrow('LCSC credentials are not configured.');
    await expect(lcscAdapter(request, { ...s.context, nonce: () => 'invalid' })).rejects.toThrow('LCSC lookup failed.');
    expect(s.fetch).not.toHaveBeenCalled();
    await expect(lcscAdapter(request, setup(null, { success: false, code: 4005, message: 'synthetic-secret' }).context)).rejects.toThrow('LCSC lookup failed.');
    const bad = setup(); bad.fetch.mockReset().mockResolvedValue(Response.json({ message: 'synthetic-secret' }, { status: 403 }));
    await expect(lcscAdapter(request, bad.context)).rejects.toThrow('Supplier request failed.');
    const limited = setup(); limited.fetch.mockReset().mockResolvedValue(Response.json({ message: 'synthetic-secret' }, { status: 429, headers: { 'retry-after': '20' } }));
    await expect(lcscAdapter(request, limited.context)).rejects.toThrow('Supplier rate limit reached; retry after 20 seconds.');
  });
});
