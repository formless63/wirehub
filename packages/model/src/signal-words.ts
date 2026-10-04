/**
 * Reading a terminal's words — a pin label, a pad's silkscreen, a conductor's
 * label — as a vocab signal.
 *
 * The base knows no signal by name. Every reading is a match against the
 * catalog's own `signals` list: an entry's `label`, `short`, `aliases` and id.
 * A domain module that brings video, fieldbus or automotive signals brings
 * the words for them in the same entries, and every reader below — compat's
 * joint rules, the new-cable wizard, the tag proposals — understands them
 * without a line of code.
 *
 * What the base does know is the handful of words that are not about any one
 * domain: ground and its synonyms, "not connected", and supply voltages.
 *
 * Pure: vocabulary and text in, ids out. Ties go to the earlier entry of the
 * list, so the same catalog always reads the same way.
 */

import { vocabEntry, vocabKey, type LaneEntry, type SignalEntry, type Vocab } from './vocab.ts';

const GROUND_WORDS = /\b(gnd|ground|return|rtn|shield|screen)\b/;
const CHASSIS_WORDS = /\b(shell|chassis|frame|earth)\b/;
const NOT_CONNECTED = /\bnot connected\b|^unused$|^n\/?c$|^no connection$/;

/** The id of the base's chassis return; a deployment may alias it, never rename it. */
export const CHASSIS_SIGNAL = 'gnd-chassis';
/** The id of the base's general ground. */
export const GROUND_SIGNAL = 'gnd';

function norm(text: string): string {
  return vocabKey(text.replace(/[_]+/g, ' '));
}

function liveSignals(vocab: Vocab | undefined): SignalEntry[] {
  return ((vocab?.['signals']?.entries ?? []) as SignalEntry[]).filter(
    (e) => e.pending !== true && e.deprecatedBy === undefined,
  );
}

function has(vocab: Vocab | undefined, id: string): boolean {
  return vocabEntry(vocab, 'signals', id) !== undefined;
}

/** The phrases an entry answers to, normalised, longest first. */
function phrasesOf(entry: SignalEntry): string[] {
  const out = new Set<string>();
  for (const text of [entry.label, entry.short, ...(entry.aliases ?? []), entry.id.replace(/-/g, ' ')]) {
    if (typeof text !== 'string') continue;
    const key = norm(text);
    if (key !== '') out.add(key);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `phrase` occur in `text` as whole words? */
function containsPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}($|[^a-z0-9])`).test(text);
}

/**
 * The best entry of `entries` the text names: an exact phrase beats a
 * contained one, a longer phrase beats a shorter one, an earlier entry
 * beats a later one. Phrases of one character match only exactly.
 */
function bestMatch(entries: SignalEntry[], text: string): SignalEntry | undefined {
  let best: { entry: SignalEntry; score: number } | undefined;
  for (const entry of entries) {
    for (const phrase of phrasesOf(entry)) {
      const score = text === phrase ? 10_000 + phrase.length : phrase.length > 1 && containsPhrase(text, phrase) ? phrase.length : 0;
      if (score > 0 && (best === undefined || score > best.score)) best = { entry, score };
    }
  }
  return best?.entry;
}

/** `+5 V`, `5V`, `-12 v` → `+5` / `-12`; `undefined` when the text names no voltage. */
function voltageOf(text: string): string | undefined {
  const match = /(^|[^0-9.])([+-]?)\s*(\d+(?:\.\d+)?)\s*v(dc)?\b/.exec(text);
  if (match === null) return undefined;
  return `${match[2] === '-' ? '-' : '+'}${Number(match[3])}`;
}

function powerSignalFor(vocab: Vocab | undefined, text: string): string | undefined {
  const volts = voltageOf(text);
  if (volts === undefined) return undefined;
  const power = liveSignals(vocab).filter((e) => e.kind === 'power');
  const same = power.find((e) => phrasesOf(e).some((phrase) => voltageOf(phrase) === volts));
  if (same !== undefined) return same.id;
  // a rail the list has no entry for: the generic supply, if the list has one
  return power.find((e) => e.id === 'pwr-v')?.id;
}

/**
 * The return a ground's words name: the chassis for shell/chassis words, the
 * entry whose own words match (`Audio GND`), or the return of the signal the
 * rest of the words name (`Red GND` → the return of whatever "Red" is), else
 * the general ground. `undefined` only when the list has no ground at all.
 */
function groundSignalFor(vocab: Vocab | undefined, text: string): string | undefined {
  const grounds = liveSignals(vocab).filter((e) => e.kind === 'ground');
  if (grounds.length === 0) return undefined;
  if (CHASSIS_WORDS.test(text) && !GROUND_WORDS.test(text.replace(CHASSIS_WORDS, ''))) {
    if (has(vocab, CHASSIS_SIGNAL)) return CHASSIS_SIGNAL;
  }
  const exact = grounds.find((e) => phrasesOf(e).includes(text));
  if (exact !== undefined) return exact.id;
  const qualifier = norm(text.replace(GROUND_WORDS, ' ').replace(CHASSIS_WORDS, ' ').replace(/\bconnector\b/g, ' ').replace(/[^a-z0-9+ ]+/g, ' '));
  if (qualifier !== '') {
    const named = bestMatch(grounds, qualifier);
    if (named !== undefined) return named.id;
    // the qualifier names a signal: its return
    const signal = bestMatch(liveSignals(vocab).filter((e) => e.kind !== 'ground'), qualifier);
    if (signal !== undefined) {
      const ret = returnOf(vocab, signal.id);
      if (ret !== undefined) return ret;
    }
    // the qualifier names a kind ("audio"): the return of every signal of it
    const byKind = grounds.find((e) => (e.returnFor ?? []).length > 0 && (e.returnFor ?? []).every((id) => vocabEntry<SignalEntry>(vocab, 'signals', id)?.kind === qualifier));
    if (byKind !== undefined) return byKind.id;
  }
  if (has(vocab, CHASSIS_SIGNAL) && CHASSIS_WORDS.test(text)) return CHASSIS_SIGNAL;
  return has(vocab, GROUND_SIGNAL) ? GROUND_SIGNAL : grounds[0]?.id;
}

/** The return of signal `id`: the ground entry whose `returnFor` names it. */
export function returnOf(vocab: Vocab | undefined, id: string): string | undefined {
  return liveSignals(vocab).find((e) => e.kind === 'ground' && (e.returnFor ?? []).includes(id))?.id;
}

/** Is this signal a ground of any sort (kind `ground`)? */
export function isGroundSignal(vocab: Vocab | undefined, id: string): boolean {
  return vocabEntry<SignalEntry>(vocab, 'signals', id)?.kind === 'ground' || id === GROUND_SIGNAL || id === CHASSIS_SIGNAL;
}

/**
 * The signal one piece of text names, or `undefined` when it names none the
 * list knows (`Mode select` with no such entry, a spare, an empty label).
 * Ground words make it a ground (`groundSignalFor`); "not connected" is `nc`
 * when the list has it; a voltage is the power entry of that voltage.
 */
export function readSignalWords(vocab: Vocab | undefined, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = norm(raw);
  if (text === '') return undefined;
  if (NOT_CONNECTED.test(text)) return has(vocab, 'nc') ? 'nc' : undefined;
  if (GROUND_WORDS.test(text) || CHASSIS_WORDS.test(text)) {
    // a ground entry's own words first: "Shield drain" may be an entry of its own
    const own = liveSignals(vocab).filter((e) => e.kind === 'ground');
    const exact = own.find((e) => phrasesOf(e).includes(text));
    return exact?.id ?? groundSignalFor(vocab, text);
  }
  // "0 V" is the return, never a rail
  if (voltageOf(text) === '+0') {
    const own = liveSignals(vocab).find((e) => e.kind === 'ground' && phrasesOf(e).includes(text));
    return own?.id ?? (has(vocab, GROUND_SIGNAL) ? GROUND_SIGNAL : undefined);
  }
  const signals = liveSignals(vocab).filter((e) => e.kind !== 'ground' && e.kind !== 'none');
  const exact = signals.find((e) => phrasesOf(e).includes(text));
  if (exact !== undefined) return exact.id;
  const power = powerSignalFor(vocab, text);
  if (power !== undefined) return power;
  return bestMatch(signals, text)?.id;
}

/**
 * Every signal a terminal's words name, label first, each once — the label
 * and its aliases may name different signals the device chooses between.
 */
export function readSignalLabels(vocab: Vocab | undefined, labels: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const label of labels) {
    const id = readSignalWords(vocab, label);
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The signal a lane carries: the lane's own `signal`, or a signal with the lane's id. */
export function signalOfLane(vocab: Vocab | undefined, lane: string): string | undefined {
  const entry = vocabEntry<LaneEntry>(vocab, 'lanes', lane);
  if (entry?.signal !== undefined) return entry.signal;
  return has(vocab, lane) ? lane : undefined;
}

/** The lane a signal belongs to: a lane naming it, or a lane with the signal's id. */
export function laneOfSignal(vocab: Vocab | undefined, signal: string): string | undefined {
  const lanes = (vocab?.['lanes']?.entries ?? []) as LaneEntry[];
  return lanes.find((l) => l.signal === signal)?.id ?? lanes.find((l) => l.id === signal)?.id;
}
