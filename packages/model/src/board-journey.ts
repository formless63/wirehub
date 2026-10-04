/**
 * The board journey's pure helpers (data model v2 §8 J3, §9 task 10,
 *): the reads the studio's board page makes of a board's
 * build file, its definitions and its interface, so the checks it shows are
 * the same ones the catalog runs.
 *
 * - `footprintPadMap`: a connector footprint's pads against the interface the
 *   mated connector carries — by pad number, by the footprint's own pad map,
 *   else by the pad's tagged signal — with every mismatch named;
 * - `rankFootprintInterfaces`: which interfaces fit a footprint best;
 * - `exclusiveGroups`: the exclusive-setting groups of one build, closed count
 *   and all, for a live rule display;
 * - `partPopulation`: each part's state on a build, and which setting sets it;
 * - `conditioningFromVia`: conditioning ids a path's `via` text suggests
 *   (a series resistor → `series-resistor`, `220 µF` → `ac-coupling`);
 * - `buildsFileName` / `buildsFileFor`: where a board's build file lives;
 * - `canonicalBuildsFile`: a file's keys in the order the committed files
 *   use, so a save from a form diffs as the change and nothing else.
 *
 * Nothing here reads a file.
 */

import { buildPopulation, type BoardBuild, type BoardBuilds, type BoardFootprint, type BuildSetting } from './builds.ts';
import type { Interface } from './interfaces.ts';
import { signalIds, vocabEntry, type SignalRef, type Vocab } from './vocab.ts';

/* ------------------------------------------------------------------ *
 * Where a board's builds live
 * ------------------------------------------------------------------ */

/** `data/builds/<name>.json`'s name for a file: `PCA-00107`, `PCA-00108-rev5`. */
export function buildsFileName(file: Pick<BoardBuilds, 'board' | 'revision'>): string {
  const base = file.board.toLowerCase();
  return file.revision === undefined ? base : `${base}-${file.revision.toLowerCase()}`;
}

/** The build file a board revision reads: one naming the revision wins over the part-number one. */
export function buildsFileFor<T extends Pick<BoardBuilds, 'board' | 'revision'>>(
  files: readonly T[],
  partNumber: string,
  revision: string | undefined,
): T | undefined {
  return (
    files.find((f) => f.board === partNumber && f.revision !== undefined && f.revision === revision) ??
    files.find((f) => f.board === partNumber && f.revision === undefined)
  );
}

/* ------------------------------------------------------------------ *
 * Footprint pads → interface positions
 * ------------------------------------------------------------------ */

export type FootprintPadStatus = 'ok' | 'unknown-position' | 'signal-mismatch' | 'untagged' | 'dual-landing';

export interface FootprintPadRow {
  /** the board terminal: `j.5` */
  terminal: string;
  /** the pad part: `5` */
  pad: string;
  /** the interface position it lands on; absent when none could be found */
  position?: string;
  /** how the position was found */
  by?: 'number' | 'map' | 'signal';
  /** what the interface says the position carries */
  signal?: SignalRef;
  label?: string;
  /** what the board's tags say the pad carries */
  padSignal?: SignalRef;
  /**
   * `dual-landing`: the conductor landing on the same copper whose signal the
   * pad's tag names (`5V`, or the pad itself) — see `ConductorLanding`
   */
  landing?: string;
  status: FootprintPadStatus;
}

/**
 * A conductor landing on a footprint pad's copper (owner, decisions page
 * 2026-09-29, batch 10: "that pad both solders to the perfboard and we also
 * land the brown 5v wire from the wire side to it"): `pad` is the cable-side
 * pad a wire lands on — the footprint terminal itself, or a cable pad the
 * netlist links it to with no part between — and `signal` what that
 * conductor carries (the pad's role's signal).
 */
export interface ConductorLanding {
  pad: string;
  signal?: SignalRef;
}

export interface FootprintMap {
  rows: FootprintPadRow[];
  /** interface positions no pad of the footprint lands on */
  unlanded: string[];
  /** rows that are fine */
  ok: number;
  /** rows that are wrong: a position the interface lacks, or a pad tagged with a different signal */
  mismatches: number;
}

/** What `footprintPadMap` needs besides the pads to read a double landing. */
export interface FootprintPadMapOptions {
  /** footprint terminal → the conductor landing on its copper (`conductorLandings`) */
  landings?: Readonly<Record<string, ConductorLanding | undefined>>;
}

/**
 * The conductor landing on each footprint terminal's copper: the terminal
 * itself when it has a pad role (a wire lands on it), else the one role-tagged
 * cable pad (no `.`) the definition links it to directly (`jp.4` ↔ `5V`, no
 * `via` part). Pure; the caller supplies each terminal's role and signal.
 */
export function conductorLandings(
  def: { terminals: readonly { id: string }[]; internalLinks: readonly { from: string; to: string; via?: string }[] },
  tagOf: (terminal: string) => { role?: string; signal?: SignalRef },
): Record<string, ConductorLanding> {
  const out: Record<string, ConductorLanding> = {};
  for (const t of def.terminals) {
    if (!t.id.includes('.')) continue;
    const own = tagOf(t.id);
    if (own.role !== undefined) {
      out[t.id] = { pad: t.id, ...(own.signal === undefined ? {} : { signal: own.signal }) };
      continue;
    }
    const linked = new Set<string>();
    for (const l of def.internalLinks) {
      if (l.via !== undefined) continue;
      const other = l.from === t.id ? l.to : l.to === t.id ? l.from : undefined;
      if (other !== undefined && !other.includes('.') && tagOf(other).role !== undefined) linked.add(other);
    }
    if (linked.size !== 1) continue;
    const pad = [...linked][0]!;
    const signal = tagOf(pad).signal;
    out[t.id] = { pad, ...(signal === undefined ? {} : { signal }) };
  }
  return out;
}

/** A signal that is a DC level (a supply rail, or a control line such as RGB blanking) rather than a waveform. */
function isLevel(ref: SignalRef | undefined, vocab: Vocab | undefined): boolean {
  if (ref === undefined || vocab === undefined) return false;
  return signalIds(ref).every((id) => {
    const kind = (vocabEntry(vocab, 'signals', id) as { kind?: string } | undefined)?.kind;
    return kind === 'power' || kind === 'control';
  });
}

function overlap(a: SignalRef | undefined, b: SignalRef | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const bs = new Set(signalIds(b));
  return signalIds(a).some((id) => bs.has(id));
}

/**
 * `overlap`, read through the signals list when there is one: two grounds
 * agree whatever their flavour (`gnd` on a pad, `gnd-chassis` on the shell
 * position), and a signal of no kind (`any`, `internal`) agrees with
 * anything — the tags and the interface only disagree when they name two
 * different things.
 */
function agree(a: SignalRef | undefined, b: SignalRef | undefined, vocab: Vocab | undefined): boolean {
  if (overlap(a, b)) return true;
  if (a === undefined || b === undefined || vocab === undefined) return false;
  const kind = (id: string): string | undefined => (vocabEntry(vocab, 'signals', id) as { kind?: string } | undefined)?.kind;
  const ka = signalIds(a).map(kind);
  const kb = signalIds(b).map(kind);
  if (ka.includes('none') || kb.includes('none')) return true;
  return ka.includes('ground') && kb.includes('ground');
}

/**
 * The footprint's terminals (`<prefix>.<pad>`) mapped onto the interface's
 * positions. A pad lands by the footprint's own `pads` map, else by its
 * number, else — when its tag names a signal only one position carries — by
 * that signal. A pad whose tagged signal the position does not carry is a
 * `signal-mismatch`; one the interface has no position for is
 * `unknown-position` (the same finding as `validateBoardBuilds`'
 * `footprint-position-unknown`) — unless it is a **double landing**
 * (`dual-landing`, owner 2026-09-29 batch 10): the footprint has a carrier
 * whose pad T-joins this one, a conductor lands on the same copper
 * (`options.landings`, see `conductorLandings`) carrying what the pad's tag
 * names, and both the tag and the position are DC levels (a rail, RGB
 * blanking) — the pad then serves the plug and the wire at once, as the
 * the source device's pin 4 (+V blanking) pad does with the brown's +5 V.
 */
export function footprintPadMap(
  footprint: Pick<BoardFootprint, 'prefix' | 'pads'> & Partial<Pick<BoardFootprint, 'carrier'>>,
  iface: Interface | undefined,
  terminals: readonly string[],
  padSignals: Readonly<Record<string, SignalRef | undefined>> = {},
  vocab?: Vocab,
  options: FootprintPadMapOptions = {},
): FootprintMap {
  const lead = `${footprint.prefix}.`;
  const own = [...new Set(terminals.filter((t) => t.startsWith(lead)))];
  const rows: FootprintPadRow[] = [];
  const landed = new Set<string>();
  for (const terminal of own) {
    const pad = terminal.slice(lead.length);
    const padSignal = padSignals[terminal];
    const row: FootprintPadRow = { terminal, pad, status: 'unknown-position', ...(padSignal === undefined ? {} : { padSignal }) };
    if (iface !== undefined) {
      const mapped = footprint.pads?.[pad];
      let position: string | undefined;
      let by: FootprintPadRow['by'];
      if (mapped !== undefined && iface.pins[mapped] !== undefined) {
        position = mapped;
        by = 'map';
      } else if (iface.pins[pad] !== undefined) {
        position = pad;
        by = 'number';
      } else if (padSignal !== undefined) {
        const hits = Object.entries(iface.pins).filter(([, fn]) => overlap(fn.signal, padSignal));
        if (hits.length === 1) {
          position = hits[0]![0];
          by = 'signal';
        }
      }
      if (position !== undefined && by !== undefined) {
        const fn = iface.pins[position]!;
        landed.add(position);
        row.position = position;
        row.by = by;
        row.signal = fn.signal;
        if (fn.label !== undefined) row.label = fn.label;
        row.status = padSignal === undefined ? 'untagged' : agree(fn.signal, padSignal, vocab) ? 'ok' : 'signal-mismatch';
        // a double landing (owner, decisions page 2026-09-29, batch 10): the
        // pad takes the plug's position through the carrier's T-join AND a
        // conductor from the wire side — its tag names what the conductor
        // carries (the brown's +5 V), the position what the plug delivers
        // (the console's +V blanking level). Both are DC levels on one copper.
        const landing = options.landings?.[terminal];
        if (
          row.status === 'signal-mismatch' &&
          footprint.carrier !== undefined &&
          landing !== undefined &&
          agree(landing.signal, padSignal, vocab) &&
          isLevel(fn.signal, vocab) &&
          isLevel(padSignal, vocab)
        ) {
          row.status = 'dual-landing';
          row.landing = landing.pad;
        }
      }
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.pad.localeCompare(b.pad, 'en', { numeric: true }));
  const unlanded = iface === undefined ? [] : Object.keys(iface.pins).filter((p) => !landed.has(p));
  return {
    rows,
    unlanded,
    ok: rows.filter((r) => r.status === 'ok' || r.status === 'untagged' || r.status === 'dual-landing').length,
    mismatches: rows.filter((r) => r.status === 'unknown-position' || r.status === 'signal-mismatch').length,
  };
}

/**
 * A footprint pad map (`pad → position`) that lands the tagged pads on the
 * interface: numbered as-is, or mirrored (`n → max + 1 − n`, a socket seen
 * from the other side), whichever agrees with more of the tags; a pad the
 * better numbering still gets wrong goes to the one position that carries its
 * tagged signal, when there is exactly one. Only entries that differ from the
 * pad's own number are returned — `{}` means "numbered as-is". A suggestion:
 * the person confirms it.
 */
export function suggestFootprintPads(
  footprint: Pick<BoardFootprint, 'prefix'>,
  iface: Interface,
  terminals: readonly string[],
  padSignals: Readonly<Record<string, SignalRef | undefined>>,
  vocab?: Vocab,
): { pads: Record<string, string>; ok: number; of: number; mirrored: boolean } {
  const lead = `${footprint.prefix}.`;
  const pads = [...new Set(terminals.filter((t) => t.startsWith(lead)).map((t) => t.slice(lead.length)))];
  const numbered = Object.keys(iface.pins).filter((p) => /^\d+$/.test(p)).map(Number);
  const max = numbered.length === 0 ? 0 : Math.max(...numbered);
  const agrees = (pad: string, position: string | undefined): boolean =>
    position !== undefined && iface.pins[position] !== undefined && agree(iface.pins[position]!.signal, padSignals[`${lead}${pad}`], vocab);
  const exactly = (pad: string, position: string): boolean => overlap(iface.pins[position]?.signal, padSignals[`${lead}${pad}`]);
  const mirror = (pad: string): string | undefined => (/^\d+$/.test(pad) && max > 0 ? String(max + 1 - Number(pad)) : undefined);
  const score = (map: (pad: string) => string | undefined): number => pads.filter((pad) => agrees(pad, map(pad))).length;
  const mirrored = score(mirror) > score((pad) => pad);
  const base = mirrored ? mirror : (pad: string): string | undefined => pad;
  const out: Record<string, string> = {};
  let ok = 0;
  const tagged = pads.filter((pad) => padSignals[`${lead}${pad}`] !== undefined);
  for (const pad of pads) {
    let position = base(pad);
    if (!agrees(pad, position) && padSignals[`${lead}${pad}`] !== undefined) {
      const hits = Object.keys(iface.pins).filter((p) => exactly(pad, p));
      if (hits.length === 1) position = hits[0];
    }
    if (agrees(pad, position)) ok += 1;
    if (position !== undefined && position !== pad && iface.pins[position] !== undefined) out[pad] = position;
  }
  return { pads: out, ok, of: tagged.length, mirrored };
}

/** Interfaces ranked by how well the footprint's pads land on them: fewest mismatches, then most pads landed. */
export function rankFootprintInterfaces(
  footprint: Pick<BoardFootprint, 'prefix' | 'pads'>,
  interfaces: readonly Interface[],
  terminals: readonly string[],
  padSignals: Readonly<Record<string, SignalRef | undefined>> = {},
  vocab?: Vocab,
): { iface: Interface; map: FootprintMap; score: number }[] {
  return interfaces
    .map((iface) => {
      const map = footprintPadMap(footprint, iface, terminals, padSignals, vocab);
      const agree = map.rows.filter((r) => r.status === 'ok').length;
      return { iface, map, score: agree * 2 + map.ok - map.mismatches * 3 };
    })
    .sort((a, b) => b.score - a.score || a.iface.id.localeCompare(b.iface.id));
}

/* ------------------------------------------------------------------ *
 * Settings and population on one build
 * ------------------------------------------------------------------ */

export interface ExclusiveGroupState {
  group: string[];
  closed: string[];
  /** exactly one closed */
  ok: boolean;
}

/** Each exclusive group of the board, as `build` sets it (the `build-exclusive` rule, per group). */
export function exclusiveGroups(file: Pick<BoardBuilds, 'exclusive'>, build: Pick<BoardBuild, 'settings'>): ExclusiveGroupState[] {
  return (file.exclusive ?? []).map((group) => {
    const closed = group.filter((fn) => build.settings?.[fn] === 'closed');
    return { group: [...group], closed, ok: build.settings === undefined || closed.length === 1 };
  });
}

export type PartBuildState = 'fitted' | 'bridged' | 'omitted';

export interface PartOnBuild {
  ref: string;
  state: PartBuildState;
  /** the setting whose state decides it (`TTL`) — the part is then changed through the setting */
  setting?: BuildSetting;
}

/**
 * Every part `refs` names, as `build` populates it: bridged (a 0 Ω link or a
 * closed jumper), omitted, else fitted. A part a setting controls says so.
 */
export function partPopulation(file: BoardBuilds, build: BoardBuild, refs: readonly string[]): PartOnBuild[] {
  const population = buildPopulation(file, build);
  const bridged = new Set(population.bridged ?? []);
  const omitted = new Set(population.omitted ?? []);
  const all = [...new Set([...refs, ...bridged, ...omitted, ...(file.settings ?? []).filter((s) => s.kind !== 'switch').map((s) => s.ref)])];
  return all
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((ref) => {
      const setting = (file.settings ?? []).find((s) => s.ref === ref && s.kind !== 'switch');
      const state: PartBuildState = omitted.has(ref) ? 'omitted' : bridged.has(ref) ? 'bridged' : 'fitted';
      return { ref, state, ...(setting === undefined ? {} : { setting }) };
    });
}

const byRef = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

/** Add `ref` to a list in reference order when the list is in that order (so undoing a change restores it), else at the end. */
function insertRef(list: string[], ref: string): void {
  const sorted = list.every((r, i) => i === 0 || byRef(list[i - 1]!, r) <= 0);
  if (!sorted) {
    list.push(ref);
    return;
  }
  const at = list.findIndex((r) => byRef(ref, r) < 0);
  if (at === -1) list.push(ref);
  else list.splice(at, 0, ref);
}

/**
 * `build` with one part set to `state` in its own `bridged` / `omitted`
 * lists (settings are not touched; a part a setting controls is changed
 * through the setting).
 */
export function withPartState(build: BoardBuild, ref: string, state: PartBuildState): BoardBuild {
  const bridged = (build.bridged ?? []).filter((r) => r !== ref);
  const omitted = (build.omitted ?? []).filter((r) => r !== ref);
  if (state === 'bridged') insertRef(bridged, ref);
  if (state === 'omitted') insertRef(omitted, ref);
  // assigning onto a copy keeps each key where it was
  const next: BoardBuild = { ...build };
  if (bridged.length > 0 || build.bridged !== undefined) next.bridged = bridged;
  if (omitted.length > 0 || build.omitted !== undefined) next.omitted = omitted;
  return next;
}

/**
 * `build` with a setting moved to `state`. For a jumper or link the
 * setting's ref is kept in step in `bridged` / `omitted`, so the population
 * and the settings never disagree (`build-setting-population`).
 */
export function withSettingState(file: BoardBuilds, build: BoardBuild, fn: string, state: string): BoardBuild {
  const settings = { ...(build.settings ?? {}), [fn]: state };
  const setting = file.settings?.find((s) => s.function === fn);
  let next: BoardBuild = { ...build, settings };
  if (setting === undefined || setting.kind === 'switch') return next;
  const target: PartBuildState =
    state === 'open' ? 'omitted' : setting.kind === 'jumper' ? 'bridged' : 'fitted';
  next = withPartState(next, setting.ref, target);
  return next;
}

/* ------------------------------------------------------------------ *
 * Conditioning a path's parts suggest
 * ------------------------------------------------------------------ */

/** Ohms named in `text`: `470 Ω`, `470R`, `4k7`, `1.2 kΩ`. */
function resistances(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(k|K)?\s*(?:Ω|ohm|R\b)|(\d+)[kK](\d+)/g)) {
    if (m[4] !== undefined && m[5] !== undefined) out.push(Number(`${m[4]}.${m[5]}`) * 1000);
    else if (m[1] !== undefined) out.push(Number(m[1]) * (m[2] === undefined ? 1 : 1000));
  }
  return out;
}

/**
 * The conditioning a path's `via` text suggests (suggested, then confirmed by
 * a person), as ids of the base `conditioning` vocabulary: a series resistor,
 * a line termination, AC coupling through a series capacitor, a buffer, a
 * level shift. Only what the words say — never a guess from a value alone.
 * A domain module's own conditioning (a sync stripper, say) is its vocabulary
 * entry and a person's choice.
 */
export function conditioningFromVia(via: string | undefined, _signal?: SignalRef): string[] {
  if (via === undefined || via.trim() === '') return [];
  const text = via;
  const out: string[] = [];
  const add = (id: string): void => {
    if (!out.includes(id)) out.push(id);
  };
  if (/\bterminat/i.test(text)) add('termination');
  else if (resistances(text).length > 0) add('series-resistor');
  if (/\d+(\.\d+)?\s*[unpµμ]F\b/i.test(text)) add('ac-coupling');
  if (/\bbuffer\b/i.test(text)) add('buffer');
  if (/level.?shift/i.test(text)) add('level-shift');
  return out;
}

/* ------------------------------------------------------------------ *
 * The committed key order
 * ------------------------------------------------------------------ */

const FILE_KEYS = ['board', 'revision', 'label', 'short', 'end', 'footprints', 'settings', 'exclusive', 'expects', 'power', 'hazards', 'pairs', 'builds', 'src'];
const PAIR_KEYS = ['board', 'relation', 'src'];
const BUILD_KEYS = ['key', 'idSuffix', 'build', 'labelSuffix', 'bridged', 'omitted', 'values', 'feedValues', 'passages', 'serves', 'src', 'note', 'settings', 'capability', 'hazards'];
const SETTING_KEYS = ['function', 'ref', 'kind', 'states', 'label', 'rules', 'src'];
const FOOTPRINT_KEYS = ['prefix', 'interface', 'integrated', 'pads'];
const PATH_KEYS = ['from', 'to', 'in', 'out', 'conditioning', 'when', 'linked', 'note'];
const SPEC_KEYS = ['signal', 'level'];
const HAZARD_KEYS = ['code', 'text', 'src'];
const RULE_KEYS = ['when', 'state', 'src'];
const WHEN_KEYS = ['destination', 'sync', 'settings', 'destinationStrips'];
const POWER_KEYS = ['rail', 'feeds', 'note'];
const CAPABILITY_KEYS = ['paths', 'src'];

/** `value`'s own keys in `order` first, the rest after in their own order; `undefined` values dropped. */
function ordered<T extends object>(value: T, order: readonly string[]): T {
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [...order.filter((k) => k in record), ...Object.keys(record).filter((k) => !order.includes(k))]) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out as T;
}

/**
 * The file with every record's keys in the committed order (`data/builds`
 * files are read by people in diffs; a form that spreads objects must not
 * reorder them). Values are untouched; `undefined` fields are dropped.
 */
export function canonicalBuildsFile(file: BoardBuilds): BoardBuilds {
  const out = ordered(file, FILE_KEYS);
  if (out.footprints !== undefined) out.footprints = out.footprints.map((f) => ordered(f, FOOTPRINT_KEYS));
  if (out.settings !== undefined) {
    out.settings = out.settings.map((s) => {
      const setting = ordered(s, SETTING_KEYS);
      if (setting.rules !== undefined) setting.rules = setting.rules.map((r) => ({ ...ordered(r, RULE_KEYS), when: ordered(r.when, WHEN_KEYS) }));
      return setting;
    });
  }
  if (out.power !== undefined) out.power = ordered(out.power, POWER_KEYS);
  if (out.pairs !== undefined) out.pairs = out.pairs.map((p) => ordered(p, PAIR_KEYS));
  if (out.hazards !== undefined) out.hazards = out.hazards.map((h) => ordered(h, HAZARD_KEYS));
  out.builds = out.builds.map((b) => {
    const build = ordered(b, BUILD_KEYS);
    if (build.hazards !== undefined) build.hazards = build.hazards.map((h) => ordered(h, HAZARD_KEYS));
    if (build.capability !== undefined) {
      const capability = ordered(build.capability, CAPABILITY_KEYS);
      capability.paths = capability.paths.map((p) => {
        const path = ordered(p, PATH_KEYS);
        path.in = ordered(path.in, SPEC_KEYS);
        if (path.out !== undefined) path.out = ordered(path.out, SPEC_KEYS);
        return path;
      });
      build.capability = capability;
    }
    return build;
  });
  return out;
}
