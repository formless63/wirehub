/**
 * The database backend's change history (cs-5k1.4): `change_set` and
 * `change` rows (`specs/postgres-backend.md` §3.5), read as the app role in
 * the org's transaction — row-level security decides what is visible, as for
 * every other read.
 *
 * - The hub-wide list is the change sets, newest first, filtered by person
 *   (name or email), date and kind; each names the records it touched — a
 *   definitions list save is split into the records that differ in it.
 * - A record's history is every row of its parts (`types.ts`), turned into
 *   per-change-set steps by the timeline (`timeline.ts`).
 * - A state after an entry is the timeline's, or the record as it is now
 *   when nothing changed it since.
 */

import { sql, type RawBuilder } from 'kysely';

import { changedFields } from '../../src/history/diff.ts';
import {
  definitionNoun,
  definitionSubject,
  known,
  RECORD_KINDS_OF,
  restorableParts,
  subjectKey,
  subjectLabel,
  touchOf,
  UNKNOWN,
  type HistoryCapabilities,
  type HistoryEntry,
  type HistoryTouch,
  type Known,
  type RecordDiff,
  type Subject,
} from '../../src/history/types.ts';
import { inOrg, type Db, type Tx } from '../pg/db.ts';
import type { HistoryList, HistoryQuery, HistorySource, SubjectState } from './source.ts';
import { stateAfter, stepsByChangeSet, type PartRow, type PartStep } from './timeline.ts';

export const DATABASE_HISTORY: HistoryCapabilities = {
  backend: 'database',
  note: 'Every save is a change set in the database, with the person who made it. Changes saved before this hub recorded earlier states (migration 0017) may show without their "before".',
  perRecord: true,
  diff: true,
  restore: true,
  filters: { person: true, date: true, kind: true },
};

/** Parts whose states are documents a person can read field by field. */
const DIFFABLE = new Set(['design', 'drawing', 'record', 'model', 'artwork-meta']);
/** Record kinds whose changes carry bytes, not a document. */
const BINARY_KINDS = new Set(['drawing-photo', 'version-artwork', 'depiction-asset', 'asset', 'catalog-file']);
/** At most this many touches listed per entry; the rest are counted. */
const TOUCHES = 25;
/** A record's history reads at most this many of its newest rows. */
const RECORD_ROWS = 5000;

interface SetRow {
  id: string;
  version: string;
  at: Date;
  name: string;
  email: string | null;
  source: string;
  message: string;
}

function entryOf(row: SetRow, touches: HistoryTouch[], more = 0): HistoryEntry {
  const [first = '', ...rest] = row.message.split('\n');
  const body = rest.join('\n').trim();
  return {
    id: row.id,
    at: row.at.toISOString(),
    by: { name: row.name, ...(row.email === null ? {} : { email: row.email }) },
    source: row.source,
    message: first,
    ...(body === '' ? {} : { body }),
    version: row.version,
    touches,
    ...(more > 0 ? { more } : {}),
  };
}

const SET_COLUMNS = sql`s.id::text AS id, s.catalog_version::text AS version, s.created_at AS at, s.actor_label AS name, p.email, s.source, s.message`;

/** A recorded JSON text as a state: SQL NULL = not recorded; JSON `null` = absent. */
function stateOf(text: string | null, recorded: boolean): Known {
  if (!recorded) return UNKNOWN;
  return known(text === null || text === 'null' ? undefined : (JSON.parse(text) as unknown));
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/* ------------------------------------------------------------------ *
 * A subject's rows
 * ------------------------------------------------------------------ */

interface SubjectRowsSql {
  where: RawBuilder<unknown>;
  /** the definition id whose element a definitions list row is read for */
  element?: string;
  part(kind: string): string | undefined;
}

/** A design's ids over time: the current one, then each earlier one with the change set that renamed it away. */
interface DesignId {
  id: string;
  /** rows of this id older than this change set only (the change set that created the next id) */
  before?: string;
}

/** Follows a design back through its renames: a rename moves the design's drawing and saved-versions rows (`from` -> `to`). */
async function designIds(tx: Tx, id: string): Promise<DesignId[]> {
  const chain: DesignId[] = [{ id }];
  for (let i = 0; i < 25; i += 1) {
    const last = chain[chain.length - 1] as DesignId;
    const moved = (
      await sql<{ key: string; cs: string }>`
        SELECT c.key, c.change_set_id::text AS cs FROM studio.change c
         WHERE c.kind IN ('design-versions', 'drawing') AND c.op = 'move' AND c.to_key = ${last.id}
           ${last.before === undefined ? sql`` : sql`AND c.change_set_id < ${last.before}::bigint`}
         ORDER BY c.change_set_id DESC LIMIT 1`.execute(tx)
    ).rows[0];
    if (moved === undefined) break;
    // the cutoffs only fall, so a design renamed away and back terminates
    chain.push({ id: moved.key, before: moved.cs });
  }
  return chain;
}

function designWhere(entry: DesignId): RawBuilder<unknown> {
  const id = entry.id;
  const prefix = `${id}/`;
  const cap = entry.before === undefined ? sql`` : sql` AND c.change_set_id < ${entry.before}::bigint`;
  return sql`(((c.kind IN ('design', 'drawing', 'drawing-photo', 'version-working') AND c.key = ${id})
          OR (c.kind IN ('design-versions', 'drawing') AND c.op = 'move' AND c.to_key = ${id})
          OR (c.kind = 'design-versions' AND c.key = ${id})
          OR (c.kind IN ('design-version', 'version-draft', 'version-artwork') AND left(c.key, ${prefix.length}) = ${prefix}))${cap})`;
}

function subjectSql(subject: Subject, ids: readonly DesignId[] = []): SubjectRowsSql {
  switch (subject.type) {
    case 'design': {
      const chain = ids.length === 0 ? [{ id: subject.id }] : ids;
      // the move rows of the rename itself belong to the new id's history; the old id's rows end before it
      const where = chain.map(designWhere).reduce((a, b) => sql`${a} OR ${b}`);
      return {
        where: sql`(${where})`,
        part: (kind) => (kind === 'design' ? 'design' : kind === 'drawing' ? 'drawing' : kind === 'drawing-photo' ? 'photo' : 'versions'),
      };
    }
    case 'definition': {
      const { kind: defKind, id } = subject;
      const prefix = `${id}/`;
      return {
        where: sql`((c.kind = 'definitions' AND c.key = ${defKind})
          OR (c.kind = 'wire' AND ${defKind} = 'wires' AND c.key = ${id})
          OR (c.kind = 'model-link' AND c.key = ${`${defKind}/${id}`})
          OR (c.kind = 'depiction-meta' AND c.key = ${id})
          OR (c.kind = 'depiction-asset' AND left(c.key, ${prefix.length}) = ${prefix}))`,
        element: id,
        part: (kind) => (kind === 'definitions' || kind === 'wire' ? 'record' : kind === 'model-link' ? 'model' : kind === 'depiction-meta' ? 'artwork-meta' : 'artwork'),
      };
    }
    case 'vocab':
      return { where: sql`(c.kind = 'vocab' AND c.key = ${subject.list})`, part: () => 'record' };
    case 'build':
      return { where: sql`(c.kind = 'builds' AND c.key = ${subject.name})`, part: () => 'record' };
  }
}

interface SubjectRow extends SetRow {
  cs: string;
  seq: number;
  kind: string;
  op: 'put' | 'delete' | 'move';
  after_text: string | null;
  after_recorded: boolean;
  before_text: string | null;
  before_recorded: boolean;
}

async function subjectRows(tx: Tx, subject: Subject): Promise<{ rows: SubjectRow[]; parts: PartRow[] }> {
  const q = subjectSql(subject, subject.type === 'design' ? await designIds(tx, subject.id) : []);
  const element = q.element ?? null;
  // a definitions list row is read for one element: its JSON text, or JSON null when the list lacks it
  const pick = (column: RawBuilder<unknown>): RawBuilder<unknown> =>
    sql`CASE WHEN c.kind = 'definitions' THEN
          CASE WHEN json_typeof(${column}) = 'array'
               THEN coalesce((SELECT e::text FROM json_array_elements(${column}) e WHERE e ->> 'id' = ${element} LIMIT 1), 'null')
               WHEN json_typeof(${column}) = 'null' THEN 'null' END
        ELSE ${column}::text END`;
  const rows = (
    await sql<SubjectRow>`
      SELECT * FROM (
        SELECT ${SET_COLUMNS}, c.change_set_id::text AS cs, c.seq, c.kind, c.op,
               ${pick(sql`c.after_body`)} AS after_text, c.after_body IS NOT NULL AS after_recorded,
               ${pick(sql`c.before_body`)} AS before_text, c.before_body IS NOT NULL AS before_recorded
          FROM studio.change c
          JOIN studio.change_set s ON s.id = c.change_set_id
          LEFT JOIN studio.person p ON p.id = s.actor_id
         WHERE ${q.where}
         ORDER BY c.change_set_id DESC, c.seq DESC
         LIMIT ${RECORD_ROWS}
      ) x ORDER BY x.cs::bigint, x.seq`.execute(tx)
  ).rows;
  const parts: PartRow[] = [];
  for (const r of rows) {
    const part = q.part(r.kind);
    if (part === undefined) continue;
    const binary = BINARY_KINDS.has(r.kind) || r.op === 'move' || !DIFFABLE.has(part);
    const after: Known = r.op === 'delete' ? known(undefined) : stateOf(r.after_text, r.after_recorded);
    parts.push({ cs: r.cs, seq: r.seq, part, before: stateOf(r.before_text, r.before_recorded), after, binary });
  }
  return { rows, parts };
}

const PART_LABEL: Readonly<Record<string, string>> = {
  design: 'design',
  drawing: 'drawing details',
  photo: 'drawing photo',
  versions: 'saved versions',
  record: 'record',
  model: '3D model',
  'artwork-meta': 'artwork',
  artwork: 'artwork file',
};

function diffOp(step: PartStep): RecordDiff['op'] {
  if (step.binary) return 'binary';
  if (!step.before.known || !step.after.known) return step.after.known && step.after.value === undefined ? 'removed' : 'unknown';
  if (step.before.value === undefined) return 'added';
  if (step.after.value === undefined) return 'removed';
  return 'changed';
}

function recordDiffs(subject: Subject, steps: readonly PartStep[]): RecordDiff[] {
  const restorable = new Set(restorableParts(subject));
  return steps.map((step) => ({
    subject: subjectKey(subject),
    label: `${subjectLabel(subject)} — ${PART_LABEL[step.part] ?? step.part}`,
    part: step.part,
    op: diffOp(step),
    before: step.before,
    after: step.after,
    // a photo is restored with the rest of the design, by the bytes' hash
    restorable: step.part === 'photo' ? subject.type === 'design' : restorable.has(step.part) && !step.binary,
  }));
}

function stepTouches(subject: Subject, steps: readonly PartStep[]): HistoryTouch[] {
  return steps.map((step) => {
    const op: HistoryTouch['op'] = step.after.known && step.after.value === undefined ? 'delete' : 'put';
    const fields = !step.binary && step.before.known && step.after.known ? changedFields(step.before.value, step.after.value) : undefined;
    return {
      subject: subjectKey(subject),
      label: `${subjectLabel(subject)} — ${PART_LABEL[step.part] ?? step.part}`,
      kind: subject.type === 'design' ? 'design' : subject.type === 'definition' ? 'library' : subject.type === 'vocab' ? 'vocab' : 'builds',
      op,
      part: step.part,
      ...(fields === undefined ? {} : { fields }),
    };
  });
}

/* ------------------------------------------------------------------ *
 * The source
 * ------------------------------------------------------------------ */

export function pgHistorySource(db: Db, orgId: string): HistorySource {
  const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => inOrg(db, orgId, fn, { snapshot: true, statementTimeoutMs: 30_000 });

  async function touchesOf(tx: Tx, ids: string[]): Promise<Map<string, { touches: HistoryTouch[]; more: number }>> {
    const out = new Map<string, { touches: HistoryTouch[]; more: number }>();
    if (ids.length === 0) return out;
    const rows = (
      await sql<{ cs: string; seq: number; kind: string; key: string; op: 'put' | 'delete' | 'move'; to_key: string | null; n: string; ids: string[] | null }>`
        SELECT x.cs, x.seq, x.kind, x.key, x.op, x.to_key, x.n::text AS n,
               CASE WHEN x.kind = 'definitions' AND json_typeof(x.after_body) = 'array' AND x.before_body IS NOT NULL THEN
                 coalesce((SELECT array_agg(coalesce(a.id, b.id) ORDER BY coalesce(a.id, b.id))
                    FROM (SELECT e ->> 'id' AS id, e::text AS t FROM json_array_elements(x.after_body) e) a
                    FULL JOIN (SELECT e ->> 'id' AS id, e::text AS t
                                 FROM json_array_elements(CASE WHEN json_typeof(x.before_body) = 'array' THEN x.before_body ELSE '[]'::json END) e) b
                      ON a.id = b.id
                   WHERE a.t IS DISTINCT FROM b.t), '{}')
               END AS ids
          FROM (
            SELECT c.change_set_id::text AS cs, c.seq, c.kind, c.key, c.op, c.to_key, c.after_body, c.before_body,
                   row_number() OVER (PARTITION BY c.change_set_id ORDER BY c.seq) AS rn,
                   count(*) OVER (PARTITION BY c.change_set_id) AS n
              FROM studio.change c
             WHERE c.change_set_id = ANY(${ids}::bigint[]) AND c.kind <> 'derived'
          ) x
         WHERE x.rn <= ${TOUCHES}
         ORDER BY x.cs::bigint, x.seq`.execute(tx)
    ).rows;
    for (const r of rows) {
      const slot = out.get(r.cs) ?? { touches: [], more: Math.max(0, Number(r.n) - TOUCHES) };
      out.set(r.cs, slot);
      if (r.kind === 'definitions' && r.ids !== null) {
        for (const id of r.ids) slot.touches.push({ subject: definitionSubject(r.key, id), label: `${definitionNoun(r.key)} ${id}`, kind: 'library', op: 'put', part: 'record' });
        continue;
      }
      const touch = touchOf(r.kind, r.key, r.op, r.to_key ?? undefined);
      // one line per subject and part
      if (!slot.touches.some((t) => t.subject === touch.subject && t.part === touch.part && t.op === touch.op)) slot.touches.push(touch);
    }
    return out;
  }

  async function setRow(tx: Tx, id: string): Promise<SetRow | undefined> {
    if (!/^\d{1,18}$/.test(id)) return undefined;
    return (await sql<SetRow>`SELECT ${SET_COLUMNS} FROM studio.change_set s LEFT JOIN studio.person p ON p.id = s.actor_id WHERE s.id = ${id}::bigint`.execute(tx)).rows[0];
  }

  return {
    capabilities: async () => DATABASE_HISTORY,

    async list(query: HistoryQuery): Promise<HistoryList> {
      return run(async (tx) => {
        const before = query.before !== undefined && /^\d{1,18}$/.test(query.before) ? query.before : null;
        const pattern = query.person === undefined || query.person.trim() === '' ? null : `%${escapeLike(query.person.trim())}%`;
        const kinds = query.kind === undefined ? null : [...RECORD_KINDS_OF[query.kind]];
        const rows = (
          await sql<SetRow>`
            SELECT ${SET_COLUMNS}
              FROM studio.change_set s LEFT JOIN studio.person p ON p.id = s.actor_id
             WHERE (${before}::bigint IS NULL OR s.id < ${before}::bigint)
               AND (${pattern}::text IS NULL OR s.actor_label ILIKE ${pattern} OR p.email ILIKE ${pattern})
               AND (${query.from ?? null}::date IS NULL OR s.created_at >= ${query.from ?? null}::date)
               AND (${query.to ?? null}::date IS NULL OR s.created_at < ${query.to ?? null}::date + 1)
               AND (${kinds}::text[] IS NULL OR EXISTS (SELECT 1 FROM studio.change c WHERE c.change_set_id = s.id AND c.kind = ANY(${kinds}::text[])))
             ORDER BY s.id DESC
             LIMIT ${query.limit + 1}`.execute(tx)
        ).rows;
        const page = rows.slice(0, query.limit);
        const touches = await touchesOf(tx, page.map((r) => r.id));
        const entries = page.map((r) => {
          const t = touches.get(r.id);
          return entryOf(r, t?.touches ?? [], t?.more ?? 0);
        });
        return { entries, ...(rows.length > query.limit && page.length > 0 ? { next: page[page.length - 1]!.id } : {}) };
      });
    },

    async record(subject, query): Promise<HistoryList> {
      return run(async (tx) => {
        const { rows, parts } = await subjectRows(tx, subject);
        const steps = stepsByChangeSet(parts);
        const sets = new Map(rows.map((r) => [r.cs, r] as const));
        const before = query.before !== undefined && /^\d{1,18}$/.test(query.before) ? BigInt(query.before) : undefined;
        const ids = [...steps.keys()].filter((cs) => before === undefined || BigInt(cs) < before).sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1));
        const page = ids.slice(0, query.limit);
        const entries = page.map((cs) => entryOf(sets.get(cs) as SetRow, stepTouches(subject, steps.get(cs) ?? [])));
        return { entries, ...(ids.length > query.limit && page.length > 0 ? { next: page[page.length - 1] } : {}) };
      });
    },

    async detail(id, subject) {
      return run(async (tx) => {
        const set = await setRow(tx, id);
        if (set === undefined) return undefined;
        if (subject !== undefined) {
          const { parts } = await subjectRows(tx, subject);
          const steps = stepsByChangeSet(parts).get(id) ?? [];
          return { entry: entryOf(set, stepTouches(subject, steps)), records: recordDiffs(subject, steps) };
        }
        const touches = (await touchesOf(tx, [id])).get(id);
        return { entry: entryOf(set, touches?.touches ?? [], touches?.more ?? 0), records: await setDiffs(tx, id) };
      });
    },

    async photoAt(subject, id) {
      if (subject.type !== 'design') return undefined;
      return run(async (tx) => {
        if ((await setRow(tx, id)) === undefined) return undefined;
        const q = subjectSql(subject, await designIds(tx, subject.id));
        // the newest photo change at or before the entry: a put names the bytes by hash, a delete is no photo
        const row = (
          await sql<{ op: string; after_etag: string | null; mime: string | null }>`
            SELECT c.op, c.after_etag, c.after_body ->> 'mime' AS mime FROM studio.change c
             WHERE ${q.where} AND c.kind = 'drawing-photo' AND c.change_set_id <= ${id}::bigint
             ORDER BY c.change_set_id DESC, c.seq DESC LIMIT 1`.execute(tx)
        ).rows[0];
        if (row === undefined || row.op === 'delete') return 'none';
        const hash = /^"?sha256:([0-9a-f]{64})"?$/.exec(row.after_etag ?? '');
        return hash === null ? undefined : { sha256: hash[1] as string, ...(row.mime === 'image/png' || row.mime === 'image/jpeg' ? { mime: row.mime } : {}) };
      });
    },

    async stateAt(subject, id) {
      return run(async (tx) => {
        if ((await setRow(tx, id)) === undefined) return undefined;
        const { parts } = await subjectRows(tx, subject);
        const out: SubjectState = {};
        for (const part of restorableParts(subject)) out[part] = stateAfter(parts, id, part);
        return { parts: out };
      });
    },
  };
}

/** Every record one change set changed, before and after (the hub-wide detail). */
async function setDiffs(tx: Tx, id: string): Promise<RecordDiff[]> {
  const rows = (
    await sql<{ seq: number; kind: string; key: string; op: 'put' | 'delete' | 'move'; to_key: string | null; after_text: string | null; before_text: string | null; before_recorded: boolean; after_recorded: boolean }>`
      SELECT c.seq, c.kind, c.key, c.op, c.to_key, c.after_body::text AS after_text, c.before_body::text AS before_text,
             c.before_body IS NOT NULL AS before_recorded, c.after_body IS NOT NULL AS after_recorded
        FROM studio.change c
       WHERE c.change_set_id = ${id}::bigint AND c.kind <> 'derived'
       ORDER BY c.seq
       LIMIT 300`.execute(tx)
  ).rows;
  // per record (kind + key): the first row's before, the last row's after
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.kind}\u0000${r.key}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: RecordDiff[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const binary = BINARY_KINDS.has(first.kind) || group.some((r) => r.op === 'move') || first.kind === 'doc' && !last.after_recorded;
    let before = stateOf(first.before_text, first.before_recorded);
    if (!before.known && !binary) {
      // the state after the previous change of the same record
      const prev = (
        await sql<{ op: string; after_text: string | null; recorded: boolean }>`
          SELECT c.op, c.after_body::text AS after_text, c.after_body IS NOT NULL AS recorded
            FROM studio.change c
           WHERE c.kind = ${first.kind} AND c.key = ${first.key} AND c.change_set_id < ${id}::bigint
           ORDER BY c.change_set_id DESC, c.seq DESC LIMIT 1`.execute(tx)
      ).rows[0];
      if (prev !== undefined) before = prev.op === 'delete' ? known(undefined) : stateOf(prev.after_text, prev.recorded);
    }
    const after = last.op === 'delete' ? known(undefined) : stateOf(last.after_text, last.after_recorded);
    const touch = touchOf(first.kind, first.key, last.op, last.to_key ?? undefined);
    if (first.kind === 'definitions') {
      out.push(...listDiffs(first.key, before, after));
      continue;
    }
    const subject = touch.subject;
    const part = touch.part ?? 'record';
    const restorable = (subject.startsWith('design:') && (part === 'design' || part === 'drawing')) || ((subject.startsWith('definition:') || subject.startsWith('vocab:') || subject.startsWith('build:')) && part === 'record');
    const step: PartStep = { part, before: binary ? UNKNOWN : before, after: binary ? UNKNOWN : after, binary };
    out.push({ subject, label: touch.label, part, op: diffOp(step), before: step.before, after: step.after, restorable: (restorable && !binary) || (part === 'photo' && subject.startsWith('design:')) });
  }
  return out;
}

/** A definitions list's change, split into the records that differ in it. */
function listDiffs(defKind: string, before: Known, after: Known): RecordDiff[] {
  if (!before.known || !after.known || !Array.isArray(after.value)) {
    return [{ subject: `other:definitions:${defKind}`, label: `${defKind} list (its earlier state was not recorded)`, part: 'record', op: 'unknown', before: UNKNOWN, after: UNKNOWN, restorable: false }];
  }
  const index = (list: unknown): Map<string, unknown> => new Map((Array.isArray(list) ? list : []).flatMap((r) => (typeof r === 'object' && r !== null && typeof (r as { id?: unknown }).id === 'string' ? [[(r as { id: string }).id, r] as const] : [])));
  const a = index(before.value);
  const b = index(after.value);
  const out: RecordDiff[] = [];
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const was = a.get(id);
    const now = b.get(id);
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    out.push({
      subject: definitionSubject(defKind, id),
      label: `${definitionNoun(defKind)} ${id} — record`,
      part: 'record',
      op: was === undefined ? 'added' : now === undefined ? 'removed' : 'changed',
      before: known(was),
      after: known(now),
      restorable: true,
    });
  }
  return out;
}
