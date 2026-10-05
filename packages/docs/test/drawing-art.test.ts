/**
 * Art for the drawing sheet: registered art and depictions are used where
 * they exist, and the sheet is byte-for-byte what it was once they are gone.
 */

import { fileURLToPath } from 'node:url';

import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { depictionsFromRoot } from '@wirehub/layout';
import { findConnector, findWire } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { cutawayFor, faceFor, registerDrawingArt, renderDrawingSheet, type FaceArt } from '../src/index.ts';

const db = loadDb();
const art = depictionsFromRoot(fileURLToPath(new URL('../../catalog/depictions', import.meta.url)));
const de9 = findConnector(db, 'de9-male')!;
const pinIds = de9.pins.map((p) => p.id).filter((id) => id !== 'shell');

const stub: FaceArt = {
  material: 'Stub',
  width: 40,
  height: 20,
  art: [{ d: 'M0 0H40V20H0Z', stroke: '#000000', width: 1 }],
  pins: [{ id: '1', x: 10, y: 10, w: 6, h: 6, shape: 'circle' }],
  labels: [],
  src: 'test',
};

describe('registered drawing art', () => {
  it('replaces a face, the title-block text and the logo, and leaves no trace when removed', () => {
    const id = listDesignIds().find((d) => loadDesign(d).instances.connectors.some((c) => c.def === 'de9-male'))!;
    const design = loadDesign(id);
    const before = renderDrawingSheet(design, db);
    const off = registerDrawingArt({
      faces: { 'de9-male': stub },
      titleBlock: { notes: ['DIMENSIONS IN', 'INCHES', 'UNLESS NOTED'], size: 'B' },
      logo: { pngBase64: 'iVBORw0KGgo=', box: [10, 10, 40, 20] },
    });
    try {
      expect(faceFor(de9, pinIds)).toMatchObject({ source: 'traced', face: { material: 'Stub' } });
      const during = renderDrawingSheet(design, db);
      expect(during).toContain('INCHES');
      expect(during).toContain('data:image/png;base64,iVBORw0KGgo=');
      expect(during).not.toBe(before);
    } finally {
      off();
    }
    expect(renderDrawingSheet(design, db)).toBe(before);
    expect(faceFor(de9, pinIds).source).toBe('drawn');
  });

  it('rejects nothing silently: face art without pins is reported by the host check', async () => {
    const { drawingArtProblems } = await import('../src/drawing/assets.ts');
    expect(drawingArtProblems({ faces: { x: { width: 1 } } })).toHaveLength(1);
    expect(drawingArtProblems({ faces: { x: stub } })).toEqual([]);
  });
});

describe('depictions on the sheet', () => {
  it('draws a catalog depiction as the connector\'s solder-side face, and the stock\'s illustration as its cutaway', () => {
    const off = registerDrawingArt({ depictions: art });
    try {
      const { face, source } = faceFor(de9, pinIds);
      expect(source).toBe('traced');
      expect(face.pins.map((p) => p.id).sort()).toEqual([...pinIds].sort());
      // solder side: pin 1 (left on the mating face) is on the right
      const p1 = face.pins.find((p) => p.id === '1')!;
      const p5 = face.pins.find((p) => p.id === '5')!;
      expect(p1.x).toBeGreaterThan(p5.x);
      expect(cutawayFor(findWire(db, 'multicore-3coax-4core')!).source).toBe('art');
      expect(cutawayFor(findWire(db, 'cat5e-utp')!).source).toBe('drawn');
    } finally {
      off();
    }
    expect(faceFor(de9, pinIds).source).toBe('drawn');
  });
});
