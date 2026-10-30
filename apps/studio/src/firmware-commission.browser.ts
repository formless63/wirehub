/** Commissioning records and flash bundles over the workbench API (`server/firmware/commission.ts`). */

import type { Outcome } from '@wirehub/editor-react';

import { request } from './definitions.browser.ts';
import type { CommissionInput, FirmwareCommission } from './firmware-commission.ts';

export const commissionsKey = (id: string) => ['firmware', 'commissions', id] as const;
export const commissioningAuthorityKey = ['firmware', 'commissioning-authority'] as const;

export interface CommissionList {
  commissions: FirmwareCommission[];
  authority: { allowed: boolean; reason?: string };
}

const base = (id: string): string => `/api/firmware/${encodeURIComponent(id)}`;

export const fetchCommissions = (id: string): Promise<Outcome<CommissionList>> => request<CommissionList>(`${base(id)}/commissions`);
export const recordCommission = (id: string, input: CommissionInput): Promise<Outcome<{ commission: FirmwareCommission }>> =>
  request(`${base(id)}/commissions`, { method: 'POST', body: input });
export const bundleUrl = (id: string, build: string): string => `${base(id)}/builds/${encodeURIComponent(build)}/bundle`;

export const fetchAuthority = (): Promise<Outcome<{ operators: string[]; etag: string }>> => request('/api/firmware/commissioning-authority');
export const saveAuthority = (operators: string[], etag: string): Promise<Outcome<{ operators: string[]; etag: string }>> =>
  request('/api/firmware/commissioning-authority', { method: 'PUT', body: { operators }, headers: { 'if-match': etag } });
