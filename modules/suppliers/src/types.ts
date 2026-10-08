/** Public offer shapes; supplier responses never enter bundled catalog data. */
export type SupplierId = 'mouser' | 'digikey' | 'lcsc';
export interface LookupRequest {
  provider: SupplierId;
  query: string;
  match: 'supplier' | 'mpn';
  manufacturer?: string;
  quantity: number;
  currency: string;
  country: string;
}
export interface SupplierOffer {
  provider: SupplierId;
  supplierNumber: string;
  mpn: string;
  manufacturer: string;
  description?: string;
  url?: string;
  observedAt: string;
  currency: string;
  unit: 'each' | 'm' | 'unknown';
  packaging?: string;
  stock?: number;
  moq?: number;
  orderMultiple?: number;
  breaks: { minQty: number; unitPrice: number }[];
  warnings?: string[];
}
export interface LookupResult { request: LookupRequest; offers: SupplierOffer[]; observedAt: string }
export interface ProviderContext {
  /** the provider credentials, by setting key (`mouserKey` …), as the host's module settings give them */
  credentials: Readonly<Partial<Record<string, string>>>;
  fetch: typeof globalThis.fetch;
  now: () => Date;
  nonce: () => string;
}
export type SupplierAdapter = (request: LookupRequest, context: ProviderContext) => Promise<SupplierOffer[]>;
