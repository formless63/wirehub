/**
 * The schematic inside the shared sheet frame. The schematic itself is drawn by
 * `@wirehub/render-svg` and owns no frame; this puts it on a sheet: the same
 * border, title block and state stamp as every other document, on the sheet's
 * paper, the page turned to suit the drawing (a wide schematic lands
 * landscape, a tall one portrait). The text stays text: a PDF made from it is
 * vector and searchable.
 */

import type { CableDesign, Db } from '@wirehub/model';

import { benchOptions, scopeSvgStyles, type BuildSheetOptions } from './build-sheet.ts';
import { frameFontStyle, framedSvg, type SheetFrameSpec } from './frame/index.ts';
import { sheetFrameFor } from './sheet-frame.ts';

/** The schematic's viewBox size, or `undefined` when the markup has none. */
export function svgSize(svg: string): { width: number; height: number } | undefined {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const vb = /viewBox="([^"]+)"/.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (vb !== undefined && vb.length === 4 && vb.every((v) => Number.isFinite(v)) && (vb[2] as number) > 0 && (vb[3] as number) > 0) return { width: vb[2] as number, height: vb[3] as number };
  return undefined;
}

/** The schematic's frame: full title block, on the paper, turned to the drawing's shape. */
export function schematicFrame(design: CableDesign, db: Db, svg: string, options: BuildSheetOptions = {}): SheetFrameSpec {
  const size = svgSize(svg);
  const orientation = size === undefined || size.width >= size.height ? 'landscape' : 'portrait';
  return sheetFrameFor(design, db, benchOptions(options), 'SCHEMATIC', orientation);
}

/** Put a schematic SVG on a framed sheet: one SVG document, the paper's size, the schematic fitted inside the border. */
export function framedSchematicSvg(svg: string, spec: SheetFrameSpec): string {
  const size = svgSize(svg) ?? { width: 297, height: 210 };
  // the schematic's own stylesheet is scoped to it, so its `text` rules cannot restyle the frame's; its root becomes a nested svg in its own units
  const scoped = scopeSvgStyles(svg);
  const nested = scoped.replace(/<svg\b[^>]*>/, (root) => {
    const kept = [/viewBox="[^"]*"/.exec(root)?.[0], /class="[^"]*"/.exec(root)?.[0]].filter((a): a is string => a !== undefined);
    return `<svg x="0" y="0" width="${size.width}" height="${size.height}" ${kept.join(' ')}>`;
  });
  return framedSvg(spec, { markup: nested, width: size.width, height: size.height }, { fonts: false, head: frameFontStyle() });
}
