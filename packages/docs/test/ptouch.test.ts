import { describe, expect, it } from 'vitest';
import { parseLbx } from 'bil-lbx';
import { loadDb, loadDesign } from '@wirehub/catalog';

import {
  BASE_EXPORTS,
  LABEL_PRESETS,
  TAPE_WIDTHS,
  deriveLabels,
  fillTemplate,
  labelPresetOf,
  labelSheetPages,
  labelSheetSvg,
  labelTemplateProblems,
  lbxExport,
  lbxFile,
  lbxParts,
  registerDrawingArt,
  tapeLayout,
  type WireLabel,
} from '../src/index.ts';

const label: WireLabel = {
  id: 'trunk/a',
  segment: 'trunk',
  end: 'a',
  designation: 'W1',
  lines: ['W1-A', 'Source end: DE-9', 'Destination end: DE-9'],
  offsetMm: 40,
  position: '40 mm from the source end of the jacket',
};
const content = { pn: 'CBL-00001', rev: '2' };
const white = labelPresetOf('tze-12-335')!;
const unzip = (bytes: Uint8Array): Map<string, Uint8Array> => {
  // stored zip: walk the local headers
  const out = new Map<string, Uint8Array>();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (v.getUint32(at, true) === 0x04034b50) {
    const size = v.getUint32(at + 18, true);
    const nameLen = v.getUint16(at + 26, true);
    const extra = v.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    out.set(name, bytes.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size));
    at += 30 + nameLen + extra + size;
  }
  return out;
};

describe('tape presets', () => {
  it('has the TZe widths and the 12 mm colour pairs, each with a source', () => {
    expect(TAPE_WIDTHS.map((w) => w.mm)).toEqual([3.5, 6, 9, 12, 18, 24, 36]);
    const ids = LABEL_PRESETS.filter((p) => p.kind === 'tape').map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['tze-12-335', 'tze-12-231', 'tze-12-131', 'tze-9-325', 'tze-18-345', 'tze-24-355']));
    for (const p of LABEL_PRESETS.filter((x) => x.kind === 'tape')) {
      expect(p.src).toMatch(/Brother/);
      expect(p.layout.pageHeight).toBe(p.tape!.width.mm);
    }
    expect(white.tape).toMatchObject({ code: 'TZe-335', tapeColor: '#000000', inkColor: '#ffffff' });
    const w12 = TAPE_WIDTHS.find((w) => w.mm === 12)!;
    expect([w12.paperPt, w12.marginPt, w12.format, w12.printableDots * 0.4]).toEqual([33.6, 2.8, 259, 28]);
  });
});

describe('tape label layout and SVG', () => {
  it('draws white ink on black tape at the tape width, auto length', () => {
    const svg = labelSheetSvg([label], { preset: 'tze-12-335', pn: content.pn, rev: content.rev });
    expect(svg).toMatch(/height="12mm"/);
    expect(svg).toContain('fill="#000000"/>');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('W1-A');
    expect(svg).toContain('CBL-00001 rev 2');
    expect(svg).toContain('data-auto-length="true"');
    expect(labelSheetSvg([label], { preset: 'tze-12-335', pn: 'CBL-00001' })).toBe(labelSheetSvg([label], { preset: 'tze-12-335', pn: 'CBL-00001' }));
  });

  it('is one label per page, and the auto length follows the text', () => {
    expect(labelSheetPages(5, { preset: 'tze-12-335' })).toBe(5);
    const short = tapeLayout({ ...label, lines: ['W1-A'] }, white, {});
    const long = tapeLayout(label, white, content);
    expect(long.lengthMm).toBeGreaterThan(short.lengthMm);
    expect(long.rows.length).toBe(3);
    // every line sits inside the printable band
    for (const r of long.rows) {
      expect(r.top).toBeGreaterThanOrEqual(long.bandTop - 1e-6);
      expect(r.top + r.height).toBeLessThanOrEqual(long.bandTop + long.bandHeight + 1e-6);
    }
  });

  it('puts the QR on when its modules print at two dots or more, else says it is left out', () => {
    expect(tapeLayout(label, white, { ...content, qr: true }).qr).toBeDefined();
    const narrow = tapeLayout(label, labelPresetOf('tze-6-315')!, { ...content, qr: true });
    expect(narrow.qr).toBeUndefined();
    expect(narrow.qrNote).toMatch(/omitted/);
    expect(labelSheetSvg([label], { preset: 'tze-6-315', qr: true, pn: 'X' })).toContain('data-qr-omitted');
    expect(labelSheetSvg([label], { preset: 'tze-12-335', qr: true, pn: 'X' })).toContain('data-qr=');
  });
});

describe('label templates', () => {
  it('fills tokens, drops empty lines and checks a template', () => {
    const facts = { lines: label.lines, designation: 'W1', end: 'a' as const, pn: 'CBL-00001', rev: '2', label: 'trunk/a' };
    expect(fillTemplate('{headline} / {pnrev}', facts)).toBe('W1-A / CBL-00001 rev 2');
    expect(fillTemplate('{details}', facts, ' | ')).toBe('Source end: DE-9 | Destination end: DE-9');
    expect(fillTemplate('{rev}', { ...facts, rev: '—' })).toBe('');
    expect(labelTemplateProblems('house', { label: 'House', src: 'Shop', lines: [{ text: '{headline}' }] })).toEqual([]);
    expect(labelTemplateProblems('house', { label: 'House', src: 'Shop', lines: [{ text: '{nope}', size: 1 }] })).toHaveLength(2);
  });

  it('a registered template, with its own font and a fixed length, drives the layout and the .lbx', () => {
    const off = registerDrawingArt({
      labelTemplates: {
        house: { label: 'House', src: 'test', family: 'Example Sans', length: 60, align: 'center', lines: [{ text: '{headline} → {line2}', weight: 'bold' }, { text: '{pnrev}', family: 'Example Mono', size: 6 }] },
      },
    });
    try {
      const layout = tapeLayout(label, white, { ...content, template: 'house' });
      expect(layout.autoLength).toBe(false);
      expect(layout.lengthMm).toBe(60);
      expect(layout.rows.map((r) => r.family)).toEqual(['Example Sans', 'Example Mono']);
      const parts = lbxParts(label, white, { ...content, template: 'house' });
      expect(parts.labelXml).toContain('name="Example Mono"');
      expect(parts.labelXml).toContain('autoLength="false"');
      expect(parts.labelXml).toContain('height="170.1pt"');
    } finally {
      off();
    }
    expect(tapeLayout(label, white, { template: 'house' }).template.label).not.toBe('House');
  });
});

describe('.lbx export', () => {
  const options = { preset: 'tze-12-335', pn: 'CBL-00001', rev: '2', design: 'de9' };

  it('round-trips through an independent parser', async () => {
    const { bytes } = lbxFile(label, white, options);
    const entries = unzip(bytes);
    expect([...entries.keys()]).toEqual(['label.xml', 'prop.xml']);
    const parsed = await parseLbx(bytes);
    expect(parsed.paper).toMatchObject({ width: 33.6, orientation: 'landscape', autoLength: true, format: 259, marginLeft: 2.8 });
    const texts = parsed.objects.filter((o) => o.type === 'text');
    expect(texts.map((o) => o.data)).toEqual(['W1-A', 'Source end: DE-9 · Destination end: DE-9', 'CBL-00001 rev 2']);
    expect(texts.every((o) => o.position.y >= 2.8 && o.position.y + o.position.height <= 33.6 - 2.8 + 0.2)).toBe(true);
    expect(texts[0]!.font.weight).toBe(700);
    const xml = new TextDecoder().decode(entries.get('label.xml'));
    expect(xml).toContain('paperColor="#000000" paperInk="#FFFFFF"');
  });

  it('is deterministic, carries the printer and a fixed time, and writes light ink on light tape', () => {
    const a = lbxParts(label, white, options);
    expect(lbxParts(label, white, options)).toEqual(a);
    expect(a.propXml).toContain('2000-01-01T00:00:00Z');
    expect(a.labelXml).toContain('printerID="0" printerName="Brother P-touch"');
    expect(lbxParts(label, white, { ...options, printer: 'pt-d610bt' }).labelXml).toContain('printerID="31792" printerName="Brother PT-D610BT"');
    expect(lbxParts(label, labelPresetOf('tze-12-231')!, options).labelXml).toContain('paperColor="#FFFFFF" paperInk="#000000"');
  });

  it('writes a QR object on light tape only, and says so for dark tape', async () => {
    const light = lbxParts(label, labelPresetOf('tze-12-231')!, { ...options, qr: true });
    expect(light.labelXml).toContain('protocol="QRCODE"');
    expect((await parseLbx(lbxFile(label, labelPresetOf('tze-12-231')!, { ...options, qr: true }).bytes)).objects.some((o) => o.type === 'barcode')).toBe(true);
    const dark = lbxParts(label, white, { ...options, qr: true });
    expect(dark.labelXml).not.toContain('barcode:barcode');
    expect(dark.notes.join(' ')).toMatch(/QR left out/);
  });

  it('exports a design: a zip of one file per label, or one file for a page', () => {
    const design = loadDesign('de9-crossover');
    const db = loadDb();
    const labels = deriveLabels(design, db);
    const many = lbxExport(labels, options, 'x');
    expect(many.mimeType).toBe('application/zip');
    const names = [...unzip(many.body).keys()];
    expect(names).toHaveLength(labels.length);
    expect(new Set(names).size).toBe(names.length);
    const one = lbxExport(labels, { ...options, page: 2 }, 'x');
    expect(one.fileName).toMatch(/\.lbx$/);
    expect([...unzip(one.body).keys()]).toEqual(['label.xml', 'prop.xml']);
    const viaFormat = BASE_EXPORTS.find((f) => f.id === 'labels.lbx')!.render(design, db, { preset: 'tze-12-335' });
    expect(viaFormat.fileName).toMatch(/labels\.zip$/);
    expect(() => lbxExport(labels, { preset: 'a4-l7160' })).toThrow(/not a P-touch tape/);
  });
});
