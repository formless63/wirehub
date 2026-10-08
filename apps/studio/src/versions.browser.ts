/**
 * Design versions over the workbench API — the
 * browser half of `server/versions.ts`. Nothing here throws: every call is an
 * `Outcome`, the same contract as `persistence.browser.ts`.
 */

import type { Outcome } from '@wirehub/editor-react';
import { DESIGN_VERSION_FORMAT_V1, type CableDesign, type DesignVersionFile, type VersionSummary } from '@wirehub/model';

import { request } from './persistence.browser.ts';

export interface WorkingStatus {
  basedOnRev?: number;
  unreleased: boolean;
  nextRev: number;
  latestRev?: number;
  /** release approvals are on */
  approvals?: boolean;
  /** the latest approved revision, when approvals are on */
  releasedRev?: number;
}

export interface DraftSummary {
  n: number;
  savedAt: string;
  savedBy: string;
  basedOnRev?: number;
  reason: string;
}

export interface VersionListing {
  revisions: VersionSummary[];
  working: WorkingStatus;
  drafts: DraftSummary[];
}

export interface ReplacedWorking extends VersionListing {
  design: CableDesign;
  keptDraft?: number;
}

export function versionsKey(id: string): readonly [string, string, string] {
  return ['studio', 'versions', id] as const;
}

export function versionKey(id: string, rev: number): readonly [string, string, string, number] {
  return ['studio', 'version', id, rev] as const;
}

const base = (id: string): string => `/api/designs/${encodeURIComponent(id)}/versions`;

export const listVersions = (id: string): Promise<Outcome<VersionListing>> => request<VersionListing>(base(id));

export const getVersion = (id: string, rev: number): Promise<Outcome<DesignVersionFile>> =>
  request<DesignVersionFile>(`${base(id)}/${rev}`);

export const saveVersion = (
  id: string,
  note: string,
): Promise<Outcome<VersionListing & { version: VersionSummary; drawingTag?: string }>> =>
  request(base(id), { method: 'POST', body: { note } });

export const unlockVersion = (id: string, rev: number, reason: string): Promise<Outcome<DesignVersionFile>> =>
  request(`${base(id)}/${rev}/unlock`, { method: 'POST', body: { reason } });

export const lockVersion = (id: string, rev: number): Promise<Outcome<DesignVersionFile>> =>
  request(`${base(id)}/${rev}/lock`, { method: 'POST', body: {} });

export type ApprovalStep = 'submit' | 'approve' | 'reject';

/** submit, approve or reject a saved version; a comment is required */
export const approvalStep = (id: string, rev: number, step: ApprovalStep, comment: string): Promise<Outcome<VersionListing & { version: VersionSummary }>> =>
  request(`${base(id)}/${rev}/${step}`, { method: 'POST', body: { comment } });

export const editVersion = (id: string, rev: number, design: CableDesign): Promise<Outcome<DesignVersionFile>> =>
  request(`${base(id)}/${rev}`, { method: 'PUT', body: { design } });

export const branchVersion = (id: string, rev: number): Promise<Outcome<ReplacedWorking>> =>
  request(`${base(id)}/${rev}/branch`, { method: 'POST', body: { confirm: rev } });

export const restoreDraft = (id: string, n: number): Promise<Outcome<ReplacedWorking>> =>
  request(`${base(id)}/drafts/${n}/restore`, { method: 'POST', body: { confirm: n } });

/** `2026-09-25T10:00:00.000Z` → `2026-09-25 10:00` (local time). */
export function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A saved revision's copied artwork, as depiction modules keyed `<defId>/<file>`. */
export interface VersionArtwork {
  meta: Record<string, unknown>;
  vector: Record<string, string>;
  raster: Record<string, string>;
  missing: string[];
}

export const getVersionArtwork = (id: string, rev: number): Promise<Outcome<VersionArtwork>> =>
  request<VersionArtwork>(`${base(id)}/${rev}/artwork`);

/** What a revision draws its parts with: its own copies, and which definitions they fix. */
export interface VersionArt {
  own: { meta: Record<string, unknown>; vector: Record<string, string>; raster: Record<string, string> };
  covered: Set<string>;
  /** definitions whose copy could not be read back — they draw today's artwork */
  missing: string[];
}

/**
 * Fetch a revision's copied artwork. Every definition it froze is covered
 * (one that had no artwork then stays abstract), except in a v1 file, which
 * kept only hashes — that one draws today's artwork, as it always did.
 */
export async function loadVersionArt(id: string, file: DesignVersionFile): Promise<VersionArt> {
  const empty = { meta: {}, vector: {}, raster: {} };
  if (file.format === DESIGN_VERSION_FORMAT_V1) return { own: empty, covered: new Set(), missing: [] };
  const out = await getVersionArtwork(id, file.rev);
  if (!out.ok) return { own: empty, covered: new Set(), missing: Object.keys(file.depictions) };
  const d = file.definitions;
  const missing = new Set(out.value.missing);
  const covered = new Set(
    [...d.connectors, ...d.pcbas, ...d.wires, ...d.components, ...d.mechanicals].map((def) => def.id).filter((defId) => !missing.has(defId)),
  );
  const { missing: _missing, ...own } = out.value;
  return { own, covered, missing: [...missing] };
}

/** A saved revision as a row of the drawing's revision table: its note, the day it was saved and who saved it. */
export function revisionRow(summary: VersionSummary): { rev: string; description: string; date: string; by: string } {
  return {
    rev: String(summary.rev),
    description: summary.note.trim() === '' ? `Revision ${summary.rev}` : summary.note.trim(),
    date: summary.savedAt.slice(0, 10).replace(/-/g, '.'),
    by: summary.savedBy,
  };
}
