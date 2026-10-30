import type { Outcome } from '@wirehub/editor-react';
import type { EnclosureFact, EnclosurePort } from '@wirehub/model';
import { request } from '../definitions.browser.ts';

/** The shapes `server/enclosures/api.ts` answers with (copied, not imported: the browser never reaches into `server/`). */
export interface EnclosureFinding { level: 'info' | 'warn' | 'error'; message: string }
export interface EnclosureOutputView { role: string; path: string; mediaType: string; sha256: string; asset?: string; bytes: number }
export interface EnclosureResult {
  outer?: { x: number; y: number; z: number };
  interior?: { x: number; y: number; z: number };
  placements?: { occurrence: string; board: string; rotation: number; offset: number[]; heightAbove: { value: number; basis: string } }[];
  openings?: { id: string; label: string; face: string; gapToWall?: number }[];
}
export interface EnclosureRunView {
  enclosure: string;
  generatedAt: string;
  by?: string;
  status: 'ok' | 'failed';
  pack: string;
  packVersion: string;
  image: string;
  tool: Record<string, string>;
  requestSha256: string;
  inputs: { spec: unknown; sources: { pcba: string; path: string; sha256: string }[] };
  findings: EnclosureFinding[];
  outputs: EnclosureOutputView[];
  result: EnclosureResult | null;
}
export interface NativeGeometryView {
  outline: [number, number][];
  widthMm: number;
  lengthMm: number;
  thicknessMm: number;
  holes: { xMm: number; yMm: number; diameterMm: number; ref: string }[];
  footprints: { ref: string; footprint: string; side: 'top' | 'bottom' }[];
  suggestedPorts: EnclosurePort[];
  /** what the board's own source states (`server/enclosures/board-geometry.ts` NativeBoardFacts) */
  facts?: { thicknessMm?: EnclosureFact; heightAboveMm?: EnclosureFact; heightBelowMm?: EnclosureFact; componentHeights: Record<string, EnclosureFact>; unknownHeights: string[]; noPart?: string[] };
}
/** The newest generation job of the shell (`/api/jobs/:id`). */
export interface EnclosureJobView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  steps: { at: string; text: string }[];
  error?: string;
  createdAt: string;
}
export interface EnclosureView {
  id: string;
  run: EnclosureRunView | null;
  job?: EnclosureJobView | null;
  available?: { ok: boolean; reason?: string };
  boards: Record<string, { geometry: NativeGeometryView; source: { path: string; sha256: string } } | { missing: string }>;
}

export const enclosureKey = (id: string): readonly string[] => ['enclosures', id];
export const boardGeometryKey = (pcba: string): readonly string[] => ['enclosures', 'boards', pcba];

export async function cancelEnclosureJob(job: string): Promise<Outcome<unknown>> {
  return request(`/api/jobs/${encodeURIComponent(job)}/cancel`, { method: 'POST', body: {} });
}

export async function readEnclosure(id: string): Promise<EnclosureView> {
  const out = await request<EnclosureView>(`/api/enclosures/${encodeURIComponent(id)}`);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

export async function readBoardGeometry(pcba: string): Promise<{ geometry: NativeGeometryView | null; missing?: string }> {
  const out = await request<{ geometry: NativeGeometryView | null; missing?: string }>(`/api/enclosures/boards/${encodeURIComponent(pcba)}/geometry`);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

/** Queue a generation (202, the job); the panel follows it through `readEnclosure`. */
export async function generateEnclosure(id: string): Promise<Outcome<{ id: string; job: EnclosureJobView; findings: EnclosureFinding[] }>> {
  return request<{ id: string; job: EnclosureJobView; findings: EnclosureFinding[] }>(`/api/enclosures/${encodeURIComponent(id)}/generate`, { method: 'POST', body: {} });
}
