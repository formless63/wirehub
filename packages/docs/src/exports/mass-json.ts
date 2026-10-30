/**
 * `mass.json` (`docs/mass.md`): the derived mass of each BOM line and of one unit, with every
 * missing input listed. Deterministic: fixed key order, two-space indent, trailing newline, grams
 * to six decimals. Measured masses (inventory batches) are never in it.
 */

import type { CableDesign, Db, MassMissing } from '@wirehub/model';

import { deriveMass, type DesignMass, type LineMass, type MassLine, type MassRate } from '../mass.ts';

export interface MassJsonOptions {
  explode?: boolean;
  /** the saved revision being exported; absent = the working copy */
  revisionNumber?: number;
}

const missingOut = (m: MassMissing): MassMissing => ({
  reason: m.reason,
  record: m.record,
  instances: [...m.instances],
  ...(m.line === undefined ? {} : { line: m.line }),
  ...(m.detail === undefined ? {} : { detail: m.detail }),
});

const rateOut = (rate: MassRate | null): MassRate | null =>
  rate === null ? null : 'gPerM' in rate ? { gPerM: rate.gPerM, from: rate.from } : { gEach: rate.gEach, ...(rate.bound === undefined ? {} : { bound: rate.bound }), from: rate.from };

const lineOut = (line: MassLine): MassLine & LineMass => ({
  key: line.key,
  category: line.category,
  ref: line.ref,
  label: line.label,
  ...(line.partNumber === undefined ? {} : { partNumber: line.partNumber }),
  qty: line.qty,
  instances: [...line.instances],
  ...(line.lengthMm === undefined ? {} : { lengthMm: line.lengthMm }),
  rate: rateOut(line.rate),
  g: line.g,
  bound: line.bound,
  ...(line.missing === undefined || line.missing.length === 0 ? {} : { missing: line.missing.map(missingOut) }),
});

/** The `wirehub.mass` document of an already derived mass. */
export function massDocument(design: CableDesign, mass: DesignMass, revisionNumber?: number): unknown {
  return {
    format: 'wirehub.mass',
    version: 1,
    unit: 'g',
    design: {
      id: design.id,
      label: design.label,
      ...(design.productRef === undefined ? {} : { productRef: design.productRef }),
      ...(revisionNumber === undefined ? {} : { rev: revisionNumber }),
    },
    explode: mass.explode,
    total: { g: mass.total.g, bound: mass.total.bound },
    lines: mass.lines.map(lineOut),
    missing: mass.missing.map(missingOut),
  };
}

/** `mass.json` for a design (or a saved revision of it). */
export function massJson(design: CableDesign, db: Db, options: MassJsonOptions = {}): string {
  const mass = deriveMass(design, db, options.explode === true ? { explode: true } : {});
  return `${JSON.stringify(massDocument(design, mass, options.revisionNumber), null, 2)}\n`;
}
