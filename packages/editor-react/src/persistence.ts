/**
 * Persistence, as an interface the editor is handed.
 *
 * The editor still never persists anything and never calls out — it asks the
 * host to. `PersistenceAdapter` is the whole contract between them: the studio
 * implements it with `fetch` against the workbench API, the future ERP
 * implements it against its own store, and the tests implement it with a `Map`.
 * No URL, no `fetch`, and no transport detail appears anywhere in this package;
 * that is what keeps `CableEditor` host-agnostic.
 *
 * **Adapters do not throw.** Every method answers with an `Outcome`, because a
 * failure here is something a person has to read and act on — an unreachable
 * server, a name already taken, a design the validator refused — and an
 * exception is not a sentence. "Nothing dead-ends" is a rule of this spec, and
 * it starts at this boundary.
 */

import { CURRENT_SCHEMA_VERSION, type CableDesign, type Issue } from '@wirehub/model';

/** What a design picker needs: the id and the human name. */
export interface DesignSummary {
  id: string;
  label: string;
}

/**
 * The answer to any request. `message` is a sentence about what happened,
 * `hint` is what to do next, `issues` is the validator's list when the store
 * refused a document on its merits.
 */
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; hint?: string; issues?: Issue[]; /** the HTTP status, when the server answered at all */ status?: number };

export interface PersistenceAdapter {
  /** every design the host knows about, for the picker */
  list(): Promise<Outcome<DesignSummary[]>>;
  /** the stored design — the "revert" target and the dirty-tracking baseline */
  load(id: string): Promise<Outcome<CableDesign>>;
  /** store an existing design; the host validates before writing */
  save(design: CableDesign): Promise<Outcome<CableDesign>>;
  /** store a design that does not exist yet; must refuse an id already in use */
  create(design: CableDesign): Promise<Outcome<CableDesign>>;
  duplicate(id: string, newId: string, newLabel: string): Promise<Outcome<CableDesign>>;
  rename(id: string, newId: string, newLabel: string): Promise<Outcome<CableDesign>>;
  /**
   * Delete, with the design's own id echoed back as `confirm`. The token is
   * not ceremony: it is what makes a stray or replayed call harmless.
   */
  remove(id: string, confirm: string): Promise<Outcome<{ id: string }>>;
}

/* ------------------------------------------------------------------ *
 * Ids and names
 * ------------------------------------------------------------------ */

/**
 * The id rule, client-side.
 *
 * The host enforces this too and is the authority — an id also becomes a file
 * name there. This copy exists so the GUI can say "that will not work" while
 * the user is still typing, instead of after a round trip.
 */
export function isDesignId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/**
 * A label turned into a usable id: "the source device (NTSC) → SCART, 75 Ω coax" becomes
 * `xlr-mic-cable-5-m`. Accents are folded, everything else that is not a
 * letter or digit becomes a single hyphen.
 *
 * A suggestion, never a decision — the New/Duplicate/Rename dialogs show it in
 * an editable field, and stop suggesting the moment the user types their own.
 */
export function slugify(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
}

/** `slugify`, then `-2`, `-3`… until the id is free. Empty labels get nothing. */
export function suggestDesignId(label: string, taken: Iterable<string> = []): string {
  const base = slugify(label);
  if (base === '') return '';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A new, empty design — valid the moment it is created, so New never fails. */
export function blankDesign(id: string, label: string, src: string): CableDesign {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    label,
    instances: { connectors: [], segments: [], components: [], pcbas: [] },
    joints: [],
    src,
  };
}

/* ------------------------------------------------------------------ *
 * Dirty tracking
 * ------------------------------------------------------------------ */

/**
 * Whether the draft says anything the stored design does not.
 *
 * Compared as documents, not by identity: undo/redo and a round trip through
 * the JSON pane all produce fresh objects that mean exactly the same thing, and
 * an editor that called those "unsaved changes" would train people to ignore
 * the marker. With no baseline (the host has not loaded one) a draft counts as
 * unsaved — the safe direction to be wrong in.
 */
export function isDirty(draft: CableDesign, baseline: CableDesign | undefined): boolean {
  if (baseline === undefined) return true;
  return canonical(draft) !== canonical(baseline);
}

/**
 * JSON with object keys in a fixed order, so two documents that state the same
 * facts compare equal however they were built. Array order is meaning here —
 * joints and instances are ordered lists — so it is left exactly as it is.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
