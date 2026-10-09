/**
 * The hub's branding settings (`GET`/`PUT /api/settings/branding`, `server/settings.ts`):
 * organisation, standard, rights line, default designer and logo. Nothing here throws.
 */

import type { BrandingSettings } from '../module-art.ts';
import type { Outcome } from '@wirehub/editor-react';
import type { PaperId, TitleBlockStandard } from '@wirehub/docs';
import { request } from './definitions.browser.ts';

export const brandingKey = ['settings', 'branding'] as const;

export interface BrandingView extends BrandingSettings {
  /** the entity tag to quote when saving */
  etag: string;
  /** this hub's own drawing art, apart from what its packs add */
  ownArt?: Record<string, unknown>;
}

/** One font this hub may choose (`GET /api/settings/branding/fonts`). */
export interface FontChoice {
  id: string;
  name: string;
  family: string;
  subfamily?: string;
  format: 'ttf' | 'otf' | 'woff2';
  source: 'upload' | 'pack';
  pack?: string;
  bytes: number;
  embeddable: boolean;
  rasterizable: boolean;
}

export interface FontList {
  fonts: FontChoice[];
  limits: { bytes: number; formats: string[] };
  /** what the uploader confirms */
  licence: string;
}

export const fontsKey = ['settings', 'branding', 'fonts'] as const;

export async function fetchFonts(base = '/api'): Promise<Outcome<FontList>> {
  return request<FontList>(`${base}/settings/branding/fonts`, { method: 'GET' });
}

/** Upload a font file; `licence` is the confirmation that its licence lets documents embed it. */
export async function uploadFont(input: { name: string; data: string; licence: boolean }, base = '/api'): Promise<Outcome<{ font: FontChoice }>> {
  return request<{ font: FontChoice }>(`${base}/settings/branding/fonts`, { method: 'POST', body: input });
}

export interface BrandingInput {
  organisation?: string;
  standard?: string;
  rights?: string;
  designer?: string;
  /** the prefix of exported wire spec files */
  filePrefix?: string;
  /** the paper documents print on by default; empty keeps A4 */
  paper?: PaperId | '';
  /** the title-block layout; empty keeps the paper's own convention */
  titleBlock?: TitleBlockStandard | '';
  /** the wire labels' stock (a label-preset id; empty keeps the paper's own grid), a QR code on each, and its URL pattern (empty: the part number and revision) */
  labelPreset?: string;
  labelQr?: boolean;
  labelQrUrl?: string;
  labelTemplate?: string;
  labelPrinter?: string;
  /** the title block's three-line general note (a line may be empty) */
  notes?: [string, string, string];
  /** the title block's tolerance rows, label and value; empty rows are dropped */
  tolerances?: [string, string][];
  /** a PNG or SVG data URI sets the logo (an SVG is drawn to a PNG on the server), `null` removes it, absent keeps it */
  logo?: string | null;
  /** the typeface: font ids from `fetchFonts`; `null` returns to the standard sans, absent keeps it */
  font?: { regular: string; bold?: string } | null;
  /** this hub's own drawing art (faces, plugs, cutaways by definition id); `null` removes it, absent keeps it */
  art?: Record<string, unknown> | null;
}

export async function fetchBranding(base = '/api'): Promise<Outcome<BrandingView>> {
  let etag = '';
  const out = await request<BrandingSettings>(`${base}/settings/branding`, { method: 'GET' }, (r) => {
    etag = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag } } : out;
}

export async function saveBranding(input: BrandingInput, etag: string, base = '/api'): Promise<Outcome<BrandingView>> {
  let next = '';
  const out = await request<BrandingSettings>(`${base}/settings/branding`, { method: 'PUT', body: input, headers: { 'if-match': etag } }, (r) => {
    next = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag: next } } : out;
}

/** The query both the settings page and the app's branding registration read. */
export const brandingQuery = {
  queryKey: brandingKey,
  queryFn: async (): Promise<BrandingView> => {
    const out = await fetchBranding();
    if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    return out.value;
  },
  retry: false,
} as const;

/* ------------------------------------------------------------------ *
 * Engineering settings: testing defaults, electrical thresholds, approvals
 * ------------------------------------------------------------------ */

export const engineeringKey = ['settings', 'engineering'] as const;

export interface EngineeringSettings {
  testDefaults?: Record<string, number>;
  electrical?: { enabled?: boolean; ampacityDerate?: number; contactDerate?: number; maxDropV?: number; maxDropPct?: number };
  costing?: { currency?: string; labourRatePerHour?: number };
  approvals?: { enabled: boolean; approverRoles?: ('owner' | 'editor')[] };
  /** read-only context from the server */
  env?: { testDefaults: Record<string, number> | null };
  builtIn?: { electrical: { maxDropV: number; maxDropPct: number; ampacityDerate: number; contactDerate: number } };
}

export interface EngineeringView extends EngineeringSettings {
  etag: string;
}

export async function fetchEngineering(base = '/api'): Promise<Outcome<EngineeringView>> {
  let etag = '';
  const out = await request<EngineeringSettings>(`${base}/settings/engineering`, { method: 'GET' }, (r) => {
    etag = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag } } : out;
}

export async function saveEngineering(input: Pick<EngineeringSettings, 'testDefaults' | 'electrical' | 'approvals' | 'costing'>, etag: string, base = '/api'): Promise<Outcome<EngineeringView>> {
  let next = '';
  const out = await request<EngineeringSettings>(`${base}/settings/engineering`, { method: 'PUT', body: input, headers: { 'if-match': etag } }, (r) => {
    next = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag: next } } : out;
}

export const engineeringQuery = {
  queryKey: engineeringKey,
  queryFn: async (): Promise<EngineeringView> => {
    const out = await fetchEngineering();
    if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    return out.value;
  },
  retry: false,
} as const;

/* ------------------------------------------------------------------ *
 * Store sources: the stores this hub trusts (`server/store-settings.ts`)
 * ------------------------------------------------------------------ */

export const storeSourcesKey = ['settings', 'stores'] as const;

export interface StoreSourceView {
  hideUnreviewed?: boolean;
  url: string;
  publicKey: string;
  keyId: string;
  fingerprint: string;
  label?: string;
  enabled: boolean;
  /** `env`/`official`: set by the server, read-only; `user`: added here */
  origin: 'env' | 'official' | 'user';
  readOnly: boolean;
  /** an added store whose URL the server also names: the server's entry wins */
  shadowed?: boolean;
  /** added stores are ignored while the deployment locks sources to the environment */
  ignored?: boolean;
}

export interface StoreSourcesView {
  allowUserSources: boolean;
  official: { url: string; state: 'trusted' | 'not-signed-yet' | 'not-enabled'; fingerprint?: string; keyId?: string };
  sources: StoreSourceView[];
  problems?: string[];
  etag: string;
}

/** What the person confirms before a store is added: the verified store and its key's fingerprint. */
export interface StorePreview {
  ok: true;
  url: string;
  publicKey: string;
  keyId: string;
  fingerprint: string;
  store: { id: string; name: string; homepage?: string };
  publishers: { id: string; name: string; url?: string }[];
  packs: number;
  alreadyConfigured?: boolean;
}

export interface FetchedStoreKey {
  publicKey: string;
  keyId: string;
  fingerprint: string;
  from: string;
  notice: string;
}

export interface StoreSourceInput {
  hideUnreviewed?: boolean;
  url: string;
  publicKey: string;
  label?: string;
  enabled?: boolean;
}

export async function fetchStoreSources(base = '/api'): Promise<Outcome<StoreSourcesView>> {
  let etag = '';
  const out = await request<Omit<StoreSourcesView, 'etag'>>(`${base}/settings/stores`, { method: 'GET' }, (r) => {
    etag = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag } } : out;
}

export async function saveStoreSources(sources: StoreSourceInput[], etag: string, base = '/api'): Promise<Outcome<StoreSourcesView>> {
  let next = '';
  const out = await request<Omit<StoreSourcesView, 'etag'>>(`${base}/settings/stores`, { method: 'PUT', body: { sources }, headers: { 'if-match': etag } }, (r) => {
    next = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag: next } } : out;
}

const withQuery = (path: string, params: Record<string, string>): string => `${path}?${new URLSearchParams(params).toString()}`;

/** Fetch an index and verify it with the key. Also "re-check now" for a configured store (no `key`). */
export const previewStoreSource = (url: string, key: string | undefined, base = '/api'): Promise<Outcome<StorePreview>> =>
  request<StorePreview>(key === undefined ? withQuery(`${base}/settings/stores/check`, { url }) : withQuery(`${base}/settings/stores/preview`, { url, key }), { method: 'GET' });

/** Fetch `wirehub-store.pub` from beside the index (trust on first use). */
export const fetchStoreKey = (url: string, base = '/api'): Promise<Outcome<FetchedStoreKey>> => request<FetchedStoreKey>(withQuery(`${base}/settings/stores/key`, { url }), { method: 'GET' });

export const storeSourcesQuery = {
  queryKey: storeSourcesKey,
  queryFn: async (): Promise<StoreSourcesView> => {
    const out = await fetchStoreSources();
    if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    return out.value;
  },
  retry: false,
} as const;

/** The stores added here, as the PUT takes them. */
export const userSourceInputs = (view: StoreSourcesView): StoreSourceInput[] =>
  view.sources.filter((s) => s.origin === 'user').map((s) => ({ url: s.url, publicKey: s.publicKey, ...(s.label === undefined ? {} : { label: s.label }), enabled: s.enabled, ...(s.hideUnreviewed === undefined ? {} : { hideUnreviewed: s.hideUnreviewed }) }));

/* ------------------------------------------------------------------ *
 * Runtime settings: notifications, sign-in, integrations, jobs (`server/runtime-settings-api.ts`)
 * ------------------------------------------------------------------ */

export const runtimeSettingsKey = ['settings', 'runtime'] as const;

export type RuntimeValue = string | number | boolean | string[];

export interface RuntimeFieldView {
  key: string;
  /** the environment variable that sets it on the server (and wins) */
  env: string;
  label: string;
  help: string;
  kind: 'text' | 'multiline' | 'url' | 'bool' | 'int' | 'list' | 'enum' | 'cron' | 'window';
  options?: string[];
  min?: number;
  max?: number;
  placeholder?: string;
  defaultText?: string;
  /** `server`: set by the server's environment (read-only here); `settings`: saved here; `default`: neither */
  source: 'server' | 'settings' | 'default';
  value?: RuntimeValue;
  /** a value saved here that the server's variable overrides */
  saved?: RuntimeValue;
  secret?: true;
  /** a secret: whether one is set (never its value) */
  set?: boolean;
  /** a secret saved here that this server cannot decrypt */
  unreadable?: true;
  setAt?: string;
}

export interface RuntimeGroupView {
  id: 'notifications' | 'sign-in' | 'integrations' | 'jobs';
  title: string;
  intro: string;
  applies: string;
  role: 'owner' | 'editor';
  editable: boolean;
  /** owner-only and you are not an owner: the values are not shown */
  restricted?: true;
  etag: string;
  fields: RuntimeFieldView[];
}

/** One field a module declares (`server/module-settings.ts`); a secret is never sent back, only whether it is set. */
export interface ModuleFieldView {
  key: string;
  label: string;
  help: string;
  kind: 'secret' | 'text' | 'bool' | 'list';
  secret?: true;
  multiline?: true;
  options?: string[];
  required?: true;
  /** the provider or feature it enables */
  gates?: string;
  /** the server variable that, when set, wins (shown locked) */
  env?: string;
  source: 'server' | 'settings' | 'default';
  /** owners: configured, from the server (locked), missing (required and unset) or unset */
  status?: 'configured' | 'server' | 'missing' | 'unset';
  value?: RuntimeValue;
  saved?: RuntimeValue;
  set?: boolean;
  unreadable?: true;
  setAt?: string;
}

/** The settings one installed module declares (module API 1.5), in Settings → Module settings. */
export interface ModuleSettingsView {
  module: string;
  title: string;
  editable: boolean;
  restricted?: true;
  /** the ETag of the module settings document (shared by every module's section) */
  etag: string;
  fields: ModuleFieldView[];
}

export interface RuntimeSettingsView {
  groups: RuntimeGroupView[];
  /** the settings installed modules declare; absent from an older server */
  modules?: ModuleSettingsView[];
  /** `keyRing` (owners only): previous keys the server still reads with, and the stored secrets not yet under the current key */
  secrets: { available: boolean; note?: string; keyRing?: { previousKeys: number; stale: number; unreadable: number } };
  /** owners only: the settings the server's environment sets that Settings does not yet hold the same value for */
  adoptable?: { key: string; env: string; label: string }[];
  problems: string[];
}

export interface AdoptResult {
  adopted: string[];
  skipped: { key: string; label: string; why: string }[];
}

/** Copy the server's values (its environment's runtime settings) into Settings, secrets into the encrypted store. */
export const adoptServerValues = (base = '/api'): Promise<Outcome<AdoptResult>> => request<AdoptResult>(`${base}/settings/adopt`, { method: 'POST', body: {} });

export interface RotateKeyResult {
  total: number;
  rotated: string[];
  current: number;
  skipped: string[];
  unreadable: string[];
  previousKeys: number;
}

/** Re-encrypt every stored secret under the server's current settings key (owner, signed in). */
export const rotateSettingsKey = (base = '/api'): Promise<Outcome<RotateKeyResult>> => request<RotateKeyResult>(`${base}/settings/rotate-key`, { method: 'POST', body: {} });

export const fetchRuntimeSettings = (base = '/api'): Promise<Outcome<RuntimeSettingsView>> => request<RuntimeSettingsView>(`${base}/settings/runtime`, { method: 'GET' });

/** Replace a group's values (a key left out is unset); secrets are set with `saveRuntimeSecret`. */
export const saveRuntimeGroup = (group: string, values: Record<string, RuntimeValue>, etag: string, base = '/api'): Promise<Outcome<unknown>> =>
  request<unknown>(`${base}/settings/runtime/${encodeURIComponent(group)}`, { method: 'PUT', body: { values }, headers: { 'if-match': etag } });

/** Set a secret (write-only), or clear it with `undefined`. */
export const saveRuntimeSecret = (key: string, value: string | undefined, base = '/api'): Promise<Outcome<{ key: string; set: boolean }>> =>
  request<{ key: string; set: boolean }>(`${base}/settings/secrets/${encodeURIComponent(key)}`, value === undefined ? { method: 'DELETE' } : { method: 'PUT', body: { value } });

/** Replace one module's non-secret settings (a key left out is unset). */
export const saveModuleSettings = (module: string, values: Record<string, RuntimeValue>, etag: string, base = '/api'): Promise<Outcome<unknown>> =>
  request<unknown>(`${base}/settings/modules/${encodeURIComponent(module)}`, { method: 'PUT', body: { values }, headers: { 'if-match': etag } });

/** Set a module's secret (write-only), or clear it with `undefined`. */
export const saveModuleSecret = (module: string, key: string, value: string | undefined, base = '/api'): Promise<Outcome<{ module: string; key: string; set: boolean }>> =>
  request<{ module: string; key: string; set: boolean }>(`${base}/settings/modules/${encodeURIComponent(module)}/secrets/${encodeURIComponent(key)}`, value === undefined ? { method: 'DELETE' } : { method: 'PUT', body: { value } });

export const runtimeSettingsQuery = {
  queryKey: runtimeSettingsKey,
  queryFn: async (): Promise<RuntimeSettingsView> => {
    const out = await fetchRuntimeSettings();
    if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    return out.value;
  },
  retry: false,
} as const;

/* ------------------------------------------------------------------ *
 * The numbering scheme (`server/pn-settings.ts`)
 * ------------------------------------------------------------------ */

export const pnSettingsKey = ['settings', 'part-numbers'] as const;

export interface PnSchemeOffer {
  pack: string;
  version: string;
  scheme: unknown;
  problems: string[];
}

export interface PnSettingsView {
  /** the stored definition, or null (the default prefix scheme) */
  config: unknown;
  effective: { kind: 'prefix' | 'declarative' | 'module' | 'default'; id: string; label: string; shape?: string; immutable: boolean };
  overriddenByModule?: boolean;
  defaults: unknown;
  kinds: string[];
  offers: PnSchemeOffer[];
  etag: string;
}

export interface PnPreview {
  ok: boolean;
  problems?: string[];
  shape?: string | null;
  immutable?: boolean;
  samples?: { pn: string; canonical: string | null; issues: { code: string; message: string }[] }[];
  suggestions?: { kind: string; suggestion: { pn: string; explanation: string } | null }[];
  impact?: { numbered: number; notInScheme: number; duplicates: number; unnumbered: number; examples: { pn: string; where: string; message: string }[] };
}

export async function fetchPnSettings(base = '/api'): Promise<Outcome<PnSettingsView>> {
  let etag = '';
  const out = await request<Omit<PnSettingsView, 'etag'>>(`${base}/settings/part-numbers`, { method: 'GET' }, (r) => {
    etag = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag } } : out;
}

export async function savePnSettings(input: { scheme: unknown } | { adoptFrom: string }, etag: string, base = '/api'): Promise<Outcome<PnSettingsView>> {
  let next = '';
  const out = await request<Omit<PnSettingsView, 'etag'>>(`${base}/settings/part-numbers`, { method: 'PUT', body: input, headers: { 'if-match': etag } }, (r) => {
    next = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag: next } } : out;
}

export const previewPnScheme = (input: { scheme: unknown; samples?: string[]; suggest?: { kind: string; variantOf?: string }[] }, base = '/api'): Promise<Outcome<PnPreview>> =>
  request<PnPreview>(`${base}/settings/part-numbers/preview`, { method: 'POST', body: input });

export const pnSettingsQuery = {
  queryKey: pnSettingsKey,
  queryFn: async (): Promise<PnSettingsView> => {
    const out = await fetchPnSettings();
    if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    return out.value;
  },
  retry: false,
} as const;

/* ------------------------------------------------------------------ *
 * Declarative validation rules (`server/rules-settings.ts`)
 * ------------------------------------------------------------------ */

export const rulesKey = ['settings', 'rules'] as const;

export interface RuleView {
  id: string;
  label?: string;
  enabled?: boolean;
  severity: 'error' | 'warning';
  message: string;
  each: string;
  where?: unknown;
  require: unknown;
  src: string;
  origin: 'local' | 'pack';
  pack?: string;
  problems: string[];
}

export interface RulesView {
  rules: RuleView[];
  /** this hub's own rules, as stored */
  local: Omit<RuleView, 'origin' | 'pack' | 'problems'>[];
  limits: { rules: number };
  subjects: { design: string[]; library: string[] };
  etag: string;
}

export interface RulePreview {
  ok: boolean;
  problems?: string[];
  designs?: { id: string; issues: number; examples: { severity: string; message: string; where?: string }[] }[];
  library?: { issues: number; examples: { severity: string; message: string; where?: string }[] };
  errors?: number;
  warnings?: number;
}

export async function fetchRules(base = '/api'): Promise<Outcome<RulesView>> {
  let etag = '';
  const out = await request<Omit<RulesView, 'etag'>>(`${base}/rules`, { method: 'GET' }, (r) => {
    etag = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag } } : out;
}

export async function saveRules(rules: unknown[], etag: string, base = '/api'): Promise<Outcome<RulesView>> {
  let next = '';
  const out = await request<Omit<RulesView, 'etag'>>(`${base}/rules`, { method: 'PUT', body: { rules }, headers: { 'if-match': etag } }, (r) => {
    next = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag: next } } : out;
}

export const previewRule = (rule: unknown, base = '/api'): Promise<Outcome<RulePreview>> => request<RulePreview>(`${base}/rules/preview`, { method: 'POST', body: { rule } });

export const rulesQuery = {
  queryKey: rulesKey,
  queryFn: async (): Promise<RulesView> => {
    const out = await fetchRules();
    if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    return out.value;
  },
  retry: false,
} as const;

/* ------------------------------------------------------------------ *
 * Outbound event webhooks (`server/webhooks/api.ts`): owners only
 * ------------------------------------------------------------------ */

export const webhooksKey = ['settings', 'webhooks'] as const;
export const webhookDeliveriesKey = ['settings', 'webhooks', 'deliveries'] as const;

export interface WebhookSubscriptionView {
  id: string;
  label?: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt?: string;
  secret: 'set' | 'unset' | 'unreadable';
}

export interface WebhooksView {
  subscriptions: WebhookSubscriptionView[];
  events: { type: string; label: string; description: string }[];
  limits: { subscriptions: number; attempts: number };
  signature: { header: string; scheme: string; payloadSchema: string };
  secrets: { available: boolean; note?: string };
  etag: string;
}

export interface WebhookDelivery {
  id: string;
  deliveryId: string;
  subscription: string;
  type: string;
  attempt: number;
  state: 'queued' | 'running' | 'delivered' | 'retrying' | 'failed' | 'skipped';
  status?: number;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  retryAt?: string;
  redeliveredFrom?: string;
  test?: boolean;
}

export async function fetchWebhooks(base = '/api'): Promise<Outcome<WebhooksView>> {
  let etag = '';
  const out = await request<Omit<WebhooksView, 'etag'>>(`${base}/settings/webhooks`, { method: 'GET' }, (r) => {
    etag = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag } } : out;
}

export async function saveWebhooks(subscriptions: Pick<WebhookSubscriptionView, 'id' | 'label' | 'url' | 'events' | 'enabled'>[] | Omit<WebhookSubscriptionView, 'secret' | 'createdAt'>[], etag: string, base = '/api'): Promise<Outcome<WebhooksView>> {
  let next = '';
  const out = await request<Omit<WebhooksView, 'etag'>>(`${base}/settings/webhooks`, { method: 'PUT', body: { subscriptions }, headers: { 'if-match': etag } }, (r) => {
    next = r.headers.get('etag') ?? '';
  });
  return out.ok ? { ok: true, value: { ...out.value, etag: next } } : out;
}

export const setWebhookSecret = (id: string, value?: string, base = '/api'): Promise<Outcome<{ id: string; set: boolean; generated?: string }>> =>
  request(`${base}/settings/webhooks/${id}/secret`, { method: 'PUT', body: value === undefined ? {} : { value } });
export const clearWebhookSecret = (id: string, base = '/api'): Promise<Outcome<{ id: string; set: boolean }>> => request(`${base}/settings/webhooks/${id}/secret`, { method: 'DELETE' });
export const testWebhook = (id: string, base = '/api'): Promise<Outcome<{ job?: string }>> => request(`${base}/settings/webhooks/${id}/test`, { method: 'POST' });
export const redeliverWebhook = (job: string, base = '/api'): Promise<Outcome<{ job?: string }>> => request(`${base}/settings/webhooks/deliveries/${job}/redeliver`, { method: 'POST' });

export const webhooksQuery = {
  queryKey: webhooksKey,
  queryFn: async (): Promise<WebhooksView> => {
    const out = await fetchWebhooks();
    if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    return out.value;
  },
  retry: false,
} as const;

export const webhookDeliveriesQuery = {
  queryKey: webhookDeliveriesKey,
  queryFn: async (): Promise<WebhookDelivery[]> => {
    const out = await request<{ deliveries: WebhookDelivery[] }>('/api/settings/webhooks/deliveries?limit=100', { method: 'GET' });
    if (!out.ok) throw new Error(out.message);
    return out.value.deliveries;
  },
  retry: false,
  refetchInterval: 5000,
} as const;
