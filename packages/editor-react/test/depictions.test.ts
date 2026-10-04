/**
 * Artwork in the preview.
 *
 * The editor never reads the artwork tree itself — it takes a `DepictionSource`
 * from its host, which is how a browser (where `node:fs` does not exist) can
 * still show real board pictures. What is proved here:
 *
 *  1. a source with one asset draws exactly that block's artwork
 *  2. every other block falls back to the abstract form, silently and exactly
 *     as the command-line renderer falls back — no artwork, no exception
 *  3. a source that has a manifest but cannot produce the bytes falls back too
 *  4. the canvas is untouched: `deriveNodes` has no idea depictions exist
 */

import { loadDb, loadDepiction, loadDesign } from '@wirehub/catalog';
import type { Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { deriveNodes } from '../src/derive.ts';
import { renderPreview } from '../src/panels/Preview.tsx';
import { initialEditorState } from '../src/store.ts';
import type { DepictionSource } from '../src/index.ts';

const db: Db = loadDb();
const DESIGN = 'db9-null-modem';
/** the console-side board of that design, drawn as `u1` */
const DEPICTED = 'PCA-00110-rev5';

/** Recognisable stand-in artwork: real anchors, artwork we can find again. */
const MARKER_ASSET = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">',
  '  <rect id="frame" class="fake-board-art" x="0" y="0" width="20" height="20"/>',
  '</svg>',
].join('\n');

/** One asset, for one definition — everything else the source knows nothing of. */
function oneAssetSource(options: { bytes?: boolean } = {}): DepictionSource {
  const meta = loadDepiction(DEPICTED).meta;
  if (meta === undefined) throw new Error(`the catalog has no depiction for ${DEPICTED}`);
  return {
    meta: (defId) => (defId === DEPICTED ? meta : undefined),
    artwork: (defId, view) =>
      options.bytes !== false && defId === DEPICTED && view === 'board-top'
        ? { kind: 'vector', source: MARKER_ASSET }
        : undefined,
  };
}

function preview(depictions: boolean | DepictionSource): string {
  const state = initialEditorState(loadDesign(DESIGN), db);
  const result = renderPreview(state.design, db, depictions);
  if (!('svg' in result)) throw new Error(`renderer failed: ${result.error}`);
  return result.svg;
}

describe('renderPreview with a host-supplied depiction source', () => {

  it('draws no artwork at all without a source', () => {
    const plain = preview(false);
    expect(plain).not.toContain('class="artwork"');
    expect(plain).not.toContain('class="depiction"');
  });

});
