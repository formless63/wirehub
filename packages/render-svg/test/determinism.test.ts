import { describe, expect, it } from 'vitest';

import { listDesignIds, loadDb, loadDesign } from '@cable-studio/catalog';

import { renderSchematic } from '../src/index.ts';

describe('determinism', () => {
  for (const id of listDesignIds()) {
    it(`${id} renders byte-identically twice`, () => {
      const first = renderSchematic(loadDesign(id), loadDb());
      const second = renderSchematic(loadDesign(id), loadDb());
      expect(second).toBe(first);
    });

    it(`${id} does not depend on object identity`, () => {
      // fresh loads produce fresh objects; a Map keyed on identity or an
      // insertion-ordered set would show up here
      const db = loadDb();
      const design = loadDesign(id);
      const a = renderSchematic(design, db);
      const b = renderSchematic(
        JSON.parse(JSON.stringify(design)) as typeof design,
        JSON.parse(JSON.stringify(db)) as typeof db,
      );
      expect(b).toBe(a);
    });

    it(`${id} rounds every coordinate to 0.01`, () => {
      const svg = renderSchematic(loadDesign(id), loadDb());
      const numbers = svg.match(/-?\d+\.\d{3,}/g) ?? [];
      expect(numbers).toEqual([]);
    });
  }

  it('renders the three fixtures to different drawings', () => {
    const db = loadDb();
    const rendered = listDesignIds().map((id) => renderSchematic(loadDesign(id), db));
    expect(new Set(rendered).size).toBe(listDesignIds().length);
  });
});
