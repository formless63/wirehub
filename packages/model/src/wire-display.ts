/**
 * Neutral, vendor-free display names for wire stocks: the maker stays inside
 * the wire's own spec/detail view and the wire spec sheet, never across cable
 * titles, pickers, the cables list or generated documents.
 */

import { findWire, type Db, type WireDefinition } from './model.ts';

/**
 * A short construction tag from the wire's own `layOrder` — never a vendor
 * name — so two stocks with the same label read apart: the ring count, plus
 * the centre/inner cores as an extra (`6+1`, `6+2C`); a lay with no extra
 * cores is just its ring count (`7C`). `allAlike` sums ring and centre for a
 * stock whose cores all carry signal alike (`8C`).
 */
export function constructionTag(wire: WireDefinition | undefined, allAlike = false): string | undefined {
  const lay = wire?.layOrder;
  if (lay === undefined) return undefined;
  const extra = (lay.center === undefined ? 0 : 1) + (lay.inner?.length ?? 0);
  if (allAlike) return `${lay.ring.length + extra}C`;
  if (extra === 0) return `${lay.ring.length}C`;
  return extra === 1 ? `${lay.ring.length}+${extra}` : `${lay.ring.length}+${extra}C`;
}

/**
 * Drops a trailing "(…)" only when it names the wire's own recorded
 * `manufacturer` — "Shielded 8-core (Acme)" → "Shielded 8-core", but
 * "3.5 mm TRS audio lead (cut-down purchased M>M cable)" is left whole: that
 * parenthetical is a fact about the lead, not the maker.
 */
export function stripMakerSuffix(label: string, manufacturer: string | undefined): string {
  if (manufacturer === undefined || manufacturer === '') return label;
  const m = /\s*\(([^)]*)\)\s*$/.exec(label);
  if (m === null || !(m[1] as string).toLowerCase().includes(manufacturer.toLowerCase())) return label;
  return label.slice(0, m.index).trim();
}

/**
 * A stock's display name, never the manufacturer: the wire's own label with a
 * maker-naming trailing parenthetical stripped, plus a construction tag when
 * another stock in the catalog shares that name.
 */
export function wireDisplayName(db: Db, id: string): string {
  const wire = findWire(db, id);
  if (wire === undefined) return id;
  const name = stripMakerSuffix(wire.label, wire.manufacturer);
  const twins = db.wires.filter((w) => stripMakerSuffix(w.label, w.manufacturer) === name);
  const tag = twins.length <= 1 ? undefined : constructionTag(wire);
  return tag === undefined ? name : `${name} ${tag}`;
}
