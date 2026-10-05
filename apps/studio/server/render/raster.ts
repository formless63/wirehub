/**
 * SVG to pixels, and pixels to PDF pages: the headless path for the documents
 * that are drawings already (the schematic, the drawing sheet, the label
 * sheet). Node only: it loads `@resvg/resvg-js`, the SVG rasteriser the Library's 3D
 * board textures already use, with the two Liberation Sans faces the sheets are
 * set in (`packages/docs/fonts`) and no system fonts, so the output does not
 * depend on the machine.
 */

import { fileURLToPath } from 'node:url';

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrandFont } from '@wirehub/docs';

import type { PdfPage } from './pdf.ts';

const FONT_FILES = ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf'].map((name) => fileURLToPath(new URL(`../../../../packages/docs/fonts/${name}`, import.meta.url)));

/**
 * The hub's own typeface for the rasteriser: it reads font files, not the sheet's `@font-face`, so the
 * font is written once (named by its hash) and the sheet's alias is replaced by the family the font
 * names. A face the rasteriser cannot read (WOFF2) leaves the bundled sans.
 */
function brandForRaster(svg: string, brand: BrandFont | undefined): { svg: string; files: string[] } {
  if (brand === undefined || !brand.regular.rasterizable) return { svg, files: [] };
  const dir = join(tmpdir(), 'wirehub-brand-fonts');
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const face of [brand.regular, brand.bold]) {
    if (face === undefined || !face.rasterizable) continue;
    const bytes = Buffer.from(face.base64, 'base64');
    const path = join(dir, `${createHash('sha256').update(bytes).digest('hex')}.${face.mime === 'font/otf' ? 'otf' : 'ttf'}`);
    if (!existsSync(path)) writeFileSync(path, bytes);
    files.push(path);
  }
  const family = brand.regular.family.replace(/'/g, '');
  return { svg: svg.split("'CS Brand'").join(`'${family}'`), files };
}

export interface RasterPage {
  /** the hub's own typeface, when branding set one (the sheet names it `CS Brand`) */
  brand?: BrandFont;
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
  const branded = brandForRaster(page.svg, page.brand);
  const fontFiles = [...FONT_FILES, ...branded.files];
  const probe = new Resvg(branded.svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Liberation Sans' } });
  const aspect = probe.width / probe.height;
  const boxW = page.width - 2 * margin;
  const boxH = page.height - 2 * margin;
  const drawW = Math.min(boxW, boxH * aspect);
  const drawH = drawW / aspect;
  const pixelWidth = Math.max(1, Math.round((drawW / 72) * dpi));
  const resvg = new Resvg(branded.svg, {
    fitTo: { mode: 'width', value: pixelWidth },
    background: '#ffffff',
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Liberation Sans' },
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

/**
 * An SVG as a PNG of `widthPx` pixels, transparent background (an uploaded
 * logo, cs-vzv). Throws a sentence when the SVG cannot be drawn. The same
 * rasteriser and fonts as the PDF pages; nothing external is fetched.
 */
export async function svgToPng(svg: string, widthPx: number): Promise<Uint8Array> {
  const { Resvg } = await import('@resvg/resvg-js');
  let resvg: InstanceType<typeof Resvg>;
  try {
    resvg = new Resvg(svg, { fitTo: { mode: 'width', value: widthPx }, font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Liberation Sans' } });
  } catch (error) {
    throw new Error(`That SVG could not be drawn: ${error instanceof Error ? error.message : String(error)}`);
  }
  return new Uint8Array(resvg.render().asPng());
}
