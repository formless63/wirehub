/**
 * Kits (data model v2 §7.1).
 *
 * A part number is not a property of a part alone: the same part can sit in
 * several kits, so a kit is its own SKU rather than a number on the part.
 *
 * A kit is an orderable SKU (`KIT-00101-00`) and a bill of parts: a
 * connector, a populated board, a shell, fasteners … Each part is picked from
 * the library, never typed, and a part may be in any number of kits. Kits are
 * **informational**: a cable BOM still lists individual parts, and nothing
 * here is exported anywhere by the base.
 *
 * Replaces `ConnectorDefinition.kitNumber`, which could name only one kit.
 *
 * Pure: records in, records out.
 */

import { recordMetaIssues, type RecordMeta } from './provenance.ts';
import type { CableDesign, Db, Issue } from './model.ts';

/** What kind of library record a kit line names. */
export type KitPartKind = 'connector' | 'pcba' | 'mechanical' | 'component' | 'wire';

export const KIT_PART_KINDS: readonly KitPartKind[] = ['connector', 'pcba', 'mechanical', 'component', 'wire'];

/** One line of a kit's bill of parts. */
export interface KitLine {
  part: { kind: KitPartKind; def: string };
  qty: number;
  /**
   * A line that applies to one stock only — the `-00` coax vs `-30`
   * bonded multi-core shell inside one kit SKU.
   */
  when?: { stockFamily?: 'coax' | 'bonded' };
  /** the line is the catalog's inference, not a stated fact — for the owner to confirm */
  inferred?: boolean;
  note?: string;
  /** where this line comes from, when it differs from the kit's own `src` */
  src?: string;
}

/** An orderable kit: a SKU and the parts it ships. */
export interface KitDefinition extends RecordMeta {
  /** `kit-de9-backshell` */
  id: string;
  label: string;
  /** the orderable identity: `KIT-00101-00`, `CMP-00104-00` */
  sku: string;
  contents: KitLine[];
  src: string;
}

/**
 * What a kit SKU may look like: one token of letters, digits and `- . _ /`.
 * Whether it follows the deployment's numbering is the part-number scheme's
 * check (`PartNumberScheme.check`), not a validation error.
 */
export const KIT_SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

/** A reference to one library part, as kit lines and "In kits" lists name it. */
export interface PartRef {
  kind: KitPartKind;
  def: string;
}

export function findKit(db: Pick<Db, 'kits'>, id: string): KitDefinition | undefined {
  return (db.kits ?? []).find((kit) => kit.id === id);
}

/** Every kit that ships `part` — many-to-many: a part may be in any number of kits. */
export function kitsContaining(db: Pick<Db, 'kits'>, part: PartRef): KitDefinition[] {
  return (db.kits ?? []).filter((kit) =>
    kit.contents.some((line) => line.part.kind === part.kind && line.part.def === part.def),
  );
}

/** Whether the library has the record a kit line names. */
export function kitPartExists(db: Db, part: PartRef): boolean {
  switch (part.kind) {
    case 'connector':
      return db.connectors.some((c) => c.id === part.def);
    case 'pcba':
      return db.pcbas.some((p) => p.id === part.def);
    case 'mechanical':
      return (db.mechanicals ?? []).some((m) => m.id === part.def);
    case 'component':
      return db.components.some((c) => c.id === part.def);
    case 'wire':
      return db.wires.some((w) => w.id === part.def);
  }
}

/** The part's label, for a kit's parts table; the id when the library has no such record. */
export function kitPartLabel(db: Db, part: PartRef): string {
  const pools: Record<KitPartKind, readonly { id: string; label: string }[]> = {
    connector: db.connectors,
    pcba: db.pcbas,
    mechanical: db.mechanicals ?? [],
    component: db.components,
    wire: db.wires,
  };
  return pools[part.kind].find((record) => record.id === part.def)?.label ?? part.def;
}

/* ------------------------------------------------------------------ *
 * Coverage — which kit a design's end is built from
 * ------------------------------------------------------------------ */

export interface KitCoverage {
  kit: string;
  sku: string;
  /** the connector instance the kit is matched at */
  instance: string;
  end: 'a' | 'b';
  /** every line that applies to this design's stock is on the design */
  complete: boolean;
  /** the applicable lines the design does not carry, as `kind:def` */
  missing: string[];
}

/** The trunk's stock family for kit lines: a stock whose screens are one bonded mass, else one with coax cores. */
function stockFamilyOf(design: CableDesign, db: Db): 'coax' | 'bonded' | undefined {
  for (const segment of design.instances.segments) {
    const wire = db.wires.find((w) => w.id === segment.def);
    if (wire === undefined) continue;
    const hasCoax = wire.structure.children.some((c) => c.kind === 'group' && c.role === 'coax');
    if (hasCoax) return 'coax';
    if ((wire.bonded ?? []).length > 0 && wire.structure.children.some((c) => c.kind === 'group' && c.role === 'shielded-core')) return 'bonded';
  }
  return undefined;
}

function designHas(design: CableDesign, part: PartRef): boolean {
  switch (part.kind) {
    case 'connector':
      return design.instances.connectors.some((i) => i.def === part.def);
    case 'pcba':
      return design.instances.pcbas.some((i) => i.def === part.def);
    case 'mechanical':
      return (design.instances.mechanical ?? []).some((i) => i.def === part.def);
    case 'component':
      return design.instances.components.some((i) => i.def === part.def);
    case 'wire':
      return design.instances.segments.some((i) => i.def === part.def);
  }
}

/**
 * For every connector instance a kit ships, how much of that kit the design
 * carries. A line scoped to the other stock (`when.stockFamily`) does not
 * count against it. The end is `a` for a connector that is the design's
 * source (role or id order), `b` otherwise — informational only.
 */
export function kitCoverage(design: CableDesign, db: Db): KitCoverage[] {
  const family = stockFamilyOf(design, db);
  const out: KitCoverage[] = [];
  const connectors = design.instances.connectors;
  connectors.forEach((instance, index) => {
    for (const kit of kitsContaining(db, { kind: 'connector', def: instance.def })) {
      const applicable = kit.contents.filter(
        (line) => line.when?.stockFamily === undefined || family === undefined || line.when.stockFamily === family,
      );
      const missing = applicable
        .filter((line) => !designHas(design, line.part))
        .map((line) => `${line.part.kind}:${line.part.def}`);
      const role = (instance.role ?? '').toLowerCase();
      const end: 'a' | 'b' = role.includes('source') || (!role.includes('dest') && index === 0) ? 'a' : 'b';
      out.push({ kit: kit.id, sku: kit.sku, instance: instance.id, end, complete: missing.length === 0, missing });
    }
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function issue(code: string, message: string, where: string, severity: Issue['severity'] = 'error'): Issue {
  return { code, severity, message, where };
}

/**
 * - `duplicate-id` (error), `missing-src` (warning);
 * - `kit-sku-format` (error): the SKU is empty or not one token (`KIT_SKU`);
 * - `kit-empty` (error): a kit with no parts;
 * - `kit-part-unknown` (error): a line names a part the library does not have;
 * - `kit-qty` (error): a quantity that is not a positive whole number.
 *
 * `kit-partial` is a per-design warning (`kitCoverage`), not a library fact.
 */
export function validateKits(db: Db): Issue[] {
  if (db.kits === undefined) return [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const kit of db.kits) {
    const where = `kits/${kit.id}`;
    if (seen.has(kit.id)) issues.push(issue('duplicate-id', `duplicate kit id '${kit.id}'`, where));
    seen.add(kit.id);
    if (!kit.src) issues.push(issue('missing-src', `record '${where}' has no src citation`, where, 'warning'));
    issues.push(...recordMetaIssues(kit, where));
    if (!KIT_SKU.test(kit.sku ?? '')) {
      issues.push(issue('kit-sku-format', `kit '${kit.id}' SKU '${kit.sku}' is not a usable SKU (one token of letters, digits and - . _ /)`, where));
    }
    if (kit.contents.length === 0) issues.push(issue('kit-empty', `kit '${kit.id}' has no parts`, where));
    kit.contents.forEach((line, index) => {
      const at = `${where}/${index + 1}`;
      if (!KIT_PART_KINDS.includes(line.part.kind) || !kitPartExists(db, line.part)) {
        issues.push(issue('kit-part-unknown', `kit '${kit.id}' lists ${line.part.kind} '${line.part.def}', which the library does not have`, at));
      }
      if (!Number.isInteger(line.qty) || line.qty < 1) {
        issues.push(issue('kit-qty', `kit '${kit.id}' line ${index + 1} has quantity ${String(line.qty)}; a kit ships whole parts`, at));
      }
    });
  }
  return issues;
}
