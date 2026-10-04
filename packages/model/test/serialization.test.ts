/**
 * The model is plain JSON: designs and definitions round-trip through
 * JSON.parse(JSON.stringify(x)) unchanged, and loading from disk is stable.
 * (Deterministic key order is not required — deep equality is.)
 */

import { describe, expect, it } from 'vitest';
import {
  listDesignIds,
  loadCatalog,
  loadDb,
  loadDesign,
  loadDesigns,
} from '@wirehub/catalog';

import { CURRENT_SCHEMA_VERSION, deriveNets, upgradeDesignSchema, validateDesign } from '../src/index.ts';

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('designs', () => {
  for (const id of listDesignIds()) {
    it(`${id} round-trips through JSON identically`, () => {
      const design = loadDesign(id);
      expect(roundTrip(design)).toEqual(design);
    });

    it(`${id} is byte-stable when re-serialized after a reload`, () => {
      const first = JSON.stringify(loadDesign(id));
      const second = JSON.stringify(roundTrip(loadDesign(id)));
      expect(second).toBe(first);
    });

    it(`${id} loads deep-equal on every load`, () => {
      expect(loadDesign(id)).toEqual(loadDesign(id));
    });
  }

  it('loads fresh objects each time (no shared mutable singleton)', () => {
    const first = loadDesign('dc-led-lead');
    const second = loadDesign('dc-led-lead');
    expect(first).not.toBe(second);
    first.joints.length = 0;
    expect(second.joints.length).toBeGreaterThan(0);
  });

  it('is at the one current schema version, with an id matching its file name', () => {
    for (const id of listDesignIds()) {
      const design = loadDesign(id);
      expect(design.schemaVersion, id).toBe(CURRENT_SCHEMA_VERSION);
      expect(design.id).toBe(id);
    }
  });
});

describe('definition library', () => {
  it('round-trips through JSON identically', () => {
    const db = loadDb();
    expect(roundTrip(db)).toEqual(db);
  });

  it('loads deep-equal on every load', () => {
    expect(loadDb()).toEqual(loadDb());
  });
});

describe('derived views survive a round trip', () => {
  const db = loadDb();

  for (const design of loadDesigns()) {
    it(`${design.id}: nets and issues are identical before and after`, () => {
      const copy = roundTrip(design);
      expect(deriveNets(copy, roundTrip(db))).toEqual(deriveNets(design, db));
      expect(validateDesign(copy, roundTrip(db))).toEqual(
        validateDesign(design, db),
      );
    });
  }

  it('loadCatalog returns the same data as the individual loaders', () => {
    const catalog = loadCatalog();
    expect(catalog.db).toEqual(db);
    expect(catalog.designs.map((d) => d.id)).toEqual(listDesignIds());
  });
});

describe('schema version migration', () => {
  it('upgrades any older document to the current version without touching its body, idempotently', () => {
    const current = loadDesign('dc-led-lead');
    for (const v of [1, 2, 3] as const) {
      const old = { ...current, schemaVersion: v };
      const up = upgradeDesignSchema(old);
      expect(up.changed).toBe(true);
      expect(up.from).toBe(v);
      expect(up.design).toEqual(current);
      expect(upgradeDesignSchema(up.design).changed).toBe(false);
    }
    expect(() => upgradeDesignSchema({ ...current, schemaVersion: 9 as never })).toThrow(/unsupported/);
  });
});
