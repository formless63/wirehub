/**
 * What the Documents view needs to print a **saved revision** rather than the
 * working copy (specs/studio-workbench.md "Design
 * versions"): only saved, locked versions go to printed sheets and to integrations
 * export; the working copy prints with an UNRELEASED mark and cannot export.
 *
 * Same contract as every other adapter: no URL and no `fetch` in this
 * package — the host loads a revision however it keeps them.
 */

import type { CableDesign, Db } from '@wirehub/model';
import type { RevisionRow } from '@wirehub/docs';
import type { DepictionSource } from '@wirehub/render-svg';

/** What the editor has open: the working copy, or one saved revision. */
export type ReleaseShowing =
  | { kind: 'working'; unreleased: boolean; basedOnRev?: number }
  | { kind: 'rev'; rev: number };

export interface DocumentRelease {
  /** saved revision numbers, ascending */
  revisions: readonly number[];
  /** the saved revisions as the drawing's revision table prints them (note, date, who), by revision, ascending; absent: the table shows the numbers alone */
  rows?: readonly RevisionRow[];
  showing: ReleaseShowing;
  /**
   * a saved revision's design, resolved against its frozen definitions, and
   * the artwork it was saved with (absent: the page's own depictions)
   */
  load: (rev: number) => Promise<{ design: CableDesign; db: Db; depictions?: DepictionSource } | undefined>;
}

/** What the Documents view prints: the working copy or a saved revision. */
export type DocumentTarget = 'working' | number;

/** Default: the revision being viewed; else the latest saved one; else the working copy. */
export function defaultDocumentTarget(release: DocumentRelease | undefined): DocumentTarget {
  if (release === undefined) return 'working';
  if (release.showing.kind === 'rev') return release.showing.rev;
  const latest = release.revisions[release.revisions.length - 1];
  return latest ?? 'working';
}

/** The title-block revision for a target: the saved number, or a dash for the working copy. */
export function targetRevision(target: DocumentTarget): string {
  return target === 'working' ? '—' : String(target);
}

/** The drawing's revision table for a target: the saved revisions up to it, a working copy as its own row. */
export function revisionTable(release: DocumentRelease | undefined, target: DocumentTarget): RevisionRow[] | undefined {
  if (release === undefined) return undefined;
  const known = new Map((release.rows ?? []).map((r) => [r.rev, r]));
  const rows = release.revisions
    .filter((n) => target === 'working' || n <= target)
    .map((n) => known.get(String(n)) ?? { rev: String(n), description: `Revision ${n}` });
  return target === 'working' ? [...rows, { rev: '—', description: 'Working copy, not released' }] : rows;
}

export { withUnreleasedMark } from '@wirehub/docs';
