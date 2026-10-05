/**
 * The resolver library over the workbench API (`server/resolver.ts`): devices, conditioning
 * recipes, hazards and the ranking policy, each this hub's own list (a pack's records shadowed
 * by id). Resolving and deriving run in the browser on the loaded library (`@wirehub/model`);
 * the server's `GET /api/resolver/resolve|derive` are for scripts and agents.
 */

import type { Outcome } from '@wirehub/editor-react';
import type { BoardProposal, ConditioningRecipe, DeviceProfile, HazardRule, Issue, ProposalDecision, ResolverPolicy } from '@wirehub/model';

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

/* ------------------------------------------------------------------ *
 * Proposals (`server/proposals.ts`)
 * ------------------------------------------------------------------ */

export interface ProposalRow {
  proposal: BoardProposal;
  state: 'open' | 'declined' | 'accepted';
  reason?: string;
  pcba?: string;
}

const pairQuery = (q: { source: { device: string; port?: string }; destination: { device: string; port?: string } }): string =>
  new URLSearchParams({ source: q.source.device, destination: q.destination.device, ...(q.source.port === undefined ? {} : { sourcePort: q.source.port }), ...(q.destination.port === undefined ? {} : { destinationPort: q.destination.port }) }).toString();

export const fetchPairProposals = (q: Parameters<typeof pairQuery>[0], base = '/api'): Promise<Outcome<{ proposals: ProposalRow[] }>> => request<{ proposals: ProposalRow[] }>(`${base}/proposals?${pairQuery(q)}`);
export const fetchProposalDecisions = (base = '/api'): Promise<Outcome<{ proposals: ProposalDecision[] }>> => request<{ proposals: ProposalDecision[] }>(`${base}/proposals`);
export const decideProposal = (action: 'decline' | 'reopen' | 'accept', body: { key: string; reason?: string; id?: string; proposal?: BoardProposal }, base = '/api'): Promise<Outcome<{ proposals: ProposalDecision[] }>> =>
  request<{ proposals: ProposalDecision[] }>(`${base}/proposals/${action}`, { method: 'POST', body });
