/**
 * The catalog loaders over the starter catalog, an almost empty in-memory
 * catalog, and the frozen fixture catalog.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { errors, kitsContaining, validateDb, validateDesign } from '@cable-studio/model';

import {
  createCatalog,
  dataPath,
  designVersionsDir,
  fixtureCatalog,
  isDesignId,
  listDesignIds,
  loadConnectors,
  loadDb,
  loadDesign,
  loadDesigns,
  loadPartNumberScheme,
  loadPcbas,
  loadVocab,
  loadWires,
  memoryCatalogSource,
} from '../src/index.ts';
import { prepareDepictionImport } from '../src/depictions/index.ts';
import { buildTags, type TagReview } from '../src/tags/build.ts';

describe('the starter catalog', () => {
  it('ships the example designs, each valid against the definitions', () => {
    expect(listDesignIds()).toEqual([
      'db9-null-modem',
      'rj45-patch-t568b',
      'rs485-de9-terminal-board',
      'trs-to-2rca-y',
      'usb-a-led-lead',
      'vga-monitor-cable',
      'xlr-mic-cable',
    ]);
    const db = loadDb();
    for (const design of loadDesigns()) expect(errors(validateDesign(design, db)), design.id).toEqual([]);
  });

  it('cites "synthetic example" on every design', () => {
    for (const design of loadDesigns()) expect(design.src, design.id).toMatch(/^synthetic example/);
  });

  it('returns fresh objects on every load', () => {
    const a = loadDesign('xlr-mic-cable');
    a.joints.length = 0;
    expect(loadDesign('xlr-mic-cable').joints.length).toBeGreaterThan(0);
  });

  it('keeps kits as their own records', () => {
    expect(kitsContaining(loadDb(), { kind: 'mechanical', def: 'de9-backshell' }).map((k) => k.sku)).toEqual(['KIT-00001']);
  });

  it('the committed tag tables are what the tag builder makes of the catalog', () => {
    const review = JSON.parse(readFileSync(dataPath('tags/review.json'), 'utf8')) as TagReview;
    const built = buildTags({ vocab: loadVocab(), connectors: loadConnectors(), pcbas: loadPcbas(), wires: loadWires(), designs: loadDesigns(), review });
    expect(readFileSync(dataPath('tags/signal-tags.json'), 'utf8')).toBe(`${JSON.stringify(built.tags, null, 2)}\n`);
    expect(built.stats.unclassifiedUsed).toBe(0);
  });
});

describe('an almost empty catalog', () => {
  const catalog = createCatalog(
    memoryCatalogSource({ 'connectors.json': '[]', 'wires.json': '[]', 'components.json': '[]' }, { name: 'the empty catalog' }),
  );

  it('loads with every optional file absent', () => {
    const db = catalog.loadDb();
    expect(db.pcbas).toEqual([]);
    expect(db.mechanicals).toEqual([]);
    expect(db.vocab).toEqual({});
    expect(validateDb(db)).toEqual([]);
    expect(catalog.listDesignIds()).toEqual([]);
  });

  it('falls back to the default part-number scheme', () => {
    expect(catalog.loadPartNumberScheme().id).toBe('prefix');
  });

  it('says which required file is missing', () => {
    const broken = createCatalog(memoryCatalogSource({}, { name: 'nothing' }));
    expect(() => broken.loadWires()).toThrow(/nothing has no wires.json/);
  });

  it('reads a configured part-number scheme', () => {
    const configured = createCatalog(
      memoryCatalogSource({
        'connectors.json': '[]',
        'wires.json': '[]',
        'components.json': '[]',
        'part-numbers.json': JSON.stringify({ id: 'shop', prefixes: { connector: 'J' }, digits: 4 }),
      }),
    );
    expect(configured.loadPartNumberScheme().parse('j-0012')).toBe('J-0012');
    expect(loadPartNumberScheme().id).toBe('prefix');
  });
});

describe('design ids', () => {
  it('are kebab-case slugs and never paths', () => {
    expect(isDesignId('rj45-patch-t568b')).toBe(true);
    expect(isDesignId('../etc/passwd')).toBe(false);
    expect(isDesignId('Has Spaces')).toBe(false);
    expect(designVersionsDir('xlr-mic-cable')).toBe('designs/_versions/xlr-mic-cable');
    expect(() => designVersionsDir('../x')).toThrow();
  });
});

describe('the fixture catalog', () => {
  it('is a frozen copy the snapshot tests render from, and it validates', () => {
    const fixture = fixtureCatalog();
    expect(fixture.listDesignIds()).toEqual(listDesignIds());
    expect(validateDb(fixture.loadDb())).toEqual([]);
  });
});

describe('artwork import', () => {
  it('normalises an SVG and refuses a format it cannot read', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="5mm" viewBox="0 0 10 5"><script>alert(1)</script><rect x="0" y="0" width="10" height="5" stroke="red"/></svg>';
    const ok = prepareDepictionImport({ fileName: 'face.svg', bytes: new TextEncoder().encode(svg), defId: 'de9-male-profibus', view: 'face' });
    expect(JSON.stringify(ok)).not.toContain('<script');
    const refused = prepareDepictionImport({ fileName: 'part.step', bytes: new Uint8Array([1, 2, 3]), defId: 'de9-male-profibus', view: 'face' });
    expect(refused).toMatchObject({ ok: false, reason: 'unsupported-format' });
  });
});
