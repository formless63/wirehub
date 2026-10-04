/**
 * Part-number search for the cable list and Quick open.
 *
 * A cable answers to every PN in `CableListEntry.partNumbers` — its own, its
 * drawing's PN as written (a length family too), each length's variation PN
 * (`CBL-00012-06`) and its parts' PNs.
 *
 * Pure and IO-free: the route and the palette hand in the rows.
 */

import type { CableListEntry } from './cable-list.ts';

/** `cbl-000 12` → `CBL-00012`: upper case, no whitespace. */
export function normalizePn(text: string): string {
  return text.toUpperCase().replace(/\s+/g, '');
}

/** A query worth matching against part numbers: it carries at least three digits (`00012`, `CBL-000`). */
export function looksLikePartNumber(query: string): boolean {
  return (query.match(/\d/g) ?? []).length >= 3;
}

const FAMILY = /^(.+-)([0-9X]?)X$/;
const FULL = /^(.+-)([0-9]?)[0-9]$/;

/**
 * Does `pn` answer to `query`? A substring of the PN (`00012`, `CBL-00012`),
 * a family query (`CBL-00012-3X` finds `-30`…`-39`), or a length inside a
 * family PN (`CBL-00012-35` finds the drawing's `CBL-00012-3X`).
 */
export function pnMatches(query: string, pn: string): boolean {
  const q = normalizePn(query);
  const t = normalizePn(pn);
  if (q === '' || t === '') return false;
  if (t.includes(q)) return true;
  // `-XX` covers every length, `-3X` the lengths starting with 3
  const lead = (m: RegExpExecArray): string => (m[2] === 'X' ? '' : (m[2] as string));
  const family = FAMILY.exec(q);
  if (family !== null && FULL.test(t) && t.startsWith(`${family[1]}${lead(family)}`)) return true;
  const tFamily = FAMILY.exec(t);
  const full = FULL.exec(q);
  return tFamily !== null && full !== null && full[1] === tFamily[1] && (lead(tFamily) === '' || full[2] === lead(tFamily));
}

/** The first of a row's PNs that answers to `query`, if any. */
export function matchedPartNumber(entry: Pick<CableListEntry, 'partNumbers'>, query: string): string | undefined {
  if (!looksLikePartNumber(query)) return undefined;
  const pns = entry.partNumbers ?? [];
  // the PN that contains what was typed beats a family that covers it (`-34` over `-3X`)
  const q = normalizePn(query);
  return pns.find((pn) => normalizePn(pn).includes(q)) ?? pns.find((pn) => pnMatches(query, pn));
}

/** The cable list's text filter: label, id, destination, wire, notes, board — and every part number the cable answers to. */
export function entryMatches(entry: CableListEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [
    entry.label,
    entry.id,
    entry.destinationShort ?? '',
    ...entry.wireLabels,
    ...(entry.wires ?? []).map((w) => `${w.name} ${w.vendor ?? ''}`),
    ...(entry.features ?? []).map((f) => f.text),
    ...entry.boardLabels,
  ]
    .join(' ')
    .toLowerCase();
  if (haystack.includes(needle)) return true;
  return (entry.partNumbers ?? []).some((pn) => pnMatches(query, pn));
}
