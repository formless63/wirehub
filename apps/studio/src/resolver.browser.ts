/**
 * The resolver library over the workbench API (`server/resolver.ts`): devices, conditioning
 * recipes, hazards and the ranking policy, each this hub's own list (a pack's records shadowed
 * by id). Resolving and deriving run in the browser on the loaded library (`@wirehub/model`);
 * the server's `GET /api/resolver/resolve|derive` are for scripts and agents.
 */

import type { Outcome } from '@wirehub/editor-react';
import type { ConditioningRecipe, DeviceProfile, HazardRule, Issue, ResolverPolicy } from '@wirehub/model';

import { request } from './definitions.browser.ts';

export const resolverKey = ['resolver', 'library'] as const;

export type Origin = { origin: 'local' | 'pack'; pack?: string; held?: boolean };

export interface ResolverView {
  devices: (DeviceProfile & Origin)[];
  recipes: (ConditioningRecipe & Origin)[];
  hazards: { builtIn: HazardRule[]; library: (HazardRule & Origin)[] };
  policy: { inForce: ResolverPolicy; local: ResolverPolicy | null; default: ResolverPolicy; criteria: string[] };
  local: { devices: Record<string, unknown>[]; recipes: Record<string, unknown>[]; hazards: Record<string, unknown>[]; policy?: Record<string, unknown> };
  issues: Issue[];
  etags: { devices: string; recipes: string; hazards: string; policy: string };
}

export const fetchResolver = (base = '/api'): Promise<Outcome<ResolverView>> => request<ResolverView>(`${base}/resolver`, { method: 'GET' });

export type ResolverList = 'devices' | 'recipes' | 'hazards';

export const saveResolverList = (list: ResolverList, records: unknown[], etag: string, base = '/api'): Promise<Outcome<ResolverView>> =>
  request<ResolverView>(`${base}/resolver/${list}`, { method: 'PUT', body: { [list]: records }, headers: { 'if-match': etag } });

export const saveResolverPolicy = (policy: unknown, etag: string, base = '/api'): Promise<Outcome<ResolverView>> =>
  request<ResolverView>(`${base}/resolver/policy`, { method: 'PUT', body: { policy }, headers: { 'if-match': etag } });

export const resolverQuery = {
  queryKey: resolverKey,
  queryFn: async (): Promise<ResolverView> => {
    const out = await fetchResolver();
    if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    return out.value;
  },
  retry: false,
} as const;
