import type { Outcome } from '@wirehub/editor-react';
import { request } from '../definitions.browser.ts';

/** The shapes `server/repro/api.ts` answers with (copied: the browser never reaches into `server/`). */
export interface FileSide { sha256: string; size: number; href: string }
export interface FileCompare {
  path: string; role: string; mediaType: string; state: 'same' | 'differs' | 'added' | 'removed';
  a?: FileSide; b?: FileSide; visual?: boolean;
  text?: TextDiff;
  inside?: { kind: 'zip' | 'glb'; total: number; same: number; onlyTimes: boolean; members: { path: string; state: FileCompare['state']; a?: { sha256: string; size: number }; b?: { sha256: string; size: number }; text?: TextDiff }[] };
}
export interface TextDiff { lines: number; differing: number; sample: { line: number; a: string; b: string }[]; onlyTimes?: boolean }
export interface RunCompare {
  a: string; b: string; verdict: 'identical' | 'same-but-times' | 'differs'; same: number; total: number; files: FileCompare[];
  changes: { field: string; a: string; b: string }[];
}
export interface RunSummary { identity?: { rev?: number; revision?: string };  id: string; op: string; status: 'ok' | 'failed'; createdAt: string; image: string; imageId: string; tool: { name: string; version: string } }
export interface ReproJob { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'; steps: { at: string; text: string }[]; error?: string; createdAt: string }
export interface ReproView {
  run: RunSummary;
  comparisons?: RunSummary[];
  canRerun: { ok: boolean; reason?: string };
  rerun: { job: ReproJob; run: RunSummary | null; compare: RunCompare | null } | null;
  of: { run: RunSummary; compare: RunCompare } | null;
}

export const reproKey = (runId: string): readonly string[] => ['repro', runId];

export async function readRepro(runId: string): Promise<ReproView> {
  const out = await request<ReproView>(`/api/repro/runs/${encodeURIComponent(runId)}`);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

export function startRerun(runId: string): Promise<Outcome<{ job: ReproJob }>> {
  return request(`/api/repro/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST', body: {} });
}

export const runPackageHref = (runId: string): string => `/api/repro/runs/${encodeURIComponent(runId)}/package`;
export const versionPackageHref = (design: string, rev: number): string => `/api/repro/designs/${encodeURIComponent(design)}/${rev}/package`;

export async function compareToolRuns(runId: string, otherId: string): Promise<{ a: RunSummary; b: RunSummary; compare: RunCompare }> {
  const out = await request<{ a: RunSummary; b: RunSummary; compare: RunCompare }>(`/api/repro/runs/${encodeURIComponent(runId)}/compare?with=${encodeURIComponent(otherId)}`);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}
