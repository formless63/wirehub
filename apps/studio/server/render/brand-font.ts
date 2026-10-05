/**
 * Reading an uploaded typeface (Settings, Branding): TrueType, OpenType or WOFF2, up to a size the
 * settings page states. Enough to say what it is (its family name), to measure it (advance widths per
 * character, for layout) and to know what each renderer can do with it:
 *
 * - an HTML sheet, a drawing's SVG and a browser-engine PDF carry the font inline as uploaded;
 * - the vector PDF embeds a TrueType-outline font (`.ttf`, an `.otf` with TrueType outlines, or a WOFF2 whose
 *   outlines are stored plain) as a subset; a CFF-outline `.otf` or a WOFF2 with compressed outlines keeps the
 *   bundled sans there (`embeddable: false`), and the settings page says so;
 * - the raster PDF (the drawing without a browser engine) needs a font file the rasteriser can read: TrueType or OpenType.
 *
 * Nothing is executed: a font is parsed as bytes within the bounds below, and every failure is a sentence.
 * Deterministic.
 */

import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';

import type { BrandFace, BrandFont } from '@wirehub/docs';

import { cmapLookup } from './ttf.ts';

/** the largest font file the settings accept, and the most a WOFF2 may unpack to */
export const MAX_FONT_BYTES = 1536 * 1024;
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;

export type FontFormat = 'ttf' | 'otf' | 'woff2';

export const FONT_MIME: Readonly<Record<FontFormat, BrandFace['mime']>> = { ttf: 'font/ttf', otf: 'font/otf', woff2: 'font/woff2' };

export interface FontInfo {
  format: FontFormat;
  mime: BrandFace['mime'];
  /** the family the font names itself */
  family: string;
  /** its style name (`Regular`, `Bold`), when it has one */
  subfamily?: string;
  /** TrueType outlines (`glyf`) or CFF outlines */
  flavor: 'truetype' | 'cff';
  unitsPerEm: number;
  /** advance widths by character, 1/1000 em, for the characters the sheets use */
  widths: Record<string, number>;
  /** the vector PDF can embed it (as the TrueType font program in `program`) */
  embeddable: boolean;
  /** the TrueType font program the vector PDF embeds, when `embeddable` */
  program?: Uint8Array;
  /** the rasteriser can read the font as uploaded (TrueType or OpenType, not WOFF2) */
  rasterizable: boolean;
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

type Tables = Map<string, Uint8Array>;

const tagAt = (bytes: Uint8Array, at: number): string => String.fromCharCode(bytes[at] as number, bytes[at + 1] as number, bytes[at + 2] as number, bytes[at + 3] as number);

/** The tables of an sfnt (TrueType or OpenType) font. */
function sfntTables(bytes: Uint8Array): Tables {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) throw new Error('That file is too short to be a font.');
  const count = view.getUint16(4);
  if (count === 0 || count > 80 || 12 + count * 16 > bytes.length) throw new Error('The font\'s table directory is damaged.');
  const tables: Tables = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length > bytes.length) throw new Error(`The font's '${tagAt(bytes, at).trim()}' table runs past the end of the file.`);
    tables.set(tagAt(bytes, at), bytes.subarray(offset, offset + length));
  }
  return tables;
}

/** The well-known table tags of the WOFF2 directory, by index (WOFF2 spec section 5.1). */
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

interface Woff2 {
  flavor: number;
  tables: Tables;
  /** tags whose data is stored in the WOFF2 transform (not the plain table) */
  transformed: Set<string>;
}

function readBase128(bytes: Uint8Array, at: { p: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const b = bytes[at.p++];
    if (b === undefined) throw new Error('The WOFF2 table directory is damaged.');
    if (i === 0 && b === 0x80) throw new Error('The WOFF2 table directory is damaged.');
    if (value > 0x1fffffff) throw new Error('The WOFF2 table directory is damaged.');
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return value;
  }
  throw new Error('The WOFF2 table directory is damaged.');
}

function readWoff2(bytes: Uint8Array): Woff2 {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 48) throw new Error('That file is too short to be a WOFF2 font.');
  const flavor = view.getUint32(4);
  const count = view.getUint16(12);
  const compressed = view.getUint32(20);
  if (count === 0 || count > 80) throw new Error('The WOFF2 table directory is damaged.');
  const at = { p: 48 };
  const entries: { tag: string; length: number; transformed: boolean }[] = [];
  for (let i = 0; i < count; i += 1) {
    const flags = bytes[at.p++];
    if (flags === undefined) throw new Error('The WOFF2 table directory is damaged.');
    const index = flags & 0x3f;
    const version = flags >> 6;
    let tag: string;
    if (index === 63) {
      tag = tagAt(bytes, at.p);
      at.p += 4;
    } else tag = WOFF2_TAGS[index] ?? '????';
    const original = readBase128(bytes, at);
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    const length = transformed ? readBase128(bytes, at) : original;
    entries.push({ tag, length, transformed });
  }
  if (at.p + compressed > bytes.length) throw new Error('The WOFF2 font\'s data runs past the end of the file.');
  let data: Uint8Array;
  try {
    data = brotliDecompressSync(bytes.subarray(at.p, at.p + compressed), { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new Error('The WOFF2 font could not be unpacked.');
  }
  const tables: Tables = new Map();
  const transformed = new Set<string>();
  let offset = 0;
  for (const e of entries) {
    if (offset + e.length > data.length) throw new Error('The WOFF2 font\'s tables run past its data.');
    tables.set(e.tag, data.subarray(offset, offset + e.length));
    if (e.transformed) transformed.add(e.tag);
    offset += e.length;
  }
  return { flavor, tables, transformed };
}

/** A TrueType font file built from plain tables (a WOFF2 whose outlines are not transformed). */
function assembleSfnt(flavor: number, tables: Tables): Uint8Array {
  const tags = [...tables.keys()].sort();
  const header = 12 + tags.length * 16;
  let size = header;
  const placed = tags.map((tag) => {
    const body = tables.get(tag) as Uint8Array;
    const entry = { tag, body, offset: size };
    size += Math.ceil(body.length / 4) * 4;
    return entry;
  });
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, flavor);
  view.setUint16(4, tags.length);
  const pow = 2 ** Math.floor(Math.log2(tags.length));
  view.setUint16(6, pow * 16);
  view.setUint16(8, Math.log2(pow));
  view.setUint16(10, tags.length * 16 - pow * 16);
  placed.forEach((t, i) => {
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c += 1) out[at + c] = t.tag.charCodeAt(c);
    // the checksum is not read back by anything here; the PDF readers recompute it
    view.setUint32(at + 8, t.offset);
    view.setUint32(at + 12, t.body.length);
    out.set(t.body, t.offset);
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * What the sheets measure
 * ------------------------------------------------------------------ */

/** The characters whose widths are kept: Basic Latin, Latin-1 and Extended-A/B, Greek, general punctuation and the few symbols a cable drawing uses. */
function measuredCodePoints(): number[] {
  const out: number[] = [];
  const range = (from: number, to: number): void => {
    for (let cp = from; cp <= to; cp += 1) out.push(cp);
  };
  range(0x20, 0x7e);
  range(0xa0, 0x24f);
  range(0x370, 0x3ff);
  range(0x2010, 0x203a);
  out.push(0x20ac, 0x2122, 0x2126, 0x2205, 0x2212, 0x2264, 0x2265, 0x00b1, 0x00d7, 0x2300);
  return [...new Set(out)];
}

function familyOf(name: Uint8Array | undefined): { family: string; subfamily?: string } {
  if (name === undefined || name.length < 6) return { family: 'Unnamed font' };
  const view = new DataView(name.buffer, name.byteOffset, name.byteLength);
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  const found = new Map<number, string>();
  for (let i = 0; i < count && 6 + i * 12 + 12 <= name.length; i += 1) {
    const at = 6 + i * 12;
    const platform = view.getUint16(at);
    const id = view.getUint16(at + 6);
    const length = view.getUint16(at + 8);
    const offset = storage + view.getUint16(at + 10);
    if (offset + length > name.length) continue;
    const raw = name.subarray(offset, offset + length);
    let text: string | undefined;
    if (platform === 3 || platform === 0) {
      text = '';
      for (let j = 0; j + 1 < raw.length; j += 2) text += String.fromCharCode(((raw[j] as number) << 8) | (raw[j + 1] as number));
    } else if (platform === 1) text = Buffer.from(raw).toString('latin1');
    if (text !== undefined && text.trim() !== '' && (!found.has(id) || platform === 3)) found.set(id, text.trim());
  }
  const family = found.get(16) ?? found.get(1) ?? 'Unnamed font';
  const subfamily = found.get(17) ?? found.get(2);
  // control characters in a family name never reach a stylesheet
  // eslint-disable-next-line no-control-regex
  const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f'"\\<>{};]/g, '').slice(0, 80).trim();
  return { family: clean(family) || 'Unnamed font', ...(subfamily === undefined || clean(subfamily) === '' ? {} : { subfamily: clean(subfamily) }) };
}

/**
 * What an uploaded font is. Throws an `Error` whose message is a sentence a person can act on
 * (not a font, too large, a collection, no character map, a damaged file).
 */
export function inspectFont(bytes: Uint8Array): FontInfo {
  if (bytes.length === 0) throw new Error('That file is empty.');
  if (bytes.length > MAX_FONT_BYTES) throw new Error(`That font is larger than ${MAX_FONT_BYTES / 1024} KiB.`);
  const magic = tagAt(bytes, 0);
  let format: FontFormat;
  let tables: Tables;
  let flavorTag: number;
  let transformed = new Set<string>();
  if (magic === 'wOF2') {
    const woff = readWoff2(bytes);
    format = 'woff2';
    tables = woff.tables;
    flavorTag = woff.flavor;
    transformed = woff.transformed;
  } else if (magic === 'ttcf') {
    throw new Error('A font collection (.ttc) cannot be used: upload one of its fonts on its own.');
  } else if (magic === 'OTTO' || magic === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) {
    tables = sfntTables(bytes);
    flavorTag = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    format = magic === 'OTTO' || tables.has('CFF ') ? 'otf' : 'ttf';
  } else {
    throw new Error('That file is not a TrueType, OpenType or WOFF2 font.');
  }
  // a variable font has no single set of advance widths: say so rather than measure the default instance wrongly
  if (tables.has('fvar')) throw new Error('A variable font cannot be used: upload its static regular and bold files.');
  const need = (tag: string): Uint8Array => {
    const t = tables.get(tag);
    if (t === undefined) throw new Error(`The font has no '${tag.trim()}' table, so it cannot be measured.`);
    return t;
  };
  for (const tag of ['head', 'hhea', 'hmtx', 'maxp', 'cmap']) need(tag);
  if (transformed.has('hmtx')) throw new Error('This WOFF2 font stores its metrics in a form that cannot be read: upload it as TrueType or OpenType.');
  const head = need('head');
  const hhea = need('hhea');
  const hmtx = need('hmtx');
  const cmap = need('cmap');
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const hheaView = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength);
  const hmtxView = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength);
  const cmapView = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const unitsPerEm = headView.getUint16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw new Error('The font\'s units per em is outside what a font has.');
  const metrics = hheaView.getUint16(34);
  if (metrics === 0 || metrics * 4 > hmtx.length) throw new Error('The font\'s metrics table is damaged.');
  let lookup: (cp: number) => number;
  try {
    lookup = cmapLookup(cmapView, 0);
  } catch {
    throw new Error('The font has no Unicode character map (format 4 or 12), so it cannot be measured.');
  }
  const widths: Record<string, number> = {};
  for (const cp of measuredCodePoints()) {
    const glyph = lookup(cp);
    if (glyph === 0) continue;
    const advance = hmtxView.getUint16(Math.min(glyph, metrics - 1) * 4);
    widths[String.fromCodePoint(cp)] = Math.round((advance * 1000) / unitsPerEm);
  }
  if (widths['A'] === undefined || widths['a'] === undefined || widths['0'] === undefined) throw new Error('The font lacks the basic Latin letters and digits the documents are set in.');
  const { family, subfamily } = familyOf(tables.get('name'));
  const trueType = tables.has('glyf') && tables.has('loca');
  const plainOutlines = trueType && !transformed.has('glyf') && !transformed.has('loca');
  let program: Uint8Array | undefined;
  if (plainOutlines) program = format === 'woff2' ? assembleSfnt(flavorTag, tables) : bytes;
  return {
    format,
    mime: FONT_MIME[format],
    family,
    ...(subfamily === undefined ? {} : { subfamily }),
    flavor: trueType ? 'truetype' : 'cff',
    unitsPerEm,
    widths,
    embeddable: program !== undefined,
    ...(program === undefined ? {} : { program }),
    rasterizable: format !== 'woff2',
  };
}

/* ------------------------------------------------------------------ *
 * As the sheets take it
 * ------------------------------------------------------------------ */

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The face the documents register: the font as uploaded, its widths and what it can do. */
export function brandFace(bytes: Uint8Array, info: FontInfo = inspectFont(bytes)): BrandFace {
  return {
    family: info.family,
    mime: info.mime,
    base64: Buffer.from(bytes).toString('base64'),
    widths: info.widths,
    embeddable: info.embeddable,
    ...(info.embeddable && info.format === 'woff2' && info.program !== undefined ? { pdfBase64: Buffer.from(info.program).toString('base64') } : {}),
    rasterizable: info.rasterizable,
  };
}

/** A brand font from the bytes of its regular face and, when it has one, its bold. */
export function brandFont(regular: Uint8Array, bold?: Uint8Array): BrandFont {
  return { regular: brandFace(regular), ...(bold === undefined ? {} : { bold: brandFace(bold) }) };
}
