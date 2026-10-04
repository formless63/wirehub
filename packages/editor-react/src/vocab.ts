/**
 * The controlled lists, as the editor's forms use them (data model v2 §5,
 *).
 *
 * The lists themselves arrive with the library (`Db.vocab`); what a host adds
 * is a `VocabAdapter` — how a new entry is appended and how a record's tags
 * are written to the side table. Same contract as the other adapters: no URL,
 * no `fetch`, every method answers with an `Outcome`. Without one the pickers
 * still pick; they just cannot add.
 *
 * Also here: how a picker turns a list into options (`vocabOptions`), how it
 * ranks what was typed against ids, labels and aliases (`rankOptions`), and
 * the one-line codec a draft uses to hold a `SignalRef` as text.
 */

import type {
  PcbaTerminalTags,
  SignalKind,
  SignalRef,
  Vocab,
  VocabEntry,
  VocabList,
  WireTags,
} from '@cable-studio/model';
import { createContext, useContext } from 'react';

import type { Outcome } from './persistence.ts';

/** What "Add '…'" sends: the rest (pending, deprecatedBy) is never set from a picker. */
export interface NewVocabEntry {
  id: string;
  label: string;
  src: string;
  aliases?: string[];
  note?: string;
  /** `signals` only: what family of signal it is */
  kind?: SignalKind;
  /** `pad-roles` only: the lane that lands on it */
  lane?: string;
}

/** One record's tags as the side table holds them; `null` clears a tag. */
export type RecordTags =
  | { kind: 'connectors'; id: string; tags: Record<string, SignalRef | null> }
  | {
      kind: 'pcbas';
      id: string;
      tags: Record<string, { role?: string | null; signal?: SignalRef | null }>;
    }
  | { kind: 'wires'; id: string; tags: { colourCode?: string | null; lanes?: Record<string, string> } };

export interface SavedTags {
  changed: boolean;
  tags: Record<string, SignalRef> | Record<string, PcbaTerminalTags> | WireTags;
}

export interface VocabAdapter {
  /** append one entry; the host refuses a duplicate id or spelling and a missing `src` */
  append(list: string, entry: NewVocabEntry): Promise<Outcome<{ entry: VocabEntry; list: VocabList }>>;
  /** write one record's tags to the side table (only what changed becomes a correction) */
  saveTags(tags: RecordTags): Promise<Outcome<SavedTags>>;
}

/* ------------------------------------------------------------------ *
 * The context the pickers read
 * ------------------------------------------------------------------ */

export interface VocabScope {
  vocab: Vocab | undefined;
  /** present when this host can add entries */
  add?: (list: string, entry: NewVocabEntry) => Promise<Outcome<VocabEntry>>;
}

export const VocabContext = createContext<VocabScope>({ vocab: undefined });

export function useVocab(): VocabScope {
  return useContext(VocabContext);
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

export interface PickOption {
  /** what is stored */
  value: string;
  /** what is shown */
  label: string;
  /** a second, quieter line: the id, or a detail */
  hint?: string;
  /** other spellings the filter matches (vocab aliases) */
  aliases?: readonly string[];
  /** a heading the option sits under */
  group?: string;
}

/**
 * A list's live entries as options: deprecated entries are left out (a lookup
 * forwards them) and pending ones are never offered.
 */
export function vocabOptions(vocab: Vocab | undefined, list: string): PickOption[] {
  const entries = vocab?.[list]?.entries ?? [];
  return entries
    .filter((entry) => entry.deprecatedBy === undefined && entry.pending !== true)
    .map((entry) => ({
      value: entry.id,
      label: entry.label,
      hint: entry.id,
      ...(entry.aliases === undefined ? {} : { aliases: entry.aliases }),
      ...groupOf(entry),
    }));
}

/** A signal lists under its kind (video, sync, ground …); other lists are flat. */
function groupOf(entry: VocabEntry): { group?: string } {
  const kind = (entry as VocabEntry & { kind?: unknown }).kind;
  return typeof kind === 'string' ? { group: kind } : {};
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The options that match `query`, best first: a label that starts with it,
 * then an id or alias that does, then any that contain it. `csy` finds CSync;
 * `R` finds the pad role whose alias is `R`. Stable within a rank.
 */
export function rankOptions(options: readonly PickOption[], query: string): PickOption[] {
  const q = norm(query);
  if (q === '') return [...options];
  const scored: { option: PickOption; score: number; at: number }[] = [];
  options.forEach((option, at) => {
    const label = norm(option.label);
    const others = [option.value, option.hint ?? '', ...(option.aliases ?? [])].map(norm);
    let score = -1;
    if (label === q || others.some((o) => o === q)) score = 0;
    else if (label.startsWith(q)) score = 1;
    else if (others.some((o) => o.startsWith(q))) score = 2;
    else if (label.split(/[\s()/-]+/).some((word) => word.startsWith(q))) score = 3;
    else if (label.includes(q) || others.some((o) => o.includes(q))) score = 4;
    if (score >= 0) scored.push({ option, score, at });
  });
  return scored.sort((a, b) => a.score - b.score || a.at - b.at).map((s) => s.option);
}

/** True when `query` is exactly an option's value, label or alias. */
export function exactOption(options: readonly PickOption[], query: string): PickOption | undefined {
  const q = norm(query);
  if (q === '') return undefined;
  return options.find(
    (option) => norm(option.label) === q || norm(option.value) === q || (option.aliases ?? []).some((a) => norm(a) === q),
  );
}

/* ------------------------------------------------------------------ *
 * Recent picks — per list, this session only
 * ------------------------------------------------------------------ */

const recentByList = new Map<string, string[]>();

export function recentPicks(list: string): readonly string[] {
  return recentByList.get(list) ?? [];
}

export function rememberPick(list: string, value: string): void {
  if (value === '') return;
  const next = [value, ...(recentByList.get(list) ?? []).filter((v) => v !== value)].slice(0, 5);
  recentByList.set(list, next);
}

/* ------------------------------------------------------------------ *
 * Ids and signal refs as text
 * ------------------------------------------------------------------ */

/**
 * The id a new entry's label suggests: lowercase words joined by hyphens,
 * with this catalog's symbols spelled out (`75 Ω` → `75-ohm`). The studio
 * server derives the same id when none is sent.
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

/** A draft holds a signal as text: `csync`, or `cvbs|csync` for "one of". */
export function signalText(ref: SignalRef | null | undefined): string {
  if (ref === undefined || ref === null) return '';
  return typeof ref === 'string' ? ref : ref.oneOf.join('|');
}

/** The inverse of `signalText`; blank is no signal. */
export function signalRefOf(text: string): SignalRef | undefined {
  const ids = text
    .split('|')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length === 0) return undefined;
  return ids.length === 1 ? (ids[0] as string) : { oneOf: ids };
}

/** A picker's first guess at a new signal's kind, from its label. */
export function guessSignalKind(label: string): SignalKind {
  const text = label.toLowerCase();
  if (/\b(gnd|ground|return|shield|chassis)\b/.test(text)) return 'ground';
  if (/\bsync\b|csync|hsync|vsync/.test(text)) return 'sync';
  if (/audio|\bl\b|\br\b/.test(text)) return 'audio';
  if (/\+?\d+\s*v\b|power|vcc|\bv\+/.test(text)) return 'power';
  if (/data|sda|scl|clock|clk/.test(text)) return 'data';
  if (/video|rgb|luma|chroma|cvbs|\by\b|pb|pr/.test(text)) return 'video';
  return 'control';
}
