/**
 * Derived records the studio keeps committed beside the catalog, recomputed
 * by the unit of work's commit whenever a save changes one of their inputs —
 * so they are never stale behind a save, and an optional git export commits
 * them together with the change that moved them.
 *
 * The base keeps one derived record itself — the signal-tag table, owned by
 * `TagStore.regenerate` (`vocab-store.ts`). A module that keeps reports or
 * export bundles of its own (a part-number reconciliation, a configurator
 * export) supplies a `DerivedStore` through the deps (`docs/modules.md`).
 */

import type { Awaitable, DerivedKind } from './storage/change-set.ts';

export interface DerivedStore {
  /** Recompute every derived record from what is stored now; the kinds whose bytes changed. */
  regenerate(): Awaitable<DerivedKind[]>;
}
