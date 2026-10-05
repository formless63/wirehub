/**
 * The vocab and tag endpoints — request in, response out, no IO (data model
 * v2 §5).
 *
 *   GET   /api/vocab                   the lists: id, label, entry count
 *   GET   /api/vocab/:list             one list
 *   POST  /api/vocab/:list             append one entry { id?, label, src, aliases?, note?, kind?, lane? }
 *   PATCH /api/vocab/:list/:entry      relabel / add aliases — the old label becomes an alias
 *   PUT   /api/tags/:kind/:id          set one record's tags in the side table
 *
 * The rules:
 *
 * 1. **Append-only.** A list only grows: `appendVocabEntry` and
 *    `vocabChangeIssues` (core) are the gate, the same ones a script uses, and
 *    a refusal names what it would have broken. Ids never change; a rename is
 *    a new label with the old one kept as an alias.
 * 2. **`src` is required** on every new entry, like every catalog record.
 * 3. **Either owner may add, in-app**: entries
 *    arrive accepted. The `pending` flag core supports is never set here; a
 *    body asking for it is refused rather than silently obeyed.
 * 4. **Tags go through the generator.** A tag set in the Library becomes an
 *    owner correction in `data/tags/review.json` and the table is rebuilt from
 *    it (`TagStore.regenerate`) — the committed table stays exactly what
 *    `scripts/tag-signals.ts` makes, which `test/tags.test.ts` holds it to.
 *    A tag written on the record itself is the record's, and is edited with
 *    the record.
 */

import {
  SIGNAL_KINDS,
  appendVocabEntry,
  errors,
  signalIds,
  validateVocab,
  validateVocabList,
  vocabChangeIssues,
  type Db,
  type Issue,
  type PcbaTerminalTags,
  type SignalRef,
  type Vocab,
  type VocabEntry,
  type VocabList,
  type WireTags,
} from '@wirehub/model';
import { proposedColourCode, withoutProposal, type TagReview } from '@wirehub/catalog/src/tags/build.ts';
import { padTags, pinSignal } from '@wirehub/catalog/src/tags/classify.ts';

import type { ApiError, ApiResponse } from './api.ts';
import { checkIfMatch, contentETag, ifMatchSatisfied } from './etag.ts';
import type { TagStore, VocabStore } from './vocab-store.ts';
import type { Awaitable } from './storage/change-set.ts';
import { packOwnerOf, packRecordRefusal, type PackGuardDeps } from './pack-guard.ts';

export interface VocabDeps extends PackGuardDeps {
  vocab?: VocabStore;
  tags?: TagStore;
  loadDb: () => Awaitable<Db>;
}

export const VOCAB_ROUTES = [
  'GET    /api/vocab',
  'GET    /api/vocab/:list',
  'POST   /api/vocab/:list',
  'PATCH  /api/vocab/:list/:entry',
  'PUT    /api/tags/:kind/:id',
] as const;

/** Who a tag set in the Library says it came from, when the caller does not say. */
export const LIBRARY_TAG_WHY = 'set in the Library (studio)';

function fail(status: number, error: string, hint?: string, issues?: Issue[]): ApiResponse {
  const body: ApiError = { error, ...(hint === undefined ? {} : { hint }) };
  if (issues !== undefined) body.issues = issues;
  return { status, body };
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): ApiResponse {
  return { status, body, ...(headers === undefined ? {} : { headers }) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The id a label would get: lowercase words joined by hyphens, with the
 * symbols this catalog uses spelled out (`75 Ω` → `75-ohm`, `µF` → `uf`).
 */
export function vocabIdOf(label: string): string {
  return label
    .replace(/[Ωω]/g, 'ohm')
    .replace(/[µμ]/g, 'u')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function issueKey(issue: Issue): string {
  return `${issue.code} ${issue.where ?? ''} ${issue.message}`;
}

/** The errors `after` has that `before` did not — what this write introduces. */
function introduced(before: Issue[], after: Issue[]): Issue[] {
  const had = new Set(errors(before).map(issueKey));
  return errors(after).filter((issue) => !had.has(issueKey(issue)));
}

function noVocab(): ApiResponse {
  return fail(
    501,
    'This studio is not set up to change the controlled lists.',
    'The lists can still be read from the library. Adding entries needs a host that stores the catalog files — the studio server does.',
  );
}

async function unknownList(list: string, store: VocabStore): Promise<ApiResponse> {
  return fail(404, `There is no list called '${list}'.`, `The lists are: ${(await store.ids()).join(', ')}.`);
}

function methodNotAllowed(method: string, allowed: string[]): ApiResponse {
  return fail(405, `${method} is not something this address accepts.`, `It answers ${allowed.join(' and ')}.`);
}

/* ------------------------------------------------------------------ *
 * Lists
 * ------------------------------------------------------------------ */

async function getLists(store: VocabStore): Promise<ApiResponse> {
  return ok({
    lists: await Promise.all(
      (await store.ids()).map(async (id) => {
        const list = await store.read(id);
        return { id, label: list?.label ?? id, count: list?.entries.length ?? 0 };
      }),
    ),
  });
}

async function getList(store: VocabStore, id: string): Promise<ApiResponse> {
  const list = await store.read(id);
  return list === undefined ? await unknownList(id, store) : ok(list, 200, { ETag: contentETag(list) });
}

/** Every list, with `list` replaced — what cross-list checks run over. */
async function vocabWith(store: VocabStore, list: VocabList): Promise<Vocab> {
  const vocab: Vocab = {};
  for (const id of await store.ids()) {
    const current = id === list.id ? list : await store.read(id);
    if (current !== undefined) vocab[id] = current;
  }
  return vocab;
}

/** The entry a POST body describes, or why it cannot be one. */
function entryOfBody(listId: string, body: unknown): { entry: VocabEntry } | { refusal: ApiResponse } {
  if (!isObject(body)) {
    return { refusal: fail(400, 'That is not a list entry.', 'Send one object: { label, src } and optionally id, aliases, note.') };
  }
  if (body['pending'] !== undefined) {
    return {
      refusal: fail(
        400,
        'Entries added here are accepted as they are added.',
        'Either owner may add an entry, with its source — leave `pending` out.',
      ),
    };
  }
  if (!filled(body['label'])) {
    return { refusal: fail(400, 'This entry has no label.', 'The label is the words a picker shows — "TXD", "Audio L pad".') };
  }
  if (!filled(body['src'])) {
    return {
      refusal: fail(
        400,
        'This entry does not say where it comes from.',
        'Every entry cites a source — the spec sheet, the board silkscreen or the standard it was read from.',
      ),
    };
  }
  const label = body['label'].trim();
  const id = filled(body['id']) ? body['id'].trim() : vocabIdOf(label);
  if (!KEBAB.test(id)) {
    return { refusal: fail(400, `'${id}' cannot be used as an id.`, 'Ids are lowercase words joined by hyphens — `gnd-sync`, `hd15`.') };
  }
  const aliases = body['aliases'];
  if (aliases !== undefined && !isStringList(aliases)) {
    return { refusal: fail(400, 'The other names are not a list of words.', 'Aliases are one string each.') };
  }
  if (body['note'] !== undefined && typeof body['note'] !== 'string') {
    return { refusal: fail(400, 'The note is not text.', 'A note is one sentence.') };
  }
  // key order follows the committed lists: id, label, the list's own fields, aliases, note, src
  const entry: Record<string, unknown> = { id, label };

  // the list-specific fields a picker's "Add" can supply
  if (listId === 'signals') {
    const kind = body['kind'];
    if (typeof kind !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(kind)) {
      return {
        refusal: fail(400, 'A signal needs its kind.', `Say what family of signal it is — one of ${SIGNAL_KINDS.join(', ')}, or another kebab-case kind your catalog uses.`),
      };
    }
    entry['kind'] = kind;
    const returnFor = body['returnFor'];
    if (returnFor !== undefined) {
      if (!isStringList(returnFor)) return { refusal: fail(400, '`returnFor` is not a list of signal ids.') };
      if (returnFor.length > 0) entry['returnFor'] = returnFor;
    }
  }
  if (listId === 'pad-roles' && body['lane'] !== undefined) {
    if (!filled(body['lane'])) return { refusal: fail(400, 'The lane is not a lane id.', 'Name a `lanes` entry — `video-r`, `sync`.') };
    entry['lane'] = body['lane'].trim();
  }
  if (listId === 'colour-codes') {
    const lanes = body['lanes'];
    if (!isObject(lanes) || Object.values(lanes).some((lane) => typeof lane !== 'string')) {
      return { refusal: fail(400, 'A colour code maps colours to lanes.', 'Send `lanes`: { "red": "video-r", … }.') };
    }
    entry['lanes'] = lanes;
  }
  const cleanAliases = (aliases ?? []).map((a) => a.trim()).filter((a) => a !== '');
  if (cleanAliases.length > 0) entry['aliases'] = cleanAliases;
  if (filled(body['note'])) entry['note'] = body['note'].trim();
  entry['src'] = body['src'].trim();
  return { entry: entry as unknown as VocabEntry };
}

async function postEntry(store: VocabStore, listId: string, body: unknown, ifMatch: string | undefined): Promise<ApiResponse> {
  const list = await store.read(listId);
  if (list === undefined) return await unknownList(listId, store);
  // append-only: a POST without If-Match is safe (the list is re-read and the
  // new entry checked against it); one that quotes a version must match it
  if (ifMatch !== undefined && !ifMatchSatisfied(ifMatch, contentETag(list))) {
    return fail(409, `The '${listId}' list changed since it was loaded.`, 'Nothing was written. Reload the list and add the entry again.');
  }
  const parsed = entryOfBody(listId, body);
  if ('refusal' in parsed) return parsed.refusal;

  const appended = appendVocabEntry(list, parsed.entry);
  if (!appended.ok) {
    return fail(
      422,
      `'${parsed.entry.label}' cannot be added to ${list.label.toLowerCase()}.`,
      'Nothing was written. An entry needs its own id and a label no other entry already answers to — pick the existing one instead.',
      appended.issues,
    );
  }
  const before = await vocabWith(store, list);
  const after = await vocabWith(store, appended.list);
  const crossRefs = introduced(validateVocab(before), validateVocab(after));
  if (crossRefs.length > 0) {
    return fail(422, `'${parsed.entry.label}' refers to something that is not in the lists.`, 'Nothing was written.', crossRefs);
  }
  await store.write(appended.list);
  return ok({ entry: parsed.entry, list: appended.list }, 201, { ETag: contentETag(appended.list) });
}

/**
 * A relabel or new aliases. The old label is kept as an alias automatically —
 * a rename never loses the spelling people already search by.
 */
async function patchEntry(deps: PackGuardDeps, store: VocabStore, listId: string, entryId: string, body: unknown, ifMatch: string | undefined): Promise<ApiResponse> {
  const list = await store.read(listId);
  if (list === undefined) return await unknownList(listId, store);
  const origin = await packOwnerOf(deps, `vocab/${listId}.json`, entryId);
  if (origin !== undefined) return packRecordRefusal('vocabulary entry', entryId, origin, `add an entry of your own to '${listId}' (POST /api/vocab/${listId}) and use that; to rename this one, give your entry the old label as an alias.`);
  // an edit of an existing entry: the list version is required
  const guard = checkIfMatch(ifMatch, contentETag(list), 'list', listId);
  if (guard !== undefined) return guard;
  const old = list.entries.find((entry) => entry.id === entryId);
  if (old === undefined) {
    return fail(404, `'${listId}' has no entry '${entryId}'.`, 'Entries are added with POST; ids never change.');
  }
  if (!isObject(body)) return fail(400, 'That is not a change to an entry.', 'Send { label?, aliases?, note? }.');
  const forbidden = Object.keys(body).filter((key) => !['label', 'aliases', 'note'].includes(key));
  if (forbidden.length > 0) {
    return fail(
      400,
      `${forbidden.join(', ')} cannot be changed here.`,
      'An entry may get a new label, more aliases or a note. Its id and source are fixed; merging is a `deprecatedBy` edit made in the file.',
    );
  }
  const label = body['label'];
  if (label !== undefined && !filled(label)) return fail(400, 'The new label is empty.');
  const aliases = body['aliases'];
  if (aliases !== undefined && !isStringList(aliases)) return fail(400, 'The other names are not a list of words.');
  if (body['note'] !== undefined && typeof body['note'] !== 'string') return fail(400, 'The note is not text.');

  const nextLabel = label === undefined ? old.label : label.trim();
  const keep = [...(old.aliases ?? [])];
  const add = (alias: string): void => {
    const trimmed = alias.trim();
    if (trimmed === '' || trimmed.toLowerCase() === nextLabel.toLowerCase()) return;
    if (!keep.some((a) => a.toLowerCase() === trimmed.toLowerCase())) keep.push(trimmed);
  };
  if (nextLabel !== old.label) add(old.label);
  for (const alias of aliases ?? []) add(alias);
  const next: VocabEntry = {
    ...old,
    label: nextLabel,
    ...(keep.length === 0 ? {} : { aliases: keep }),
    ...(filled(body['note']) ? { note: body['note'].trim() } : {}),
  };
  const nextList: VocabList = { ...list, entries: list.entries.map((entry) => (entry.id === entryId ? next : entry)) };
  const issues = [...vocabChangeIssues(list, nextList), ...introduced(validateVocabList(list), validateVocabList(nextList))];
  if (issues.length > 0) {
    return fail(422, `'${old.label}' cannot be changed that way.`, 'Nothing was written.', issues);
  }
  await store.write(nextList);
  return ok({ entry: next, list: nextList }, 200, { ETag: contentETag(nextList) });
}

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

type TagKind = 'connectors' | 'pcbas' | 'wires';

function isSignalRef(value: unknown): value is SignalRef {
  if (typeof value === 'string') return value !== '';
  return isObject(value) && isStringList(value['oneOf']) && value['oneOf'].length > 0;
}

function refIssue(vocab: Vocab | undefined, list: string, id: string, where: string): Issue[] {
  const entries = vocab?.[list]?.entries;
  if (entries === undefined || entries.some((entry) => entry.id === id)) return [];
  return [{ code: 'vocab-unknown', severity: 'error', message: `'${id}' is not in the '${list}' list`, where }];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Fold one record's requested tags into the review file. Only what differs
 * from the table as it stands becomes a correction — re-saving a form whose
 * tags nobody touched writes nothing.
 */
async function putTags(deps: VocabDeps, tagStore: TagStore, kind: string, id: string, body: unknown): Promise<ApiResponse> {
  if (kind !== 'connectors' && kind !== 'pcbas' && kind !== 'wires') {
    return fail(404, `'${kind}' has no tags.`, 'Tags are kept for connectors (pin signals), pcbas (pad role and signal) and wires (colour code).');
  }
  if (!isObject(body) || !isObject(body['tags'])) {
    return fail(400, 'That is not a set of tags.', 'Send { tags: { … }, why? }.');
  }
  const requested = body['tags'];
  const why = filled(body['why']) ? body['why'].trim() : LIBRARY_TAG_WHY;
  const db = await deps.loadDb();
  const table = await tagStore.tags();
  const review: TagReview = structuredClone(await tagStore.review());
  const issues: Issue[] = [];
  let changed = false;

  if ((kind as TagKind) === 'connectors') {
    const connector = db.connectors.find((c) => c.id === id);
    if (connector === undefined) return fail(404, `There is no connector called '${id}'.`);
    const current = table.connectors?.[id] ?? {};
    for (const [pinId, value] of Object.entries(requested)) {
      const pin = connector.pins.find((p) => p.id === pinId);
      const where = `connectors/${id}/${pinId}`;
      if (pin === undefined) return fail(400, `'${id}' has no pin '${pinId}'.`, 'Save the connector with the pin first, then its signal.');
      if (pin.signal !== undefined) {
        return fail(409, `Pin ${pinId} carries its signal on the connector record.`, 'Change it with the connector itself; the side table does not override a record.');
      }
      if (value !== null && !isSignalRef(value)) return fail(400, `Pin ${pinId}'s signal is not a signal id.`);
      if (value !== null) for (const s of signalIds(value)) issues.push(...refIssue(db.vocab, 'signals', s, where));
      if (same(value, current[pinId])) continue;
      // a correction that only restates the generator's proposal is no correction
      const kept = withoutProposal({ signal: value as SignalRef | null, why }, { signal: pinSignal(db.vocab, pin) });
      review.connectors ??= {};
      review.connectors[id] ??= {};
      if (kept === undefined) delete review.connectors[id][pinId];
      else review.connectors[id][pinId] = kept;
      if (Object.keys(review.connectors[id]).length === 0) delete review.connectors[id];
      changed = true;
    }
  } else if ((kind as TagKind) === 'pcbas') {
    const pcba = db.pcbas.find((p) => p.id === id);
    if (pcba === undefined) return fail(404, `There is no board called '${id}'.`);
    const current = table.pcbas?.[id] ?? {};
    for (const [terminalId, value] of Object.entries(requested)) {
      const terminal = pcba.terminals.find((t) => t.id === terminalId);
      const where = `pcbas/${id}/${terminalId}`;
      if (terminal === undefined) return fail(400, `'${id}' has no pad '${terminalId}'.`, 'Save the board with the pad first, then its tags.');
      if (terminal.role !== undefined || terminal.signal !== undefined) {
        return fail(409, `Pad ${terminalId} carries its tags on the board record.`, 'Change them with the board itself.');
      }
      if (!isObject(value)) return fail(400, `Pad ${terminalId}'s tags are not { role, signal }.`);
      const role = value['role'];
      const signal = value['signal'];
      if (role !== undefined && role !== null && !filled(role)) return fail(400, `Pad ${terminalId}'s role is not a pad-role id.`);
      if (signal !== undefined && signal !== null && !isSignalRef(signal)) return fail(400, `Pad ${terminalId}'s signal is not a signal id.`);
      if (typeof role === 'string') issues.push(...refIssue(db.vocab, 'pad-roles', role, where));
      if (signal !== undefined && signal !== null) for (const s of signalIds(signal as SignalRef)) issues.push(...refIssue(db.vocab, 'signals', s, where));
      const now: PcbaTerminalTags = current[terminalId] ?? {};
      const fix: { role?: string | null; signal?: SignalRef | null; why: string } = {
        ...(review.pcbas?.[id]?.[terminalId] ?? {}),
        why,
      };
      let differs = false;
      if (role !== undefined && !same(role, now.role)) {
        fix.role = role as string | null;
        differs = true;
      }
      if (signal !== undefined && !same(signal, now.signal)) {
        fix.signal = signal as SignalRef | null;
        differs = true;
      }
      if (!differs) continue;
      review.pcbas ??= {};
      review.pcbas[id] ??= {};
      // `why` last, the way the committed review entries read
      const { why: _why, ...fields } = fix;
      const before = review.pcbas[id][terminalId];
      // a field that only restates the importer's proposal is no correction:
      // drop it, and the whole entry when nothing is left
      const kept = db.vocab === undefined ? { ...fields, why } : withoutProposal({ ...fields, why }, { ...padTags(db.vocab, terminal) });
      if (kept === undefined) delete review.pcbas[id][terminalId];
      else review.pcbas[id][terminalId] = kept;
      if (Object.keys(review.pcbas[id]).length === 0) delete review.pcbas[id];
      if (!same(before, kept)) changed = true;
    }
  } else {
    const wire = db.wires.find((w) => w.id === id);
    if (wire === undefined) return fail(404, `There is no wire stock called '${id}'.`);
    if (wire.colourCode !== undefined) {
      return fail(409, `'${id}' carries its colour code on the stock record.`, 'Change it with the stock itself.');
    }
    const current: WireTags = table.wires?.[id] ?? {};
    const code = requested['colourCode'];
    const lanes = requested['lanes'];
    if (code !== undefined && code !== null && !filled(code)) return fail(400, 'The colour code is not a colour-code id.');
    if (lanes !== undefined && (!isObject(lanes) || Object.values(lanes).some((l) => typeof l !== 'string'))) {
      return fail(400, 'Lanes map conductor paths to lane ids.');
    }
    if (typeof code === 'string') issues.push(...refIssue(db.vocab, 'colour-codes', code, `wires/${id}`));
    for (const [path, lane] of Object.entries((lanes ?? {}) as Record<string, string>)) {
      issues.push(...refIssue(db.vocab, 'lanes', lane, `wires/${id}/${path}`));
    }
    const fix = { ...(review.wires?.[id] ?? {}), why } as NonNullable<TagReview['wires']>[string];
    let differs = false;
    if (code !== undefined && !same(code, current.colourCode)) {
      fix.colourCode = code as string | null;
      differs = true;
    }
    if (lanes !== undefined && !same(lanes, current.lanes)) {
      fix.lanes = lanes as Record<string, string>;
      differs = true;
    }
    if (differs) {
      review.wires ??= {};
      const { why: _why, ...fields } = fix;
      const before = review.wires[id];
      const kept = db.vocab === undefined ? { ...fields, why } : withoutProposal({ ...fields, why }, { colourCode: proposedColourCode(db.vocab, wire) });
      if (kept === undefined) delete review.wires[id];
      else review.wires[id] = kept;
      if (!same(before, kept)) changed = true;
    }
  }

  if (issues.length > 0) {
    return fail(422, 'A tag names something that is not in the lists.', 'Nothing was written. Pick an entry, or add it to the list first.', issues);
  }
  if (changed) {
    await tagStore.writeReview(review);
    await tagStore.regenerate();
  }
  const after = await tagStore.tags();
  const tags = (kind as TagKind) === 'connectors' ? after.connectors?.[id] : (kind as TagKind) === 'pcbas' ? after.pcbas?.[id] : after.wires?.[id];
  return ok({ kind, id, changed, tags: tags ?? {} });
}

/* ------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------ */

/**
 * Everything under `/api/vocab` and `/api/tags`. Answers `undefined` for any
 * other path so `api.ts` can carry on routing.
 */
export async function handleVocabRequest(
  method: string,
  parts: string[],
  body: unknown,
  deps: VocabDeps,
  ifMatch?: string,
): Promise<ApiResponse | undefined> {
  if (parts[0] !== 'api') return undefined;
  if (parts[1] === 'vocab') {
    const [, , list, entry, ...rest] = parts;
    if (rest.length > 0) return undefined;
    const store = deps.vocab;
    if (store === undefined) return noVocab();
    if (list === undefined) return method === 'GET' ? await getLists(store) : methodNotAllowed(method, ['GET']);
    if (!KEBAB.test(list)) return await unknownList(list, store);
    if (entry === undefined) {
      if (method === 'GET') return await getList(store, list);
      if (method === 'POST') return await postEntry(store, list, body, ifMatch);
      return methodNotAllowed(method, ['GET', 'POST']);
    }
    return method === 'PATCH' ? await patchEntry(deps, store, list, entry, body, ifMatch) : methodNotAllowed(method, ['PATCH']);
  }
  if (parts[1] === 'tags') {
    const [, , kind, id, ...rest] = parts;
    if (kind === undefined || id === undefined || rest.length > 0) return undefined;
    const tagStore = deps.tags;
    if (tagStore === undefined) return noVocab();
    if (!KEBAB.test(id)) return fail(400, `${JSON.stringify(id)} is not a record id.`);
    return method === 'PUT' ? await putTags(deps, tagStore, kind, id, body) : methodNotAllowed(method, ['PUT']);
  }
  return undefined;
}
