/**
 * Organisation identity registered as title-block text (cs-5k1.2): the drawing
 * sheet, the wire spec and the bench header print it; unset keeps the generic
 * text; art registered earlier (a module's) wins.
 */

import { loadDb, loadDesign, listDesignIds } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { headerHtml, registerDrawingArt, renderDrawingSheet, renderWireSpecSheet, sheetHeader } from '../src/index.ts';
import { registeredTitleBlock } from '../src/drawing/assets.ts';

const db = loadDb();
const design = loadDesign(listDesignIds()[0]!);

describe('title-block branding', () => {
  it('prints the organisation, rights line and default designer, and leaves no trace when removed', () => {
    const wire = db.wires[0]!;
    const before = [renderDrawingSheet(design, db), renderWireSpecSheet(wire), headerHtml(sheetHeader(design, db, { kind: 'BUILD' }))];
    const off = registerDrawingArt({ titleBlock: { organisation: 'Acme Cable Co', rights: 'Confidential - Acme Cable Co', designer: 'J. Doe', standard: 'Acme Standard' } });
    try {
      const sheet = renderDrawingSheet(design, db);
      expect(sheet).toContain('Confidential - Acme Cable Co');
      expect(sheet).toContain('J. Doe');
      const spec = renderWireSpecSheet(wire);
      expect(spec).toContain('ACME CABLE CO');
      expect(spec).toContain('Acme Standard');
      expect(spec).toContain('Confidential - Acme Cable Co');
      const bench = headerHtml(sheetHeader(design, db, { kind: 'BUILD' }));
      expect(bench).toContain('Acme Cable Co');
      expect(bench).toContain('Confidential');
    } finally {
      off();
    }
    expect([renderDrawingSheet(design, db), renderWireSpecSheet(wire), headerHtml(sheetHeader(design, db, { kind: 'BUILD' }))]).toEqual(before);
    expect(before[1]).toContain('WIREHUB');
  });

  it('the first registration to set a part wins', () => {
    const offs = [registerDrawingArt({ titleBlock: { organisation: 'Module Org' } }), registerDrawingArt({ titleBlock: { organisation: 'Setting Org', rights: 'R' } })];
    try {
      expect(registeredTitleBlock()).toMatchObject({ organisation: 'Module Org', rights: 'R' });
    } finally {
      offs.forEach((off) => off());
    }
  });
});
