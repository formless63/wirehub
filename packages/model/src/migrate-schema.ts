/**
 * The only reader of old design schema versions (storage seams,
 *).
 *
 * Every stored design is at `CURRENT_SCHEMA_VERSION` (4). Versions 1–3 only
 * ever *added* optional structure (v2 pigtails / bonded stocks / pad
 * qualifiers, v3 `recipe`, v4 breakouts), so an older document upgrades by
 * taking the current number — nothing in its body moves. This module is what
 * the one-shot catalog migration (`packages/catalog/scripts/migrate-schema-version.ts`)
 * and the workbench API's body reader call; nothing else looks at a version
 * number below the current one.
 */

import { CURRENT_SCHEMA_VERSION, type CableDesign } from './model.ts';

/** Every schema version a document may arrive at. */
export const READABLE_SCHEMA_VERSIONS = [1, 2, 3, 4] as const;

export function isReadableSchemaVersion(value: unknown): value is (typeof READABLE_SCHEMA_VERSIONS)[number] {
  return (READABLE_SCHEMA_VERSIONS as readonly unknown[]).includes(value);
}

/**
 * `design` at the current schema version. Idempotent: a current document
 * comes back as the same object, `changed: false`. Throws for a version this
 * code cannot read (a newer tool wrote it).
 */
export function upgradeDesignSchema<T extends Pick<CableDesign, 'schemaVersion'>>(design: T): { design: T; from: number; changed: boolean } {
  const from = design.schemaVersion as unknown;
  if (!isReadableSchemaVersion(from)) throw new Error(`unsupported design schemaVersion ${String(from)}`);
  if (from === CURRENT_SCHEMA_VERSION) return { design, from, changed: false };
  return { design: { ...design, schemaVersion: CURRENT_SCHEMA_VERSION }, from, changed: true };
}
