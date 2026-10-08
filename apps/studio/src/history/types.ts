/**
 * Change history: the vocabulary the server's history routes and the
 * browser's History panel share (cs-5k1.4). Pure, no IO — imported by both
 * `server/` and the browser bundle, like `locks/records.ts`.
 *
 * A **subject** is the record a person asks the history of, named exactly as
 * an edit lock names it: `design:<id>` or `definition:<kind>:<id>` (plus
 * `vocab:<list>` and `build:<name>`, restored through the vocab and builds routes). A subject has
 * **parts**: a design is its document and its drawing details (both
 * restorable), its photo and its saved versions (listed only); a library
 * record is the record itself (restorable), its 3D model link and its artwork.
 *
 * An **entry** is one change set (the database backend) or one commit (the
 * file backend's git log): who, when, the message, and which records it
 * touched.
 */

import { LOCKABLE_DEFINITION_KINDS } from '../locks/records.ts';

export type HistoryBackend = 'database' | 'git' | 'none';

/** What this hub's history can do, said once per answer so the panel never offers what is not there. */
export interface HistoryCapabilities {
  backend: HistoryBackend;
  /** one sentence: where the history comes from, and what it lacks */
  note: string;
  /** a record's own history */
  perRecord: boolean;
  /** before/after states of each change (the field-level diff) */
  diff: boolean;
  /** restore a design or library record to an earlier state */
  restore: boolean;
  /** which filters the hub-wide list honours */
  filters: { person: boolean; date: boolean; kind: boolean };
}

/** The kinds the hub-wide list filters by. */
export const HISTORY_KINDS = ['design', 'library', 'vocab', 'builds', 'other'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export function isHistoryKind(value: unknown): value is HistoryKind {
  return typeof value === 'string' && (HISTORY_KINDS as readonly string[]).includes(value);
}

/** One record an entry touched. */
export interface HistoryTouch {
  /** a subject key (`design:x`), or `other:<what>` for something no panel shows */
  subject: string;
  /** what a person reads: `design de9-crossover`, `connectors list` */
  label: string;
  kind: HistoryKind;
  op: 'put' | 'delete' | 'move';
  /** the part of the subject (`design`, `drawing`, `record`, `versions` …) */
  part?: string;
  /** a move's new key */
  to?: string;
  /** the top-level fields that changed, when both states are known (a record's own history) */
  fields?: string[];
}

export interface HistoryEntry {
  /** the change set id (database) or the commit sha (git) */
  id: string;
  /** ISO time */
  at: string;
  by: { name: string; email?: string };
  /** studio | worker | import | script | migration | git-history | git */
  source: string;
  /** the first line of the message */
  message: string;
  /** the rest of the message, when there is one */
  body?: string;
  /** the catalog version this change set produced (database) */
  version?: string;
  touches: HistoryTouch[];
  /** touches left out of a long list */
  more?: number;
}

export interface HistoryPage {
  capabilities: HistoryCapabilities;
  entries: HistoryEntry[];
  /** pass as `before` for the next (older) page */
  next?: string;
}

/** A state that may not have been recorded: `known: false` says so instead of guessing. */
export type Known<T = unknown> = { known: true; value: T | undefined } | { known: false };

export const UNKNOWN: Known<never> = { known: false };
export const known = <T>(value: T | undefined): Known<T> => ({ known: true, value });

/** One part of one record, before and after an entry. */
export interface RecordDiff {
  subject: string;
  label: string;
  part: string;
  /** added / changed / removed, or `binary` (a file whose bytes changed) */
  op: 'added' | 'changed' | 'removed' | 'binary' | 'unknown';
  before: Known;
  after: Known;
  /** whether a restore can bring this part back */
  restorable: boolean;
}

export interface HistoryEntryDetail {
  capabilities: HistoryCapabilities;
  entry: HistoryEntry;
  records: RecordDiff[];
  /**
   * With `?subject=`: each restorable part's current version (its ETag; null =
   * absent), which a restore quotes back as If-Match — so a restore never
   * lands on a record that moved on after the person looked.
   */
  current?: Record<string, string | null>;
}

/** What `POST /api/history/records/:subject/restore` answers. */
export interface RestoreAnswer {
  restored: { subject: string; entry: string; parts: string[] };
  /** parts that could not be brought back, each said in a sentence (a photo whose file is gone) */
  skipped?: string[];
  /** the restored design (a design subject) or record (a library subject), as stored now */
  value?: unknown;
  etag?: string;
}

/* ------------------------------------------------------------------ *
 * Subjects
 * ------------------------------------------------------------------ */

export type Subject =
  | { type: 'design'; id: string }
  | { type: 'definition'; kind: string; id: string }
  | { type: 'vocab'; list: string }
  | { type: 'build'; name: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

/** `design:x` → `{ type: 'design', id: 'x' }`; undefined for anything else. */
export function parseSubject(text: string): Subject | undefined {
  if (text.length > 260) return undefined;
  const [type, a, b, ...rest] = text.split(':');
  if (rest.length > 0 || a === undefined || !ID.test(a)) return undefined;
  if (type === 'design' && b === undefined) return { type, id: a };
  if (type === 'vocab' && b === undefined) return { type, list: a };
  if (type === 'build' && b === undefined) return { type, name: a };
  if (type === 'definition' && b !== undefined && ID.test(b) && (LOCKABLE_DEFINITION_KINDS as readonly string[]).includes(a)) return { type, kind: a, id: b };
  return undefined;
}

export function subjectKey(subject: Subject): string {
  switch (subject.type) {
    case 'design':
      return `design:${subject.id}`;
    case 'definition':
      return `definition:${subject.kind}:${subject.id}`;
    case 'vocab':
      return `vocab:${subject.list}`;
    case 'build':
      return `build:${subject.name}`;
  }
}

const NOUN: Readonly<Record<string, string>> = {
  connectors: 'connector',
  components: 'component',
  wires: 'wire stock',
  pcbas: 'board',
  bodies: 'body',
  interfaces: 'pinout',
  mechanicals: 'part',
  kits: 'kit',
};

export function subjectLabel(subject: Subject): string {
  switch (subject.type) {
    case 'design':
      return `design ${subject.id}`;
    case 'definition':
      return `${NOUN[subject.kind] ?? subject.kind} ${subject.id}`;
    case 'vocab':
      return `list ${subject.list}`;
    case 'build':
      return `build ${subject.name}`;
  }
}

/** The parts a restore brings back. */
export function restorableParts(subject: Subject): string[] {
  if (subject.type === 'design') return ['design', 'drawing'];
  return ['record'];
}

/** Which hub-wide kind a change-set record kind belongs to. */
export function historyKindOf(recordKind: string): HistoryKind {
  switch (recordKind) {
    case 'design':
    case 'drawing':
    case 'drawing-photo':
    case 'design-version':
    case 'version-working':
    case 'version-draft':
    case 'version-artwork':
    case 'design-versions':
      return 'design';
    case 'definitions':
    case 'wire':
    case 'wire-library':
    case 'model-link':
    case 'depiction-meta':
    case 'depiction-asset':
      return 'library';
    case 'vocab':
    case 'tag-review':
      return 'vocab';
    case 'builds':
      return 'builds';
    default:
      return 'other';
  }
}

/** The change-set record kinds of each hub-wide kind (the database's `kind` filter). */
export const RECORD_KINDS_OF: Readonly<Record<HistoryKind, readonly string[]>> = {
  design: ['design', 'drawing', 'drawing-photo', 'design-version', 'version-working', 'version-draft', 'version-artwork', 'design-versions'],
  library: ['definitions', 'wire', 'wire-library', 'model-link', 'depiction-meta', 'depiction-asset'],
  vocab: ['vocab', 'tag-review'],
  builds: ['builds'],
  other: ['doc', 'catalog-file', 'asset'],
};

const PART_OF: Readonly<Record<string, string>> = {
  design: 'design',
  drawing: 'drawing',
  'drawing-photo': 'photo',
  'design-version': 'versions',
  'version-working': 'versions',
  'version-draft': 'versions',
  'version-artwork': 'versions',
  'design-versions': 'versions',
  definitions: 'record',
  wire: 'record',
  'model-link': 'model',
  'depiction-meta': 'artwork',
  'depiction-asset': 'artwork',
  vocab: 'record',
  builds: 'record',
};

/**
 * The subject one change row is about, read from its record kind and key
 * alone (a definitions list names no single record: its element changes are
 * found by comparing the lists).
 */
export function touchOf(recordKind: string, key: string, op: HistoryTouch['op'], to?: string): HistoryTouch {
  const kind = historyKindOf(recordKind);
  const head = key.includes('/') ? key.slice(0, key.indexOf('/')) : key;
  const part = PART_OF[recordKind];
  const base = { kind, op, ...(part === undefined ? {} : { part }), ...(to === undefined ? {} : { to }) };
  switch (recordKind) {
    case 'design':
    case 'drawing':
    case 'drawing-photo':
    case 'version-working':
    case 'design-versions':
    case 'design-version':
    case 'version-draft':
    case 'version-artwork':
      return { ...base, subject: `design:${head}`, label: `design ${head}${part === 'design' ? '' : ` (${part})`}` };
    case 'definitions':
      return { ...base, subject: `other:definitions:${key}`, label: `${key} list` };
    case 'wire':
      return { ...base, subject: `definition:wires:${key}`, label: `wire stock ${key}` };
    case 'model-link': {
      const [k = '', ...rest] = key.split('/');
      const id = rest.join('/');
      return { ...base, subject: `definition:${k}:${id}`, label: `${NOUN[k] ?? k} ${id} (3D model)` };
    }
    case 'vocab':
      return { ...base, subject: `vocab:${key}`, label: `list ${key}` };
    case 'builds':
      return { ...base, subject: `build:${key}`, label: `build ${key}` };
    case 'depiction-meta':
    case 'depiction-asset':
      return { ...base, subject: `other:artwork:${head}`, label: `artwork ${head}` };
    default:
      return { ...base, subject: `other:${recordKind}:${key}`, label: otherLabel(recordKind, key) };
  }
}

const OTHER_KIND: Readonly<Record<string, string>> = { doc: 'setting', 'catalog-file': 'catalog file', asset: 'file' };

/** What a record with no page of its own is called: its kind and its name, never its path in the data tree. */
export function otherLabel(recordKind: string, key: string): string {
  const name = (key.split('/').pop() ?? key).replace(/\.(json|md|svg|png|jpg|webp)$/i, '');
  return `${OTHER_KIND[recordKind] ?? recordKind} ${name}`;
}

/** `connectors` → the subject of one of its records. */
export function definitionSubject(kind: string, id: string): string {
  return `definition:${kind}:${id}`;
}

export function definitionNoun(kind: string): string {
  return NOUN[kind] ?? kind;
}
