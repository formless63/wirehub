/**
 * The starter face art: every file is what the generator writes, every
 * depiction validates against the catalog it ships with (so its anchors are
 * the pinouts' positions), each carries a CC0 `src`, and each pin element
 * sits on its anchor.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createCatalog, dataPath, fsCatalogSource, installPackLayer, layeredCatalogSource, loadPackArt } from '../src/index.ts';
import { loadDepiction } from '../src/depictions/index.ts';
import { faceArtFiles } from '../scripts/face-art.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const modules = readdirSync(join(ROOT, 'modules')).filter((m) => existsSync(join(ROOT, 'modules', m, 'pack', 'wirehub-pack.json')) && m !== 'example');
const packDirs = modules.map((m) => join(ROOT, 'modules', m, 'pack'));
const db = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), ...packDirs.map((d) => fsCatalogSource(d))])).loadDb();

const trees = [join(ROOT, 'packages/catalog/depictions'), ...packDirs.map((d) => join(d, 'depictions'))].filter((d) => existsSync(d));

describe('generated face art', () => {
  it('is what the generator writes (run packages/catalog/scripts/face-art.ts to refresh)', () => {
    for (const [path, text] of Object.entries(faceArtFiles())) {
      expect(readFileSync(join(ROOT, path), 'utf8'), path).toBe(text);
    }
  });

  it('covers the starter families and the domain packs', () => {
    const ids = trees.flatMap((t) => readdirSync(t));
    for (const id of ['de9-male', 'de9-female', 'jst-xh-2', 'terminal-block-4', 'multicore-3coax-4core', 'rj45-8p8c-plug', 'xlr3-male', 'xlr3-female', 'rca-male', 'trs-3-5mm-male', 'usb-a-plug', 'obd2-16-male', 'hd15-male']) {
      expect(ids, id).toContain(id);
    }
  });

  for (const tree of trees) {
    for (const id of readdirSync(tree)) {
      it(`${id}: valid, anchored on its pinout, CC0, pins on anchors`, () => {
        const loaded = loadDepiction(id, { db, root: tree });
        expect(loaded.issues, JSON.stringify(loaded.issues)).toEqual([]);
        const meta = loaded.meta!;
        expect(meta.src).toMatch(/CC0-1\.0/);
        for (const asset of Object.values(meta.views)) expect(asset.src).toMatch(/CC0-1\.0/);
        const svg = readFileSync(join(tree, id, meta.views[meta.anchorFrame]!.file), 'utf8');
        const pins = [...svg.matchAll(/<(circle|rect) data-pin="([^"]+)"([^>]*)\/>/g)];
        for (const [, el, pin, attrs] of pins) {
          const num = (k: string): number => Number(new RegExp(`${k}="([^"]+)"`).exec(attrs!)![1]);
          const [x, y] = el === 'circle' ? [num('cx'), num('cy')] : [num('x') + num('width') / 2, num('y') + num('height') / 2];
          expect(meta.pinAnchors[pin!]?.x, `${pin} x`).toBeCloseTo(x, 1);
          expect(meta.pinAnchors[pin!]?.y, `${pin} y`).toBeCloseTo(y, 1);
        }
        expect(svg).not.toMatch(/<script|href=/);
      });
    }
  }
});

describe('pack art records', () => {
  it('the av-video pack ships SCART and JP21 drawings and layouts that parse', () => {
    const { art, issues } = loadPackArt(join(ROOT, 'modules/av-video/pack'));
    expect(issues).toEqual([]);
    expect(art.connectors.map((c) => c.id)).toEqual(['jp21-21', 'scart-21']);
    expect(art.bodyLayouts.map((l) => l.id)).toEqual(['scart21', 'jp21']);
    for (const c of art.connectors) expect(c.src).toMatch(/CC0-1\.0/);
  });
});

describe('installing a pack layer', () => {
  it('copies the pack\'s depiction images and art records with its data files', () => {
    const packs = mkdtempSync(join(tmpdir(), 'wirehub-art-packs-'));
    try {
      installPackLayer(dataPath(''), packs, join(ROOT, 'modules/networking/pack'));
      expect(existsSync(join(packs, 'networking/depictions/rj45-8p8c-plug/mating-face.svg'))).toBe(true);
      expect(existsSync(join(packs, 'networking/depictions/rj45-8p8c-plug/meta.json'))).toBe(true);
    } finally {
      rmSync(packs, { recursive: true, force: true });
    }
  });
});
