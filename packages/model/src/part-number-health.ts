/**
 * Part-number health: which numbers are taken twice, which parts have none, and
 * where the places that carry a design's number disagree.
 *
 * Pure, and pattern-free: a number's canonical spelling comes from the
 * deployment's `PartNumberScheme` (`parse`), and "this scheme numbers that kind"
 * is whether `suggest` answers for it. Nothing here knows what a number looks like.
 *
 * Identity. A duplicate is one number on two *different physical things*. A
 * connector and the body it is built on are twins — one part seen at two levels of
 * the catalog — and a design's product reference and its drawing's number are one
 * design saying its number twice; neither is a duplicate.
 */

import { DEFAULT_PART_NUMBER_SCHEME, canonicalPartNumber, type KnownPartNumber, type PartNumberScheme, type PnKind, type PnSuggestion } from './part-numbers.ts';
import type { CableDesign, Db, Issue } from './model.ts';

/** One place a number is written. */
export interface PnHolder {
  /** the number as written */
  pn: string;
  /** its canonical spelling under the scheme, upper-cased for comparison */
  canonical: string;
  kind: PnKind;
  id: string;
  label: string;
  /** `connectors/de9-male` — also what an `Issue.where` says */
  where: string;
  /** what physical thing it names: twins share one */
  identity: string;
  /** which field: `partNumber`, `sku`, `productRef` or the drawing's `partNumber` */
  field: 'partNumber' | 'sku' | 'productRef' | 'drawing';
}

export interface PnDuplicate {
  /** canonical, upper-cased */
  pn: string;
  holders: PnHolder[];
}

export interface PnUnnumbered {
  kind: PnKind;
  id: string;
  label: string;
  where: string;
  /** what the scheme would number it, given every number in use and the suggestions above it */
  suggestion?: PnSuggestion;
}

export interface PnDisagreement {
  designId: string;
  label: string;
  productRef: string;
  drawingPn: string;
}

export interface PnFormatFinding {
  holder: PnHolder;
  code: string;
  message: string;
}

export interface PartNumberReport {
  duplicates: PnDuplicate[];
  unnumbered: PnUnnumbered[];
  disagreements: PnDisagreement[];
  /** numbers the scheme itself objects to (`PartNumberScheme.check`) */
  format: PnFormatFinding[];
  /** how many numbered things were read */
  numbered: number;
}

export interface PnDrawings {
  [designId: string]: { partNumber?: string } | undefined;
}

const clean = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value.trim());

function canon(pn: string, scheme: PartNumberScheme): string {
  return (canonicalPartNumber(pn, scheme) ?? pn).toUpperCase();
}

type Numbered = { id: string; label: string; partNumber?: string };

/** Every number written anywhere in the catalog, the designs and their drawings. */
export function partNumberHolders(
  db: Pick<Db, 'connectors' | 'wires' | 'components' | 'pcbas' | 'mechanicals' | 'bodies' | 'kits' | 'products'>,
  designs: readonly Pick<CableDesign, 'id' | 'label' | 'productRef'>[] = [],
  drawings: PnDrawings = {},
  scheme: PartNumberScheme = DEFAULT_PART_NUMBER_SCHEME,
): PnHolder[] {
  const out: PnHolder[] = [];
  const add = (pn: string | undefined, kind: PnKind, id: string, label: string, where: string, identity: string, field: PnHolder['field']): void => {
    const text = clean(pn);
    if (text !== undefined) out.push({ pn: text, canonical: canon(text, scheme), kind, id, label, where, identity, field });
  };
  const plain = (list: readonly Numbered[] | undefined, group: string, kind: PnKind): void => {
    for (const r of list ?? []) add(r.partNumber, kind, r.id, r.label, `${group}/${r.id}`, `${group}/${r.id}`, 'partNumber');
  };
  for (const body of db.bodies ?? []) add(body.partNumber, 'connector', body.id, body.label, `bodies/${body.id}`, `body/${body.id}`, 'partNumber');
  for (const c of db.connectors) add(c.partNumber, 'connector', c.id, c.label, `connectors/${c.id}`, c.body === undefined ? `connectors/${c.id}` : `body/${c.body}`, 'partNumber');
  plain(db.wires, 'wires', 'wire');
  plain(db.components, 'components', 'component');
  plain(db.pcbas, 'pcbas', 'pcba');
  for (const m of db.mechanicals ?? []) {
    const kind: PnKind = m.kind === 'shell' ? 'shell' : m.kind === 'fastener' ? 'fastener' : 'mechanical-other';
    add(m.partNumber, kind, m.id, m.label, `mechanicals/${m.id}`, `mechanicals/${m.id}`, 'partNumber');
  }
  for (const k of db.kits ?? []) add(k.sku, 'kit', k.id ?? k.sku, k.label, `kits/${k.id ?? k.sku}`, `kits/${k.id ?? k.sku}`, 'sku');
  for (const d of designs) {
    add(d.productRef, 'design', d.id, d.label, `designs/${d.id}`, `designs/${d.id}`, 'productRef');
    add(drawings[d.id]?.partNumber, 'design', d.id, d.label, `drawings/${d.id}`, `designs/${d.id}`, 'drawing');
  }
  // a product family's own number, and each variant's — a variant is the design it names, so its number is not a second holder of that design's
  for (const p of db.products ?? []) {
    if (p.partNumber !== undefined && !/X/.test(p.partNumber)) add(p.partNumber, 'design', p.id, p.label, `products/${p.id}`, `products/${p.id}`, 'partNumber');
    for (const v of p.variants) add(v.partNumber, 'design', v.design, `${p.label} ${v.label ?? v.id}`, `products/${p.id}/${v.id}`, `designs/${v.design}`, 'partNumber');
  }
  return out;
}

/** Numbers written on two or more different things (twins and a design's own two copies do not count). */
export function duplicatesOf(holders: readonly PnHolder[]): PnDuplicate[] {
  const byNumber = new Map<string, PnHolder[]>();
  for (const h of holders) byNumber.set(h.canonical, [...(byNumber.get(h.canonical) ?? []), h]);
  const out: PnDuplicate[] = [];
  for (const [pn, list] of byNumber) {
    if (new Set(list.map((h) => h.identity)).size > 1) out.push({ pn, holders: list });
  }
  return out.sort((a, b) => (a.pn < b.pn ? -1 : a.pn > b.pn ? 1 : 0));
}

/**
 * `validateDb`'s part: one `pn-duplicate` warning per record that shares a number with a
 * different part. Designs are not in the library, so they are the report's.
 */
export function pnDuplicateIssues(db: Db, scheme: PartNumberScheme = DEFAULT_PART_NUMBER_SCHEME): Issue[] {
  return duplicatesOf(partNumberHolders(db, [], {}, scheme)).flatMap((dup) =>
    dup.holders.map((h) => {
      const others = dup.holders.filter((o) => o.identity !== h.identity).map((o) => o.where);
      return {
        code: 'pn-duplicate',
        severity: 'warning' as const,
        message: `part number '${h.pn}' is also on ${others.join(', ')}`,
        where: h.where,
      };
    }),
  );
}

/** Which holders (other than `except`'s own identity) already carry `pn`. */
export function holdersOfNumber(holders: readonly PnHolder[], pn: string, scheme: PartNumberScheme = DEFAULT_PART_NUMBER_SCHEME, exceptIdentity?: string): PnHolder[] {
  const wanted = canon(pn, scheme);
  return holders.filter((h) => h.canonical === wanted && h.identity !== exceptIdentity);
}

const NUMBERED_GROUPS: readonly { group: 'connectors' | 'wires' | 'components' | 'pcbas'; kind: PnKind }[] = [
  { group: 'connectors', kind: 'connector' },
  { group: 'wires', kind: 'wire' },
  { group: 'components', kind: 'component' },
  { group: 'pcbas', kind: 'pcba' },
];

/** The whole report: duplicates, unnumbered parts and designs, disagreements, and the scheme's own findings. */
export function partNumberReport(
  db: Pick<Db, 'connectors' | 'wires' | 'components' | 'pcbas' | 'mechanicals' | 'bodies' | 'kits'>,
  designs: readonly Pick<CableDesign, 'id' | 'label' | 'productRef'>[] = [],
  drawings: PnDrawings = {},
  scheme: PartNumberScheme = DEFAULT_PART_NUMBER_SCHEME,
  extra: readonly KnownPartNumber[] = [],
): PartNumberReport {
  const holders = partNumberHolders(db, designs, drawings, scheme);
  const known: KnownPartNumber[] = [
    ...holders.map((h) => ({ pn: h.pn, kind: h.kind, label: h.label, source: h.where })),
    ...extra,
  ];
  const unnumbered: PnUnnumbered[] = [];
  const numberedIds = new Set(holders.map((h) => h.where.split('/')[0] + '/' + h.id));
  const consider = (kind: PnKind, id: string, label: string, where: string): void => {
    const suggestion = scheme.suggest({ kind, label, id }, known);
    // a kind the scheme does not number is never "missing" a number
    if (suggestion === undefined) return;
    unnumbered.push({ kind, id, label, where, suggestion });
    known.push({ pn: suggestion.pn, kind, label, source: `suggested ${where}` });
  };
  for (const { group, kind } of NUMBERED_GROUPS) {
    for (const r of db[group] as readonly Numbered[]) if (!numberedIds.has(`${group}/${r.id}`)) consider(kind, r.id, r.label, `${group}/${r.id}`);
  }
  for (const m of db.mechanicals ?? []) {
    if (numberedIds.has(`mechanicals/${m.id}`)) continue;
    consider(m.kind === 'shell' ? 'shell' : m.kind === 'fastener' ? 'fastener' : 'mechanical-other', m.id, m.label, `mechanicals/${m.id}`);
  }
  const designHasNumber = new Set(holders.filter((h) => h.kind === 'design').map((h) => h.id));
  for (const d of designs) if (!designHasNumber.has(d.id)) consider('design', d.id, d.label, `designs/${d.id}`);

  const disagreements: PnDisagreement[] = [];
  for (const d of designs) {
    const ref = clean(d.productRef);
    const drawing = clean(drawings[d.id]?.partNumber);
    if (ref !== undefined && drawing !== undefined && canon(ref, scheme) !== canon(drawing, scheme)) {
      disagreements.push({ designId: d.id, label: d.label, productRef: ref, drawingPn: drawing });
    }
  }

  const format: PnFormatFinding[] = [];
  for (const h of holders) {
    for (const f of scheme.check(h.pn, h.kind)) format.push({ holder: h, code: f.code, message: f.message });
  }

  return { duplicates: duplicatesOf(holders), unnumbered, disagreements, format, numbered: holders.length };
}
