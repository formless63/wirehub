import type { IntegrationContribution, ModuleJobs, ModuleSettingContribution, ModuleSettings } from '@wirehub/modules';
import type { LookupRequest, LookupResult, ProviderContext, SupplierAdapter, SupplierId, SupplierOffer } from './types.ts';
import { mouserAdapter } from './providers/mouser.ts';
import { digiKeyAdapter } from './providers/digikey.ts';
import { lcscAdapter } from './providers/lcsc.ts';
import { SupplierHttpError } from './providers/http.ts';
import { supplierUrl } from './urls.ts';

const PROVIDERS = [
  { id: 'mouser', label: 'Mouser', credentials: ['mouserKey'] },
  { id: 'digikey', label: 'DigiKey', credentials: ['digikeyClientId', 'digikeyClientSecret', 'digikeyAccountId'] },
  { id: 'lcsc', label: 'LCSC', credentials: ['lcscKey', 'lcscSecret'] },
] as const;
type CredentialKey = (typeof PROVIDERS)[number]['credentials'][number];
const CREDENTIAL_KEYS: readonly CredentialKey[] = PROVIDERS.flatMap((p) => [...p.credentials]);

/**
 * What the module asks an owner for in Settings → Module settings (module API 1.5). The
 * credentials are secrets: kept encrypted by the host, never shown again. Each keeps its
 * deployment variable, which, when set, wins and is shown locked.
 */
export const SUPPLIER_SETTINGS: readonly ModuleSettingContribution[] = [
  { key: 'providers', label: 'Enabled providers', kind: 'list', options: ['mouser', 'digikey', 'lcsc'], env: 'WIREHUB_SUPPLIERS_PROVIDERS', gates: 'lookups', help: 'Providers start disabled. Enable one once its credentials are set; each lookup uses that account’s quota.' },
  { key: 'mouserKey', label: 'Mouser Search API key', required: true, gates: 'mouser', env: 'WIREHUB_SUPPLIERS_MOUSER_KEY', help: 'From Mouser’s Search API registration.' },
  { key: 'digikeyClientId', label: 'DigiKey client ID', required: true, gates: 'digikey', env: 'WIREHUB_SUPPLIERS_DIGIKEY_CLIENT_ID', help: 'Product Information V4, client-credentials application.' },
  { key: 'digikeyClientSecret', label: 'DigiKey client secret', required: true, gates: 'digikey', env: 'WIREHUB_SUPPLIERS_DIGIKEY_CLIENT_SECRET' },
  { key: 'digikeyAccountId', label: 'DigiKey account ID', required: true, gates: 'digikey', env: 'WIREHUB_SUPPLIERS_DIGIKEY_ACCOUNT_ID' },
  { key: 'lcscKey', label: 'LCSC API key', required: true, gates: 'lcsc', env: 'WIREHUB_SUPPLIERS_LCSC_KEY', help: 'Approved agent access to the current api.lcsc.com API.' },
  { key: 'lcscSecret', label: 'LCSC API secret', required: true, gates: 'lcsc', env: 'WIREHUB_SUPPLIERS_LCSC_SECRET' },
];
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
  /** the settings to read when the host gives none with a request (tests); a host gives `request.settings` / `context.settings` */
  settings?: ModuleSettings;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  nonce?: () => string;
  adapters?: Partial<Record<SupplierId, SupplierAdapter>>;
}

/**
 * Dependencies resolve at use time so runtime enable/credentials changes take effect: the
 * module's declared settings are read through the host's module API at every request and job,
 * never from the process environment (the host applies the `WIREHUB_SUPPLIERS_*` overrides).
 */
export function createSupplierIntegration(options: SupplierServerOptions = {}): IntegrationContribution {
  const context = async (settings: ModuleSettings | undefined): Promise<ProviderContext & { providers: string }> => {
    const source = settings ?? options.settings;
    const credentials: Partial<Record<CredentialKey, string>> = {};
    for (const key of CREDENTIAL_KEYS) {
      const value = await source?.get(key);
      if (value !== undefined) credentials[key] = value;
    }
    return {
      credentials, providers: (await source?.get('providers')) ?? '',
      fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
      now: options.now ?? (() => new Date()), nonce: options.nonce ?? (() => globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)),
    };
  };
  const safeError = (error: unknown): string => typeof error === 'string' && /^(?:Supplier (?:request (?:failed|timed out)|redirect refused|response is (?:invalid|too large)|rejected the lookup|credentials are not configured|is disabled or not configured|rate limit reached; retry (?:later|after \d{1,4} seconds))\.|Invalid supplier lookup request\.)$/.test(error) ? error : 'Supplier lookup failed.';
  const configured = (ctx: ProviderContext & { providers: string }) => {
    const enabled = new Set(ctx.providers.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean));
    return PROVIDERS.map((p) => ({ id: p.id, label: p.label, enabled: enabled.has(p.id), configured: p.credentials.every((key) => (ctx.credentials[key] ?? '').trim() !== '') }));
  };
  const ready = (request: LookupRequest, ctx: ProviderContext & { providers: string }): boolean => configured(ctx).some((p) => p.id === request.provider && p.enabled && p.configured);
  const adapters: Record<SupplierId, SupplierAdapter> = { mouser: mouserAdapter, digikey: digiKeyAdapter, lcsc: lcscAdapter, ...options.adapters };
  const cleanText = (value: unknown, max: number, credentials: ProviderContext['credentials']): string | undefined => {
    if (typeof value !== 'string') return undefined;
    let clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    for (const name of CREDENTIAL_KEYS) {
      const secret = credentials[name]?.trim();
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
      const supplierNumber = cleanText(value.supplierNumber, 200, ctx.credentials);
      const mpn = cleanText(value.mpn, 200, ctx.credentials);
      const manufacturer = cleanText(value.manufacturer, 200, ctx.credentials);
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
      const warnings = (Array.isArray(value.warnings) ? value.warnings : []).slice(0, 5).map((v) => cleanText(v, 160, ctx.credentials)).filter((v): v is string => v !== undefined);
      if ([...priceByQuantity.values()].some((prices) => prices.size > 1)) warnings.push('Conflicting prices for the same quantity were omitted.');
      if (!sameCurrency) warnings.push('No usable price in the requested currency.');
      const description = cleanText(value.description, 1000, ctx.credentials);
      const packaging = cleanText(value.packaging, 200, ctx.credentials);
      const candidate = supplierUrl(value.url, request.provider);
      const url = candidate !== undefined && cleanText(candidate, 1000, ctx.credentials) === candidate ? candidate : undefined;
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
    return { request: { ...request, query: cleanText(request.query, 200, ctx.credentials), ...(request.manufacturer === undefined ? {} : { manufacturer: cleanText(request.manufacturer, 120, ctx.credentials) }) }, offers: offersOf(value?.offers, request, ctx), observedAt: cleanText(value?.observedAt, 40, ctx.credentials) ?? ctx.now().toISOString() };
  };
  const safeJob = (job: NonNullable<Awaited<ReturnType<ModuleJobs['get']>>>, ctx: ProviderContext) => ({
    id: cleanText(job.id, 200, ctx.credentials), kind: 'suppliers:lookup', status: cleanText(job.status, 30, ctx.credentials),
    steps: job.steps.slice(0, 50).map((step) => ({ at: cleanText(step.at, 40, ctx.credentials), text: cleanText(step.text, 200, ctx.credentials) })),
    ...(job.result === undefined ? {} : { result: resultOf(job.result, ctx) }),
    ...(job.error === undefined ? {} : { error: safeError(job.error) }),
  });
  return {
    id: 'suppliers', label: 'Supplier offers',
    routes: [
      { method: 'GET', path: 'config', handle: async (request) => ({ status: 200, body: { providers: configured(await context(request.settings)) } }) },
      { method: 'POST', path: 'lookup', handle: async (request) => {
        const lookup = lookupRequest(request.body);
        if (lookup === undefined) return { status: 400, body: { error: 'Invalid supplier lookup request.' } };
        if (!ready(lookup, await context(request.settings))) return { status: 409, body: { error: 'Supplier is disabled or not configured.' } };
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
          return job === undefined || job.kind !== 'suppliers:lookup' ? { status: 404, body: { error: 'No such supplier lookup.' } } : { status: 200, body: { job: safeJob(job, await context(request.settings)) } };
        } catch { return { status: 500, body: { error: 'Could not read supplier lookup.' } }; }
      } },
    ],
    queues: [{ id: 'lookup', label: 'Supplier lookup', run: async ({ request, settings }) => {
      const lookup = lookupRequest(request);
      if (lookup === undefined) throw new Error('Invalid supplier lookup request.');
      const ctx = await context(settings);
      if (!ready(lookup, ctx)) throw new Error('Supplier is disabled or not configured.');
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
