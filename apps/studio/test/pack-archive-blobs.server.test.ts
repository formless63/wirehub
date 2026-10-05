/** Vendor PDFs and fonts in a pack archive: which paths, which bytes, which sizes (`server/pack-archive.ts`). */

import { describe, expect, it } from 'vitest';

import { MAX_PACK_FONT_BYTES, MAX_PACK_PDF_BYTES, MAX_PACK_PDFS_TOTAL_BYTES, PackArchiveError, isPackDocPath, isPackFilePath, isPackFontPath, pdfProblem, readPackBytes } from '../server/pack-archive.ts';
import { pdfBytes } from './migration-gaps-flow.ts';
import { zipFiles } from './pack-bundle-flow.ts';

const manifest = JSON.stringify({ format: 1, id: 'blobs', name: 'Blobs', version: '1.0.0', license: 'CC0-1.0' });
const ttf = (extra = 0): Uint8Array => new Uint8Array([0x00, 0x01, 0x00, 0x00, ...new Uint8Array(32 + extra)]);

describe('what a pack may ship besides records and images', () => {
  it('names the paths: PDFs under docs/ and assets/, fonts under fonts/', () => {
    expect(isPackDocPath('docs/c146.pdf')).toBe(true);
    expect(isPackDocPath('assets/vendor/c146.pdf')).toBe(true);
    expect(isPackDocPath('docs/../c146.pdf')).toBe(false);
    expect(isPackDocPath('docs/c146.exe')).toBe(false);
    expect(isPackDocPath('other/c146.pdf')).toBe(false);
    expect(isPackDocPath('docs/.hidden.pdf')).toBe(false);
    expect(isPackFontPath('fonts/Brand-Regular.ttf')).toBe(true);
    expect(isPackFontPath('fonts/Brand.woff2')).toBe(true);
    expect(isPackFontPath('fonts/Brand.woff')).toBe(false);
    expect(isPackFilePath('docs/c146.pdf') && isPackFilePath('fonts/a.otf')).toBe(true);
  });

  it('reads a zip with PDFs and fonts, and checks the bytes', () => {
    const files = { 'wirehub-pack.json': manifest, 'docs/a.pdf': pdfBytes('a'), 'fonts/a.ttf': ttf() };
    const read = readPackBytes(zipFiles(files));
    expect([...read.files.keys()].sort()).toEqual(['docs/a.pdf', 'fonts/a.ttf', 'wirehub-pack.json']);
    expect(() => readPackBytes(zipFiles({ ...files, 'docs/b.pdf': new TextEncoder().encode('nope') }))).toThrow(/not a PDF/);
    expect(() => readPackBytes(zipFiles({ ...files, 'fonts/b.woff2': ttf() }))).toThrow(/not a WOFF2 font/);
    expect(() => readPackBytes(zipFiles({ ...files, 'fonts/b.ttf': new TextEncoder().encode('nope') }))).toThrow(/not a TrueType font/);
  });

  it('limits one PDF, all PDFs, and one font', () => {
    const pad = (n: number): Uint8Array => new Uint8Array([...pdfBytes('pad'), ...new Uint8Array(n)]);
    expect(() => readPackBytes(zipFiles({ 'wirehub-pack.json': manifest, 'docs/a.pdf': pad(MAX_PACK_PDF_BYTES) }))).toThrow(PackArchiveError);
    const each = Math.floor(MAX_PACK_PDF_BYTES * 0.9);
    const many: Record<string, Uint8Array> = { 'wirehub-pack.json': new TextEncoder().encode(manifest) };
    for (let i = 0; i * each <= MAX_PACK_PDFS_TOTAL_BYTES; i += 1) many[`docs/p${i}.pdf`] = pad(each - 1000 + i);
    expect(() => readPackBytes(new TextEncoder().encode(JSON.stringify({ format: 1, manifest: JSON.parse(manifest), files: Object.fromEntries(Object.entries(many).filter(([k]) => k !== 'wirehub-pack.json').map(([k, v]) => [k, Buffer.from(v).toString('base64')])) })))).toThrow(/PDFs add up|larger/);
    expect(() => readPackBytes(zipFiles({ 'wirehub-pack.json': manifest, 'fonts/a.ttf': ttf(MAX_PACK_FONT_BYTES) }))).toThrow(/larger than a pack font/);
  });

  it('refuses a PDF that runs or reaches out', () => {
    expect(pdfProblem(pdfBytes('ok'))).toBeUndefined();
    expect(pdfProblem(pdfBytes('x', '/Launch << /F (cmd) >> '))).toMatch(/active content/);
    expect(pdfProblem(pdfBytes('x', '/EmbeddedFile '))).toMatch(/active content/);
    // a name that merely starts with the same letters is not a script
    expect(pdfProblem(pdfBytes('x', '/JSONish 1 '))).toBeUndefined();
  });
});
