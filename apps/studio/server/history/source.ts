/**
 * Where a hub's change history comes from (cs-5k1.4): one interface, three
 * sources —
 *
 * - **database** (`pg.ts`): `change_set` / `change` rows, read through the
 *   app role and the org's row-level security. Every save is there, with its
 *   person; diffs and restores work for every change since migration 0017
 *   (earlier ones as far as neighbouring rows recorded them).
 * - **git** (`git.ts`): the file backend's catalog, when it is in a git work
 *   tree — the commits the git export (`WIREHUB_GIT_AUTOCOMMIT=true`) makes,
 *   or anyone else's. Saves made while the export is off are not in it.
 * - **none**: a file catalog outside git. Nothing is recorded; the panel says so.
 */

import type { CheckpointSummary, HistoryCapabilities, HistoryEntry, HistoryKind, HistoryTouch, Known, RecordDiff, Subject } from '../../src/history/types.ts';

export interface HistoryQuery {
  /** a name or email, matched case-insensitively as a substring */
  person?: string;
  /** YYYY-MM-DD, inclusive */
  from?: string;
  to?: string;
  kind?: HistoryKind;
  /** an entry id: answer the entries older than it */
  before?: string;
  /** an API token id: only the change sets made with it (an agent checkpoint) */
  token?: string;
  limit: number;
}

export interface HistoryList {
  entries: HistoryEntry[];
  next?: string;
}

/** A subject's restorable parts right after an entry; `'current'`: unchanged since, read it from the stores. */
export type SubjectState = Record<string, Known | 'current'>;

/** A design's drawing photo at some point: by the hash its bytes are stored under, `'none'`, or why not. */
export type PhotoState = { sha256: string; mime?: 'image/png' | 'image/jpeg'; bytes?: Uint8Array } | { unrestorable: string } | 'none' | undefined;

/** One record an agent checkpoint changed (`CheckpointSource.of`). */
export interface CheckpointRecord {
  subject: Subject;
  /** the restorable parts (and `photo`) the checkpoint's change sets changed */
  parts: string[];
  /** change sets by anyone else that changed those parts after the checkpoint began */
  others: string[];
  /** each changed part's state right before the checkpoint began; `'current'`: unchanged since */
  before: SubjectState;
  /** a design's drawing photo before the checkpoint, when the checkpoint changed it */
  photo?: PhotoState;
}

/**
 * A catalog document a checkpoint changed that its undo puts back besides records (what Explore keeps,
 * `CHECKPOINT_DOCS`): its value before the checkpoint's first change and after its last. `undefined`: absent.
 */
export interface CheckpointDoc {
  path: string;
  before: unknown;
  after: unknown;
  /** false when a change set from before history kept bodies left the earlier value unrecorded */
  recorded: boolean;
}

/** The documents an agent checkpoint's undo covers besides records: Explore's kept explorations and their picks. */
export const CHECKPOINT_DOCS: readonly string[] = ['data/explore/saved.json'];

/** Agent checkpoints (database only): an API token's change sets, grouped. */
export interface CheckpointSource {
  /** the tokens that made changes, the most recent first */
  list(limit: number): Promise<CheckpointSummary[]>;
  /** one token's checkpoint, from change set `from` on (default: its first); undefined: the token made none */
  of(token: string, from?: string): Promise<{ summary: CheckpointSummary; from: string; entries: HistoryEntry[]; records: CheckpointRecord[]; others: HistoryTouch[]; docs?: CheckpointDoc[] } | undefined>;
}

export interface HistorySource {
  capabilities(): Promise<HistoryCapabilities>;
  /** the hub's entries, newest first */
  list(query: HistoryQuery): Promise<HistoryList>;
  /** the entries that changed `subject`, newest first */
  record(subject: Subject, query: { before?: string; limit: number }): Promise<HistoryList>;
  /** one entry and what it changed (only `subject`'s parts, when given); undefined: no such entry */
  detail(id: string, subject?: Subject): Promise<{ entry: HistoryEntry; records: RecordDiff[] } | undefined>;
  /**
   * The restorable parts of `subject` right after entry `id`; undefined: no
   * such entry. `stored`: the library record is in its file form (a git
   * catalog keeps connectors as body + interface), to be composed before it
   * goes back through the definition routes.
   */
  stateAt(subject: Subject, id: string): Promise<{ parts: SubjectState; stored?: boolean } | undefined>;
  /**
   * A design's drawing photo right after entry `id`, by the content hash its
   * bytes are stored under; `'none'`: the drawing had no photo then;
   * undefined: not recoverable (an older entry, a legacy per-design file, no
   * such entry). The bytes are read by hash (`WorkbenchDeps.blobByHash`).
   */
  photoAt?(subject: Subject, id: string): Promise<PhotoState>;
  /** agent checkpoints, where the history records which token made each change */
  checkpoints?: CheckpointSource;
}

export const NO_HISTORY: HistoryCapabilities = {
  backend: 'none',
  note: 'This hub keeps its catalog as files outside git, so no change history is recorded. Saved design versions still work. Put the catalog in a git repository and turn on the git export to record every save, or use the database backend.',
  perRecord: false,
  diff: false,
  restore: false,
  filters: { person: false, date: false, kind: false },
};

/** A hub with no history: every list is empty and says why. */
export function noHistorySource(capabilities: HistoryCapabilities = NO_HISTORY): HistorySource {
  return {
    capabilities: async () => capabilities,
    list: async () => ({ entries: [] }),
    record: async () => ({ entries: [] }),
    detail: async () => undefined,
    stateAt: async () => undefined,
  };
}
