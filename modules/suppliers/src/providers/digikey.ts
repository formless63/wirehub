/**
 * Server-side Product Information V4 adapter. Primary sources:
 * https://developer.digikey.com/tutorials-and-resources/oauth-20-2-legged-flow
 * https://developer.digikey.com/products/product-information-v4/productsearch/productdetails
 * https://developer.digikey.com/node/2360/oas-download (V4 schema, including Account-ID).
 * No refresh token or customer credentials; each lookup acquires a new short-lived token.
 */
import type { SupplierAdapter, SupplierOffer } from '../types.ts';
import { jsonRequest, SupplierHttpError } from './http.ts';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as ObjectValue : {};
const text = (v: unknown): string => typeof v === 'string' ? v.trim().slice(0, 2000) : '';
const integer = (v: unknown, minimum: number): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= minimum ? v : undefined;
function prices(value: unknown): SupplierOffer['breaks'] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((v) => {
    const p = object(v); const minQty = integer(p.BreakQuantity, 1);
    return minQty === undefined || typeof p.UnitPrice !== 'number' || !Number.isFinite(p.UnitPrice) || p.UnitPrice <= 0 ? [] : [{ minQty, unitPrice: p.UnitPrice }];
  }).sort((a, b) => a.minQty - b.minQty);
}
function productUrl(value: unknown): string | undefined {
  try {
    const u = new URL(text(value));
    const hosts = ['digikey.com', 'www.digikey.com', 'www.digikey.ca', 'www.digikey.co.uk', 'www.digikey.de', 'www.digikey.fr', 'www.digikey.jp', 'www.digikey.cn', 'www.digikey.hk', 'www.digikey.tw', 'www.digikey.sg', 'www.digikey.com.au', 'www.digikey.co.nz'];
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && hosts.includes(u.hostname) ? u.href : undefined;
  } catch { return undefined; }
}

export const digiKeyAdapter: SupplierAdapter = async (request, context) => {
  const clientId = context.credentials.digikeyClientId;
  const secret = context.credentials.digikeyClientSecret;
  const account = context.credentials.digikeyAccountId;
  if (!clientId?.trim() || !secret?.trim() || !account?.trim()) throw new Error('DigiKey credentials are not configured.');
  try {
    const token = object(await jsonRequest('https://api.digikey.com/v1/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials' }).toString(),
    }, context));
    const bearer = text(token.access_token);
    if (!bearer || text(token.token_type).toLowerCase() !== 'bearer' || /[\r\n]/.test(bearer)) throw new Error('Invalid token.');
    const response = object(await jsonRequest(`https://api.digikey.com/products/v4/search/${encodeURIComponent(request.query)}/productdetails`, {
      method: 'GET', headers: {
        Accept: 'application/json', Authorization: `Bearer ${bearer}`, 'X-DIGIKEY-Client-Id': clientId,
        'X-DIGIKEY-Account-Id': account, 'X-DIGIKEY-Locale-Language': 'en',
        'X-DIGIKEY-Locale-Site': request.country === 'GB' ? 'UK' : request.country,
        'X-DIGIKEY-Locale-Currency': request.currency,
      },
    }, context));
    const product = object(response.Product);
    const mpn = text(product.ManufacturerProductNumber);
    const manufacturer = text(object(product.Manufacturer).Name);
    if (!mpn || !manufacturer) return [];
    if (request.match === 'mpn' && mpn.toLowerCase() !== request.query.toLowerCase()) return [];
    if (request.manufacturer && manufacturer.toLowerCase() !== request.manufacturer.toLowerCase()) return [];
    // DigiKey may correct unsupported requested locales. Its returned currency is authoritative.
    const suppliedCurrency = text(object(response.SearchLocaleUsed).Currency).toUpperCase();
    const hasCurrency = /^[A-Z]{3}$/.test(suppliedCurrency);
    const currency = hasCurrency ? suppliedCurrency : request.currency;
    const observedAt = context.now().toISOString();
    const variations = Array.isArray(product.ProductVariations) ? product.ProductVariations.slice(0, 100) : [];
    return variations.flatMap((raw): SupplierOffer[] => {
      const variant = object(raw);
      const supplierNumber = text(variant.DigiKeyProductNumber);
      if (!supplierNumber || request.match === 'supplier' && supplierNumber.toLowerCase() !== request.query.toLowerCase()) return [];
      const packaging = text(object(variant.PackageType).Name);
      const ownPrices = prices(variant.MyPricing);
      const breaks = hasCurrency ? ownPrices.length > 0 ? ownPrices : prices(variant.StandardPricing) : [];
      const url = productUrl(product.ProductUrl);
      const description = text(object(product.Description).DetailedDescription) || text(object(product.Description).ProductDescription);
      // StandardPackage is a manufacturer's packing size, NOT an order multiple.
      const stock = integer(variant.QuantityAvailableforPackageType, 0);
      const moq = integer(variant.MinimumOrderQuantity, 1);
      const unit = 'unknown' as const;
      const warnings = ['Supplier quantity unit is unconfirmed; no packaging-to-length conversion was inferred.'];
      if (!hasCurrency) warnings.push('Pricing currency was not supplied; prices were omitted.');
      else if (currency !== request.currency) warnings.push('Supplier returned a different currency; no conversion was applied.');
      if (variant.MarketPlace === true) warnings.push('Marketplace offer: separate shipping fees may apply.');
      if (typeof variant.DigiReelFee === 'number' && variant.DigiReelFee > 0) warnings.push('Additional reel fee is not included in unit prices.');
      return [{ provider: 'digikey', supplierNumber, mpn, manufacturer, observedAt, currency, unit, breaks, warnings,
        ...(description ? { description } : {}), ...(url ? { url } : {}), ...(packaging ? { packaging } : {}),
        ...(stock === undefined ? {} : { stock }), ...(moq === undefined ? {} : { moq }),
      }];
    });
  } catch (error) {
    if (error instanceof SupplierHttpError) throw error;
    throw new Error('DigiKey lookup failed.');
  }
};
