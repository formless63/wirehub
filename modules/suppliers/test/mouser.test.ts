import { describe, expect, it, vi } from 'vitest';
import { mouserAdapter } from '../src/providers/mouser.ts';
import type { LookupRequest, ProviderContext } from '../src/types.ts';

const request: LookupRequest = { provider: 'mouser', query: 'SYN-1/A', match: 'mpn', manufacturer: 'Synthetic', quantity: 10, currency: 'USD', country: 'US' };
const part = { MouserPartNumber: 'SKU-1', ManufacturerPartNumber: 'SYN-1/A', Manufacturer: 'Synthetic', Description: 'Synthetic component', AvailabilityInStock: '12', Min: '2', Mult: '2', ProductAttributes: [{ AttributeName: 'Packaging', AttributeValue: 'Cut Tape' }], PriceBreaks: [{ Quantity: 1, Price: '$1.25', Currency: 'USD' }, { Quantity: 10, Price: '1.00 USD', Currency: 'USD' }] };
const context = (response: unknown): ProviderContext => ({ credentials: { mouserKey: 'test-only-credential' }, fetch: vi.fn(async () => Response.json(response)) as typeof fetch, now: () => new Date('2026-01-02T03:04:05Z'), nonce: () => 'synthetic' });

describe('Mouser V2 synthetic responses', () => {
  it('sends the official exact part-number request and maps trustworthy quote fields', async () => {
    const ctx = context({ SearchResults: { Parts: [part] }, Errors: [] });
    const offers = await mouserAdapter(request, ctx);
    expect(offers).toMatchObject([{ supplierNumber: 'SKU-1', mpn: 'SYN-1/A', manufacturer: 'Synthetic', stock: 12, moq: 2, orderMultiple: 2, packaging: 'Cut Tape', currency: 'USD', unit: 'unknown', breaks: [{ minQty: 1, unitPrice: 1.25 }, { minQty: 10, unitPrice: 1 }] }]);
    const [url, init] = (ctx.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/api/v2/search/partnumberandmanufacturer?apiKey=');
    expect(JSON.parse(init.body)).toEqual({ SearchByPartMfrNameRequest: { mouserPartNumber: 'SYN-1/A', partSearchOptions: 'Exact', manufacturerName: 'Synthetic' } });
    expect(init.redirect).toBe('error');
  });

  it('omits uncertain stock and invalid/localized/foreign prices without converting to zero', async () => {
    const ctx = context({ SearchResults: { Parts: [{ ...part, AvailabilityInStock: 'unknown', Availability: 'Expected soon', Min: '', Mult: 'N/A', PriceBreaks: [
      { Quantity: 1, Price: '', Currency: 'USD' }, { Quantity: 2, Price: 'Call', Currency: 'USD' },
      { Quantity: 3, Price: '1,25', Currency: 'USD' }, { Quantity: 4, Price: '€1.25', Currency: 'EUR' },
      { Quantity: 5, Price: '-1', Currency: 'USD' }, { Quantity: 7, Price: '1,234', Currency: 'USD' }, { Quantity: 6, Price: '$0.00', Currency: 'USD' },
    ] }] } });
    const [offer] = await mouserAdapter(request, ctx);
    expect(offer?.breaks).toEqual([{ minQty: 6, unitPrice: 0 }]);
    expect(offer).not.toHaveProperty('stock');
    expect(offer).not.toHaveProperty('moq');
    expect(offer).not.toHaveProperty('orderMultiple');
  });

  it('omits unsupported or unsafe product links', async () => {
    for (const ProductDetailUrl of ['javascript:alert(1)', 'https://mouser.com.attacker.invalid/product', 'https://www.mouser.de/product']) {
      const [offer] = await mouserAdapter(request, context({ SearchResults: { Parts: [{ ...part, ProductDetailUrl }] } }));
      expect(offer).not.toHaveProperty('url');
    }
    expect(await mouserAdapter(request, context({ SearchResults: { Parts: [{ ...part, ProductDetailUrl: 'https://www.mouser.com/ProductDetail/synthetic' }] } }))).toMatchObject([{ url: 'https://www.mouser.com/ProductDetail/synthetic' }]);
  });

  it('accepts only explicitly numbered in-stock availability and warns for missing currency', async () => {
    const ctx = context({ SearchResults: { Parts: [{ ...part, AvailabilityInStock: undefined, Availability: '1,234 In Stock', PriceBreaks: [{ Quantity: 1, Price: '€1.25', Currency: 'EUR' }] }] } });
    expect(await mouserAdapter(request, ctx)).toMatchObject([{ stock: 1234, breaks: [], warnings: ['Sale unit is not specified by this supplier response.', 'No usable price in the requested currency.'] }]);
  });

  it('rejects provider errors generically and bounds/malformed-filters rows', async () => {
    await expect(mouserAdapter(request, context({ Errors: [{ Message: 'secret details' }] }))).rejects.toThrow(/^Supplier rejected the lookup\.$/);
    await expect(mouserAdapter(request, context({ SearchResults: {} }))).rejects.toThrow(/^Supplier response is invalid\.$/);
    expect(await mouserAdapter(request, context({ SearchResults: { Parts: [{}] } }))).toEqual([]);
    expect(await mouserAdapter(request, context({ SearchResults: { Parts: Array.from({ length: 100 }, () => part) } }))).toHaveLength(50);
  });
});
