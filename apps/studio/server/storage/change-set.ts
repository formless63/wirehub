/**
 * The change set — what one request asks storage to write, in a shape no
 * backend owns (storage seams; `specs/storage-seam.md`).
 *
 * A handler never writes. It reads through the unit of work's stores, runs
 * the pure core logic, and every write it makes is *staged* here as a
 * `RecordChange`: a record kind, the record's key within that kind, and the
 * new value (a JSON document, plus bytes for binary records). At the end of
 * the request the whole set is committed in one step by the backend — today
 * the file backend (atomic temp+rename per file, the write journal, the git
 * backup commit), later a Postgres backend (one SQL transaction; binary
 * payloads to object storage).
 *
 * Nothing here mentions a path, a file name or a table.
 */

import type { StudioUser } from '../me.ts';

/** Every record kind the workbench writes. Keys are the kind's natural id. */
export type RecordKind =
  /** key = design id; value = `CableDesign` */
  | 'design'
  /** key = design id; value = `DrawingMeta` (title block) */
  | 'drawing'
  /** key = design id; value = `{ mime }` + `bytes`, or delete = no photo */
  | 'drawing-photo'
  /** key = definition kind (`connectors`, `pcbas`, …); value = the whole record list */
  | 'definitions'
  /** key = list id; value = `VocabList` */
  | 'vocab'
  /** key = `review`; value = `TagReview` (the hand-reviewed input the tag table derives from) */
  | 'tag-review'
  /** key = `parts` | `recipes`; value = the whole list */
  | 'wire-library'
  /** key = wire stock id; value = `WireDefinition` */
  | 'wire'
  /** key = build file name; value = `BoardBuilds` */
  | 'builds'
  /** key = `<design id>/<rev>`; value = `DesignVersionFile` */
  | 'design-version'
  /** key = design id; value = `WorkingState` */
  | 'version-working'
  /** key = `<design id>/<n>`; value = `DraftFile` */
  | 'version-draft'
  /** key = `<design id>/<blob name>`; `bytes` = the artwork blob */
  | 'version-artwork'
  /** key = design id — every versions record of a design (op `move` on rename) */
  | 'design-versions'
  /** key = asset id (sha256 of the bytes); value = `{ mime, originalName, src }` + `bytes` */
  | 'asset'
  /** key = the Library record, `<kind>/<id>`; value = `ModelLink`; delete = detach (B0) */
  | 'model-link'
  /** key = definition id; value = the depiction's `meta.json` record (B7) */
  | 'depiction-meta'
  /** key = `<definition id>/<file>`; `bytes` = the artwork file (B7) */
  | 'depiction-asset'
  /** key = a catalog path (`data/…`); value = the document: JSON, or text for `.md`/`.txt`; delete removes it */
  | 'doc';

/** Records recomputed from the others at commit — never staged by a handler. */
/** `module`: whatever derived records a module's `DerivedStore` keeps (`derived.ts`) */
export type DerivedKind = 'tags' | 'module';

export interface RecordChange {
  kind: RecordKind;
  key: string;
  /** `move` renames every record of a design (`key`) to `to` */
  op: 'put' | 'delete' | 'move';
  /** the new JSON document (`put`) */
  value?: unknown;
  /** a binary payload (`put` of an asset, a photo, an artwork blob) */
  bytes?: Uint8Array;
  /** `move` only: the new key */
  to?: string;
  /**
   * Optimistic concurrency: the version (content ETag) of this record when
   * the unit of work read it — `null` when it read "no such record". The
   * commit refuses the whole set if any record has moved on since. Absent:
   * the record was not read first (an unconditional write).
   */
  expect?: string | null;
}

export interface ChangeSet {
  changes: RecordChange[];
  /** who made the change and how, for the backend's own log (the file backend's git commit is written by the host) */
  context: { method: string; path: string; user?: StudioUser };
}

export interface CommitResult {
  /** the primary changes applied, in order */
  applied: number;
  /** the derived records recomputed because of them */
  derived: DerivedKind[];
}

/** A precondition failed at commit: `kind`/`key` changed since this request read it. Nothing was written. */
export class StaleRecordError extends Error {
  readonly kind: RecordKind;
  readonly key: string;
  constructor(kind: RecordKind, key: string) {
    super(`${kind} '${key}' changed since it was read`);
    this.name = 'StaleRecordError';
    this.kind = kind;
    this.key = key;
  }
}

/**
 * A backend that cannot write (the Postgres backend before its write path,
 * plan Phase B) refused a change. Nothing was written; the request answers 503.
 */
export class ReadOnlyBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlyBackendError';
  }
}

/** A value, or a promise of one — what every store method returns (a file store answers at once, a database later). */
export type Awaitable<T> = T | Promise<T>;
