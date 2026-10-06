/**
 * Server-side approved partner API, not website scraping. Primary source:
 * https://www.lcsc.com/docs/index.html links (via apiDocLink) to
 * https://wmsc.lcsc.com/crm/download/api/doc : Access & Usage Guide v3.4, July 1 2026.
 * Sections 1.4/2.2/4.1.1/4.1.6: production api.lcsc.com, API v1 endpoints,
 * auth headers and SHA-256 over auth prefix + sorted quote_plus business parameters.
 * The still-published docs/openapi legacy ips.lcsc.com endpoints use SHA-1 and
 * are deliberately not mixed with this current API.
 */
import type { SupplierAdapter, SupplierOffer } from '../types.ts';
import { jsonRequest, SupplierHttpError } from './http.ts';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as ObjectValue : {};
const text = (v: unknown): string => typeof v === 'string' ? v.trim().slice(0, 2000) : '';
function quantity(v: unknown, min: number): number | undefined {
  // The current response declares quantityAvailable a string; blank/unknown is not zero.
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= min ? n : undefined;
}
const quotePlus = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
function productUrl(v: unknown): string | undefined {
  try {
    const u = new URL(text(v));
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && ['lcsc.com', 'www.lcsc.com'].includes(u.hostname) ? u.href : undefined;
  } catch { return undefined; }
}
function prices(v: unknown): SupplierOffer['breaks'] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 100).flatMap((raw) => {
    const row = object(raw); const minQty = quantity(row.breakQuantity, 1);
    return minQty === undefined || typeof row.unitPrice !== 'number' || !Number.isFinite(row.unitPrice) || row.unitPrice <= 0 ? [] : [{ minQty, unitPrice: row.unitPrice }];
  }).sort((a, b) => a.minQty - b.minQty);
}

export const lcscAdapter: SupplierAdapter = async (request, context) => {
  const key = context.env.WIREHUB_SUPPLIERS_LCSC_KEY;
  const secret = context.env.WIREHUB_SUPPLIERS_LCSC_SECRET;
  if (!key?.trim() || !secret?.trim()) throw new Error('LCSC credentials are not configured.');
  try {
    if (!['USD', 'CNY', 'EUR', 'HKD'].includes(request.currency)) throw new Error('Unsupported currency.');
    const nonce = context.nonce();
    if (!/^[a-zA-Z0-9]{16}$/.test(nonce)) throw new Error('Invalid nonce.');
    const now = context.now();
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const payload: Record<string, string> = { currency: request.currency, returnInformation: 'All' };
    const endpoint = request.match === 'supplier' ? 'productdetails' : 'keywordsearch';
    if (request.match === 'supplier') payload.lcscProductNumber = request.query;
    else Object.assign(payload, { keyword: request.query, language: 'EN', limit: '30', offset: '0' });
    const query = Object.keys(payload).sort().map((k) => `${quotePlus(k)}=${quotePlus(payload[k]!)}`).join('&');
    const signatureBytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`key=${key}&nonce=${nonce}&secret=${secret}&timestamp=${timestamp}&${query}`));
    const signature = Array.from(new Uint8Array(signatureBytes), (b) => b.toString(16).padStart(2, '0')).join('');
    const response = object(await jsonRequest(`https://api.lcsc.com/rest/api/agent/product/v1/${endpoint}?${query}`, {
      method: 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json', key, nonce, timestamp, signature },
    }, context));
    if (response.success !== true || response.code !== 200) throw new Error('Unsuccessful provider result.');
    const result = object(response.result);
    const products = request.match === 'supplier' ? [result] : Array.isArray(result.products) ? result.products.slice(0, 30) : [];
    return products.flatMap((raw): SupplierOffer[] => {
      const product = object(raw);
      const supplierNumber = text(product.lcscProductNumber);
      // Guide field table says ProductCode; its actual examples say ProductNumber.
      const mpn = text(product.manufacturerProductNumber) || text(product.manufacturerProductCode);
      const maker = Array.isArray(product.manufacturer) ? product.manufacturer[0] : product.manufacturer;
      const manufacturer = text(object(maker).name);
      if (!supplierNumber || !mpn || !manufacturer) return [];
      if (request.match === 'supplier' && supplierNumber.toLowerCase() !== request.query.toLowerCase()) return [];
      if (request.match === 'mpn' && mpn.toLowerCase() !== request.query.toLowerCase()) return [];
      if (request.manufacturer && manufacturer.toLowerCase() !== request.manufacturer.toLowerCase()) return [];
      const pricing = object(product.productPrice);
      // Currency can be ignored with returnInformation=All; always use returned currency.
      const suppliedCurrency = text(pricing.currency).toUpperCase();
      const hasCurrency = ['USD', 'CNY', 'EUR', 'HKD'].includes(suppliedCurrency);
      const currency = hasCurrency ? suppliedCurrency : request.currency;
      const stock = quantity(product.quantityAvailable ?? pricing.quantityAvailable, 0);
      const moq = quantity(product.minimumOrderQuantity, 1);
      const orderMultiple = quantity(product.incrementQuantity, 1);
      const packaging = text(product.packageType);
      const url = productUrl(product.productDetailURL);
      const description = text(product.description);
      const unit = 'unknown' as const;
      const warnings = ['Supplier quantity unit is unconfirmed; no packaging-to-length conversion was inferred.'];
      if (!hasCurrency) warnings.push('Pricing currency was not supplied; prices were omitted.');
      else if (currency !== request.currency) warnings.push('Supplier returned a different currency; no conversion was applied.');
      if (typeof pricing.lcscReelFee === 'number' && pricing.lcscReelFee > 0) warnings.push('Additional reel fee is not included in unit prices.');
      return [{ provider: 'lcsc', supplierNumber, mpn, manufacturer, observedAt: now.toISOString(), currency, unit, breaks: hasCurrency ? prices(pricing.standardPricing) : [], warnings,
        ...(packaging ? { packaging } : {}), ...(url ? { url } : {}), ...(description ? { description } : {}),
        ...(stock === undefined ? {} : { stock }), ...(moq === undefined ? {} : { moq }), ...(orderMultiple === undefined ? {} : { orderMultiple }),
      }];
    });
  } catch (error) {
    if (error instanceof SupplierHttpError) throw error;
    throw new Error('LCSC lookup failed.');
  }
};
