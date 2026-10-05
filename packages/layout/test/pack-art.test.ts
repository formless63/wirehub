/**
 * Art a pack or catalog ships: connector drawings registered as data, and
 * depictions filed under a body, with a face turned so pins sit level with
 * their wires and one that cannot be (pins on a shared line) left to the
 * built-in drawing or the pin table.
 */

import { fileURLToPath } from 'node:url';

import { loadDb, loadDesign, type ConnectorArtRecord } from '@wirehub/catalog';
import type { DepictionSource } from '../src/index.ts';
import { describe, expect, it } from 'vitest';

import { connectorArt, depictionsFromRoot, layoutSchematic, registerConnectorArt, registeredConnectorArt } from '../src/index.ts';

const db = loadDb();
const design = loadDesign('de9-crossover');
const base = depictionsFromRoot(fileURLToPath(new URL('../../catalog/depictions', import.meta.url)));

const record: ConnectorArtRecord = {
  id: 'toy-face',
  families: ['d-sub'],
  short: 'TOY',
  width: 40,
  height: 30,
  approximate: true,
  shapes: [{ el: 'rect', x: 1, y: 1, width: 38, height: 28, tone: 'shell' }],
  pins: [...Array.from({ length: 9 }, (_, i) => ({ terminal: String(i + 1), form: 'pin' as const, x: 4 + i * 4, y: 15, r: 1 })), { terminal: 'shell', form: 'shell' as const, x: 2, y: 2, ifDefined: true }],
  labels: [],
  src: 'test',
};

describe('registered connector drawings', () => {
  it('draw the connectors they name, win over the built-in drawing, and leave no trace when removed', () => {
    const def = db.connectors.find((c) => c.id === 'de9-male')!;
    expect(connectorArt({ def, facing: 'right' })?.short).toBe('D-9');
    const off = registerConnectorArt([record]);
    try {
      expect(registeredConnectorArt()).toHaveLength(1);
      expect(connectorArt({ def, facing: 'right' })?.short).toBe('TOY');
    } finally {
      off();
    }
    expect(registeredConnectorArt()).toHaveLength(0);
    expect(connectorArt({ def, facing: 'right' })?.short).toBe('D-9');
  });

  it('a record that leaves out a pin the connector has draws nothing', () => {
    const off = registerConnectorArt([{ ...record, pins: record.pins.slice(0, 5) }]);
    try {
      expect(connectorArt({ def: db.connectors.find((c) => c.id === 'de9-male')!, facing: 'right' })).toBeUndefined();
    } finally {
      off();
    }
  });
});

describe('depictions of a connector', () => {
  it('the base DE-9 face is found by body, turned a quarter, with one wire per pin level', () => {
    const diagram = layoutSchematic(design, db, { depictions: base });
    const block = diagram.blocks.find((b) => b.kind === 'connector')!;
    expect(block.depiction?.turn).toBe(90);
    expect(block.depiction?.defId).toMatch(/^de9-(male|female)$/);
    const ys = block.ports.map((p) => p.y);
    expect(new Set(ys.map((y) => Math.round(y * 10))).size).toBe(ys.length);
  });

  it('leaves a face whose used pins share a line to the built-in drawing', () => {
    const flat: DepictionSource = {
      meta: (id) =>
        id === 'de9-male' || id === 'de9-female'
          ? {
              defId: id,
              anchorFrame: 'mating-face',
              src: 'test',
              views: { 'mating-face': { file: 'x.svg', kind: 'vector', mmPerUnit: 1, sourceKind: 'hand', widthUnits: 20, heightUnits: 10, src: 'test' } },
              pinAnchors: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), { x: 2 + i * 0.5, y: 5 }])),
            }
          : undefined,
      artwork: () => ({ kind: 'vector', source: '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>' }),
    };
    const diagram = layoutSchematic(design, db, { depictions: flat });
    expect(diagram.blocks.find((b) => b.kind === 'connector')?.depiction).toBeUndefined();
    expect(diagram.depictions.some((d) => d.status === 'crowded-anchors')).toBe(true);
  });
});
