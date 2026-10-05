import { describe, expect, it } from 'vitest';

import { fixtureCatalog, fixtureDepictionsRoot, listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { depictionsFromRoot } from '@wirehub/layout';

import { renderSchematic } from '../src/index.ts';

/**
 * The goldens render the frozen fixture catalog (`packages/catalog/fixtures/v1`)
 * — its designs, its definitions and its own artwork — so
 * an edit to a live design in the studio never fails this file. Every live
 * design is still rendered and checked, by invariant rather than by bytes, in
 * `audit.test.ts`, `structure.test.ts`, `determinism.test.ts` and the via check
 * at the bottom of this file.
 */
const fixture = fixtureCatalog();
const fixtureArt = depictionsFromRoot(fixtureDepictionsRoot());

/**
 * PCBA `via` strings are human-readable catalog prose ("R203 180 Ω blanking")
 * that is expected to be reworded as the boards get re-verified. The drawing
 * treats them as opaque annotation content and no geometry depends on them
 * (the PCBA corridor is a constant), so the golden masks the annotations out:
 * a reworded `via` must not fail this test, while anything that actually moves
 * on the page must.
 */
function maskVia(svg: string): string {
  return svg
    .replace(/(?:<text class="annot"[^>]*>[^<]*<\/text>)+/g, '<text class="annot">«via»</text>')
    // a `via` said by the board part it runs through keeps its words as the
    // link's tooltip
    .replace(/(<g class="pcba-link"[^>]*>)<title>[^<]*<\/title>/g, '$1<title>«via»</title>');
}

/** One element per line, so a golden diff is reviewable. */
function pretty(svg: string): string {
  return svg.replace(/></g, '>\n<');
}

describe('golden schematics', () => {
  const db = fixture.loadDb();
  for (const id of fixture.listDesignIds()) {
    /**
     * `depictions: false` is the drawing as it stood before artwork existed,
     * and this snapshot is the one it has always matched — untouched when
     * depictions landed. That makes the fallback path *provably* unchanged:
     * every block that cannot be depicted still draws exactly these bytes.
     */
    it(`${id} matches its golden drawing`, () => {
      expect(
        pretty(maskVia(renderSchematic(fixture.loadDesign(id), db, { depictions: false }))),
      ).toMatchSnapshot();
    });

    /** The same page with artwork on — depicted blocks and all. */
    it(`${id} matches its depicted golden drawing`, () => {
      expect(pretty(maskVia(renderSchematic(fixture.loadDesign(id), db, { depictions: fixtureArt })))).toMatchSnapshot();
    });
  }

  it('does not move a single coordinate when a via annotation is reworded', () => {
    const original = loadDb();
    const reworded = loadDb();
    for (const pcba of reworded.pcbas) {
      for (const link of pcba.internalLinks) {
        if (link.via !== undefined) {
          link.via = `${link.via} — reworded during board re-verification, at length`;
        }
      }
    }
    for (const id of listDesignIds()) {
      const design = loadDesign(id);
      expect(maskVia(renderSchematic(design, reworded))).toBe(
        maskVia(renderSchematic(design, original)),
      );
    }
    // two renders of every catalog design (see depictions.test.ts)
  }, 30_000);
});
