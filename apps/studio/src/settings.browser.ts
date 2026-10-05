/**
 * The hub's branding settings (`GET`/`PUT /api/settings/branding`, `server/settings.ts`):
 * organisation, standard, rights line, default designer and logo. Nothing here throws.
 */

import type { BrandingSettings } from '../module-art.ts';
import type { Outcome } from '@wirehub/editor-react';
import { request } from './definitions.browser.ts';

export const brandingKey = ['settings', 'branding'] as const;

export interface BrandingView extends BrandingSettings {
  /** the entity tag to quote when saving */
  etag: string;
}

export interface BrandingInput {
  organisation?: string;
  standard?: string;
  rights?: string;
  designer?: string;
  /** the prefix of exported wire spec files */
  filePrefix?: string;
  /** the title block's three-line general note (a line may be empty) */
  notes?: [string, string, string];
  /** the title block's tolerance rows, label and value; empty rows are dropped */
  tolerances?: [string, string][];
  /** a PNG or SVG data URI sets the logo (an SVG is drawn to a PNG on the server), `null` removes it, absent keeps it */
  logo?: string | null;
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
  view.sources.filter((s) => s.origin === 'user').map((s) => ({ url: s.url, publicKey: s.publicKey, ...(s.label === undefined ? {} : { label: s.label }), enabled: s.enabled }));
