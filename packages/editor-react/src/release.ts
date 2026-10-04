/**
 * What the Documents view needs to print a **saved revision** rather than the
 * working copy (specs/studio-workbench.md "Design
 * versions"): only saved, locked versions go to printed sheets and to integrations
 * export; the working copy prints with an UNRELEASED mark and cannot export.
 *
 * Same contract as every other adapter: no URL and no `fetch` in this
 * package — the host loads a revision however it keeps them.
 */

import type { CableDesign, Db } from '@cable-studio/model';
import type { DepictionSource } from '@cable-studio/render-svg';

/** What the editor has open: the working copy, or one saved revision. */
export type ReleaseShowing =
  | { kind: 'working'; unreleased: boolean; basedOnRev?: number }
  | { kind: 'rev'; rev: number };

export interface DocumentRelease {
  /** saved revision numbers, ascending */
  revisions: readonly number[];
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

/**
 * Stamp a rendered document UNRELEASED: a large diagonal mark on every page
 * (a fixed element repeats per printed page). Inserted before `</body>`, so
 * the document's own markup and stylesheet are untouched.
 */
export function withUnreleasedMark(html: string): string {
  const mark =
    '<div class="cs-unreleased-mark" aria-hidden="true" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:2147483647">' +
    '<span style="transform:rotate(-28deg);font:700 88px/1 system-ui,sans-serif;letter-spacing:.12em;color:rgba(200,30,30,.16);border:6px solid rgba(200,30,30,.16);padding:6px 28px;border-radius:8px;-webkit-print-color-adjust:exact;print-color-adjust:exact">UNRELEASED</span>' +
    '</div>';
  const at = html.lastIndexOf('</body>');
  return at < 0 ? `${html}${mark}` : `${html.slice(0, at)}${mark}${html.slice(at)}`;
}
