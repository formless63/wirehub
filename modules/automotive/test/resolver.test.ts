/** The device resolver with the automotive pack: a control unit's sensor port to two sensors whose pinouts differ. */

import { createCatalog, dataPath, fsCatalogSource, layeredCatalogSource } from '@wirehub/catalog';
import { deriveCable, resolve, validateDb, validateDesign } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

const catalog = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(new URL('../pack/', import.meta.url).pathname, 'automotive')]));
const db = catalog.loadDb();
const to = (sensor: string) => ({ source: { device: 'engine-control-unit' }, destination: { device: sensor } });

describe('the resolver with the automotive pack', () => {
  it('validates', () => expect(validateDb(db)).toEqual([]));

  it('wires a sensor with the same pinout pin for pin, on a three-core cable with sealed contacts', () => {
    const r = resolve(db, to('pressure-sensor-a'));
    expect(r.options[0]!.links.map((l) => `${l.from}->${l.to}`).sort()).toEqual(['1->1', '2->2']);
    expect(r.options[0]!.grounds).toEqual({ source: ['3'], destination: ['3'] });
    const d = deriveCable(db, to('pressure-sensor-a'));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.design.instances.segments[0]?.def).toBe('auto-3core-0-5');
    expect(d.design.instances.connectors.every((c) => (c.cavities ?? []).length === 3)).toBe(true);
    expect(validateDesign(d.design, db)).toEqual([]);
  });

  it('crosses supply and return for the other pinout, and refuses the straight cable that would short the 5 V', () => {
    const r = resolve(db, to('pressure-sensor-b'));
    expect(r.options[0]!.links.map((l) => `${l.from}->${l.to}`).sort()).toEqual(['1->3', '2->2']);
    const straight = r.rejected.find((x) => x.option.kind === 'straight');
    expect(straight?.why.map((w) => w.code)).toEqual(['hazard:power-into-ground', 'hazard:power-into-ground']);
    const d = deriveCable(db, to('pressure-sensor-b'));
    expect(d.ok && validateDesign(d.design, db)).toEqual([]);
  });
});
