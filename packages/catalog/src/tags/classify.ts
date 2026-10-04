/**
 * Proposals for the signal tags: today's strings — pin labels and aliases,
 * pad silkscreen ids and labels, conductor colours, instance roles — read
 * into vocab ids.
 *
 * This is the one place the label-reading lives for tagging. It is run by the
 * tag builder (`build.ts`), whose output (`data/tags/*.json`) is what the
 * model reads; it is never consulted at runtime. A reading it cannot make is
 * `undefined` and lands in the unclassified report — nothing is guessed.
 *
 * The words come from the catalog's vocabulary, not from this file: a signal
 * is recognised by its entry's label, short name and aliases
 * (`readSignalWords`, `@wirehub/model`). A domain module that adds signals
 * adds the words for them in its catalog pack.
 *
 * Pure: strings and vocab in, ids out.
 */

import {
  laneOfSignal,
  readSignalLabels,
  readSignalWords,
  resolveVocab,
  type ColourCodeEntry,
  type SignalRef,
  type Vocab,
} from '@wirehub/model';

/**
 * A connector pin's signal: its label, widened by what its aliases add — a
 * pin labelled with one signal and aliased with another carries either, the
 * device deciding. The shell position of a connector is its chassis, however
 * its label reads.
 */
export function pinSignal(vocab: Vocab | undefined, pin: { id: string; label: string; aliases?: string[] }): SignalRef | undefined {
  const own = readSignalWords(vocab, pin.label);
  if (own === undefined) return undefined;
  const signals = readSignalLabels(vocab, [pin.label, ...(pin.aliases ?? [])]);
  if (signals[0] === 'gnd' && /^(shell|s\d+)$/i.test(pin.id) && resolveVocab(vocab, 'signals', 'gnd-chassis') !== undefined) {
    signals[0] = 'gnd-chassis';
  }
  return signals.length === 1 ? (signals[0] as string) : { oneOf: signals };
}

/** A board terminal's tags: the pad role its silkscreen id names, and the signal its label names. */
export interface PadTags {
  role?: string;
  signal?: SignalRef;
}

/**
 * A board terminal's proposal. Cable pads (a bare id: `A`, `GND`) get a
 * **role** from their silkscreen id through the `pad-roles` aliases, and a
 * **signal** from their label. Connector-side pads (`j.5`, `jp.GND`) carry a
 * signal only; their position belongs to the footprint's interface.
 */
export function padTags(vocab: Vocab, terminal: { id: string; label?: string }): PadTags {
  const signal = terminal.label === undefined ? undefined : readSignalWords(vocab, terminal.label);
  if (terminal.id.includes('.')) return signal === undefined ? {} : { signal };
  const role = resolveVocab(vocab, 'pad-roles', terminal.id)?.entry.id;
  return {
    ...(role === undefined ? {} : { role }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * The colour code a stock follows: the most specific code whose colours cover
 * every coloured conductor (a two-colour audio lead is a two-colour code, not
 * an eight-colour one), and under which no conductor's own label names a
 * different lane. `undefined` when no code fits.
 */
export function colourCodeFor(
  vocab: Vocab,
  conductors: { path: string; color?: string; label?: string }[],
): { code: string; disagreements: string[] } | undefined {
  const codes = ((vocab['colour-codes']?.entries ?? []) as ColourCodeEntry[])
    .filter((c) => c.pending !== true && c.deprecatedBy === undefined)
    .sort((a, b) => Object.keys(a.lanes).length - Object.keys(b.lanes).length);
  const coloured = conductors.filter((c) => c.color !== undefined);
  if (coloured.length === 0) return undefined;
  for (const code of codes) {
    if (!coloured.every((c) => code.lanes[c.color as string] !== undefined)) continue;
    const disagreements = coloured.filter((c) => {
      const said = c.label === undefined ? undefined : laneOfLabel(vocab, c.label);
      return said !== undefined && said !== code.lanes[c.color as string];
    });
    if (disagreements.length === 0) return { code: code.id, disagreements: [] };
  }
  return undefined;
}

/** The lane a conductor label names (its signal's lane), if any. */
export function laneOfLabel(vocab: Vocab, label: string): string | undefined {
  if (/\bspare\b/i.test(label) && resolveVocab(vocab, 'lanes', 'spare') !== undefined) return 'spare';
  const signal = readSignalWords(vocab, label);
  return signal === undefined ? undefined : laneOfSignal(vocab, signal);
}

/**
 * The slot an instance's free-text role names: the trunk and the legs of a
 * stock, the source and destination plugs. Anything else is left for a
 * person (`data/tags/review.json`).
 */
export function slotOfRole(kind: 'connector' | 'segment', role: string, _def: string): string | undefined {
  const text = role.toLowerCase().replace(/\s+/g, ' ').trim();
  if (kind === 'segment') {
    if (/^trunk\b/.test(text)) return 'trunk';
    if (/\bleg\b|\brun out of the mould\b/.test(text)) return 'leg';
    return undefined;
  }
  if (/\bleg\b/.test(text)) return 'leg-plug';
  if (/^source (plug|end)\b|plug into the source/.test(text)) return 'source-plug';
  if (/^destination (plug|end)\b|plug into the destination/.test(text)) return 'dest-plug';
  return undefined;
}
