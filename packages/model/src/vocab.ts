/**
 * Controlled vocabularies — data model v2 §2.1 / §5.
 *
 * One list per kind of meaning a field can carry: `signals`, `levels`,
 * `lanes`, `colour-codes`, `pad-roles`, `families`, … The
 * lists live in the catalog (`packages/catalog/data/vocab/<list>.json`) and
 * arrive here as `Db.vocab`. This module only knows their shape and rules:
 *
 * - every entry is `{ id, label, aliases?, deprecatedBy?, src }`; ids are
 *   kebab-case and unique in their list, and every entry cites a `src`;
 * - **ids never change**. A rename is a new `label` with the old one kept in
 *   `aliases`; a merge sets `deprecatedBy`, and lookups follow it forward;
 * - lists are **append-only**: an entry is never removed, and an edit may only
 *   add (a label with its predecessor aliased, an alias, `deprecatedBy`).
 *   `vocabChangeIssues` is the check a writer (the studio's
 *   `POST /api/vocab/:list`, a script) runs before it saves;
 * - an entry may be `pending` — proposed, not yet accepted. Owner question Q8
 *   is who may add entries; with "either owner, in-app" nothing is ever
 *   pending, with "owner-approved only" new entries arrive pending and are
 *   accepted by clearing the flag. References to a pending entry are warnings.
 *
 * Pure and presentation-free: lists in, entries and issues out.
 */

import type { Db, Issue } from './model.ts';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** One entry of any list. List-specific fields extend this. */
export interface VocabEntry {
  id: string;
  label: string;
  /** a compact display name for tight columns ('CSync' for 'CSync', 'CVBS' for 'CVBS (composite as sync)'); `label` otherwise */
  short?: string;
  /** other spellings that mean this entry (old labels, silkscreen ids, config-graph ids) */
  aliases?: string[];
  /** merged into another entry: lookups of this id resolve to that one */
  deprecatedBy?: string;
  /** proposed, not yet accepted (owner question Q8, option b) */
  pending?: boolean;
  note?: string;
  src: string;
}

/**
 * What family of signal an entry is. It lets a consumer treat a signal it has
 * no special rule for sensibly — a newly added return is still ground.
 */
export type SignalKind = 'video' | 'sync' | 'audio' | 'power' | 'control' | 'data' | 'ground' | 'none';

export const SIGNAL_KINDS: readonly SignalKind[] = ['video', 'sync', 'audio', 'power', 'control', 'data', 'ground', 'none'];

/** An entry of `signals`. */
export interface SignalEntry extends VocabEntry {
  kind: SignalKind;
  /** for a return (`gnd-video-r`): the signals it is the return of */
  returnFor?: string[];
}

/** An entry of `pad-roles`: a board's cable pad, and the lane that lands on it. */
export interface PadRoleEntry extends VocabEntry {
  lane?: string;
}

/** An entry of `colour-codes`: conductor colour → lane. */
export interface ColourCodeEntry extends VocabEntry {
  lanes: Record<string, string>;
}

/** One list, as its file holds it. */
export interface VocabList<E extends VocabEntry = VocabEntry> {
  /** the list id — also its file name */
  id: string;
  label: string;
  src: string;
  entries: E[];
}

/** Every list, keyed by list id. */
export type Vocab = Record<string, VocabList>;

/** A vocab `signals` id. A string, not a union: the lists are data and grow at runtime. */
export type SignalId = string;

/** What a terminal carries: one signal, or one of several the device decides between. */
export type SignalRef = SignalId | { oneOf: SignalId[] };

/** The tags of one board terminal. */
export interface PcbaTerminalTags {
  role?: string;
  signal?: SignalRef;
}

/** Tags of one wire stock. */
export interface WireTags {
  colourCode?: string;
  /** element path → lane, where a conductor departs from the colour code */
  lanes?: Record<string, string>;
}

/**
 * The tag table kept beside the definitions (`data/tags/signal-tags.json`),
 * written by the catalog's `tag-signals` script. A tag on the record itself
 * wins over the table.
 */
export interface SignalTags {
  src: string;
  /** connector id → pin id → signal */
  connectors?: Record<string, Record<string, SignalRef>>;
  /** board id → terminal id → tags */
  pcbas?: Record<string, Record<string, PcbaTerminalTags>>;
  /** wire id → tags */
  wires?: Record<string, WireTags>;
}

/** The lists the catalog ships, in the order the spec (§2.1, §5) names them. */
export const VOCAB_LIST_IDS = [
  'signals',
  'levels',
  'lanes',
  'colour-codes',
  'pad-roles',
  'families',
  'genders',
  'locations',
  'materials',
  'constructions',
  'core-kinds',
  'colours',
  'component-kinds',
  'conditioning',
  'sources',
  'manufacturers',
  'connector-constructions',
  'connector-mountings',
  'connector-sourcing',
] as const;

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** How free text is compared with ids, labels and aliases: case and spacing ignored. */
export function vocabKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function vocabList(vocab: Vocab | undefined, list: string): VocabList | undefined {
  return vocab?.[list];
}

export interface VocabLookupOptions {
  /** also accept entries still awaiting acceptance (default false) */
  includePending?: boolean;
}

/**
 * The entry an id names, with `deprecatedBy` followed to the entry that
 * replaced it. `undefined` for an unknown id (or a pending one, unless asked).
 */
export function vocabEntry<E extends VocabEntry = VocabEntry>(
  vocab: Vocab | undefined,
  list: string,
  id: string,
  options: VocabLookupOptions = {},
): E | undefined {
  const entries = vocab?.[list]?.entries;
  if (entries === undefined) return undefined;
  const seen = new Set<string>();
  let current = entries.find((e) => e.id === id);
  while (current?.deprecatedBy !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const next: string = current.deprecatedBy;
    current = entries.find((e) => e.id === next);
  }
  if (current === undefined) return undefined;
  if (current.pending === true && options.includePending !== true) return undefined;
  return current as E;
}

export interface VocabMatch<E extends VocabEntry = VocabEntry> {
  entry: E;
  /** what the text matched: the id, the label, an alias; `deprecated` when it was forwarded */
  via: 'id' | 'label' | 'alias';
  deprecated: boolean;
}

/**
 * Resolve free text — an id, a label or an alias, any case — to its entry.
 * What a picker's "paste table" and the tagging script use to turn today's
 * strings into ids. Ids win over labels, labels over aliases.
 */
export function resolveVocab<E extends VocabEntry = VocabEntry>(
  vocab: Vocab | undefined,
  list: string,
  text: string,
  options: VocabLookupOptions = {},
): VocabMatch<E> | undefined {
  const entries = vocab?.[list]?.entries;
  if (entries === undefined) return undefined;
  const key = vocabKey(text);
  const tests: [VocabMatch['via'], (e: VocabEntry) => boolean][] = [
    ['id', (e) => vocabKey(e.id) === key],
    ['label', (e) => vocabKey(e.label) === key],
    ['alias', (e) => (e.aliases ?? []).some((a) => vocabKey(a) === key)],
  ];
  for (const [via, test] of tests) {
    const hit = entries.find(test);
    if (hit === undefined) continue;
    const entry = vocabEntry<E>(vocab, list, hit.id, options);
    return entry === undefined ? undefined : { entry, via, deprecated: entry.id !== hit.id };
  }
  return undefined;
}

/** The signals a `SignalRef` names, in order. */
export function signalIds(ref: SignalRef): SignalId[] {
  return typeof ref === 'string' ? [ref] : ref.oneOf;
}

/* ------------------------------------------------------------------ *
 * Validation of the lists themselves
 * ------------------------------------------------------------------ */

function issue(code: string, message: string, where: string, severity: Issue['severity'] = 'error'): Issue {
  return { code, severity, message, where };
}

/**
 * Everything wrong with one list on its own: missing id/label/src, a non
 * kebab-case or duplicate id, a label or alias that another entry already
 * answers to, a `deprecatedBy` that goes nowhere or round in a circle.
 */
export function validateVocabList(list: VocabList): Issue[] {
  const issues: Issue[] = [];
  const at = (id: string): string => `vocab/${list.id}/${id}`;
  if (!KEBAB.test(list.id)) issues.push(issue('vocab-bad-id', `list id '${list.id}' is not kebab-case`, `vocab/${list.id}`));
  if (!list.src) issues.push(issue('missing-src', `vocab list '${list.id}' has no src citation`, `vocab/${list.id}`, 'warning'));
  const ids = new Map<string, number>();
  for (const entry of list.entries) ids.set(entry.id, (ids.get(entry.id) ?? 0) + 1);
  const reported = new Set<string>();
  /** every spelling (id, label, alias) → the entries answering to it */
  const spellings = new Map<string, Set<string>>();
  const claim = (text: string, id: string): void => {
    const key = vocabKey(text);
    const owners = spellings.get(key) ?? new Set<string>();
    owners.add(id);
    spellings.set(key, owners);
  };
  for (const entry of list.entries) {
    if (typeof entry.id !== 'string' || entry.id === '') {
      issues.push(issue('vocab-bad-id', `an entry of '${list.id}' has no id`, `vocab/${list.id}`));
      continue;
    }
    if (!KEBAB.test(entry.id)) issues.push(issue('vocab-bad-id', `'${entry.id}' is not a kebab-case id`, at(entry.id)));
    if ((ids.get(entry.id) ?? 0) > 1 && !reported.has(entry.id) && reported.add(entry.id)) issues.push(issue('duplicate-id', `'${entry.id}' appears ${ids.get(entry.id)} times in '${list.id}'`, at(entry.id)));
    if (typeof entry.label !== 'string' || entry.label.trim() === '') {
      issues.push(issue('vocab-no-label', `'${entry.id}' has no label`, at(entry.id)));
    }
    if (typeof entry.src !== 'string' || entry.src.trim() === '') {
      issues.push(issue('missing-src', `'${entry.id}' has no src citation`, at(entry.id)));
    }
    claim(entry.id, entry.id);
    if (typeof entry.label === 'string') claim(entry.label, entry.id);
    for (const alias of entry.aliases ?? []) claim(alias, entry.id);
    if (entry.deprecatedBy !== undefined) {
      if (entry.deprecatedBy === entry.id || !ids.has(entry.deprecatedBy)) {
        issues.push(issue('vocab-deprecated-by-unknown', `'${entry.id}' is deprecated by '${entry.deprecatedBy}', which is not in '${list.id}'`, at(entry.id)));
      } else {
        const seen = new Set([entry.id]);
        let next: string | undefined = entry.deprecatedBy;
        while (next !== undefined && !seen.has(next)) {
          seen.add(next);
          next = list.entries.find((e) => e.id === next)?.deprecatedBy;
        }
        if (next !== undefined) issues.push(issue('vocab-deprecated-cycle', `'${entry.id}' is deprecated round a circle`, at(entry.id)));
      }
    }
  }
  for (const [text, owners] of spellings) {
    if (owners.size < 2) continue;
    issues.push(
      issue('vocab-ambiguous', `'${text}' names more than one entry of '${list.id}': ${[...owners].sort().join(', ')}`, `vocab/${list.id}`),
    );
  }
  return issues;
}

/** A reference from one list's entries into another list (a colour code's lanes, a pad role's lane). */
function crossRefIssues(vocab: Vocab): Issue[] {
  const issues: Issue[] = [];
  const has = (list: string, id: string): boolean => vocab[list]?.entries.some((e) => e.id === id) === true;
  const signals = vocab['signals']?.entries as SignalEntry[] | undefined;
  for (const entry of signals ?? []) {
    if (!SIGNAL_KINDS.includes(entry.kind)) {
      issues.push(issue('vocab-bad-kind', `signal '${entry.id}' has kind '${String(entry.kind)}'`, `vocab/signals/${entry.id}`));
    }
    for (const id of entry.returnFor ?? []) {
      if (!has('signals', id)) issues.push(issue('vocab-unknown', `signal '${entry.id}' returns unknown signal '${id}'`, `vocab/signals/${entry.id}`));
    }
  }
  if (vocab['lanes'] !== undefined) {
    for (const entry of (vocab['pad-roles']?.entries ?? []) as PadRoleEntry[]) {
      if (entry.lane !== undefined && !has('lanes', entry.lane)) {
        issues.push(issue('vocab-unknown', `pad role '${entry.id}' names unknown lane '${entry.lane}'`, `vocab/pad-roles/${entry.id}`));
      }
    }
    for (const entry of (vocab['colour-codes']?.entries ?? []) as ColourCodeEntry[]) {
      for (const [colour, lane] of Object.entries(entry.lanes ?? {})) {
        if (!has('lanes', lane)) issues.push(issue('vocab-unknown', `colour code '${entry.id}' maps ${colour} to unknown lane '${lane}'`, `vocab/colour-codes/${entry.id}`));
        if (vocab['colours'] !== undefined && !has('colours', colour)) {
          issues.push(issue('vocab-unknown', `colour code '${entry.id}' maps unknown colour '${colour}'`, `vocab/colour-codes/${entry.id}`));
        }
      }
    }
  }
  return issues;
}

/** Every list on its own, plus the references between lists. */
export function validateVocab(vocab: Vocab): Issue[] {
  const issues: Issue[] = [];
  for (const [key, list] of Object.entries(vocab)) {
    if (list.id !== key) issues.push(issue('vocab-bad-id', `list '${key}' says its id is '${list.id}'`, `vocab/${key}`));
    issues.push(...validateVocabList(list));
  }
  issues.push(...crossRefIssues(vocab));
  return issues;
}

/* ------------------------------------------------------------------ *
 * References from the definitions into the lists
 * ------------------------------------------------------------------ */

/**
 * Check one reference: `vocab-unknown` (error) for an id the list does not
 * have, `vocab-deprecated` / `vocab-pending` (warnings) for one that is merged
 * away or not yet accepted.
 */
function refIssues(vocab: Vocab, list: string, id: string, where: string): Issue[] {
  if (vocab[list] === undefined) return [];
  const raw = vocab[list].entries.find((e) => e.id === id);
  if (raw === undefined) return [issue('vocab-unknown', `'${id}' is not in the '${list}' list`, where)];
  if (raw.deprecatedBy !== undefined) {
    return [issue('vocab-deprecated', `'${id}' is deprecated; use '${vocabEntry(vocab, list, id, { includePending: true })?.id ?? raw.deprecatedBy}'`, where, 'warning')];
  }
  if (raw.pending === true) return [issue('vocab-pending', `'${id}' in '${list}' is awaiting acceptance`, where, 'warning')];
  return [];
}

function signalRefIssues(vocab: Vocab, ref: SignalRef, where: string): Issue[] {
  if (typeof ref !== 'string' && (!Array.isArray(ref.oneOf) || ref.oneOf.length === 0)) {
    return [issue('vocab-unknown', 'a { oneOf } signal needs at least one signal', where)];
  }
  return signalIds(ref).flatMap((id) => refIssues(vocab, 'signals', id, where));
}

/**
 * Every vocab reference in the definitions and the tag table: pin signals,
 * pad roles and signals, stock colour codes and lane overrides, connector
 * families. A tag must name a list entry (`vocab-unknown` is an error); a
 * connector's free-text `family` must resolve through ids, labels or aliases
 * (`vocab-unmatched`, a warning — the field is still free text until the
 * pickers land).
 */
export function vocabReferenceIssues(db: Db): Issue[] {
  const vocab = db.vocab;
  if (vocab === undefined) return [];
  const issues: Issue[] = [];
  for (const connector of db.connectors) {
    for (const pin of connector.pins) {
      if (pin.signal !== undefined) issues.push(...signalRefIssues(vocab, pin.signal, `connectors/${connector.id}/${pin.id}`));
    }
    if (vocab['families'] !== undefined && resolveVocab(vocab, 'families', connector.family) === undefined) {
      issues.push(issue('vocab-unmatched', `family '${connector.family}' is not in the families list`, `connectors/${connector.id}`, 'warning'));
    }
    if (connector.construction !== undefined) {
      issues.push(...refIssues(vocab, 'connector-constructions', connector.construction, `connectors/${connector.id}`));
    }
    if (connector.sourcing !== undefined) {
      issues.push(...refIssues(vocab, 'connector-sourcing', connector.sourcing, `connectors/${connector.id}`));
    }
  }
  for (const body of db.bodies ?? []) {
    if (body.construction !== undefined) {
      issues.push(...refIssues(vocab, 'connector-constructions', body.construction, `bodies/${body.id}`));
    }
  }
  for (const pcba of db.pcbas) {
    for (const terminal of pcba.terminals) {
      const where = `pcbas/${pcba.id}/${terminal.id}`;
      if (terminal.role !== undefined) issues.push(...refIssues(vocab, 'pad-roles', terminal.role, where));
      if (terminal.signal !== undefined) issues.push(...signalRefIssues(vocab, terminal.signal, where));
    }
  }
  const laneRefs = (lanes: Record<string, string> | undefined, where: string): void => {
    for (const [path, lane] of Object.entries(lanes ?? {})) issues.push(...refIssues(vocab, 'lanes', lane, `${where}/${path}`));
  };
  for (const wire of db.wires) {
    if (wire.colourCode !== undefined) issues.push(...refIssues(vocab, 'colour-codes', wire.colourCode, `wires/${wire.id}`));
    const walk = (element: { kind: string; id: string; lane?: string; children?: unknown[] }, path: string): void => {
      if (element.lane !== undefined) issues.push(...refIssues(vocab, 'lanes', element.lane, `wires/${wire.id}/${path}`));
      for (const child of (element.children ?? []) as { kind: string; id: string }[]) {
        walk(child, path === '' ? child.id : `${path}.${child.id}`);
      }
    };
    walk(wire.structure, '');
  }
  const tags = db.tags;
  if (tags !== undefined) {
    for (const [connector, pins] of Object.entries(tags.connectors ?? {})) {
      for (const [pin, ref] of Object.entries(pins)) issues.push(...signalRefIssues(vocab, ref, `tags/connectors/${connector}/${pin}`));
    }
    for (const [pcba, terminals] of Object.entries(tags.pcbas ?? {})) {
      for (const [terminal, t] of Object.entries(terminals)) {
        const where = `tags/pcbas/${pcba}/${terminal}`;
        if (t.role !== undefined) issues.push(...refIssues(vocab, 'pad-roles', t.role, where));
        if (t.signal !== undefined) issues.push(...signalRefIssues(vocab, t.signal, where));
      }
    }
    for (const [wire, t] of Object.entries(tags.wires ?? {})) {
      if (t.colourCode !== undefined) issues.push(...refIssues(vocab, 'colour-codes', t.colourCode, `tags/wires/${wire}`));
      laneRefs(t.lanes, `tags/wires/${wire}`);
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * Append-only writes
 * ------------------------------------------------------------------ */

/**
 * What an edit of a list did that an append-only list may not: remove an
 * entry, change a label without keeping the old one as an alias, drop an
 * alias, undo a `deprecatedBy`, or send an accepted entry back to pending.
 * Adding entries, aliases, a `deprecatedBy`, a note or accepting a pending
 * entry are all fine. The lists' own rules (`validateVocabList`) still apply
 * to `after`.
 */
export function vocabChangeIssues(before: VocabList, after: VocabList): Issue[] {
  const issues: Issue[] = [];
  const at = (id: string): string => `vocab/${after.id}/${id}`;
  if (before.id !== after.id) issues.push(issue('vocab-list-renamed', `list '${before.id}' cannot become '${after.id}'`, `vocab/${before.id}`));
  for (const old of before.entries) {
    const now = after.entries.find((e) => e.id === old.id);
    if (now === undefined) {
      issues.push(issue('vocab-entry-removed', `'${old.id}' was removed; entries are never removed (deprecate it instead)`, at(old.id)));
      continue;
    }
    if (vocabKey(now.label) !== vocabKey(old.label) && !(now.aliases ?? []).some((a) => vocabKey(a) === vocabKey(old.label))) {
      issues.push(issue('vocab-rename-unaliased', `'${old.id}' was relabelled from '${old.label}' without keeping it as an alias`, at(old.id)));
    }
    for (const alias of old.aliases ?? []) {
      if (!(now.aliases ?? []).includes(alias)) issues.push(issue('vocab-alias-removed', `'${old.id}' lost its alias '${alias}'`, at(old.id)));
    }
    if (old.deprecatedBy !== undefined && now.deprecatedBy !== old.deprecatedBy) {
      issues.push(issue('vocab-undeprecated', `'${old.id}' was deprecated by '${old.deprecatedBy}'; that cannot be undone or moved`, at(old.id)));
    }
    if (old.pending !== true && now.pending === true) {
      issues.push(issue('vocab-unaccepted', `'${old.id}' was accepted and cannot return to pending`, at(old.id)));
    }
  }
  return issues;
}

export type AppendResult =
  | { ok: true; list: VocabList }
  | { ok: false; issues: Issue[] };

/**
 * Append one entry to a list — the only write an in-app "Add '…'" makes.
 * Refused (with the issues) when the entry has no id, label or `src`, reuses
 * an id or a spelling another entry answers to, or names a `deprecatedBy`
 * that is not there. `pending: true` in the options files it for acceptance
 * (owner question Q8, option b); the default adds it accepted (option a).
 */
export function appendVocabEntry(
  list: VocabList,
  entry: VocabEntry,
  options: { pending?: boolean } = {},
): AppendResult {
  const added: VocabEntry = { ...entry, ...(options.pending === true ? { pending: true } : {}) };
  const next: VocabList = { ...list, entries: [...list.entries, added] };
  const introduced = new Set(validateVocabList(list).map((i) => `${i.code} ${i.where} ${i.message}`));
  const issues = [
    ...validateVocabList(next).filter((i) => !introduced.has(`${i.code} ${i.where} ${i.message}`) && i.severity === 'error'),
    ...vocabChangeIssues(list, next),
  ];
  return issues.length === 0 ? { ok: true, list: next } : { ok: false, issues };
}
