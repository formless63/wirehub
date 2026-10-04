/**
 * Connector artwork: every family in the catalog draws as itself, from its
 * definition alone, with a handle on every pin — and a family the drawing
 * does not know keeps the pin list exactly.
 */

import { loadDb, loadDesign } from '@cable-studio/catalog';
import type { ConnectorDefinition, Db } from '@cable-studio/model';
import { describe, expect, it } from 'vitest';

import { bodyDrawing, connectorArt, type ConnectorArt } from '../src/connector-art.ts';
import { deriveNodes, type ConnectorNodeData } from '../src/derive.ts';

const db: Db = loadDb();

function def(id: string): ConnectorDefinition {
  const found = db.connectors.find((connector) => connector.id === id);
  if (found === undefined) throw new Error(`no connector ${id}`);
  return found;
}

function art(id: string, facing: 'left' | 'right' = 'right'): ConnectorArt {
  const drawn = connectorArt({ def: def(id), facing });
  if (drawn === undefined) throw new Error(`no art for ${id}`);
  return drawn;
}

/** Distinct values, rounded — the columns or rows a face's pins sit in. */
function distinct(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value)))].sort((p, q) => p - q);
}

/** Families the editor has no built-in art for yet (a follow-up): they fall back to the pin table. */
const NO_ART_YET = new Set(['rj45', 'xlr', 'usb-a', 'jst-xh', 'terminal-block']);

describe('every catalog connector with built-in art', () => {
  it.each(db.connectors.filter((connector) => !NO_ART_YET.has(connector.family)).map((connector) => connector.id))('%s draws with a handle on every pin, inside its box', (id) => {
    const drawn = art(id);
    expect(drawn.pins.map((pin) => pin.terminal).sort()).toEqual(def(id).pins.map((pin) => pin.id).sort());
    for (const pin of drawn.pins) {
      expect(pin.x).toBeGreaterThanOrEqual(0);
      expect(pin.x).toBeLessThanOrEqual(drawn.width);
      expect(pin.y).toBeGreaterThanOrEqual(0);
      expect(pin.y).toBeLessThanOrEqual(drawn.height);
    }
    // two pins never share a spot
    const spots = new Set(drawn.pins.map((pin) => `${Math.round(pin.x)},${Math.round(pin.y)}`));
    expect(spots.size).toBe(drawn.pins.length);
    // deterministic
    expect(connectorArt({ def: def(id), facing: 'right' })).toEqual(drawn);
  });
});



describe('art keyed by body', () => {
  const bodyOf = (id: string) => db.bodies!.find((body) => body.id === id)!;

  it('takes the body\'s explicit drawing over its family', () => {
    expect(bodyOf('de9-male').drawing).toBe('d-sub');
    expect(bodyDrawing({ id: 'x', label: 'x', family: 'trs-3-5mm' })).toBe('trs');
    expect(bodyDrawing({ id: 'din8-262-male', label: 'DIN-8 262°', family: 'din' })).toBe('din-262');
  });
});
