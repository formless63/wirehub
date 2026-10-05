/**
 * How a host keeps revisions of library records (`@wirehub/model` `record-revisions.ts`,
 * `docs/revisions.md`): the list with where each is used, one revision in full, saving the next,
 * and the scheme's next variant number. The studio's adapter speaks `/api/revisions/…`.
 */

import type { ExternalRevision, RecordRevision, RevisionArt, RevisionWhereUsed } from '@wirehub/model';

import type { Outcome } from './persistence.ts';

export type RevisionSummary = Omit<RecordRevision, 'record' | 'art'> & { hasArt: boolean };

export interface RevisionsView {
  kind: string;
  id: string;
  label: string;
  current: { record?: Record<string, unknown>; partNumber?: string; rev?: number; changedSince?: number; gone?: boolean };
  revisions: RevisionSummary[];
  external: { module: string; source: string; label: string; revisions: ExternalRevision[]; error?: string }[];
  whereUsed: RevisionWhereUsed;
  etag: string;
}

export interface SaveRevisionInput {
  note: string;
  label?: string;
  art?: RevisionArt;
  model?: { asset: string; mime?: string };
  /** give the record the scheme's next variant number first */
  renumber?: boolean;
}

export interface RevisionsAdapter {
  list(kind: string, id: string): Promise<Outcome<RevisionsView>>;
  read(kind: string, id: string, rev: number): Promise<Outcome<RecordRevision>>;
  save(kind: string, id: string, input: SaveRevisionInput): Promise<Outcome<RevisionsView>>;
  nextNumber(kind: string, id: string): Promise<Outcome<{ suggestion: { pn: string; explanation?: string } }>>;
}

/** A compare side: a record as it is, or one of its revisions (`<kind>/<id>@<rev>`). */
export interface CompareSide {
  kind: string;
  id: string;
  rev?: number;
}

export function parseCompareSide(item: string | undefined): CompareSide | undefined {
  if (item === undefined) return undefined;
  const slash = item.indexOf('/');
  if (slash <= 0) return undefined;
  const kind = item.slice(0, slash);
  const rest = item.slice(slash + 1);
  const at = rest.lastIndexOf('@');
  if (at > 0 && /^\d+$/.test(rest.slice(at + 1))) return { kind, id: rest.slice(0, at), rev: Number(rest.slice(at + 1)) };
  return { kind, id: rest };
}

export const compareSideId = (side: CompareSide): string => `${side.kind}/${side.id}${side.rev === undefined ? '' : `@${side.rev}`}`;
