/**
 * Proposals for the signal tags (data model v2 task 2):
 * today's strings — pin labels and aliases, pad silkscreen ids and labels,
 * conductor colours, instance roles — read into vocab ids.
 *
 * This is the one place the label-reading lives for tagging. It is run by
 * `scripts/tag-signals.ts`, whose output (`data/tags/*.json`) is what the
 * model reads; it is never consulted at runtime. A reading it cannot make is
 * `undefined` and lands in the unclassified report for the owner — nothing is
 * guessed.
 *
 * Pure: strings and vocab in, ids out.
 */

import { resolveVocab, type ColourCodeEntry, type SignalRef, type Vocab } from '@wirehub/model';

/** A reading of one string: a signal, the bare word "sync" (the lane, no type), or nothing. */
export type Reading = { signal: string } | { genericSync: true } | undefined;

function norm(text: string): string {
  return text.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The return a ground label names, from the words left once the ground words are gone. */
function groundOf(text: string): string | undefined {
  if (/\b(shell|chassis)\b/.test(text)) return 'gnd-chassis';
  const qualifier = text
    .replace(/\b(gnd|ground|shield|connector|return)\b/g, ' ')
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (qualifier === '') return 'gnd';
  if (/^(audio|aud)$/.test(qualifier)) return 'gnd-audio';
  if (/^(red|video r)$/.test(qualifier)) return 'gnd-video-r';
  if (/^(green|video g)$/.test(qualifier)) return 'gnd-video-g';
  if (/^(blue|video b)$/.test(qualifier)) return 'gnd-video-b';
  if (/^(cvbs|sync|csync|luma)$/.test(qualifier)) return 'gnd-sync';
  if (/^video$/.test(qualifier)) return 'gnd-video';
  if (/^blanking$/.test(qualifier)) return 'gnd-blanking';
  if (/^data$/.test(qualifier)) return 'gnd-data';
  return undefined;
}

/** Every sync-family signal a label names, in the order it names them. */
function syncFamily(text: string): string[] {
  const hits: [number, string][] = [];
  for (const [pattern, id] of [
    [/\bcsync\b|composite sync/, 'csync'],
    [/\bcvbs\b|composite video|\bcomposite\b/, 'cvbs'],
    [/\bluma\b|\(y\)/, 'luma'],
  ] as const) {
    const at = text.search(pattern);
    if (at !== -1 && !hits.some(([, h]) => h === id)) hits.push([at, id]);
  }
  return hits.sort((a, b) => a[0] - b[0]).map(([, id]) => id);
}

/**
 * Read one label (or alias) as a signal. Order matters exactly where the words
 * overlap: "Red GND" is a return before it is red, "Digital RGBI (legacy,
 * unused)" is RGBI before it is unused, "CSync or CVBS" names both.
 */
export function readLabel(raw: string): Reading {
  const text = norm(raw);
  if (text === '') return undefined;
  if (/\brgbi\b/.test(text)) return { signal: 'rgbi-digital' };
  if (/\bgnd\b|\bground\b|\bshield\b|\bshell\b|\bchassis\b/.test(text)) {
    const ground = groundOf(text);
    return ground === undefined ? undefined : { signal: ground };
  }
  if (/not connected|^unused$|^n\/?c$/.test(text)) return { signal: 'nc' };
  if (/internal net/.test(text)) return { signal: 'internal' };
  if (/unclassified|unknown/.test(text)) return undefined;
  if (/genlock\/?aux|genlock \/ aux/.test(text)) return { signal: 'genlock-aux' };
  if (/\bxclk\b/.test(text)) return { signal: 'xclk' };
  if (/\bddc\b.*\b(data|sda)\b/.test(text)) return { signal: 'data-ddc-sda' };
  if (/\bddc\b.*\b(clock|scl)\b/.test(text)) return { signal: 'data-ddc-scl' };
  if (/av\.?link/.test(text)) return { signal: 'data-av-link' };
  if (/^data$/.test(text)) return { signal: 'data' };
  if (/mode.?select/.test(text)) return { signal: 'mode-select' };
  if (/^ym\b/.test(text)) return { signal: 'ym-overlay' };
  if (/blanking|\bys\b|rgb select|fast.switch/.test(text)) return { signal: 'blanking' };
  if (/function switch|status|aspect/.test(text)) return { signal: 'function-switch' };
  if (/light ?gun/.test(text)) return { signal: 'lightgun' };
  if (/\bhsync\b/.test(text)) return { signal: 'hsync' };
  if (/\bvsync\b/.test(text)) return { signal: 'vsync' };
  const family = syncFamily(text);
  // "Sync (delivered)", "TTL sync branch", "Sync (CVBS)": the sync lane, its type set by the build
  if (/^sync\b|\bsync branch\b|^sync in$/.test(text) && !/\bcsync\b/.test(text)) return { genericSync: true };
  if (family.length > 0) return { signal: family[0] as string };
  if (/\bsync\b/.test(text)) return { genericSync: true };
  if (/\bchroma\b|\(c\)/.test(text)) return { signal: 'chroma' };
  if (/\baudio\b|^la$|^ra$/.test(text)) {
    if (/\bmono\b|l\s*\+\s*r/.test(text)) return { signal: 'audio-mono' };
    if (/\bl\b|\bleft\b|^la$/.test(text)) return { signal: 'audio-l' };
    if (/\br\b|\bright\b|^ra$/.test(text)) return { signal: 'audio-r' };
    return { signal: 'audio-mono' };
  }
  if (/\bred\b|\bvideo r\b/.test(text)) return { signal: 'video-r' };
  if (/\bgreen\b|\bvideo g\b/.test(text)) return { signal: 'video-g' };
  if (/\bblue\b|\bvideo b\b/.test(text)) return { signal: 'video-b' };
  if (/^pb$/.test(text)) return { signal: 'ypbpr-pb' };
  if (/^pr$/.test(text)) return { signal: 'ypbpr-pr' };
  if (/^y$/.test(text)) return { signal: 'ypbpr-y' };
  if (/(^|\s)-\s*12\s*v\b/.test(text)) return { signal: 'pwr-12v-neg' };
  if (/\+?\s*12\s*v\b/.test(text)) return { signal: 'pwr-12v' };
  if (/\+?\s*9\s*v\b/.test(text)) return { signal: 'pwr-9v' };
  if (/\+?\s*5\s*v\b/.test(text)) return { signal: 'pwr-5v' };
  if (/console power|\bv\+|supply rail/.test(text)) return { signal: 'pwr-v' };
  if (/^signal$/.test(text)) return { signal: 'any' };
  return undefined;
}

/** A reading as a signal, where the bare "sync" of a pin means CSync. */
function asPinSignal(reading: Reading): string | undefined {
  if (reading === undefined) return undefined;
  return 'genericSync' in reading ? 'csync' : reading.signal;
}

/**
 * A connector pin's signal: its label, widened by what its aliases add —
 * SCART 20 "CVBS in" aliased "sync in" takes CVBS or CSync; Mini-DIN 10 pin 1
 * "CSync (NTSC)" aliased "+9 V DC (PAL)" is CSync or a 9 V rail by region. A
 * label naming two sync signals ("Sync (CSync or CVBS, per mod)") is both. The
 * shell position of a connector is its chassis, however its label reads.
 */
export function pinSignal(pin: { id: string; label: string; aliases?: string[] }): SignalRef | undefined {
  const text = norm(pin.label);
  const family = syncFamily(text);
  const own: string[] = family.length > 1 ? family : [asPinSignal(readLabel(pin.label))].filter((s): s is string => s !== undefined);
  if (own.length === 0) return undefined;
  const signals = [...own];
  for (const alias of pin.aliases ?? []) {
    const extra = asPinSignal(readLabel(alias));
    if (extra !== undefined && !signals.includes(extra)) signals.push(extra);
  }
  if (signals[0] === 'gnd' && /^(shell|s\d+)$/i.test(pin.id)) signals[0] = 'gnd-chassis';
  return signals.length === 1 ? (signals[0] as string) : { oneOf: signals };
}

/** A board terminal's tags: the pad role its silkscreen id names, and the signal its label names. */
export interface PadTags {
  role?: string;
  signal?: SignalRef;
}

/**
 * A board terminal's proposal. Cable pads (a bare id: `R`, `LA`, `GND`) get a
 * **role** from their silkscreen id through the `pad-roles` aliases, and a
 * **signal** from their label when the label says more than "sync" — the
 * delivered sync type is the build's (task 8), so "Sync (delivered)" pads carry
 * only their role. Silkscreen `L` is Audio L on some boards and Luma on others
 * (ground-truth §3), so it is never aliased: its role comes from its label.
 * Connector-side pads (`j.5`, `jp.GND`) carry a signal only; their position
 * belongs to the footprint's interface (task 8).
 */
export function padTags(vocab: Vocab, terminal: { id: string; label?: string }): PadTags {
  const reading = terminal.label === undefined ? undefined : readLabel(terminal.label);
  const signal = reading !== undefined && 'signal' in reading ? reading.signal : undefined;
  if (terminal.id.includes('.')) {
    const pinLike = reading !== undefined && 'genericSync' in reading ? 'csync' : signal;
    return pinLike === undefined ? {} : { signal: pinLike };
  }
  let role = resolveVocab(vocab, 'pad-roles', terminal.id)?.entry.id;
  if (role === undefined && terminal.id === 'L' && signal !== undefined) {
    role = signal === 'audio-l' ? 'audio-l' : signal === 'luma' ? 'sync' : undefined;
  }
  return {
    ...(role === undefined ? {} : { role }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * The colour code a stock follows: the most specific code whose colours cover
 * every coloured conductor (a two-colour audio lead is `rca-audio`, not the
 * eight-colour fleet code), and under which no conductor's own label names a
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
      const said = c.label === undefined ? undefined : laneOfLabel(c.label);
      return said !== undefined && said !== code.lanes[c.color as string];
    });
    if (disagreements.length === 0) return { code: code.id, disagreements: [] };
  }
  return undefined;
}

/** The lane a conductor label names ("Video Sync centre conductor" → sync), if any. */
export function laneOfLabel(label: string): string | undefined {
  const text = norm(label);
  if (/\bspare\b/.test(text)) return 'spare';
  const reading = readLabel(label);
  if (reading === undefined) return undefined;
  if ('genericSync' in reading) return 'sync';
  const lanes: Record<string, string> = {
    'video-r': 'video-r', 'video-g': 'video-g', 'video-b': 'video-b',
    csync: 'sync', cvbs: 'sync', luma: 'sync',
    'audio-l': 'audio-l', 'audio-r': 'audio-r',
    'pwr-5v': 'power', 'pwr-12v': 'power', 'pwr-9v': 'power', 'pwr-v': 'power',
  };
  return lanes[reading.signal];
}

/**
 * The slot an instance's free-text role names (data model v2 §2.1 `slots`,
 * the 45 — now 55 — role strings). Plugs are told apart by what they hang off
 * (a whip's RCA plugs, a lead's TRS plug, a leg's jack) before source and
 * destination, since "audio lead plug … into the source's audio out" is a
 * lead plug, not the source plug.
 */
export function slotOfRole(kind: 'connector' | 'segment', role: string, def: string): string | undefined {
  const text = norm(role);
  if (kind === 'segment') {
    if (/^trunk\b/.test(text)) return 'trunk';
    if (/^audio-lead-trs/.test(def) || /\btrs\b.*\blead\b/.test(text)) return 'audio-lead';
    if (/\bwhip\b/.test(text)) return 'audio-whip';
    if (/\bleg\b|\brun out of the mould\b/.test(text)) return 'leg';
    return undefined;
  }
  if (/light ?gun|\bleg\b/.test(text)) return 'leg-plug';
  if (/audio lead plug|\btrs\b.*\bjack\b|aux audio whip plug/.test(text)) return 'audio-lead-plug';
  if (/^audio [lr] plug\b/.test(text)) return 'audio-whip-plug';
  if (/^source plug\b|plug into the source device/.test(text)) return 'source-plug';
  if (/^destination plug\b|plug into the destination|\bbnc$|^jp21 plug\b/.test(text)) return 'dest-plug';
  return undefined;
}
