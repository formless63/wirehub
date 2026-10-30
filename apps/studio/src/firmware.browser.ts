/** Firmware projects over the workbench API (`server/firmware/api.ts`). */

import type { Outcome } from '@wirehub/editor-react';

import { request } from './definitions.browser.ts';
import type { ConfigParams, ConfigValue, FirmwareBuild, FirmwareProject, FirmwareTarget } from './firmware.ts';

export const firmwareKey = ['firmware'] as const;
export const firmwareProjectKey = (id: string) => ['firmware', 'project', id] as const;
export const firmwareOccurrencesKey = (board?: string) => ['firmware', 'occurrences', board ?? '*'] as const;

export interface FirmwareList {
  projects: FirmwareProject[];
  targets: FirmwareTarget[];
  etag: string;
}
export interface OccurrenceRow {
  design: string;
  designLabel: string;
  instance: string;
  board: string;
  note?: string;
}
export interface FirmwarePage {
  project: FirmwareProject;
  builds: FirmwareBuild[];
  occurrences: { design: string; instance: string; problem?: string; designLabel?: string; instanceDef?: string }[];
  board: null | { id: string; label?: string; missing?: boolean };
  targets: FirmwareTarget[];
  /** the tool pack's examples, while the project has no source */
  examples?: { id: string; files: { path: string; base64: string }[] }[];
  etag: string;
}

export const fetchFirmware = (query = ''): Promise<Outcome<FirmwareList>> => request<FirmwareList>(`/api/firmware${query}`);
export const saveFirmware = (projects: FirmwareProject[], etag: string): Promise<Outcome<FirmwareList>> =>
  request<FirmwareList>('/api/firmware', { method: 'PUT', body: { projects }, headers: { 'if-match': etag } });
export const fetchFirmwareProject = (id: string): Promise<Outcome<FirmwarePage>> => request<FirmwarePage>(`/api/firmware/${encodeURIComponent(id)}`);
export const fetchOccurrences = (board?: string): Promise<Outcome<{ occurrences: OccurrenceRow[] }>> =>
  request<{ occurrences: OccurrenceRow[] }>(`/api/firmware/occurrences${board === undefined ? '' : `?board=${encodeURIComponent(board)}`}`);
export const uploadSource = (id: string, files: { path: string; base64: string }[], etag: string): Promise<Outcome<{ project: FirmwareProject; etag: string }>> =>
  request(`/api/firmware/${encodeURIComponent(id)}/source`, { method: 'POST', body: { files }, headers: { 'if-match': etag } });
export const startCompile = (id: string, occurrence?: { design: string; instance: string }, network = false): Promise<Outcome<{ build: FirmwareBuild }>> =>
  request(`/api/firmware/${encodeURIComponent(id)}/compile`, { method: 'POST', body: { ...(occurrence === undefined ? {} : { occurrence }), ...(network ? { network: true } : {}) } });
export const fileUrl = (id: string, sha: string): string => `/api/firmware/${encodeURIComponent(id)}/files/${sha}`;

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A typed value from what was typed: numbers and true/false as such, empty as null (defined, no value). */
export function parseConfigValue(text: string): ConfigValue {
  const t = text.trim();
  if (t === '') return null;
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^-?(0x[0-9a-fA-F]+|\d+(\.\d+)?)$/.test(t)) return t.startsWith('0x') || t.startsWith('-0x') ? Number.parseInt(t, 16) : Number(t);
  return t;
}
export const formatConfigValue = (v: ConfigValue): string => (v === null ? '' : String(v));
export const configText = (params: ConfigParams): string => Object.entries(params).map(([k, v]) => (v === null ? k : `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)).join(' ');

export const slugify = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
