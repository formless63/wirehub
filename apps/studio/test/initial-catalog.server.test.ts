/** The catalogs a new organisation starts from (plan §9.4): both import cleanly and load. */

import { createCatalog, memoryCatalogSource } from '@wirehub/catalog';
import { dataFileMap, explode, render } from '@wirehub/catalog/src/codec/index.ts';
import { describe, expect, it } from 'vitest';

import { initialCatalog } from '../server/pg/setup-mode.ts';

describe('initial catalogs', () => {
  for (const kind of ['starter', 'empty'] as const) {
    it(`${kind}: explodes without a problem and loads`, () => {
      const { rows, errors } = explode(initialCatalog(kind));
      expect(errors).toEqual([]);
      const catalog = createCatalog(memoryCatalogSource(dataFileMap(render(rows))));
      const db = catalog.loadDb();
      expect(Object.keys(db.vocab ?? {}).length).toBeGreaterThan(10);
      if (kind === 'empty') {
        expect(db.connectors).toEqual([]);
        expect(catalog.listDesignIds()).toEqual([]);
      } else expect(catalog.listDesignIds().length).toBe(4);
    });
  }
});
