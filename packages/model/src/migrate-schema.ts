/**
 * The only reader of old design schema versions (storage seams).
 *
 * Every stored design is at `CURRENT_SCHEMA_VERSION` (4), or at
 * `SUBASSEMBLY_SCHEMA_VERSION` (5) when it places sub-assemblies. Versions
 * only ever *added* optional structure (v2 pigtails / bonded stocks / pad
 * qualifiers, v3 `recipe`, v4 breakouts, v5 sub-assemblies), so an older document upgrades by
 * taking the current number — nothing in its body moves. This module is what
 * the one-shot catalog migration (`packages/catalog/scripts/migrate-schema-version.ts`)
 * and the workbench API's body reader call; nothing else looks at a version
 * number below the current one.
 */

import { CURRENT_SCHEMA_VERSION, SUBASSEMBLY_SCHEMA_VERSION, type CableDesign } from './model.ts';

/** Every schema version a document may arrive at. */
export const READABLE_SCHEMA_VERSIONS = [1, 2, 3, 4, 5] as const;

export function isReadableSchemaVersion(value: unknown): value is (typeof READABLE_SCHEMA_VERSIONS)[number] {
  return (READABLE_SCHEMA_VERSIONS as readonly unknown[]).includes(value);
}

/**
 * `design` at the schema version it is stored at: the current one, or v5
 * when it places sub-assemblies (`schemaVersionFor`; a document that gained
 * its first sub-assembly is raised to 5, one that lost its last goes back to
 * 4 — nothing in its body moves). Idempotent: a document already there comes
 * back as the same object, `changed: false`. Throws for a version this code
 * cannot read (a newer tool wrote it).
 */
export function upgradeDesignSchema<T extends Pick<CableDesign, 'schemaVersion'>>(design: T): { design: T; from: number; changed: boolean } {
  const from = design.schemaVersion as unknown;
  if (!isReadableSchemaVersion(from)) throw new Error(`unsupported design schemaVersion ${String(from)}`);
  const instances = (design as { instances?: { subassemblies?: unknown } }).instances;
  const target = Array.isArray(instances?.subassemblies) && instances.subassemblies.length > 0 ? SUBASSEMBLY_SCHEMA_VERSION : CURRENT_SCHEMA_VERSION;
  if (from === target) return { design, from, changed: false };
  return { design: { ...design, schemaVersion: target }, from, changed: true };
}
