/**
 * The Documents tab, in the browser's own conditions.
 *
 * This suite runs under the app's Vite config, where `node:fs`/`node:url` are
 * the throwing shim — so it is the proof that `@cable-studio/docs` (and the
 * whole `render-svg` → `layout` → `catalog` chain under it) can build a bench
 * build sheet with no filesystem in reach. A document that reached for one
 * would fail here, loudly, rather than in front of a user.
 *
 * The artwork comes from the same bundled `DepictionSource` the schematic
 * preview uses, threaded through the docs package's `depictions` option.
 */

import { renderDocument } from '@cable-studio/editor-react';
import { describe, expect, it } from 'vitest';

import { liveCatalogInMemory } from './catalog-in-memory.ts';
import { browserDepictions, depictionDefsOf } from '../src/depictions.browser.ts';

const db = liveCatalogInMemory().loadDb();
const design = liveCatalogInMemory().loadDesign('db9-null-modem');

function html(result: ReturnType<typeof renderDocument>): string {
  expect('html' in result, 'error' in result ? result.error : '').toBe(true);
  return 'html' in result ? result.html : '';
}

describe('the documents, rendered the way the browser renders them', () => {

  it('builds the BOM and the continuity spec as their own printable sheets', () => {
    const bom = html(renderDocument('bom', design, db));
    expect(bom).toContain('BILL OF MATERIALS');
    expect(bom).toContain('cs-bomtable');

    const spec = html(renderDocument('test-spec', design, db));
    expect(spec).toContain('CONTINUITY &amp; TEST SPEC');
    expect(spec).toContain('cs-table--nets');
  });

});
