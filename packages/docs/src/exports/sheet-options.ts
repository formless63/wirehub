/**
 * The sheet settings of a drawing sidecar as the renderers' options — one
 * function for the Documents view, the server's document routes and the CLI,
 * so a sheet prints the same wherever it is rendered.
 */

import type { CableDesign } from '@wirehub/model';

import type { DocumentIdentity } from '../build-sheet.ts';
import type { DrawingMeta, SheetSettings } from '../drawing/model.ts';

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
): { paper?: 'A4' | 'letter'; generatedAt?: string; document?: DocumentIdentity } {
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
