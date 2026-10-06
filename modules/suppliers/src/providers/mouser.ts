import type { SupplierAdapter, SupplierOffer } from '../types.ts';
import { jsonRequest, SupplierHttpError } from './http.ts';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 200): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined;
const count = (value: unknown): number | undefined => {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw))) return undefined;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
};

/** Parse only unambiguous decimal prices; locale commas and unknown text never become zero. */
function price(value: unknown, currency: string): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  let raw = value.trim();
  if (raw.startsWith(currency)) raw = raw.slice(currency.length).trim();
  if (raw.endsWith(currency)) raw = raw.slice(0, -currency.length).trim();
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : undefined;
  if (symbol !== undefined && raw.startsWith(symbol)) raw = raw.slice(symbol.length).trim();
  if (raw.includes(',') && !raw.includes('.')) return undefined;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return undefined;
  const number = Number(raw.replaceAll(',', ''));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function productUrl(value: unknown): string | undefined {
  try {
    const url = new URL(text(value, 1000) ?? '');
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && (url.hostname === 'mouser.com' || url.hostname.endsWith('.mouser.com')) ? url.href : undefined;
  } catch { return undefined; }
}

/** Official V2 SearchApi schema: https://api.mouser.com/api/docs/V2 . */
export const mouserAdapter: SupplierAdapter = async (request, context) => {
  const key = context.env.WIREHUB_SUPPLIERS_MOUSER_KEY?.trim();
  if (!key) throw new SupplierHttpError('Supplier credentials are not configured.');
  // V2 uses this method for both manufacturer and supplier part numbers.
  const url = new URL('https://api.mouser.com/api/v2/search/partnumberandmanufacturer');
  url.searchParams.set('apiKey', key);
  const response = object(await jsonRequest(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ SearchByPartMfrNameRequest: {
      mouserPartNumber: request.query, partSearchOptions: 'Exact',
      ...(request.manufacturer === undefined ? {} : { manufacturerName: request.manufacturer }),
    } }),
  }, context));
  if (Array.isArray(response.Errors) && response.Errors.length > 0) throw new SupplierHttpError('Supplier rejected the lookup.');
  const parts = object(response.SearchResults).Parts;
  if (!Array.isArray(parts)) throw new SupplierHttpError('Supplier response is invalid.');
  const observedAt = context.now().toISOString();
  return parts.slice(0, 50).flatMap((raw): SupplierOffer[] => {
    const part = object(raw);
    const supplierNumber = text(part.MouserPartNumber);
    const mpn = text(part.ManufacturerPartNumber);
    const manufacturer = text(part.Manufacturer);
    if (supplierNumber === undefined || mpn === undefined || manufacturer === undefined) return [];
    const breaks = (Array.isArray(part.PriceBreaks) ? part.PriceBreaks : []).slice(0, 50).flatMap((raw) => {
      const row = object(raw);
      if (text(row.Currency)?.toUpperCase() !== request.currency) return [];
      const minQty = count(row.Quantity);
      const unitPrice = price(row.Price, request.currency);
      return minQty === undefined || minQty <= 0 || unitPrice === undefined ? [] : [{ minQty, unitPrice }];
    }).sort((a, b) => a.minQty - b.minQty);
    const stock = count(part.AvailabilityInStock) ?? (() => {
      const available = text(part.Availability);
      const match = available?.match(/^(\d+|\d{1,3}(?:,\d{3})+) In Stock$/i);
      return match === null || match === undefined ? undefined : count(match[1]!.replaceAll(',', ''));
    })();
    const moq = count(part.Min);
    const orderMultiple = count(part.Mult);
    const description = text(part.Description, 1000);
    const url = productUrl(part.ProductDetailUrl);
    const attributes = Array.isArray(part.ProductAttributes) ? part.ProductAttributes : [];
    const packaging = text(attributes.map(object).find((a) => a.AttributeName === 'Packaging')?.AttributeValue);
    // The V2 schema has no reliable sale-unit field: packaging is not a unit conversion.
    return [{ provider: 'mouser', supplierNumber, mpn, manufacturer, observedAt,
      currency: request.currency, unit: 'unknown', breaks,
      ...(description === undefined ? {} : { description }), ...(url === undefined ? {} : { url }),
      ...(stock === undefined ? {} : { stock }), ...(moq === undefined || moq === 0 ? {} : { moq }),
      ...(orderMultiple === undefined || orderMultiple === 0 ? {} : { orderMultiple }),
      ...(packaging === undefined ? {} : { packaging }),
      warnings: ['Sale unit is not specified by this supplier response.', ...(breaks.length === 0 ? ['No usable price in the requested currency.'] : [])],
    }];
  });
};
