/**
 * A small TrueType reader and subsetter, enough to embed one of the bundled
 * Liberation Sans faces in a PDF: character to glyph (the `cmap`), glyph
 * advances (`hmtx`), the few metrics a font descriptor needs, and a subset
 * font program that keeps only the glyphs a document uses. No dependency;
 * deterministic (the same glyphs give the same bytes).
 *
 * It reads what Liberation Sans is: a TrueType outline font (`glyf`/`loca`)
 * with a Unicode `cmap` (format 4, or 12). It refuses anything else rather
 * than embedding something it did not understand.
 */

export interface TrueTypeFont {
  unitsPerEm: number;
  numGlyphs: number;
  /** the glyph for a code point; 0 (`.notdef`) when the face has none */
  glyphFor(codePoint: number): number;
  /** a glyph's advance, in font units */
  advance(glyph: number): number;
  /** the width of `text` at `size`, summing advances (no kerning, as a PDF `Tj` sets it) */
  width(text: string, size: number): number;
  /** metrics scaled to 1000 units per em, as a PDF font descriptor states them */
  descriptor: { ascent: number; descent: number; capHeight: number; bbox: [number, number, number, number]; italicAngle: number };
  /** a font program holding only `glyphs` (and `.notdef`, and any component a composite glyph names) */
  subset(glyphs: Iterable<number>): Uint8Array;
}

const u16 = (v: DataView, at: number): number => v.getUint16(at);
const i16 = (v: DataView, at: number): number => v.getInt16(at);
const u32 = (v: DataView, at: number): number => v.getUint32(at);

interface Table {
  offset: number;
  length: number;
}

function tagAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] as number, bytes[at + 1] as number, bytes[at + 2] as number, bytes[at + 3] as number);
}

/** The sum of a table's big-endian 32-bit words, zero-padded to a whole word. */
function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word = ((bytes[i] ?? 0) * 0x1000000 + ((bytes[i + 1] ?? 0) << 16) + ((bytes[i + 2] ?? 0) << 8) + (bytes[i + 3] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

export function loadTrueType(bytes: Uint8Array): TrueTypeFont {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = u32(view, 0);
  if (version !== 0x00010000 && tagAt(bytes, 0) !== 'true') throw new Error('ttf: not a TrueType font');
  const tables = new Map<string, Table>();
  for (let i = 0; i < u16(view, 4); i += 1) {
    const at = 12 + i * 16;
    tables.set(tagAt(bytes, at), { offset: u32(view, at + 8), length: u32(view, at + 12) });
  }
  const need = (tag: string): Table => {
    const t = tables.get(tag);
    if (t === undefined) throw new Error(`ttf: no '${tag}' table (an outline font with TrueType outlines is needed)`);
    return t;
  };
  const head = need('head');
  const hhea = need('hhea');
  const maxp = need('maxp');
  const hmtx = need('hmtx');
  const loca = need('loca');
  const glyf = need('glyf');
  const cmap = need('cmap');
  const unitsPerEm = u16(view, head.offset + 18);
  const locaLong = i16(view, head.offset + 50) === 1;
  const numGlyphs = u16(view, maxp.offset + 4);
  const metrics = u16(view, hhea.offset + 34);

  const advance = (glyph: number): number => u16(view, hmtx.offset + Math.min(glyph, metrics - 1) * 4);
  const sideBearing = (glyph: number): number =>
    glyph < metrics ? i16(view, hmtx.offset + glyph * 4 + 2) : i16(view, hmtx.offset + metrics * 4 + (glyph - metrics) * 2);
  const glyphRange = (glyph: number): [number, number] =>
    locaLong
      ? [u32(view, loca.offset + glyph * 4), u32(view, loca.offset + glyph * 4 + 4)]
      : [u16(view, loca.offset + glyph * 2) * 2, u16(view, loca.offset + glyph * 2 + 2) * 2];

  // the Unicode character map: format 12 when there is one, else format 4
  let lookup: ((cp: number) => number) | undefined;
  const subtables: { platform: number; encoding: number; offset: number }[] = [];
  for (let i = 0; i < u16(view, cmap.offset + 2); i += 1) {
    const at = cmap.offset + 4 + i * 8;
    subtables.push({ platform: u16(view, at), encoding: u16(view, at + 2), offset: cmap.offset + u32(view, at + 4) });
  }
  const wide = subtables.find((s) => s.platform === 3 && s.encoding === 10 && u16(view, s.offset) === 12);
  const narrow = subtables.find((s) => (s.platform === 3 && s.encoding === 1) || s.platform === 0);
  if (wide !== undefined) {
    const groups = u32(view, wide.offset + 12);
    lookup = (cp) => {
      for (let g = 0; g < groups; g += 1) {
        const at = wide.offset + 16 + g * 12;
        const start = u32(view, at);
        if (cp < start) return 0;
        if (cp <= u32(view, at + 4)) return u32(view, at + 8) + (cp - start);
      }
      return 0;
    };
  } else if (narrow !== undefined && u16(view, narrow.offset) === 4) {
    const segs = u16(view, narrow.offset + 6) / 2;
    const ends = narrow.offset + 14;
    const starts = ends + segs * 2 + 2;
    const deltas = starts + segs * 2;
    const ranges = deltas + segs * 2;
    lookup = (cp) => {
      if (cp > 0xffff) return 0;
      for (let s = 0; s < segs; s += 1) {
        if (cp > u16(view, ends + s * 2)) continue;
        const start = u16(view, starts + s * 2);
        if (cp < start) return 0;
        const offset = u16(view, ranges + s * 2);
        if (offset === 0) return (cp + i16(view, deltas + s * 2)) & 0xffff;
        const glyph = u16(view, ranges + s * 2 + offset + (cp - start) * 2);
        return glyph === 0 ? 0 : (glyph + i16(view, deltas + s * 2)) & 0xffff;
      }
      return 0;
    };
  } else throw new Error('ttf: no Unicode character map (format 4 or 12)');

  const os2 = tables.get('OS/2');
  const post = tables.get('post');
  const scale = (v: number): number => Math.round((v * 1000) / unitsPerEm);
  const descriptor: TrueTypeFont['descriptor'] = {
    ascent: scale(i16(view, hhea.offset + 4)),
    descent: scale(i16(view, hhea.offset + 6)),
    capHeight: os2 !== undefined && u16(view, os2.offset) >= 2 ? scale(i16(view, os2.offset + 88)) : scale(i16(view, hhea.offset + 4)) * 0.72,
    bbox: [scale(i16(view, head.offset + 36)), scale(i16(view, head.offset + 38)), scale(i16(view, head.offset + 40)), scale(i16(view, head.offset + 42))],
    italicAngle: post === undefined ? 0 : view.getInt32(post.offset + 4) / 65536,
  };

  /** the glyphs a composite glyph is built from */
  const components = (glyph: number): number[] => {
    const [from, to] = glyphRange(glyph);
    if (to - from < 10) return [];
    const at = glyf.offset + from;
    if (i16(view, at) >= 0) return [];
    const out: number[] = [];
    let p = at + 10;
    for (;;) {
      const flags = u16(view, p);
      out.push(u16(view, p + 2));
      p += 4 + (flags & 0x1 ? 4 : 2);
      if (flags & 0x8) p += 2;
      else if (flags & 0x40) p += 4;
      else if (flags & 0x80) p += 8;
      if (!(flags & 0x20)) break;
    }
    return out;
  };

  return {
    unitsPerEm,
    numGlyphs,
    glyphFor: (cp) => lookup(cp),
    advance,
    width(text, size) {
      let units = 0;
      for (const ch of text) units += advance(lookup(ch.codePointAt(0) as number));
      return (units / unitsPerEm) * size;
    },
    descriptor,
    subset(glyphs) {
      const used = new Set<number>([0]);
      const queue = [...glyphs];
      while (queue.length > 0) {
        const g = queue.pop() as number;
        if (used.has(g) && g !== 0) continue;
        if (g >= numGlyphs) continue;
        used.add(g);
        queue.push(...components(g).filter((c) => !used.has(c)));
      }
      const last = Math.max(...used);
      const count = last + 1;
      // glyph data of the kept glyphs, each padded to a whole word
      const pieces: Uint8Array[] = [];
      const offsets: number[] = [0];
      let total = 0;
      for (let g = 0; g < count; g += 1) {
        let piece = new Uint8Array(0);
        if (used.has(g)) {
          const [from, to] = glyphRange(g);
          const raw = bytes.subarray(glyf.offset + from, glyf.offset + to);
          piece = new Uint8Array(Math.ceil(raw.length / 4) * 4);
          piece.set(raw);
        }
        pieces.push(piece);
        total += piece.length;
        offsets.push(total);
      }
      const newGlyf = new Uint8Array(total);
      let at = 0;
      for (const piece of pieces) {
        newGlyf.set(piece, at);
        at += piece.length;
      }
      const newLoca = new Uint8Array((count + 1) * 4);
      const locaView = new DataView(newLoca.buffer);
      offsets.forEach((o, i) => locaView.setUint32(i * 4, o));
      // every kept glyph gets a full metrics record
      const newHmtx = new Uint8Array(count * 4);
      const hmtxView = new DataView(newHmtx.buffer);
      for (let g = 0; g < count; g += 1) {
        hmtxView.setUint16(g * 4, advance(g));
        hmtxView.setInt16(g * 4 + 2, sideBearing(g));
      }
      const copy = (t: Table): Uint8Array => bytes.slice(t.offset, t.offset + t.length);
      const newHead = copy(head);
      const newHeadView = new DataView(newHead.buffer);
      newHeadView.setUint32(8, 0); // checkSumAdjustment, set once the whole font is known
      newHeadView.setInt16(50, 1); // long `loca`
      const newHhea = copy(hhea);
      new DataView(newHhea.buffer).setUint16(34, count);
      const newMaxp = copy(maxp);
      new DataView(newMaxp.buffer).setUint16(4, count);
      const out = new Map<string, Uint8Array>([
        ['glyf', newGlyf],
        ['head', newHead],
        ['hhea', newHhea],
        ['hmtx', newHmtx],
        ['loca', newLoca],
        ['maxp', newMaxp],
      ]);
      // the hinting programs travel with the outlines
      for (const tag of ['cvt ', 'fpgm', 'prep']) {
        const t = tables.get(tag);
        if (t !== undefined) out.set(tag, copy(t));
      }
      const tags = [...out.keys()].sort();
      const headerSize = 12 + tags.length * 16;
      let size = headerSize;
      const placed = tags.map((tag) => {
        const body = out.get(tag) as Uint8Array;
        const entry = { tag, body, offset: size };
        size += Math.ceil(body.length / 4) * 4;
        return entry;
      });
      const font = new Uint8Array(size);
      const fontView = new DataView(font.buffer);
      fontView.setUint32(0, 0x00010000);
      fontView.setUint16(4, tags.length);
      const pow = 2 ** Math.floor(Math.log2(tags.length));
      fontView.setUint16(6, pow * 16);
      fontView.setUint16(8, Math.log2(pow));
      fontView.setUint16(10, tags.length * 16 - pow * 16);
      placed.forEach((t, i) => {
        const at = 12 + i * 16;
        for (let c = 0; c < 4; c += 1) font[at + c] = t.tag.charCodeAt(c);
        fontView.setUint32(at + 4, checksum(t.body));
        fontView.setUint32(at + 8, t.offset);
        fontView.setUint32(at + 12, t.body.length);
        font.set(t.body, t.offset);
      });
      const headAt = (placed.find((t) => t.tag === 'head') as { offset: number }).offset;
      fontView.setUint32(headAt + 8, (0xb1b0afba - checksum(font)) >>> 0);
      return font;
    },
  };
}
