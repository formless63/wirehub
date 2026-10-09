/**
 * Art for the drawing sheet, supplied by whoever hosts it
 * (`specs/drawing-language.md` §6, §7).
 *
 * The base ships none of its own here: every face, plug and cutaway the
 * sheet shows comes from the definitions (`drawn-faces.ts`, `cutaway.ts`),
 * from **depictions** — SVG faces and cutaway illustrations a catalog or a
 * pack ships, read through a `DepictionSource` (`depiction-art.ts`) — or from
 * the records registered here: traced faces and side-view plugs keyed by
 * connector id, a cutaway per wire stock, the title block's logo and its
 * fixed text. A deployment's module registers them at start
 * (`registerDrawingArt`); with nothing registered the sheet draws exactly
 * what the base always drew.
 */

import type { DepictionSource } from '@wirehub/layout';

import type { PaperId, TitleBlockStandard } from '../frame/paper.ts';
import type { FaceArt } from './faces.ts';

/** A cutaway as an SVG document and its frame size. */
export interface CutawayArt {
  svg: string;
  width: number;
  height: number;
}

/** The title block's logo: a PNG (base64) and the box it is fitted into, in points. */
export interface LogoArt {
  pngBase64: string;
  box: readonly [number, number, number, number];
}

/** The title block's fixed wording; every part optional, the generic text stands in. */
export interface TitleBlockText {
  /** the three-line general note beside the tolerances (default "ALL DIMENSIONS ARE / IN MM UNLESS / OTHERWISE SPECIFIED") */
  notes?: readonly [string, string, string];
  /** the tolerance table: label/value pairs */
  tolerances?: readonly (readonly [string, string])[];
  /** the SIZE cell (default `A`) */
  size?: string;
  /** the organisation the documents are issued by (wire spec mark, bench header); unset = the generic text */
  organisation?: string;
  /** the name of the document standard on the wire spec (default `WIRE_SPEC_STANDARD`) */
  standard?: string;
  /** a rights / confidentiality line: the drawing's title block, the wire spec's footer; unset = none */
  rights?: string;
  /** the designer printed when a design's drawing sidecar names none */
  designer?: string;
  /** the prefix of every exported wire spec file (default `WIRE_SPEC_FILE_PREFIX`, `WSS_`) */
  filePrefix?: string;
  /** the paper the sheets print on when nothing asks for another (Settings › Documents); unset = A4 */
  paper?: PaperId;
  /** the title-block layout of every sheet (Settings › Documents); unset = the paper's own convention (ISO for the A sizes, ANSI for the North American ones) */
  titleBlock?: TitleBlockStandard;
  /** the label stock the wire labels print on (`exports/label-presets.ts`); unset = the paper's own sheet grid */
  labelPreset?: string;
  /** a QR code on each wire label (the part number and revision, or the URL pattern below); unset = none */
  labelQr?: boolean;
  /** the QR's URL pattern, `{pn}` `{rev}` `{design}` `{label}`; unset = the part number and revision as text */
  labelQrUrl?: string;
}

export interface DrawingArt {
  /** traced solder-side faces, by connector definition id */
  faces?: Readonly<Record<string, FaceArt>>;
  /** side-view plugs, by connector definition id (`<id>-ra` is the 90° version) */
  plugs?: Readonly<Record<string, FaceArt>>;
  /** cutaway art per wire stock id */
  cutaways?: Readonly<Record<string, CutawayArt>>;
  logo?: LogoArt;
  titleBlock?: TitleBlockText;
  /** the typeface the documents are set in (the first registration to set one wins) */
  font?: BrandFont;
  /**
   * Where depictions come from for faces and cutaways (a catalog's own tree,
   * a pack's). Several registrations layer, the earliest first.
   */
  depictions?: DepictionSource;
}

/**
 * A licensed typeface the hub sets its documents in, as the branding settings supply it: one
 * face for regular text and, when it has one, a bold. The bytes are the font as uploaded
 * (`mime` says which kind), so an HTML sheet can carry it inline and the browser engine
 * can print it; `widths` are its advance widths per character (1/1000 em), so layout
 * measures the face that prints; `embeddable` says the vector PDF can embed it (a TrueType-outline
 * font: `.ttf`, or an `.otf` with TrueType outlines). The base ships none: with nothing registered
 * the bundled sans is used, exactly as before.
 */
export interface BrandFace {
  /** the family name the font declares (shown in Settings; the sheets use their own alias) */
  family: string;
  mime: 'font/ttf' | 'font/otf' | 'font/woff2';
  /** the font file, base64 */
  base64: string;
  /** advance widths by character, 1/1000 em */
  widths: Readonly<Record<string, number>>;
  embeddable: boolean;
  /** the TrueType font program the vector PDF embeds when it is not the file itself (a WOFF2 whose outlines are plain), base64 */
  pdfBase64?: string;
  /** the rasteriser (the drawing's PDF without a browser engine) can read the file as uploaded */
  rasterizable: boolean;
}

export interface BrandFont {
  regular: BrandFace;
  bold?: BrandFace;
}

const registered: DrawingArt[] = [];

/** Register drawing art; returns the function that takes it out again. */
export function registerDrawingArt(art: DrawingArt): () => void {
  registered.push(art);
  return () => {
    const at = registered.indexOf(art);
    if (at !== -1) registered.splice(at, 1);
  };
}

/** The registered traced face for a connector id (the first registration to have one). */
export function registeredFace(id: string): FaceArt | undefined {
  for (const art of registered) if (art.faces?.[id] !== undefined) return art.faces[id];
  return undefined;
}

export function registeredFaceIds(): string[] {
  return [...new Set(registered.flatMap((art) => Object.keys(art.faces ?? {})))].sort();
}

export function registeredPlug(id: string): FaceArt | undefined {
  for (const art of registered) if (art.plugs?.[id] !== undefined) return art.plugs[id];
  return undefined;
}

export function registeredPlugIds(): string[] {
  return [...new Set(registered.flatMap((art) => Object.keys(art.plugs ?? {})))].sort();
}

export function registeredCutaway(wireId: string): CutawayArt | undefined {
  for (const art of registered) if (art.cutaways?.[wireId] !== undefined) return art.cutaways[wireId];
  return undefined;
}

/** The registered brand typeface, if any (the first registration to set one). */
export function registeredBrandFont(): BrandFont | undefined {
  return registered.find((art) => art.font !== undefined)?.font;
}

export function registeredLogo(): LogoArt | undefined {
  return registered.find((art) => art.logo !== undefined)?.logo;
}

/** The title block's wording: the first registration to set each part. */
export function registeredTitleBlock(): TitleBlockText {
  const blocks = registered.map((art) => art.titleBlock).filter((t): t is TitleBlockText => t !== undefined);
  const notes = blocks.find((t) => t.notes !== undefined)?.notes;
  const tolerances = blocks.find((t) => t.tolerances !== undefined)?.tolerances;
  const first = <K extends 'size' | 'organisation' | 'standard' | 'rights' | 'designer' | 'filePrefix' | 'paper' | 'titleBlock' | 'labelPreset' | 'labelQr' | 'labelQrUrl'>(key: K): Partial<Record<K, NonNullable<TitleBlockText[K]>>> => {
    const found = blocks.find((t) => t[key] !== undefined && t[key] !== '')?.[key];
    return found === undefined ? {} : ({ [key]: found } as Record<K, NonNullable<TitleBlockText[K]>>);
  };
  return {
    ...(notes === undefined ? {} : { notes }),
    ...(tolerances === undefined ? {} : { tolerances }),
    ...first('size'),
    ...first('organisation'),
    ...first('standard'),
    ...first('rights'),
    ...first('designer'),
    ...first('filePrefix'),
    ...first('paper'),
    ...first('titleBlock'),
    ...first('labelPreset'),
    ...first('labelQr'),
    ...first('labelQrUrl'),
  };
}

/** The depiction sources registered for the sheet, layered in registration order. */
export function registeredDepictions(): DepictionSource | undefined {
  const sources = registered.map((art) => art.depictions).filter((s): s is DepictionSource => s !== undefined);
  if (sources.length === 0) return undefined;
  const owner = (id: string): DepictionSource | undefined => sources.find((s) => s.meta(id) !== undefined);
  return { meta: (id) => owner(id)?.meta(id), artwork: (id, view) => owner(id)?.artwork(id, view) };
}

/**
 * Check a parsed `DrawingArt` (a module's `art.drawing`) before it is
 * registered: what a sheet cannot use is named, never thrown.
 */
export function drawingArtProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['drawing art is not an object'];
  const art = raw as DrawingArt;
  const problems: string[] = [];
  const face = (what: string, id: string, f: FaceArt | undefined): void => {
    if (f === undefined || typeof f.width !== 'number' || typeof f.height !== 'number' || !Array.isArray(f.art) || !Array.isArray(f.pins) || !Array.isArray(f.labels) || typeof f.src !== 'string' || f.src === '') {
      problems.push(`${what} '${id}' needs width, height, art, pins, labels and a src`);
    }
  };
  for (const [id, f] of Object.entries(art.faces ?? {})) face('face', id, f);
  for (const [id, f] of Object.entries(art.plugs ?? {})) face('plug', id, f);
  for (const [id, c] of Object.entries(art.cutaways ?? {})) {
    if (typeof c?.svg !== 'string' || typeof c.width !== 'number' || typeof c.height !== 'number') problems.push(`cutaway '${id}' needs svg, width and height`);
  }
  if (art.titleBlock?.notes !== undefined && art.titleBlock.notes.length !== 3) problems.push('title block notes are three lines');
  if (art.font !== undefined) {
    for (const [slot, f] of [['regular', art.font.regular], ['bold', art.font.bold]] as const) {
      if (f === undefined && slot === 'bold') continue;
      if (typeof f?.base64 !== 'string' || typeof f.family !== 'string' || typeof f.widths !== 'object' || f.widths === null || typeof f.embeddable !== 'boolean' || !['font/ttf', 'font/otf', 'font/woff2'].includes(f.mime)) problems.push(`the ${slot} font needs family, mime, base64 and widths`);
    }
  }
  return problems;
}
