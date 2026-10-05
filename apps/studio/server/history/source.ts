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

import type { HistoryCapabilities, HistoryEntry, HistoryKind, Known, RecordDiff, Subject } from '../../src/history/types.ts';

export interface HistoryQuery {
  /** a name or email, matched case-insensitively as a substring */
  person?: string;
  /** YYYY-MM-DD, inclusive */
  from?: string;
  to?: string;
  kind?: HistoryKind;
  /** an entry id: answer the entries older than it */
  before?: string;
  limit: number;
}

export interface HistoryList {
  entries: HistoryEntry[];
  next?: string;
}

/** A subject's restorable parts right after an entry; `'current'`: unchanged since, read it from the stores. */
export type SubjectState = Record<string, Known | 'current'>;

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
}

export const NO_HISTORY: HistoryCapabilities = {
  backend: 'none',
  note: 'This hub keeps its catalog as files outside git, so no change history is recorded. Saved design versions still work. Put the catalog in a git repository and turn on the git export (WIREHUB_GIT_AUTOCOMMIT=true) to record every save, or use the database backend.',
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
