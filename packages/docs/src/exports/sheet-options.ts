/**
 * The sheet settings of a drawing sidecar as the renderers' options — one
 * function for the Documents view, the server's document routes and the CLI,
 * so a sheet prints the same wherever it is rendered.
 */

import type { CableDesign } from '@wirehub/model';

import type { PaperId } from '../frame/paper.ts';

import type { DocumentIdentity } from '../build-sheet.ts';
import type { DrawingMeta, SheetSettings } from '../drawing/model.ts';
import { escapeHtml } from '../text.ts';

/**
 * The sheet options a design's drawing sidecar asks for
 * as renderer options. The document number defaults to the part number — the
 * owners use part numbers as document numbers — and the revision to the
 * drawing's. `today` is only read when the stamp is on, so the renderers stay
 * deterministic unless someone asked for a date.
 */
export function sheetRenderOptions(
  meta: DrawingMeta,
  design: CableDesign,
  today: () => string,
): { paper?: PaperId; generatedAt?: string; document?: DocumentIdentity } {
  const sheet: SheetSettings = meta.sheet ?? {};
  const number = sheet.number ?? meta.partNumber ?? design.productRef;
  const revision = sheet.revision ?? meta.revision;
  const document: DocumentIdentity = {
    ...(number === undefined ? {} : { number }),
    ...(revision === undefined ? {} : { revision }),
    ...(sheet.status === undefined ? {} : { status: sheet.status }),
  };
  return {
    ...(sheet.paper === undefined ? {} : { paper: sheet.paper }),
    ...(sheet.stampDate === true ? { generatedAt: today() } : {}),
    ...(Object.keys(document).length === 0 ? {} : { document }),
  };
}

/**
 * Stamp a rendered HTML document with its state, in the corner: a small
 * bordered word on the top edge of the page, on every printed page (a fixed
 * element repeats per page). For a document that did not carry its state
 * itself; the sheets made by this package print the state in their title block
 * and stamp it from there, so they need no help. Inserted before `</body>`,
 * so the document's own markup and stylesheet are untouched.
 */
export function withUnreleasedMark(html: string, label = 'UNRELEASED'): string {
  const mark =
    '<div class="cs-state-stamp" aria-hidden="true" style="position:fixed;right:11mm;top:3mm;z-index:2147483647;pointer-events:none">' +
    '<span style="display:inline-block;box-sizing:border-box;height:4.6mm;padding:0 2mm;border:0.75pt solid #8f1d1d;background:#fff;color:#8f1d1d;font:500 7pt/4mm \'IBM Plex Mono\',ui-monospace,Menlo,monospace;letter-spacing:.06em;-webkit-print-color-adjust:exact;print-color-adjust:exact">' +
    escapeHtml(label) +
    '</span></div>';
  const at = html.lastIndexOf('</body>');
  return at < 0 ? `${html}${mark}` : `${html.slice(0, at)}${mark}${html.slice(at)}`;
}
