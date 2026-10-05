/** Reading an uploaded typeface (`server/render/brand-font.ts`): what it is, how wide it sets, what each renderer can do with it. */

import { readFileSync } from 'node:fs';

import { sans } from '@wirehub/docs/src/drawing/fonts.generated.ts';
import { describe, expect, it } from 'vitest';

import { MAX_FONT_BYTES, brandFace, inspectFont } from '../server/render/brand-font.ts';
import { brandmark } from './migration-gaps-flow.ts';

const fonts = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../packages/docs/fonts/${name}`, import.meta.url)));

describe('inspectFont', () => {
  it('reads a TrueType font: its family, its widths, and that every renderer can use it', () => {
    const info = inspectFont(fonts('LiberationSans-Bold.ttf'));
    expect(info).toMatchObject({ format: 'ttf', mime: 'font/ttf', family: 'Liberation Sans', subfamily: 'Bold', flavor: 'truetype', unitsPerEm: 2048, embeddable: true, rasterizable: true });
    expect(info.widths['A']).toBe(722);
    expect(info.widths[' ']).toBe(278);
    expect(info.widths['Ω']).toBeGreaterThan(0);
    expect(Object.keys(info.widths).length).toBeGreaterThan(500);
  });

  it('reads an OpenType font with CFF outlines: usable on the sheets and the raster PDF, not embedded in the vector PDF', () => {
    const info = inspectFont(fonts('texgyreadventor-regular.otf'));
    expect(info).toMatchObject({ format: 'otf', flavor: 'cff', family: 'TeX Gyre Adventor', embeddable: false, rasterizable: true });
    expect(info.widths['a']).toBeGreaterThan(300);
  });

  it('reads a WOFF2 font: carried inline and measured; its compressed outlines keep the vector PDF on the bundled sans', () => {
    const info = inspectFont(new Uint8Array(Buffer.from(sans.woff2, 'base64')));
    expect(info).toMatchObject({ format: 'woff2', mime: 'font/woff2', flavor: 'truetype', embeddable: false, rasterizable: false });
    expect(info.widths['A']).toBe(667);
  });

  it('makes a face the sheets register, with the file as uploaded', () => {
    const bytes = brandmark(false);
    const face = brandFace(bytes);
    expect(face).toMatchObject({ family: 'Brandmark Sans1', mime: 'font/ttf', embeddable: true, rasterizable: true });
    expect(Buffer.from(face.base64, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });

  it('says what is wrong in a sentence', () => {
    expect(() => inspectFont(new Uint8Array())).toThrow(/empty/);
    expect(() => inspectFont(new TextEncoder().encode('hello, this is not a font'))).toThrow(/not a TrueType, OpenType or WOFF2 font/);
    expect(() => inspectFont(new Uint8Array(MAX_FONT_BYTES + 1))).toThrow(/larger than/);
    expect(() => inspectFont(new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0, 0, 0, 0, 1]))).toThrow(/collection/);
    expect(() => inspectFont(new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0]))).toThrow(/table directory/);
    // a WOFF2 whose compressed block is garbage
    const woff = Buffer.from(sans.woff2, 'base64');
    woff.fill(0x41, 100, 140);
    expect(() => inspectFont(new Uint8Array(woff))).toThrow(/WOFF2/);
    // a font cut short
    expect(() => inspectFont(fonts('LiberationSans-Regular.ttf').subarray(0, 5000))).toThrow();
  });

  it('refuses a variable font rather than measure one instance of it', () => {
    const bytes = Buffer.from(fonts('LiberationSans-Regular.ttf'));
    // rename one table tag to fvar in the directory: the font now claims to be variable
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint16(4);
    for (let i = 0; i < count; i += 1) {
      const at = 12 + i * 16;
      if (bytes.toString('latin1', at, at + 4) === 'post') bytes.write('fvar', at, 'latin1');
    }
    expect(() => inspectFont(new Uint8Array(bytes))).toThrow(/variable font/);
  });
});
