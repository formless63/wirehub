/**
 * The module's own drawings: SCART and JP21 live in this pack (not in the
 * base), draw through the registered art on a design that uses the SCART
 * connector, and the base alone leaves the connector as a pin table.
 */

import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, layeredCatalogSource, parseBodyLayouts, parseConnectorArt } from '@wirehub/catalog';
import { registerBodyLayouts, templatesFor } from '@wirehub/editor-react';
import { connectorArt, layoutSchematic, registerConnectorArt } from '@wirehub/layout';
import { createRegistry } from '@wirehub/modules';
import { renderSchematic } from '@wirehub/render-svg';
import type { ConnectorArtRecord, BodyLayoutRecord } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { AV_VIDEO_PACK, avVideo } from '../src/index.ts';

const packDir = fileURLToPath(AV_VIDEO_PACK);
const catalog = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(packDir, 'av-video')]));
const db = catalog.loadDb();
const vga = catalog.loadDesign('vga-monitor-cable');
// the monitor cable with its far end a SCART plug (the pins it uses exist on both)
const scartCable: CableDesign = {
  ...vga,
  id: 'scart-end-cable',
  instances: { ...vga.instances, connectors: vga.instances.connectors.map((c) => (c.id === 'j2' ? { ...c, def: 'scart-male' } : c)) },
};

const art = createRegistry([avVideo]).art();
const records = art.flatMap((a) => (a.connectors ?? []).map((raw) => parseConnectorArt(raw, 'art').record as ConnectorArtRecord));
const layouts = art.flatMap((a) => parseBodyLayouts(a.bodyLayouts, 'layouts').records as BodyLayoutRecord[]);

describe('the module carries its drawings', () => {
  it('contributes valid SCART and JP21 drawings and layouts', () => {
    expect(records.map((r) => r.id)).toEqual(['scart-21', 'jp21-21', 'bnc']);
    expect(records.every((r) => r !== undefined)).toBe(true);
    expect(layouts.map((l) => l.id)).toEqual(['scart21', 'jp21']);
  });

  it('draws BNC in side view with the pack, and a generic plug without it', () => {
    const bnc = { id: 'bnc-test', label: 'BNC', family: 'bnc', gender: 'male', pins: [{ id: 'tip', label: 'tip' }, { id: 'shell', label: 'shell' }] } as unknown as Parameters<typeof connectorArt>[0]['def'];
    expect(connectorArt({ def: bnc, facing: 'left' })).toMatchObject({ view: 'profile', short: 'Plug', approximate: true });
    const off = registerConnectorArt(records);
    try {
      const art = connectorArt({ def: bnc, facing: 'right' })!;
      expect(art).toMatchObject({ view: 'profile', short: 'BNC', facing: 'right', approximate: true });
      expect(art.pins.every((p) => p.x > art.width / 2)).toBe(true);
    } finally {
      off();
    }
  });

  it('draws the pack\'s own BNC connector with the pack art, and leaves out what it does not have', () => {
    const bnc = db.connectors.find((c) => c.id === 'bnc-male')!;
    const body = db.bodies?.find((b) => b.id === bnc.body);
    expect(bnc).toMatchObject({ license: 'CC0-1.0', family: 'bnc', interface: 'bnc-coax' });
    expect(bnc.src).toContain('IEC 61169-8');
    expect(body).toBeDefined();
    const off = registerConnectorArt(records);
    try {
      const art = connectorArt({ def: bnc, facing: 'left', ...(body === undefined ? {} : { body }) })!;
      expect(art).toMatchObject({ view: 'profile', short: 'BNC', facing: 'left', approximate: true });
      expect(art.pins.map((p) => p.terminal)).toEqual(['tip', 'shell']);
      // a plug that has only a shell: its centre lug tag is not drawn, the other still is
      const shellOnly = { ...bnc, pins: bnc.pins.filter((p) => p.id === 'shell') };
      const bare = connectorArt({ def: shellOnly, facing: 'left' })!;
      expect(bare.shapes.length).toBe(art.shapes.length - 1);
    } finally {
      off();
    }
  });

  it('draws SCART on a design that uses it, and nothing without the module', () => {
    const scart = db.connectors.find((c) => c.id === 'scart-male')!;
    const body = db.bodies?.find((b) => b.id === scart.body);
    expect(connectorArt({ def: scart, facing: 'right', ...(body === undefined ? {} : { body }) })).toBeUndefined();
    expect(layoutSchematic(scartCable, db).blocks.find((b) => b.id === 'j2')?.connectorArt).toBeUndefined();

    const off = registerConnectorArt(records);
    try {
      const block = layoutSchematic(scartCable, db).blocks.find((b) => b.id === 'j2')!;
      expect(block.connectorArt?.short).toBe('SCART');
      expect(block.connectorArt?.pins.length).toBe(21);
      const svg = renderSchematic(scartCable, db);
      expect(svg).toContain('data-depiction="scart-male/mating-face"');
      expect(renderSchematic(scartCable, db)).toBe(svg);
    } finally {
      off();
    }
    expect(layoutSchematic(scartCable, db).blocks.find((b) => b.id === 'j2')?.connectorArt).toBeUndefined();
  });

  it('JP21 draws by its family and caption', () => {
    const off = registerConnectorArt(records);
    try {
      const pins = Array.from({ length: 21 }, (_, i) => ({ id: String(i + 1), label: String(i + 1) }));
      expect(connectorArt({ def: { id: 'jp21-x', label: 'x', family: 'jp21', gender: 'male', pins, src: 'x' }, facing: 'right' })?.short).toBe('JP21');
    } finally {
      off();
    }
  });

  it('offers the module\'s body layouts to the connector builder', () => {
    expect(templatesFor('scart')).toEqual([]);
    const off = registerBodyLayouts(layouts);
    try {
      expect(templatesFor('scart').map((t) => t.id)).toEqual(['scart21']);
      expect(templatesFor('jp21')[0]?.positions.length).toBe(22);
    } finally {
      off();
    }
  });
});
