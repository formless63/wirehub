import type { IntegrationContribution, ModuleJobs } from '@wirehub/modules';
import type { LookupRequest, LookupResult, ProviderContext, SupplierAdapter, SupplierId, SupplierOffer } from './types.ts';
import { mouserAdapter } from './providers/mouser.ts';
import { digiKeyAdapter } from './providers/digikey.ts';
import { lcscAdapter } from './providers/lcsc.ts';
import { SupplierHttpError } from './providers/http.ts';

const PROVIDERS = [
  { id: 'mouser', label: 'Mouser', credentials: ['WIREHUB_SUPPLIERS_MOUSER_KEY'] },
  { id: 'digikey', label: 'DigiKey', credentials: ['WIREHUB_SUPPLIERS_DIGIKEY_CLIENT_ID', 'WIREHUB_SUPPLIERS_DIGIKEY_CLIENT_SECRET', 'WIREHUB_SUPPLIERS_DIGIKEY_ACCOUNT_ID'] },
  { id: 'lcsc', label: 'LCSC', credentials: ['WIREHUB_SUPPLIERS_LCSC_KEY', 'WIREHUB_SUPPLIERS_LCSC_SECRET'] },
] as const;
const ENV = ['WIREHUB_SUPPLIERS_PROVIDERS', ...PROVIDERS.flatMap((p) => [...p.credentials])];
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: string): string => value.trim().toUpperCase();
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;

/** Requests name one exact identity, never a fuzzy or multi-part search. */
export function lookupRequest(value: unknown): LookupRequest | undefined {
  const raw = object(value);
  if (raw === undefined || !PROVIDERS.some((p) => p.id === raw.provider) || (raw.match !== 'supplier' && raw.match !== 'mpn')) return undefined;
  const input = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max && !/[\u0000-\u001f\u007f|]/.test(value) ? value.trim() : undefined;
  const query = input(raw.query, raw.provider === 'mouser' ? 40 : 200);
  const manufacturer = raw.manufacturer === undefined ? undefined : input(raw.manufacturer, 120);
  if (query === undefined || (raw.provider === 'mouser' && query.length < 3) || (raw.manufacturer !== undefined && manufacturer === undefined) || !positive(raw.quantity) || typeof raw.currency !== 'string' || !/^[A-Za-z]{3}$/.test(raw.currency) || typeof raw.country !== 'string' || !/^[A-Za-z]{2}$/.test(raw.country)) return undefined;
  return { provider: raw.provider as SupplierId, match: raw.match, query, quantity: raw.quantity,
    currency: raw.currency.toUpperCase(), country: raw.country.toUpperCase(),
    ...(manufacturer === undefined ? {} : { manufacturer }),
  };
}

export interface SupplierServerOptions {
  env?: Readonly<Record<string, string | undefined>> | (() => Readonly<Record<string, string | undefined>>);
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  nonce?: () => string;
  adapters?: Partial<Record<SupplierId, SupplierAdapter>>;
}

/** Dependencies resolve at use time so runtime enable/credentials changes take effect. */
export function createSupplierIntegration(options: SupplierServerOptions = {}): IntegrationContribution {
  const context = (): ProviderContext => ({
    env: typeof options.env === 'function' ? options.env() : options.env ?? (typeof process === 'undefined' ? {} : process.env),
    fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
    now: options.now ?? (() => new Date()), nonce: options.nonce ?? (() => globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)),
  });
  const safeError = (error: unknown): string => typeof error === 'string' && /^(?:Supplier (?:request (?:failed|timed out)|redirect refused|response is (?:invalid|too large)|rejected the lookup|credentials are not configured|is disabled or not configured|rate limit reached; retry (?:later|after \d{1,4} seconds))\.|Invalid supplier lookup request\.)$/.test(error) ? error : 'Supplier lookup failed.';
  const configured = (env: ProviderContext['env']) => {
    const enabled = new Set((env.WIREHUB_SUPPLIERS_PROVIDERS ?? '').split(',').map((id) => id.trim().toLowerCase()).filter(Boolean));
    return PROVIDERS.map((p) => ({ id: p.id, label: p.label, enabled: enabled.has(p.id), configured: p.credentials.every((key) => (env[key] ?? '').trim() !== '') }));
  };
  const ready = (request: LookupRequest, env: ProviderContext['env']): boolean => configured(env).some((p) => p.id === request.provider && p.enabled && p.configured);
  const adapters: Record<SupplierId, SupplierAdapter> = { mouser: mouserAdapter, digikey: digiKeyAdapter, lcsc: lcscAdapter, ...options.adapters };
  const cleanText = (value: unknown, max: number, env: ProviderContext['env']): string | undefined => {
    if (typeof value !== 'string') return undefined;
    let clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    for (const provider of PROVIDERS) for (const name of provider.credentials) {
      const secret = env[name]?.trim();
      if (secret) for (const encoded of [secret, encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString().slice(6)]) clean = clean.split(encoded).join('[redacted]');
    }
    return clean === '' ? undefined : clean.slice(0, max);
  };
  const offersOf = (values: unknown, request: LookupRequest, ctx: ProviderContext): SupplierOffer[] => {
    if (!Array.isArray(values)) return [];
    const observedAt = ctx.now().toISOString();
    return values.slice(0, 50).flatMap((raw): SupplierOffer[] => {
      const value = object(raw);
      if (value === undefined || value.provider !== request.provider || typeof value.supplierNumber !== 'string' || typeof value.mpn !== 'string' || typeof value.manufacturer !== 'string') return [];
      if (identifier(request.match === 'supplier' ? value.supplierNumber : value.mpn) !== identifier(request.query) || (request.manufacturer !== undefined && identifier(value.manufacturer) !== identifier(request.manufacturer))) return [];
      const supplierNumber = cleanText(value.supplierNumber, 200, ctx.env);
      const mpn = cleanText(value.mpn, 200, ctx.env);
      const manufacturer = cleanText(value.manufacturer, 200, ctx.env);
      if (supplierNumber === undefined || mpn === undefined || manufacturer === undefined) return [];
      const sameCurrency = value.currency === request.currency;
      const parsedBreaks = sameCurrency && Array.isArray(value.breaks) ? value.breaks.slice(0, 50).flatMap((raw) => {
        const row = object(raw);
        return row !== undefined && positive(row.minQty) && typeof row.unitPrice === 'number' && Number.isFinite(row.unitPrice) && row.unitPrice >= 0 ? [{ minQty: row.minQty, unitPrice: row.unitPrice }] : [];
      }).sort((a, b) => a.minQty - b.minQty) : [];
      const priceByQuantity = new Map<number, Set<number>>();
      for (const row of parsedBreaks) {
        const prices = priceByQuantity.get(row.minQty) ?? new Set<number>();
        prices.add(row.unitPrice);
        priceByQuantity.set(row.minQty, prices);
      }
      const breaks = [...priceByQuantity].flatMap(([minQty, prices]) => prices.size === 1 ? [{ minQty, unitPrice: [...prices][0]! }] : []);
      const unit = value.unit === 'each' || value.unit === 'm' ? value.unit : 'unknown';
      const warnings = (Array.isArray(value.warnings) ? value.warnings : []).slice(0, 5).map((v) => cleanText(v, 160, ctx.env)).filter((v): v is string => v !== undefined);
      if ([...priceByQuantity.values()].some((prices) => prices.size > 1)) warnings.push('Conflicting prices for the same quantity were omitted.');
      if (!sameCurrency) warnings.push('No usable price in the requested currency.');
      const description = cleanText(value.description, 1000, ctx.env);
      const packaging = cleanText(value.packaging, 200, ctx.env);
      let url: string | undefined;
      try {
        const parsed = new URL(String(value.url));
        if (parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && (parsed.port === '' || parsed.port === '443') && ['mouser.com', 'digikey.com', 'lcsc.com'].some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)) && parsed.href.length <= 1000 && cleanText(parsed.href, 1000, ctx.env) === parsed.href) url = parsed.href;
      } catch { /* no usable public product URL */ }
      const stock = typeof value.stock === 'number' && Number.isSafeInteger(value.stock) && value.stock >= 0 ? value.stock : undefined;
      return [{ provider: request.provider, supplierNumber, mpn, manufacturer, observedAt: typeof value.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.observedAt) && Number.isFinite(Date.parse(value.observedAt)) ? value.observedAt : observedAt, currency: request.currency, unit, breaks,
        ...(description === undefined ? {} : { description }), ...(packaging === undefined ? {} : { packaging }), ...(url === undefined ? {} : { url }),
        ...(stock === undefined ? {} : { stock }), ...(positive(value.moq) ? { moq: value.moq } : {}), ...(positive(value.orderMultiple) ? { orderMultiple: value.orderMultiple } : {}),
        ...(warnings.length === 0 ? {} : { warnings }),
      }];
    });
  };
  const resultOf = (raw: unknown, ctx: ProviderContext): Record<string, unknown> | undefined => {
    const value = object(raw);
    const request = lookupRequest(value?.request);
    if (request === undefined) return undefined;
    return { request: { ...request, query: cleanText(request.query, 200, ctx.env), ...(request.manufacturer === undefined ? {} : { manufacturer: cleanText(request.manufacturer, 120, ctx.env) }) }, offers: offersOf(value?.offers, request, ctx), observedAt: cleanText(value?.observedAt, 40, ctx.env) ?? ctx.now().toISOString() };
  };
  const safeJob = (job: NonNullable<Awaited<ReturnType<ModuleJobs['get']>>>, ctx: ProviderContext) => ({
    id: cleanText(job.id, 200, ctx.env), kind: 'suppliers:lookup', status: cleanText(job.status, 30, ctx.env),
    steps: job.steps.slice(0, 50).map((step) => ({ at: cleanText(step.at, 40, ctx.env), text: cleanText(step.text, 200, ctx.env) })),
    ...(job.result === undefined ? {} : { result: resultOf(job.result, ctx) }),
    ...(job.error === undefined ? {} : { error: safeError(job.error) }),
  });
  return {
    id: 'suppliers', label: 'Supplier offers', env: ENV,
    routes: [
      { method: 'GET', path: 'config', handle: async () => ({ status: 200, body: { providers: configured(context().env) } }) },
      { method: 'POST', path: 'lookup', handle: async (request) => {
        const lookup = lookupRequest(request.body);
        if (lookup === undefined) return { status: 400, body: { error: 'Invalid supplier lookup request.' } };
        if (!ready(lookup, context().env)) return { status: 409, body: { error: 'Supplier is disabled or not configured.' } };
        if (request.jobs === undefined) return { status: 501, body: { error: 'This studio runs no jobs.' } };
        try { return { status: 202, body: { job: await request.jobs.enqueue('lookup', { ...lookup }) } }; }
        catch { return { status: 500, body: { error: 'Could not enqueue supplier lookup.' } }; }
      } },
      { method: 'GET', path: 'lookup', handle: async (request) => {
        if (request.jobs === undefined) return { status: 501, body: { error: 'This studio runs no jobs.' } };
        const id = request.query.get('id');
        if (id === null || id === '' || id.length > 200) return { status: 400, body: { error: 'A lookup job id is required.' } };
        try {
          const job = await request.jobs.get(id);
          return job === undefined || job.kind !== 'suppliers:lookup' ? { status: 404, body: { error: 'No such supplier lookup.' } } : { status: 200, body: { job: safeJob(job, context()) } };
        } catch { return { status: 500, body: { error: 'Could not read supplier lookup.' } }; }
      } },
    ],
    queues: [{ id: 'lookup', label: 'Supplier lookup', run: async ({ request }) => {
      const lookup = lookupRequest(request);
      if (lookup === undefined) throw new Error('Invalid supplier lookup request.');
      const ctx = context();
      if (!ready(lookup, ctx.env)) throw new Error('Supplier is disabled or not configured.');
      try {
        const values = await adapters[lookup.provider](lookup, ctx);
        const result: LookupResult = { request: lookup, offers: offersOf(values, lookup, ctx), observedAt: ctx.now().toISOString() };
        return { ...result };
      } catch (error) {
        throw new Error(error instanceof SupplierHttpError ? safeError(error.message) : 'Supplier lookup failed.');
      }
    } }],
  };
}

export const supplierIntegration = createSupplierIntegration();
