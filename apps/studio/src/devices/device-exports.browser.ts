import type { Outcome } from '@wirehub/editor-react';
import { request } from '../definitions.browser.ts';

/** The shapes `server/devices/api.ts` answers with (copied, not imported: the browser never reaches into `server/`). */
export interface DeviceExportOutput { path: string; role: string; mediaType: string; size: number; sha256: string; href: string }
export interface DeviceExportRun {
  id: string;
  jobId?: string;
  record: string;
  identity: { revision?: string };
  sources: { role: string; path: string; sha256: string }[];
  pack: string;
  packVersion: string;
  image: string;
  tool: { name: string; version: string };
  op: string;
  params: { design?: { id: string; rev?: number }; parts?: number; requestSha256?: string };
  status: 'ok' | 'failed';
  findings: { level: 'info' | 'warn' | 'error'; message: string }[];
  outputs: DeviceExportOutput[];
  durationMs?: number;
  createdAt: string;
  logHref: string;
}
export interface DeviceExportJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  steps: { at: string; text: string }[];
  error?: string;
  createdAt: string;
}
export interface DeviceExportsView {
  record: string;
  available: { ok: boolean; reason?: string };
  runs: DeviceExportRun[];
  job: DeviceExportJob | null;
}

/**
 * The exports a view may offer: a saved version's view only those made from that
 * version, never a working-copy export (it may hold newer geometry); the working copy's view all.
 */
export function exportsForView<R extends { params: { design?: { rev?: number } } }>(runs: readonly R[], rev: number | undefined): R[] {
  return rev === undefined ? [...runs] : runs.filter((r) => r.params.design?.rev === rev);
}

export const deviceExportsKey = (id: string): readonly string[] => ['device-exports', id];

export async function readDeviceExports(id: string): Promise<DeviceExportsView> {
  const out = await request<DeviceExportsView>(`/api/devices/${encodeURIComponent(id)}/exports`);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

/** Queue an export of the working copy, or of saved Rev `rev` (202, the job). */
export async function startDeviceExport(id: string, rev?: number): Promise<Outcome<{ job: DeviceExportJob; findings: { level: string; message: string }[]; parts: number }>> {
  return request(`/api/devices/${encodeURIComponent(id)}/exports`, { method: 'POST', body: rev === undefined ? {} : { rev } });
}

export async function cancelDeviceExport(job: string): Promise<Outcome<unknown>> {
  return request(`/api/jobs/${encodeURIComponent(job)}/cancel`, { method: 'POST', body: {} });
}
