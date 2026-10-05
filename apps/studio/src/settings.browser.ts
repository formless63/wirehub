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
  /** a PNG data URI sets the logo, `null` removes it, absent keeps it */
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

export async function saveEngineering(input: Pick<EngineeringSettings, 'testDefaults' | 'electrical' | 'approvals'>, etag: string, base = '/api'): Promise<Outcome<EngineeringView>> {
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
