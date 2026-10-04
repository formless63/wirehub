/**
 * The browser depiction source.
 *
 * Two halves, tested apart: the pure assembly rules (which the renderer leans
 * on when artwork is missing or mislabelled), and the globs themselves — the
 * one thing a unit test of the pure half cannot catch is a path pattern that
 * matches nothing, which is exactly how this feature would silently do nothing.
 */

import { renderPreview } from '@wirehub/editor-react';
import { describe, expect, it } from 'vitest';

import { cableListRows, liveCatalogInMemory } from './catalog-in-memory.ts';

const catalog = liveCatalogInMemory();
const loadDbInBrowser = catalog.loadDb;
const loadDesignInBrowser = catalog.loadDesign;
const bundledDesignIds = catalog.listDesignIds;
const bundledCableList = cableListRows;
import { assembleDepictionSource, browserDepictions, depictionDefsOf, lazyDepictions, versionDepictionSource } from '../src/depictions.browser.ts';

const DIR = '../../../packages/catalog/depictions';

/** A minimal, valid manifest for a made-up definition. */
function meta(defId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    defId,
    anchorFrame: 'board-top',
    src: 'test fixture',
    views: {
      'board-top': {
        file: 'board-top.svg',
        kind: 'vector',
        mmPerUnit: 1,
        sourceKind: 'kicad',
        widthUnits: 10,
        heightUnits: 10,
        src: 'test fixture',
      },
    },
    pinAnchors: { '1': { x: 1, y: 1 } },
    ...extra,
  };
}

const ART = '<svg viewBox="0 0 10 10"><rect id="frame" width="10" height="10"/></svg>';

describe('assembleDepictionSource', () => {
  it('keys manifests by directory and hands back the matching artwork', () => {
    const source = assembleDepictionSource({
      meta: { [`${DIR}/fake-board/meta.json`]: meta('fake-board') },
      vector: { [`${DIR}/fake-board/board-top.svg`]: ART },
    });

    expect(source.meta('fake-board')?.defId).toBe('fake-board');
    expect(source.artwork('fake-board', 'board-top')).toEqual({ kind: 'vector', source: ART });
  });

  it('knows nothing about definitions the tree has no directory for', () => {
    const source = assembleDepictionSource({ meta: {}, vector: {} });
    expect(source.meta('fake-board')).toBeUndefined();
    expect(source.artwork('fake-board', 'board-top')).toBeUndefined();
  });

  it('returns nothing for a view the manifest does not declare', () => {
    const source = assembleDepictionSource({
      meta: { [`${DIR}/fake-board/meta.json`]: meta('fake-board') },
      vector: { [`${DIR}/fake-board/board-top.svg`]: ART },
    });
    expect(source.artwork('fake-board', 'mating-face')).toBeUndefined();
  });

  it('returns nothing when the file the manifest names was not bundled', () => {
    const source = assembleDepictionSource({
      meta: { [`${DIR}/fake-board/meta.json`]: meta('fake-board') },
      vector: {},
    });
    // the manifest is still there, so layout reports `unreadable-asset` and
    // draws the abstract block — the same fallback the CLI takes
    expect(source.meta('fake-board')).toBeDefined();
    expect(source.artwork('fake-board', 'board-top')).toBeUndefined();
  });

  it('drops a manifest that will not parse, rather than throwing', () => {
    const source = assembleDepictionSource({
      meta: {
        [`${DIR}/broken/meta.json`]: { defId: 'broken' },
        [`${DIR}/nonsense/meta.json`]: 'not an object',
        [`${DIR}/fake-board/meta.json`]: meta('fake-board'),
      },
      vector: {},
    });
    expect(source.meta('broken')).toBeUndefined();
    expect(source.meta('nonsense')).toBeUndefined();
    expect(source.meta('fake-board')).toBeDefined();
  });

  it('ignores a manifest that sits in the wrong directory', () => {
    const source = assembleDepictionSource({
      meta: { [`${DIR}/fake-board/meta.json`]: meta('some-other-board') },
      vector: {},
    });
    expect(source.meta('fake-board')).toBeUndefined();
    expect(source.meta('some-other-board')).toBeUndefined();
  });

  it('refuses a file name that tries to leave its own directory', () => {
    const escaping = meta('fake-board', {
      views: {
        'board-top': {
          file: '../elsewhere/board-top.svg',
          kind: 'vector',
          mmPerUnit: 1,
          sourceKind: 'kicad',
          widthUnits: 10,
          heightUnits: 10,
          src: 'test fixture',
        },
      },
    });
    const source = assembleDepictionSource({
      meta: { [`${DIR}/fake-board/meta.json`]: escaping },
      vector: { [`${DIR}/fake-board/board-top.svg`]: ART },
    });
    expect(source.artwork('fake-board', 'board-top')).toBeUndefined();
  });

  it('will not pass vector bytes off as the raster the manifest declared', () => {
    const raster = meta('fake-board', {
      views: {
        'board-top': {
          file: 'board-top.png',
          kind: 'raster',
          mmPerUnit: 1,
          sourceKind: 'photo',
          widthUnits: 10,
          heightUnits: 10,
          src: 'test fixture',
        },
      },
    });
    const source = assembleDepictionSource({
      meta: { [`${DIR}/fake-board/meta.json`]: raster },
      vector: { [`${DIR}/fake-board/board-top.png`]: ART },
    });
    expect(source.artwork('fake-board', 'board-top')).toBeUndefined();
  });

  it('embeds raster art only when it arrives as its own bytes', () => {
    const raster = meta('fake-board', {
      views: {
        'board-top': {
          file: 'board-top.png',
          kind: 'raster',
          mmPerUnit: 1,
          sourceKind: 'photo',
          widthUnits: 10,
          heightUnits: 10,
          src: 'test fixture',
        },
      },
    });
    const inlined = assembleDepictionSource({
      meta: { [`${DIR}/fake-board/meta.json`]: raster },
      vector: {},
      raster: { [`${DIR}/fake-board/board-top.png`]: 'data:image/png;base64,AAAA' },
    });
    expect(inlined.artwork('fake-board', 'board-top')).toEqual({
      kind: 'raster',
      dataUri: 'data:image/png;base64,AAAA',
    });

    // a URL out of the bundle would break the drawing's self-containment
    const referenced = assembleDepictionSource({
      meta: { [`${DIR}/fake-board/meta.json`]: raster },
      vector: {},
      raster: { [`${DIR}/fake-board/board-top.png`]: '/assets/board-top-a1b2.png' },
    });
    expect(referenced.artwork('fake-board', 'board-top')).toBeUndefined();
  });
});

describe('the lazy source (udy.9)', () => {
  const later = <T,>(value: T) => {
    let calls = 0;
    const load = async (): Promise<T> => {
      calls += 1;
      return value;
    };
    return Object.assign(load, { calls: () => calls });
  };

  it('answers nothing until a definition is loaded, then a new snapshot has it', async () => {
    const metaLoader = later(meta('board-1'));
    const svgLoader = later(ART);
    const lazy = lazyDepictions({ meta: { [`${DIR}/board-1/meta.json`]: metaLoader }, vector: { [`${DIR}/board-1/board-top.svg`]: svgLoader } });
    const before = lazy.current();
    expect(before.meta('board-1')).toBeUndefined();
    await lazy.load(['board-1', 'rca-male']);
    const after = lazy.current();
    expect(after).not.toBe(before);
    expect(after.meta('board-1')?.defId).toBe('board-1');
    expect(after.artwork('board-1', 'board-top')).toEqual({ kind: 'vector', source: ART });
    // fetched once, however often it is asked for
    await lazy.load(['board-1']);
    expect(metaLoader.calls()).toBe(1);
    expect(svgLoader.calls()).toBe(1);
  });

  it('a miss starts the fetch, and subscribers hear when it lands', async () => {
    const lazy = lazyDepictions({ meta: { [`${DIR}/board-2/meta.json`]: later(meta('board-2')) }, vector: { [`${DIR}/board-2/board-top.svg`]: later(ART) } });
    let heard = 0;
    const off = lazy.subscribe(() => void (heard += 1));
    expect(lazy.current().artwork('board-2', 'board-top')).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toBe(1);
    expect(lazy.current().artwork('board-2', 'board-top')?.kind).toBe('vector');
    off();
  });

  it('a chunk that fails to load leaves the block abstract and is retried', async () => {
    let fail = true;
    const lazy = lazyDepictions({
      meta: { [`${DIR}/board-3/meta.json`]: async () => (fail ? Promise.reject(new Error('offline')) : meta('board-3')) },
      vector: { [`${DIR}/board-3/board-top.svg`]: later(ART) },
    });
    await lazy.load(['board-3']);
    // asking again retries — and this retry fails too
    expect(lazy.current().meta('board-3')).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fail = false;
    await lazy.load(['board-3']);
    expect(lazy.current().meta('board-3')).toBeDefined();
  });
});

describe('the bundled tree', () => {
  const lazy = browserDepictions();

  it('says nothing about a definition with no depiction', () => {
    expect(lazy.current().meta('rca-male')).toBeUndefined();
    expect(lazy.current().artwork('rca-male', 'mating-face')).toBeUndefined();
  });

  it('is one memoised loader, so what is fetched is shared', () => {
    expect(browserDepictions()).toBe(lazy);
  });
});

/**
 * The whole browser path, end to end — and the proof that it *is* the browser
 * path: this suite runs under the app's own Vite config, where `node:fs` is the
 * throwing shim. A render that reached for the filesystem would fail here.
 */
describe('the preview, rendered the way the browser renders it', () => {
  const db = loadDbInBrowser();
  const design = loadDesignInBrowser('de9-crossover');

  it('still draws the abstract blocks when the host asks for none', () => {
    const result = renderPreview(design, db, false);
    expect('svg' in result).toBe(true);
    if (!('svg' in result)) return;
    expect(result.svg).not.toContain('class="artwork"');
  });

  it('falls back per block, exactly as the command-line renderer does', () => {
    // a design whose boards the bundled tree has no manifest for still renders
    const thin = assembleDepictionSource({ meta: {}, vector: {} });
    const result = renderPreview(design, db, thin);
    expect('svg' in result).toBe(true);
    if (!('svg' in result)) return;
    expect(result.svg).not.toContain('class="artwork"');
    expect(result.svg.startsWith('<svg')).toBe(true);
  });
});

describe('the definitions the browser bundles', () => {
  // the browser loader mirrors the catalog's loadPcbas; a board only one of them
  // knows (e.g. a KiCad-direct revision) shows up here as an unknown-def
  it('resolve every board every bundled design uses', () => {
    const ids = new Set(loadDbInBrowser().pcbas.map((pcba) => pcba.id));
    const missing = bundledDesignIds().flatMap((id) =>
      loadDesignInBrowser(id)
        .instances.pcbas.filter((pcba) => !ids.has(pcba.def))
        .map((pcba) => `${id}:${pcba.def}`),
    );
    expect(missing).toEqual([]);
  });

  it('resolve every shell and fastener every bundled design uses', () => {
    const ids = new Set((loadDbInBrowser().mechanicals ?? []).map((part) => part.id));
    const missing = bundledDesignIds().flatMap((id) =>
      (loadDesignInBrowser(id).instances.mechanical ?? [])
        .filter((part) => !ids.has(part.def))
        .map((part) => `${id}:${part.def}`),
    );
    expect(missing).toEqual([]);
  });

});

describe('a saved revision draws its own artwork (pci.27)', () => {
  const live = assembleDepictionSource({
    meta: { 'x/board/meta.json': meta('board'), 'x/added/meta.json': meta('added'), 'x/bare/meta.json': meta('bare') },
    vector: { 'x/board/board-top.svg': '<svg id="today"/>', 'x/added/board-top.svg': ART, 'x/bare/board-top.svg': ART },
  });
  const own = { meta: { 'board/meta.json': meta('board') }, vector: { 'board/board-top.svg': '<svg id="saved"/>' }, raster: {} };
  const source = versionDepictionSource(own, new Set(['board', 'bare']), live);

  it('covered parts draw the saved copy, not today\'s', () => {
    expect(source.artwork('board', 'board-top')).toEqual({ kind: 'vector', source: '<svg id="saved"/>' });
  });
  it('a covered part that had no artwork when saved stays abstract', () => {
    expect(source.meta('bare')).toBeUndefined();
    expect(source.artwork('bare', 'board-top')).toBeUndefined();
  });
  it('a part the revision never froze draws today\'s artwork', () => {
    expect(source.artwork('added', 'board-top')).toEqual({ kind: 'vector', source: ART });
  });
});
