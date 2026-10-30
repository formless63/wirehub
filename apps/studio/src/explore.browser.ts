/** Solution exploration over the workbench API (`server/explore.ts`, `docs/explore.md`). */

import type { Outcome } from '@wirehub/editor-react';
import type { EnclosurePreset, Exploration, ExploreOverride, FirmwareTargetRef, Requirement } from '@wirehub/model';

import type { SavedExploration } from '../server/explore.ts';
import { request } from './definitions.browser.ts';

export type { SavedExploration };

export interface ExploreView {
  saved: SavedExploration[];
  presets: { builtIn: EnclosurePreset[]; local: EnclosurePreset[]; inForce: EnclosurePreset[] };
  targets: FirmwareTargetRef[];
  etags: { saved: string; presets: string };
}

export const exploreKey = ['explore'] as const;
const base = '/api/explore';

export const fetchExplore = (): Promise<Outcome<ExploreView>> => request<ExploreView>(base, { method: 'GET' });

export const runExploration = (requirement: Requirement, overrides: readonly ExploreOverride[]): Promise<Outcome<{ exploration: Exploration }>> =>
  request<{ exploration: Exploration }>(`${base}/run`, { method: 'POST', body: { requirement, overrides } });

export const saveExploration = (exploration: { requirement: Requirement; overrides: ExploreOverride[]; label?: string; picked?: SavedExploration['picked'] }, etag: string): Promise<Outcome<{ saved: SavedExploration[]; exploration: SavedExploration; etags: ExploreView['etags'] }>> =>
  request(`${base}/saved`, { method: 'PUT', body: { exploration }, headers: { 'if-match': etag } });

export const forgetExploration = (key: string, etag: string): Promise<Outcome<{ saved: SavedExploration[]; etags: ExploreView['etags'] }>> =>
  request(`${base}/saved?key=${encodeURIComponent(key)}`, { method: 'DELETE', headers: { 'if-match': etag } });

export const savePresets = (presets: EnclosurePreset[], etag: string): Promise<Outcome<{ presets: ExploreView['presets']; etags: ExploreView['etags'] }>> =>
  request(`${base}/presets`, { method: 'PUT', body: { presets }, headers: { 'if-match': etag } });
