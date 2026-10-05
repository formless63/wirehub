/**
 * SVG to pixels, and pixels to PDF pages: the headless path for the documents
 * that are drawings already (the schematic, the drawing sheet, the label
 * sheet). Node only: it loads `@resvg/resvg-js`, the SVG rasteriser the Library's 3D
 * board textures already use, with the two Liberation Sans faces the sheets are
 * set in (`packages/docs/fonts`) and no system fonts, so the output does not
 * depend on the machine.
 */

import { fileURLToPath } from 'node:url';

import type { PdfPage } from './pdf.ts';

const FONT_FILES = ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf'].map((name) => fileURLToPath(new URL(`../../../../packages/docs/fonts/${name}`, import.meta.url)));

export interface RasterPage {
  svg: string;
  /** the PDF page size (points); the image is scaled to fit inside `margin` and centred */
  width: number;
  height: number;
  margin?: number;
  /** pixels per inch of the page (default 200) */
  dpi?: number;
}

export async function svgToPdfPage(page: RasterPage): Promise<PdfPage> {
  const { Resvg } = await import('@resvg/resvg-js');
  const margin = page.margin ?? 0;
  const dpi = page.dpi ?? 200;
  const probe = new Resvg(page.svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Liberation Sans' } });
  const aspect = probe.width / probe.height;
  const boxW = page.width - 2 * margin;
  const boxH = page.height - 2 * margin;
  const drawW = Math.min(boxW, boxH * aspect);
  const drawH = drawW / aspect;
  const pixelWidth = Math.max(1, Math.round((drawW / 72) * dpi));
  const resvg = new Resvg(page.svg, {
    fitTo: { mode: 'width', value: pixelWidth },
    background: '#ffffff',
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Liberation Sans' },
  });
  const image = resvg.render();
  const rgba = image.pixels;
  const rgb = new Uint8Array(image.width * image.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i] as number;
    rgb[j + 1] = rgba[i + 1] as number;
    rgb[j + 2] = rgba[i + 2] as number;
  }
  return {
    kind: 'image',
    width: page.width,
    height: page.height,
    at: { x: (page.width - drawW) / 2, y: (page.height - drawH) / 2, w: drawW, h: drawH },
    pixelWidth: image.width,
    pixelHeight: image.height,
    rgb,
  };
}
