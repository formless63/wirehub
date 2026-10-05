/**
 * Revisions of library records (`docs/revisions.md`): a connector, a board, a shell … saved as
 * numbered revisions with a note, the way a design saves versions.
 *
 * A revision is a snapshot of the record as the library had it (with its part number, so a new
 * variant number under the scheme's variant segment shows which revision got it), optionally the
 * record's 2D art and the content address of its 3D model at the time, so two revisions can be
 * compared field by field, picture by picture and model by model. **Where used** reads the saved
 * design versions: a version froze the definitions it used, so the revision whose snapshot equals
 * a version's frozen copy is the one that version was built with; designs' working copies use the
 * record as it is now.
 *
 * Other sources (an external file share, a PLM) can supply revisions through a module
 * (`revisionSources`) or the API; they are listed beside the hub's own, read-only.
 *
 * Pure: records in, records out. The host supplies times and names.
 */

import type { Db, Issue } from './model.ts';
import { stableJson, type DesignVersionFile, type FrozenDefinitions } from './versions.ts';

/** The library kinds that keep revisions. */
export const REVISION_KINDS = ['connectors', 'components', 'wires', 'pcbas', 'mechanicals', 'kits', 'bodies', 'interfaces'] as const;

export type RevisionKind = (typeof REVISION_KINDS)[number];

export const isRevisionKind = (kind: string): kind is RevisionKind => (REVISION_KINDS as readonly string[]).includes(kind);

/** A record's 2D art at a revision: one drawn view, as SVG text (inert when shown as an image). */
export interface RevisionArt {
  view: string;
  svg: string;
}

export interface RecordRevision {
  /** 1, 2, 3 … in the order they were saved */
  rev: number;
  /** how people name it, when not by number (`Rev B`, `2026 tooling`) */
  label?: string;
  note: string;
  /** ISO time, from the host */
  savedAt: string;
  savedBy?: string;
  /** the record's part number at this revision */
  partNumber?: string;
  /** the record as the library had it */
  record: Record<string, unknown>;
  art?: RevisionArt;
  /** the record's 3D model at this revision: its content address (sha256) */
  model?: { asset: string; mime?: string };
}

/** One record's revisions: `data/revisions/<kind>/<id>.json`. */
export interface RecordRevisionFile {
  kind: string;
  id: string;
  revisions: RecordRevision[];
}

/** A revision another source supplies (a module's `revisionSources`, an import): read-only beside the hub's. */
export interface ExternalRevision {
  /** the source's own name for it (`Rev6`, `B`, a commit) */
  rev: string;
  label?: string;
  note?: string;
  savedAt?: string;
  partNumber?: string;
  record?: Record<string, unknown>;
  art?: RevisionArt;
  model?: { asset: string; mime?: string };
  /** where it came from, as a citation */
  src: string;
}

/** The catalog path of a record's revision file. */
export const revisionFilePath = (kind: string, id: string): string => `data/revisions/${kind}/${id}.json`;

const DB_FIELD: Readonly<Record<RevisionKind, keyof Db>> = {
  connectors: 'connectors',
  components: 'components',
  wires: 'wires',
  pcbas: 'pcbas',
  mechanicals: 'mechanicals',
  kits: 'kits',
  bodies: 'bodies',
  interfaces: 'interfaces',
};

/** A library record as the loaded library has it (a connector with its pins composed). */
export function findLibraryRecord(db: Db, kind: string, id: string): Record<string, unknown> | undefined {
  if (!isRevisionKind(kind)) return undefined;
  const list = (db[DB_FIELD[kind]] ?? []) as readonly { id?: string; sku?: string }[];
  return list.find((r) => (r.id ?? r.sku) === id) as Record<string, unknown> | undefined;
}

/** Two snapshots of one record say the same thing (key order aside). */
export function sameRecord(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/** The revision a record equals, newest first; `undefined` when it changed since the last one. */
export function revisionOfRecord(file: RecordRevisionFile | undefined, record: unknown): RecordRevision | undefined {
  return [...(file?.revisions ?? [])].reverse().find((r) => sameRecord(r.record, record));
}

export interface NewRevisionInput {
  note: string;
  at: string;
  by?: string;
  label?: string;
  art?: RevisionArt;
  model?: { asset: string; mime?: string };
}

/** The file with `record` saved as the next revision. */
export function saveRecordRevision(file: RecordRevisionFile | undefined, kind: string, id: string, record: Record<string, unknown>, input: NewRevisionInput): RecordRevisionFile {
  const revisions = file?.revisions ?? [];
  const rev = revisions.reduce((n, r) => Math.max(n, r.rev), 0) + 1;
  const pn = typeof record['partNumber'] === 'string' ? record['partNumber'] : typeof record['sku'] === 'string' ? record['sku'] : undefined;
  const next: RecordRevision = {
    rev,
    ...(input.label === undefined || input.label.trim() === '' ? {} : { label: input.label.trim() }),
    note: input.note,
    savedAt: input.at,
    ...(input.by === undefined ? {} : { savedBy: input.by }),
    ...(pn === undefined ? {} : { partNumber: pn }),
    record,
    ...(input.art === undefined ? {} : { art: input.art }),
    ...(input.model === undefined ? {} : { model: input.model }),
  };
  return { kind, id, revisions: [...revisions, next] };
}

const MAX_SVG = 512 * 1024;

/** What is wrong with a revision file (one sent through the API), one sentence each. */
export function recordRevisionProblems(value: unknown, kind: string, id: string): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['a revision file is { kind, id, revisions: [...] }'];
  const file = value as Partial<RecordRevisionFile>;
  if (file.kind !== kind || file.id !== id) problems.push(`the file is for ${String(file.kind)}/${String(file.id)}, not ${kind}/${id}`);
  if (!Array.isArray(file.revisions)) return [...problems, 'revisions must be a list'];
  const seen = new Set<number>();
  for (const [i, r] of file.revisions.entries()) {
    const at = `revision ${i + 1}`;
    if (typeof r !== 'object' || r === null) {
      problems.push(`${at} is not an object`);
      continue;
    }
    if (!Number.isInteger(r.rev) || r.rev < 1) problems.push(`${at}: rev must be a whole number from 1`);
    else if (seen.has(r.rev)) problems.push(`${at}: rev ${r.rev} appears twice`);
    else seen.add(r.rev);
    if (typeof r.note !== 'string') problems.push(`${at}: a note is required (it may be empty)`);
    if (typeof r.savedAt !== 'string' || Number.isNaN(Date.parse(r.savedAt))) problems.push(`${at}: savedAt must be an ISO time`);
    if (typeof r.record !== 'object' || r.record === null || Array.isArray(r.record)) problems.push(`${at}: record must be the record's snapshot`);
    else if ((r.record['id'] ?? r.record['sku']) !== id) problems.push(`${at}: the snapshot is of '${String(r.record['id'] ?? r.record['sku'])}', not '${id}'`);
    if (r.art !== undefined && (typeof r.art !== 'object' || typeof r.art.view !== 'string' || typeof r.art.svg !== 'string' || !/<svg[\s>/]/i.test(r.art.svg) || r.art.svg.length > MAX_SVG)) {
      problems.push(`${at}: art must be { view, svg } with SVG text of at most ${MAX_SVG / 1024} KB`);
    }
    if (r.model !== undefined && (typeof r.model !== 'object' || !/^[0-9a-f]{64}$/.test(String(r.model.asset)))) problems.push(`${at}: model.asset must be a sha256 content address`);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Where used
 * ------------------------------------------------------------------ */

export interface RevisionUse {
  design: string;
  label: string;
  /** the saved version that froze it; absent = the design's working copy */
  version?: number;
  released?: boolean;
}

export interface RevisionWhereUsed {
  /** rev → the versions (and working copies) built with it */
  byRev: Record<number, RevisionUse[]>;
  /** uses of a state of the record no revision recorded (changed since, or never saved) */
  unrecorded: RevisionUse[];
}

const FROZEN_FIELD: Partial<Record<RevisionKind, keyof FrozenDefinitions>> = {
  connectors: 'connectors',
  components: 'components',
  wires: 'wires',
  pcbas: 'pcbas',
  mechanicals: 'mechanicals',
  bodies: 'bodies',
  interfaces: 'interfaces',
};

/**
 * Which revision each saved version was built with, and which the working copies use now.
 * `designs`: the designs that use the record now (working copy), with its current snapshot;
 * `versions`: saved version files of any design (their frozen definitions are read).
 */
export function revisionsWhereUsed(
  file: RecordRevisionFile | undefined,
  kind: string,
  id: string,
  current: Record<string, unknown> | undefined,
  designs: readonly { id: string; label: string }[],
  versions: readonly Pick<DesignVersionFile, 'designId' | 'rev' | 'definitions' | 'design' | 'approval'>[],
  released?: ReadonlyMap<string, number | undefined>,
): RevisionWhereUsed {
  const out: RevisionWhereUsed = { byRev: {}, unrecorded: [] };
  const place = (snapshot: unknown, use: RevisionUse): void => {
    const rev = revisionOfRecord(file, snapshot);
    if (rev === undefined) out.unrecorded.push(use);
    else (out.byRev[rev.rev] ??= []).push(use);
  };
  const field = isRevisionKind(kind) ? FROZEN_FIELD[kind] : undefined;
  if (field !== undefined) {
    for (const v of versions) {
      const frozen = ((v.definitions[field] ?? []) as readonly { id: string }[]).find((r) => r.id === id);
      if (frozen === undefined) continue;
      place(frozen, { design: v.designId, label: v.design.label, version: v.rev, ...(released?.get(v.designId) === v.rev ? { released: true } : {}) });
    }
  }
  if (current !== undefined) for (const d of designs) place(current, { design: d.id, label: d.label });
  return out;
}
