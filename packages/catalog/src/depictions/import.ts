/**
 * `import-depiction` — normalising whatever artwork the owner has into the
 * house style.
 *
 * The spec's input ladder (`specs/depictions.md` §"Input ladder") is *accept
 * downward, recommend upward*: take the file that exists, say plainly what a
 * better one would have bought. This module is the part of that with no IO in
 * it, so every rule below is unit-testable:
 *
 *  - **SVG** is the one format normalised in full: sanitised (no scripts, no
 *    stylesheets, no external references, no webfonts), repainted monochrome
 *    on `currentColor`, snapped to the house stroke weights, and rewrapped
 *    mm-true so `mmPerUnit` is always 1 on the way out.
 *  - **PNG / JPEG** are copied byte-for-byte — a raster tier is a photograph
 *    of the truth, and re-encoding it only loses. Their pixel size is read
 *    straight from the file header (both are a few bytes of framing, no
 *    decoder needed) and the caller supplies the scale.
 *  - **DXF, STEP/STL, PDF and everything else** are refused with instructions.
 *    Each would need a parser this package is not allowed to grow (zero
 *    runtime dependencies), and a half-working import that silently drops
 *    geometry is worse than no import at all.
 *
 * Nothing here throws on bad input: every problem is a `warnings` entry or an
 * `error` on the result.
 */

import {
  HOUSE_STYLE,
  round,
  type DepictionAsset,
  type SourceKind,
} from './model.ts';
import { escapeXml } from './svg.ts';

/* ------------------------------------------------------------------ *
 * Format classification
 * ------------------------------------------------------------------ */

export type ImportFormat = 'svg' | 'png' | 'jpeg' | 'unsupported';

export interface FormatVerdict {
  format: ImportFormat;
  extension: string;
  /** For `unsupported`: why, and what to do instead. */
  guidance?: string[];
}

/**
 * Formats that are a real rung of the ladder but need a parser we will not
 * write, keyed by extension. The message is the whole point: it names the rung
 * and the one command that gets the file onto a rung we do support.
 */
const REFUSED: Readonly<Record<string, string[]>> = {
  '.dxf': [
    'DXF is not supported yet (ladder rung 2 · vector CAD).',
    'A DXF reader is a real parser, and this package carries zero runtime dependencies.',
    'Do this instead: open the file in the CAD tool that made it (QCAD, LibreCAD, Inkscape,',
    'or KiCad for a board outline) and export plain SVG, then re-run this command on the .svg.',
    'Set the export units to millimetres so the scale comes across on its own.',
  ],
  '.dwg': [
    'DWG is not supported yet (ladder rung 2 · vector CAD), and it is a proprietary',
    'binary format. Export DXF or — better — plain SVG in millimetres, then import that.',
  ],
  '.step': [
    'STEP is not supported yet (ladder rung 3 · solid model, explicitly deferred in',
    'specs/depictions.md). Turning a solid into line art needs an orthographic projection',
    'pass; the racc/custom blender-container approach is the reference if it is ever built.',
    'Do this instead: take an orthographic screenshot or an SVG export from the CAD viewer',
    'and import that, or hand-draw the face view as SVG.',
  ],
  '.stp': [
    'STEP is not supported yet (ladder rung 3 · solid model, explicitly deferred).',
    'Export an orthographic view as SVG or PNG and import that instead.',
  ],
  '.stl': [
    'STL is not supported yet (ladder rung 3 · mesh). A mesh has no edges to trace and',
    'no units; projecting one to line art is deferred. Export an orthographic view as',
    'SVG or PNG and import that instead.',
  ],
  '.iges': [
    'IGES is not supported yet (ladder rung 3 · solid model). Export SVG or PNG instead.',
  ],
  '.igs': [
    'IGES is not supported yet (ladder rung 3 · solid model). Export SVG or PNG instead.',
  ],
  '.pdf': [
    'PDF is not supported yet (ladder rung 4 · datasheet page).',
    'A PDF page needs a full content-stream parser, which this package will not grow.',
    'Do this instead: if the page is vector, export it to SVG (Inkscape opens PDF pages,',
    'and `pdftocairo -svg -f N -l N file.pdf out` does it headlessly) and import the SVG —',
    'that keeps you on rung 2. If it is a scan, export the page to PNG at 300 dpi or more,',
    'crop it to the part, and import that with --width-mm.',
  ],
  '.webp': [
    'WebP is not supported yet: its header comes in three variants and reading the pixel',
    'size reliably needs more framing code than the format earns.',
    'Do this instead: convert to PNG (`cwebp`/`dwebp`, or any image editor) and import that.',
  ],
  '.gif': ['GIF is not a depiction format. Export PNG and import that.'],
  '.bmp': ['BMP is not supported. Export PNG and import that.'],
  '.tif': ['TIFF is not supported. Export PNG and import that.'],
  '.tiff': ['TIFF is not supported. Export PNG and import that.'],
};

export function classifyImport(fileName: string): FormatVerdict {
  const dot = fileName.lastIndexOf('.');
  const extension = dot === -1 ? '' : fileName.slice(dot).toLowerCase();
  if (extension === '.svg') return { format: 'svg', extension };
  if (extension === '.png') return { format: 'png', extension };
  if (extension === '.jpg' || extension === '.jpeg') return { format: 'jpeg', extension };
  const guidance = REFUSED[extension];
  return {
    format: 'unsupported',
    extension,
    guidance: guidance ?? [
      `'${extension === '' ? fileName : extension}' is not a format this importer knows.`,
      'Supported today: .svg (normalised in full), .png and .jpg (copied, with a declared scale).',
      'Everything else: get it to SVG if it is vector, PNG if it is a picture, then re-run.',
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Raster headers
 * ------------------------------------------------------------------ */

export interface PixelSize {
  width: number;
  height: number;
}

/** PNG: an 8-byte signature, then an IHDR chunk whose first 8 bytes are w/h. */
export function pngSize(bytes: Uint8Array): PixelSize | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return undefined;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return undefined;
  }
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return undefined;
  const read = (at: number): number =>
    ((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
  const width = read(16) >>> 0;
  const height = read(20) >>> 0;
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * JPEG: walk the marker chain to the first start-of-frame (`SOF0`…`SOF15`,
 * skipping the four that are not frame headers) and read its 16-bit h/w.
 */
export function jpegSize(bytes: Uint8Array): PixelSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    let marker = bytes[at + 1] ?? 0;
    // 0xff fill bytes may pad a marker
    let cursor = at + 1;
    while (marker === 0xff && cursor + 1 < bytes.length) {
      cursor += 1;
      marker = bytes[cursor] ?? 0;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at = cursor + 1;
      continue;
    }
    const length = ((bytes[cursor + 1] ?? 0) << 8) | (bytes[cursor + 2] ?? 0);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      const height = ((bytes[cursor + 4] ?? 0) << 8) | (bytes[cursor + 5] ?? 0);
      const width = ((bytes[cursor + 6] ?? 0) << 8) | (bytes[cursor + 7] ?? 0);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (length < 2) return undefined;
    at = cursor + 1 + length;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Lengths
 * ------------------------------------------------------------------ */

/** CSS absolute units, in millimetres per unit. `px` is the CSS pixel, 1/96 in. */
const UNIT_MM: Readonly<Record<string, number>> = {
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: 25.4 / 96,
};

export interface Length {
  value: number;
  unit: string;
  /** Millimetres, when the unit is an absolute one. */
  mm?: number;
}

/** Parse an SVG length (`27.42mm`, `1024`, `8in`, `50%`). */
export function parseLength(raw: string | undefined): Length | undefined {
  if (raw === undefined) return undefined;
  const match = /^\s*([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*([a-zA-Z%]*)\s*$/.exec(raw);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  const perUnit = unit === '' ? undefined : UNIT_MM[unit];
  return {
    value,
    unit,
    ...(perUnit === undefined ? {} : { mm: value * perUnit }),
  };
}

/* ------------------------------------------------------------------ *
 * SVG normalisation
 * ------------------------------------------------------------------ */

export interface NormalizeSvgOptions {
  /** Title for the emitted document. */
  title: string;
  /** `<desc>` / provenance line. */
  description: string;
  /** Millimetres per source user unit, when the file does not say. */
  mmPerUnit?: number;
  /** Total width in millimetres, when the file does not say. */
  widthMm?: number;
  /** Leave stroke weights exactly as the source had them. */
  keepStrokeWidths?: boolean;
}

export interface NormalizeSvgResult {
  /** The normalised, mm-true document — or `undefined` when it cannot be made. */
  svg?: string;
  /** Frame in artwork units; the output is mm-true, so these are millimetres. */
  widthUnits?: number;
  heightUnits?: number;
  /** Always 1 for a normalised SVG: the content is scaled to millimetres. */
  mmPerUnit?: number;
  /** How the scale was established, for the `src` citation. */
  scaleSource?: 'declared' | 'width-mm' | 'mm-per-unit';
  warnings: string[];
  error?: string;
}

/** Elements whose whole subtree is dropped on import. */
const STRIP_ELEMENTS = [
  'script',
  'style',
  'metadata',
  'foreignObject',
  'image',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
  'audio',
  'video',
  'iframe',
];

function stripElements(svg: string): { body: string; removed: string[] } {
  let out = svg;
  const removed: string[] = [];
  for (const name of STRIP_ELEMENTS) {
    const selfClosing = new RegExp(`<${name}\\b[^>]*/>`, 'gi');
    const paired = new RegExp(`<${name}\\b[\\s\\S]*?</${name}\\s*>`, 'gi');
    const before = out;
    out = out.replace(selfClosing, '').replace(paired, '');
    if (out !== before) removed.push(name);
  }
  return { body: out, removed };
}

const KEEP_PAINT = new Set(['none', 'currentcolor', 'inherit', 'transparent']);

/** Elements whose `fill` is the mark itself, not a filled area. */
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textpath']);

/** Nearest house stroke weight, in millimetres. */
export function houseStrokeWidth(mm: number): number {
  const options = [
    HOUSE_STYLE.strokeDetail,
    HOUSE_STYLE.strokePad,
    HOUSE_STYLE.strokeOutline,
  ];
  let best = options[0] ?? HOUSE_STYLE.strokePad;
  for (const option of options) {
    if (Math.abs(option - mm) < Math.abs(best - mm)) best = option;
  }
  return best;
}

/**
 * Sanitise and repaint the body of an SVG.
 *
 * The pass walks tags rather than raw attributes, because a rule like "`fill`
 * means the mark on a `<text>` and a filled *area* everywhere else" cannot be
 * expressed without knowing the element. The house output is **line art**: the
 * area fills go, the outlines stay and paint in one ink.
 *
 * Exported for its own tests — the removals here are the security- and
 * print-relevant half of an import.
 */
export function sanitizeSvgBody(
  body: string,
  options: { mmPerUnit: number; keepStrokeWidths?: boolean },
): { body: string; warnings: string[] } {
  const warnings: string[] = [];
  const stripped = stripElements(body);
  if (stripped.removed.length > 0) {
    warnings.push(
      `removed ${stripped.removed.join(', ')} element(s) — assets must be inert and self-contained`,
    );
  }

  const counts = {
    handlers: 0,
    external: 0,
    styles: 0,
    repainted: 0,
    unfilled: 0,
    fonts: 0,
    snapped: 0,
  };

  const out = stripped.body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(
      /<([a-zA-Z][\w:.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g,
      (_match, rawName: string, rawAttrs: string, close: string) => {
        const name = rawName.toLowerCase();
        const isText = TEXT_ELEMENTS.has(name);
        const kept: string[] = [];
        for (const attr of rawAttrs.matchAll(/([a-zA-Z][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
          const key = (attr[1] ?? '').toLowerCase();
          const value = attr[2] ?? '';
          if (/^on[a-z]+$/.test(key)) {
            counts.handlers += 1;
            continue;
          }
          if (key === 'class') continue;
          if (key === 'style') {
            counts.styles += 1;
            continue;
          }
          if (key === 'href' || key === 'xlink:href') {
            if (!value.startsWith('#') && !value.startsWith('data:')) {
              counts.external += 1;
              continue;
            }
            kept.push(`${key}="${value}"`);
            continue;
          }
          if (key === 'font-family') {
            counts.fonts += 1;
            kept.push('font-family="sans-serif"');
            continue;
          }
          if (key === 'fill') {
            const paint = value.trim().toLowerCase();
            if (KEEP_PAINT.has(paint)) {
              kept.push(`fill="${paint === 'transparent' ? 'none' : value}"`);
            } else if (isText) {
              counts.repainted += 1;
              kept.push('fill="currentColor"');
            } else {
              counts.unfilled += 1;
              kept.push('fill="none"');
            }
            continue;
          }
          if (key === 'stroke') {
            const paint = value.trim().toLowerCase();
            if (KEEP_PAINT.has(paint) || paint.startsWith('url(')) {
              kept.push(`stroke="${paint.startsWith('url(') || paint === 'transparent' ? 'none' : value}"`);
            } else {
              counts.repainted += 1;
              kept.push('stroke="currentColor"');
            }
            continue;
          }
          if (key === 'stroke-width' && options.keepStrokeWidths !== true) {
            const length = parseLength(value);
            if (length === undefined) {
              kept.push(`stroke-width="${value}"`);
              continue;
            }
            const house = houseStrokeWidth(length.value * options.mmPerUnit);
            const snapped = round(house / options.mmPerUnit);
            if (snapped !== length.value) counts.snapped += 1;
            kept.push(`stroke-width="${snapped}"`);
            continue;
          }
          kept.push(`${key}="${value}"`);
        }
        return `<${rawName}${kept.length === 0 ? '' : ` ${kept.join(' ')}`}${close}>`;
      },
    );

  if (counts.handlers > 0) warnings.push(`removed ${counts.handlers} event-handler attribute(s)`);
  if (counts.external > 0) {
    warnings.push(
      `removed ${counts.external} external reference(s) — an asset may not reach outside itself`,
    );
  }
  if (counts.styles > 0) {
    warnings.push(
      `removed ${counts.styles} inline style attribute(s) — presentation attributes carry the house style instead`,
    );
  }
  if (counts.fonts > 0) {
    warnings.push(
      `re-set ${counts.fonts} font-family to the generic sans stack — no asset may carry a webfont`,
    );
  }
  if (counts.repainted > 0) {
    warnings.push(`repainted ${counts.repainted} stroke/text fill(s) to currentColor — assets are monochrome-safe`);
  }
  if (counts.unfilled > 0) {
    warnings.push(
      `emptied ${counts.unfilled} area fill(s) — the house style is line art, so shapes keep their outline and lose their tone`,
    );
  }
  if (counts.snapped > 0) {
    warnings.push(
      `snapped ${counts.snapped} stroke-width value(s) to the house weights (${HOUSE_STYLE.strokeDetail} / ${HOUSE_STYLE.strokePad} / ${HOUSE_STYLE.strokeOutline} mm)`,
    );
  }

  return { body: out.replace(/>\s*\n\s*</g, '>\n<').trim(), warnings };
}

/** The attributes of the outermost `<svg>` element. */
function rootAttributes(source: string): Record<string, string> | undefined {
  const open = /<svg\b([^>]*)>/i.exec(source);
  if (open === null) return undefined;
  const attributes: Record<string, string> = {};
  for (const match of (open[1] ?? '').matchAll(/([a-zA-Z:_-]+)\s*=\s*"([^"]*)"/g)) {
    attributes[(match[1] ?? '').toLowerCase()] = match[2] ?? '';
  }
  return attributes;
}

function svgInner(source: string): string {
  const open = /<svg\b[^>]*>/i.exec(source);
  if (open === null) return source;
  const start = open.index + open[0].length;
  const end = source.lastIndexOf('</svg');
  return end === -1 || end < start ? source.slice(start) : source.slice(start, end);
}

/**
 * Normalise an imported SVG into the house document: mm-true, monochrome,
 * self-contained, one wrapping `<g>` that carries the source's own origin
 * offset and the scale into millimetres.
 */
export function normalizeSvg(
  source: string,
  options: NormalizeSvgOptions,
): NormalizeSvgResult {
  const warnings: string[] = [];
  const attributes = rootAttributes(source);
  if (attributes === undefined) {
    return { warnings, error: 'no <svg> element found — is this really an SVG file?' };
  }

  /* --- the source's own frame, in user units --------------------- */
  let minX = 0;
  let minY = 0;
  let unitsWide: number | undefined;
  let unitsHigh: number | undefined;
  const viewBox = attributes['viewbox'];
  if (viewBox !== undefined) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      minX = parts[0] ?? 0;
      minY = parts[1] ?? 0;
      unitsWide = parts[2];
      unitsHigh = parts[3];
    }
  }
  const widthAttr = parseLength(attributes['width']);
  const heightAttr = parseLength(attributes['height']);
  if (unitsWide === undefined || unitsHigh === undefined) {
    unitsWide = widthAttr?.value;
    unitsHigh = heightAttr?.value;
  }
  if (unitsWide === undefined || unitsHigh === undefined || unitsWide <= 0 || unitsHigh <= 0) {
    return {
      warnings,
      error:
        'the file declares no usable frame (needs a viewBox, or width and height) — nothing can be scaled without one',
    };
  }

  /* --- millimetres per user unit --------------------------------- */
  let mmPerUnit: number | undefined;
  let scaleSource: NormalizeSvgResult['scaleSource'];
  if (options.mmPerUnit !== undefined && options.mmPerUnit > 0) {
    mmPerUnit = options.mmPerUnit;
    scaleSource = 'mm-per-unit';
  } else if (options.widthMm !== undefined && options.widthMm > 0) {
    mmPerUnit = options.widthMm / unitsWide;
    scaleSource = 'width-mm';
  } else if (widthAttr?.mm !== undefined && widthAttr.mm > 0) {
    mmPerUnit = widthAttr.mm / unitsWide;
    scaleSource = 'declared';
    if (widthAttr.unit === 'px' || widthAttr.unit === '') {
      warnings.push(
        'scale taken from a pixel width (1 px = 1/96 in) — pass --width-mm if the drawing is not at CSS pixel scale',
      );
    }
  }
  if (mmPerUnit === undefined) {
    return {
      warnings,
      error:
        'cannot establish a millimetre scale: the file has no absolute width. Pass --width-mm <mm> (the real width of the part) or --mm-per-unit <mm>.',
    };
  }

  /* --- sanitise and rewrap --------------------------------------- */
  const sanitized = sanitizeSvgBody(svgInner(source), {
    mmPerUnit,
    ...(options.keepStrokeWidths === undefined
      ? {}
      : { keepStrokeWidths: options.keepStrokeWidths }),
  });
  warnings.push(...sanitized.warnings);

  const widthUnits = round(unitsWide * mmPerUnit);
  const heightUnits = round(unitsHigh * mmPerUnit);
  const transform = `scale(${round(mmPerUnit)}) translate(${round(-minX)} ${round(-minY)})`;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthUnits} ${heightUnits}" width="${widthUnits}mm" height="${heightUnits}mm">`,
    `  <title>${escapeXml(options.title)}</title>`,
    `  <desc>${escapeXml(options.description)}</desc>`,
    `  <g fill="none" stroke="currentColor" stroke-width="${round(HOUSE_STYLE.strokePad / mmPerUnit)}" stroke-linecap="round" stroke-linejoin="round">`,
    `    <g transform="${transform}">`,
    ...sanitized.body.split('\n').map((line) => `      ${line.trim()}`),
    '    </g>',
    '  </g>',
    '</svg>',
  ];

  return {
    svg: `${lines.join('\n')}\n`,
    widthUnits,
    heightUnits,
    mmPerUnit: 1,
    ...(scaleSource === undefined ? {} : { scaleSource }),
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * meta.json merge
 * ------------------------------------------------------------------ */

/**
 * Merge one imported view into a definition's manifest.
 *
 * `pinAnchors` only ever holds anchors that really exist — an anchor with no
 * position is not data, it is a to-do, and writing one would fail validation.
 * The to-do goes in `pinAnchorsTodo`: every terminal of the target definition
 * that is still unanchored, so a human (or the future editor) can see exactly
 * what is left without deriving it. Validation ignores the key, and it
 * disappears on its own once the last anchor lands.
 */
export function mergeDepictionMeta(
  existing: Record<string, unknown> | undefined,
  input: {
    defId: string;
    view: string;
    asset: DepictionAsset;
    /** Every terminal id the definition exposes, or `undefined` when unknown. */
    expectedIds?: readonly string[];
    /** other names an expected id answers to — anchored under any, it is not a to-do (50a.24) */
    expectedAliases?: Readonly<Record<string, readonly string[]>>;
    src: string;
  },
): Record<string, unknown> {
  const base = existing ?? {};
  const views: Record<string, unknown> = {
    ...((base['views'] as Record<string, unknown> | undefined) ?? {}),
  };
  views[input.view] = input.asset;
  const sortedViews: Record<string, unknown> = {};
  for (const name of Object.keys(views).sort()) sortedViews[name] = views[name];

  const anchors = (base['pinAnchors'] as Record<string, unknown> | undefined) ?? {};
  const sortedAnchors: Record<string, unknown> = {};
  for (const id of Object.keys(anchors).sort()) sortedAnchors[id] = anchors[id];

  const anchorFrame =
    typeof base['anchorFrame'] === 'string' && sortedViews[base['anchorFrame']] !== undefined
      ? base['anchorFrame']
      : input.asset.mirrorOf === undefined
        ? input.view
        : ((base['anchorFrame'] as string | undefined) ?? input.view);

  const todo = (input.expectedIds ?? [])
    .filter((id) => [id, ...(input.expectedAliases?.[id] ?? [])].every((name) => sortedAnchors[name] === undefined))
    .sort();

  return {
    defId: input.defId,
    views: sortedViews,
    pinAnchors: sortedAnchors,
    ...(todo.length === 0 ? {} : { pinAnchorsTodo: todo }),
    anchorFrame,
    src: typeof base['src'] === 'string' && base['src'] !== '' ? base['src'] : input.src,
  };
}

/* ------------------------------------------------------------------ *
 * One import, decided
 * ------------------------------------------------------------------ */

/**
 * How the citations an import writes name the thing that performed it and the
 * options it offers.
 *
 * The rules below are shared by the CLI and by the studio's upload endpoint,
 * but the *sentences* they leave in `src` have to name whichever door the file
 * came through — a `meta.json` that tells a reader to "pass --src next time"
 * when the file was dropped onto a web page is provenance that lies. So the
 * voice is a parameter and the rules are not.
 */
export interface ImportVoice {
  /** what performed the import, as the citation names it */
  importer: string;
  /** what the caller calls "the real width in millimetres" */
  widthOption: string;
  /** what the caller calls the provenance field */
  srcOption: string;
  /** the two "pass one of these" lines shown when raster art has no scale */
  scaleGuidance: string[];
}

/** The command line's voice — the wording `import-depiction` has always used. */
export const CLI_VOICE: ImportVoice = {
  importer: 'scripts/import-depiction.ts',
  widthOption: '--width-mm',
  srcOption: '--src',
  scaleGuidance: [
    '  --width-mm <mm>      the real width of the part in the picture (easiest)',
    '  --mm-per-unit <mm>   millimetres per pixel',
  ],
};

export interface DepictionImportRequest {
  /** the uploaded file's own name — the extension classifies it, the stem cites it */
  fileName: string;
  /** the file's bytes; SVG is decoded as UTF-8 */
  bytes: Uint8Array;
  defId: string;
  view: string;
  /** name to store the asset under; defaults to `<view><ext>` */
  outName?: string;
  /** real width of the part in millimetres */
  widthMm?: number;
  /** millimetres per source unit / pixel */
  mmPerUnit?: number;
  sourceKind?: SourceKind;
  /** provenance the caller supplied; absent, a citation is composed */
  src?: string;
  mirrorOf?: string;
  mirrorAxis?: 'x' | 'y';
  keepStrokeWidths?: boolean;
  /** every terminal id the definition exposes, for `pinAnchorsTodo` */
  expectedIds?: readonly string[];
  /** other names an expected id answers to (a connector pin's aliases) */
  expectedAliases?: Readonly<Record<string, readonly string[]>>;
  /** the manifest already on disk, so this view merges rather than replaces */
  existingMeta?: Record<string, unknown>;
  voice?: ImportVoice;
}

/** Why an import cannot happen, in words the refusal shows verbatim. */
export interface DepictionImportRefusal {
  ok: false;
  reason: 'unsupported-format' | 'unreadable-header' | 'no-scale' | 'cannot-normalise';
  format: ImportFormat;
  /** one sentence, for a heading or an API's `error` field */
  message: string;
  /**
   * The refusal in full, one line each, **shown verbatim**. This is the whole
   * of what the CLI prints and the whole of what the studio's upload dialog
   * shows: the ladder's advice is the product, not a debug detail.
   */
  guidance: string[];
  warnings: string[];
}

export interface DepictionImportPlan {
  ok: true;
  format: Exclude<ImportFormat, 'unsupported'>;
  /** the file name the asset is stored under, inside the depiction directory */
  fileName: string;
  /** what to write there — normalised SVG text, or the raster bytes unchanged */
  content: string | Uint8Array;
  asset: DepictionAsset;
  /** the merged manifest, ready to be written as `meta.json` */
  meta: Record<string, unknown>;
  /** what normalisation changed, in plain sentences */
  warnings: string[];
  /** raster only: the pixel size read out of the header */
  pixelSize?: PixelSize;
}

export type DepictionImportResult = DepictionImportPlan | DepictionImportRefusal;

/** `a/b/c.svg` → `c.svg`, without reaching for `node:path`. */
function baseName(fileName: string): string {
  const parts = fileName.split(/[\\/]/);
  return parts[parts.length - 1] ?? fileName;
}

/**
 * Decide one import, start to finish, with no filesystem in sight.
 *
 * This is the whole of what `import-depiction` *does*: classify the file,
 * normalise or refuse it, establish a millimetre scale, and merge the result
 * into the definition's manifest. The CLI wraps it with argument parsing and
 * writes the two files; the studio's upload endpoint wraps it with a multipart
 * parser and writes the same two files. Neither owns a rule.
 *
 * Nothing here throws: a file this importer will not take comes back as a
 * refusal carrying the guidance verbatim, exactly as the ladder in
 * `specs/depictions.md` asks.
 */
export function prepareDepictionImport(
  request: DepictionImportRequest,
): DepictionImportResult {
  const voice = request.voice ?? CLI_VOICE;
  const name = baseName(request.fileName);
  const verdict = classifyImport(name);

  if (verdict.format === 'unsupported') {
    return {
      ok: false,
      reason: 'unsupported-format',
      format: 'unsupported',
      message: `cannot import ${name}`,
      guidance: verdict.guidance ?? [],
      warnings: [],
    };
  }

  const warnings: string[] = [];
  let content: string | Uint8Array;
  let asset: DepictionAsset;
  let fileName: string;
  let pixelSize: PixelSize | undefined;

  if (verdict.format === 'svg') {
    const sourceKind: SourceKind = request.sourceKind ?? 'svg';
    fileName = request.outName ?? `${request.view}.svg`;
    const citation =
      request.src ??
      `Imported from ${name} by ${voice.importer} and normalised to the house style (monochrome currentColor, house stroke weights, mm-true, self-contained). Provenance beyond the file name was not supplied — pass ${voice.srcOption} next time.`;
    const result = normalizeSvg(new TextDecoder().decode(request.bytes), {
      title: `${request.defId} — ${request.view}`,
      description: citation,
      ...(request.mmPerUnit === undefined ? {} : { mmPerUnit: request.mmPerUnit }),
      ...(request.widthMm === undefined ? {} : { widthMm: request.widthMm }),
      ...(request.keepStrokeWidths === true ? { keepStrokeWidths: true } : {}),
    });
    warnings.push(...result.warnings);
    if (
      result.svg === undefined ||
      result.widthUnits === undefined ||
      result.heightUnits === undefined
    ) {
      return {
        ok: false,
        reason: 'cannot-normalise',
        format: 'svg',
        message: `cannot normalise ${name}: ${result.error ?? 'unknown problem'}`,
        guidance: [`cannot normalise ${name}: ${result.error ?? 'unknown problem'}`],
        warnings,
      };
    }
    content = result.svg;
    asset = {
      file: fileName,
      kind: 'vector',
      mmPerUnit: 1,
      sourceKind,
      widthUnits: result.widthUnits,
      heightUnits: result.heightUnits,
      ...(request.mirrorOf === undefined ? {} : { mirrorOf: request.mirrorOf as DepictionAsset['mirrorOf'] }),
      ...(request.mirrorAxis === undefined ? {} : { mirrorAxis: request.mirrorAxis }),
      src: `${citation} Scale established from ${result.scaleSource ?? 'the file'}.`,
    };
  } else {
    const size = verdict.format === 'png' ? pngSize(request.bytes) : jpegSize(request.bytes);
    if (size === undefined) {
      return {
        ok: false,
        reason: 'unreadable-header',
        format: verdict.format,
        message: `cannot read the pixel size out of ${name} — the header does not look like a ${verdict.format.toUpperCase()}.`,
        guidance: [
          `cannot read the pixel size out of ${name} — the header does not look like a ${verdict.format.toUpperCase()}.`,
          'Re-export the image and try again.',
        ],
        warnings,
      };
    }
    pixelSize = size;
    // millimetres per pixel is a derived ratio; six decimals is well past the
    // precision of any measurement that produced it, and keeps the JSON stable
    const exact =
      request.mmPerUnit ??
      (request.widthMm === undefined ? undefined : request.widthMm / size.width);
    const mmPerUnit = exact === undefined ? undefined : Math.round(exact * 1e6) / 1e6;
    if (mmPerUnit === undefined) {
      return {
        ok: false,
        reason: 'no-scale',
        format: verdict.format,
        message:
          'raster artwork carries no scale of its own, and a depiction without a millimetre scale cannot be anchored or drawn at true size.',
        guidance: [
          'raster artwork carries no scale of its own, and a depiction without a millimetre',
          'scale cannot be anchored or drawn at true size.',
          `${name} is ${size.width}×${size.height} px. Pass one of:`,
          ...voice.scaleGuidance,
        ],
        warnings,
      };
    }
    fileName = request.outName ?? `${request.view}${verdict.extension}`;
    content = request.bytes;
    asset = {
      file: fileName,
      kind: 'raster',
      mmPerUnit,
      sourceKind: request.sourceKind ?? 'photo',
      widthUnits: size.width,
      heightUnits: size.height,
      ...(request.mirrorOf === undefined ? {} : { mirrorOf: request.mirrorOf as DepictionAsset['mirrorOf'] }),
      ...(request.mirrorAxis === undefined ? {} : { mirrorAxis: request.mirrorAxis }),
      src:
        request.src ??
        `Imported from ${name} by ${voice.importer}, copied unmodified (raster tier). ${size.width}×${size.height} px at ${mmPerUnit} mm/px${request.widthMm === undefined ? '' : ` (from ${voice.widthOption} ${request.widthMm})`}. Provenance beyond the file name was not supplied — pass ${voice.srcOption} next time.`,
    };
    warnings.push(
      'raster art is copied as-is: it cannot be restyled, and it prints at whatever resolution it has',
    );
  }

  const meta = mergeDepictionMeta(request.existingMeta, {
    defId: request.defId,
    view: request.view,
    asset,
    ...(request.expectedIds === undefined ? {} : { expectedIds: request.expectedIds }),
    ...(request.expectedAliases === undefined ? {} : { expectedAliases: request.expectedAliases }),
    src:
      request.src ??
      `Depiction manifest seeded by ${voice.importer} from ${name}; anchors are hand-authored (see pinAnchorsTodo for what is still missing).`,
  });

  return {
    ok: true,
    format: verdict.format,
    fileName,
    content,
    asset,
    meta,
    warnings,
    ...(pixelSize === undefined ? {} : { pixelSize }),
  };
}

/* ------------------------------------------------------------------ *
 * Guidance
 * ------------------------------------------------------------------ */

export interface GuidanceInput {
  sourceKind: SourceKind;
  kind: 'vector' | 'raster';
  /** The definition has KiCad pinmap coverage: rung 1 is available for free. */
  hasKicadSource?: boolean;
  unanchored: readonly string[];
  anchored: number;
}

/**
 * What better input would have been available, and what is still to do. The
 * spec asks the importer to *recommend upward*; this is that paragraph.
 */
export function importGuidance(input: GuidanceInput): string[] {
  const lines: string[] = [];
  if (input.hasKicadSource === true) {
    lines.push(
      'Rung 1 is available for this definition: pinmaps.json carries pad x/y for this board,',
      'so `pnpm --filter @wirehub/catalog generate-depictions` produces mm-true artwork',
      'with every anchor placed — no upload, no hand anchoring. Prefer it to this import.',
    );
  } else if (input.kind === 'raster') {
    lines.push(
      'This is rung 4 (raster). One rung up — a plain SVG export from whatever drew the part —',
      'would give crisp line art at any print size, mm-true scale with no --width-mm guess, and',
      'strokes the house style can normalise. Two rungs up, the KiCad source anchors itself.',
    );
  } else if (input.sourceKind === 'hand' || input.sourceKind === 'svg') {
    lines.push(
      'This is rung 2 (vector). If the part is one of the production boards, rung 1 is better:',
      'pinmaps.json already carries its pad coordinates, and the generator anchors every pin',
      'for you. Hand artwork is the right answer only for connectors and third-party parts.',
    );
  }
  if (input.unanchored.length === 0) {
    lines.push(`Anchors: all ${input.anchored} terminal(s) of this definition are anchored.`);
  } else {
    const shown = input.unanchored.slice(0, 12).join(', ');
    lines.push(
      `Anchors: ${input.anchored} placed, ${input.unanchored.length} still unanchored — ${shown}${input.unanchored.length > 12 ? ', …' : ''}`,
      'They are listed in meta.json under "pinAnchorsTodo". Move an id into "pinAnchors" with',
      '{"x": …, "y": …} in the anchor frame\'s units once you know where it sits. Until every',
      'used pin is anchored, the renderer draws this block as the abstract pin table.',
    );
  }
  return lines;
}
