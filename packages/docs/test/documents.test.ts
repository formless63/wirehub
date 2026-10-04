/**
 * Every document over every example design: deterministic, self-contained,
 * and agreeing with the structured BOM.
 */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign, loadDesigns } from '@wirehub/catalog';
import { DEFAULT_PART_NUMBER_SCHEME, knownPartNumbers } from '@wirehub/model';

import { deriveBom, deriveBomSheet, renderBomMarkdown, renderBuildSheet, renderDrawingSheet, renderTestSpecSheet } from '../src/index.ts';

const db = loadDb();

describe.each(listDesignIds())('%s', (id) => {
  const design = loadDesign(id);

  it('every document is deterministic and carries no external resource', () => {
    for (const render of [
      () => renderBuildSheet(design, db, { depictions: false }),
      () => renderTestSpecSheet(design, db),
      () => renderDrawingSheet(design, db),
    ]) {
      const a = render();
      expect(render()).toBe(a);
      expect(a).not.toMatch(/<link\b|<script\b|\bsrc="https?:|url\(https?:/);
    }
  });

  it('the BOM sheet prints one line per BOM line (the trunk once per variation)', () => {
    const bom = deriveBom(design, db);
    const sheet = deriveBomSheet(design, db);
    expect(sheet.lines.length).toBeGreaterThanOrEqual(bom.lines.length);
    expect(sheet.lines.every((line) => line.state === 'mapped' || line.reason !== undefined)).toBe(true);
  });
});

describe('the BOM against the numbering scheme', () => {
  it('every starter part is numbered, so nothing is unmapped', () => {
    for (const design of loadDesigns()) {
      const sheet = deriveBomSheet(design, db);
      expect(sheet.lines.filter((l) => l.state === 'unmapped').map((l) => l.ref), design.id).toEqual([]);
    }
  });

  it('proposes a product number for a design that has none, from the scheme', () => {
    const sheet = deriveBomSheet(loadDesign('xlr-mic-cable'), db, {
      partNumbers: { scheme: DEFAULT_PART_NUMBER_SCHEME, known: knownPartNumbers(db, loadDesigns()) },
    });
    expect(sheet.productProposal?.pn).toBe('CBL-00001');
  });

  it('the markdown BOM names the parts by part number', () => {
    const md = renderBomMarkdown(loadDesign('rj45-patch-t568b'), db, { depictions: false });
    expect(md).toContain('CON-');
    expect(md).toContain('WIR-00001');
  });
});
