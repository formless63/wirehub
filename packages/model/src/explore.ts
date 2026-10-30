/**
 * Solution exploration (`docs/explore.md`): given a requirement, enumerate useful combinations of
 * what the library already has and say of each whether it is **valid**, **invalid** (with the
 * reasons) or **unknown** (with the facts nobody has stated yet).
 *
 * Two requirement kinds:
 *
 * - `connect` — a device port to a device port, optionally carrying named signals. The dimensions
 *   are the resolver's options (`resolve.ts`, refused ones included), the stocks that fit each
 *   (`suggestStocks`), the plugs that mate each end (`plugsInto`) and, for an option through an
 *   adapter board, the firmware projects written for that board.
 * - `enclose` — a board in a generated enclosure with named ports reachable. The dimensions are
 *   enclosure parameter presets, the printers the hub's print profiles name (does the base fit
 *   the bed and the height, are the walls two perimeters thick) and the board's firmware projects
 *   (or the supported targets, when the requirement asks for firmware and none exists yet).
 *
 * Manual decisions are overrides (`exclude`, `prefer`, `include`, `assume`) addressed to a stable
 * target (`stock:<id>`, `fact:<key>` …); they are applied on every re-exploration, and one whose
 * target no longer appears is reported as stale rather than dropped.
 *
 * Inventory availability is an optional input (free quantity per item, in base units); without it
 * a bill line's availability is simply not stated.
 *
 * Pure and deterministic: library, requirement, context and overrides in; an exploration out.
 */

import { deriveCable, plugsInto, stockNeeds, suggestStocks } from './derive-cable.ts';
import { devicePort, resolveDevice, type ResolverLibrary } from './devices.ts';
import { diffBodies, type CableOverride } from './body.ts';
import { ENCLOSURE_DEFAULTS, type EnclosureBoard, type EnclosureFact, type EnclosureParams, type EnclosureSpec } from './enclosure.ts';
import type { CableDesign, Db, MechanicalDefinition } from './model.ts';
import { resolve, type CableOption, type End } from './resolve.ts';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface ConnectRequirement {
  kind: 'connect';
  source: { device: string; port?: string };
  destination: { device: string; port?: string };
  /** signals (vocabulary ids) the connection must carry */
  signals?: string[];
  lengthMm?: number;
  /** consider adapter boards (default true) */
  boards?: boolean;
}

export interface EncloseRequirement {
  kind: 'enclose';
  /** the pcbas record */
  board: string;
  /** board ports (EnclosurePort id or footprint ref) that must get an opening */
  ports?: string[];
  /** the board needs firmware: list the supported targets when no project exists yet */
  firmware?: boolean;
}

export type Requirement = ConnectRequirement | EncloseRequirement;

/** A firmware project as exploration sees it (the firmware feature's record, reduced). */
export interface FirmwareCandidate {
  id: string;
  label: string;
  board?: string;
  target: string;
  /** the latest build's status, when known */
  lastBuild?: 'queued' | 'running' | 'ok' | 'failed' | 'error' | 'cancelled';
}

export interface FirmwareTargetRef {
  id: string;
  label: string;
}

/** A named set of enclosure design parameters, with optional limits on the result. */
export interface EnclosurePreset {
  id: string;
  label: string;
  params: EnclosureParams;
  /** outside limits (a box it must fit, a printer bed): exceeding one makes the combination invalid */
  maxOuterMm?: { x?: number; y?: number; z?: number };
  src: string;
}

/** A printer an enclosure may be printed on (a print profile of kind printer, reduced). */
export interface PrinterCandidate {
  id: string;
  label: string;
  /** the build plate (FDM bed or resin display), mm */
  bedMm: [number, number];
  maxHeightMm?: number;
  /** FDM nozzle: a wall under two of its widths prints as one thin perimeter pair or gaps */
  nozzleMm?: number;
}

/** Free quantity per item (`<kind>:<id>`), in base units (ea, mm). */
export type Availability = Readonly<Record<string, number>>;

export interface ExploreContext {
  firmware?: readonly FirmwareCandidate[];
  targets?: readonly FirmwareTargetRef[];
  /** hub presets, merged by id over `BUILT_IN_PRESETS` */
  presets?: readonly EnclosurePreset[];
  /** printers to check an enclosure against (absent or empty: not a dimension) */
  printers?: readonly PrinterCandidate[];
  /** absent: inventory not consulted */
  availability?: Availability;
  /** cap on combinations returned (default 48) */
  limit?: number;
  /**
   * What each board's own source states (thickness, part heights, edge ports — `basis: 'native'`),
   * by pcba id: used where no enclosure record states the fact.
   */
  native?: Readonly<Record<string, NativeBoardFacts>>;
}

/** Board facts read from a board's own source (its KiCad board file and 3D export). */
export type NativeBoardFacts = Pick<EnclosureBoard, 'thicknessMm' | 'heightAboveMm' | 'heightBelowMm' | 'ports'>;

export type OverrideKind = 'exclude' | 'prefer' | 'include' | 'assume';

/**
 * A manual decision. `target`: `option:<id>`, `stock:<id>`, `plug:source:<id>`,
 * `plug:destination:<id>`, `firmware:<id>`, `target:<id>`, `preset:<id>`, `combo:<id>` or
 * `fact:<key>` (assume only). `include` adds a stock the resolver did not suggest.
 */
export interface ExploreOverride {
  kind: OverrideKind;
  target: string;
  reason?: string;
  by?: string;
  at?: string;
}

export type Verdict = 'valid' | 'invalid' | 'unknown';

export type ChoiceDim = 'option' | 'stock' | 'plug:source' | 'plug:destination' | 'firmware' | 'target' | 'preset' | 'printer';

export interface ComboChoice {
  dim: ChoiceDim;
  id: string;
  label: string;
}

export interface BomLine {
  kind: 'connectors' | 'wires' | 'components' | 'pcbas' | 'mechanicals';
  id: string;
  label: string;
  qty: number;
  unit: 'ea' | 'mm';
  /** free in inventory (base units); absent = not consulted */
  free?: number;
}

export interface UnknownFact {
  /** stable: the `fact:<key>` an `assume` override names */
  key: string;
  text: string;
}

export interface Combo {
  /** stable within a library: the choices, `dim=id` joined by `|` */
  id: string;
  verdict: Verdict;
  choices: ComboChoice[];
  /** why it is invalid */
  reasons: string[];
  /** facts nobody stated (an unknown verdict) */
  unknowns: UnknownFact[];
  /** unknown facts an override accepts, with its reason */
  assumed: (UnknownFact & { reason?: string })[];
  /** worth knowing, not wrong */
  warnings: string[];
  notes: string[];
  bom: BomLine[];
  /** shortage lines (free < qty) when inventory was consulted */
  short: number;
  /** a summary of the physical result: conductors, length, outside size … */
  facts: Record<string, string | number>;
  preferred: boolean;
  excluded?: { reason?: string };
  /** 1 = first */
  rank: number;
  /** for `connect`: what `pickConnect` needs */
  pick?: { option: string; stock?: string; plugs: Partial<Record<End, string>>; firmware?: string };
  /** for `enclose`: the preset and the effective parameters */
  enclosure?: { preset: string; params: EnclosureParams; firmware?: string; target?: string; printer?: string };
  /** board proposals may help: the option has missing pieces */
  gaps: boolean;
  /** how well a `connect` combination fits, lower is better: requested signals not carried, stock fit, boards, stock misfits (screen, pairs, coax centres), conductors dropped or spare, parts (ranking only) */
  fit?: number[];
}

export interface Exploration {
  requirement: Requirement;
  key: string;
  combos: Combo[];
  /** combinations past the limit */
  more: number;
  problems: string[];
  stale: ExploreOverride[];
  counts: Record<Verdict | 'excluded', number>;
}

/* ------------------------------------------------------------------ *
 * Built-in presets (generic design choices, not facts about any product)
 * ------------------------------------------------------------------ */

export const BUILT_IN_PRESETS: readonly EnclosurePreset[] = [
  { id: 'compact', label: 'Compact', params: { wallMm: 1.6, floorMm: 1.6, lidMm: 1.6, clearanceMm: 0.5, topClearanceMm: 1, standoffMm: 3, ventsLid: false }, src: 'synthetic example: tight print-friendly defaults' },
  { id: 'standard', label: 'Standard', params: {}, src: 'the enclosure generator defaults' },
  { id: 'rugged', label: 'Rugged', params: { wallMm: 3, floorMm: 3, lidMm: 3, clearanceMm: 1.5, topClearanceMm: 3, standoffMm: 6, cornerRadiusMm: 4, lidScrews: true, ventsLid: false }, src: 'synthetic example: thick walls, no vents' },
  { id: 'split-vented', label: 'Split, vented', params: { lid: 'split', ventsLid: true, ventsSides: true, topClearanceMm: 4 }, src: 'synthetic example: split shell for tall parts, vented' },
];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const endKey = (e: { device: string; port?: string }): string => `${e.device}${e.port === undefined ? '' : `.${e.port}`}`;

/** The identity overrides and a saved exploration are kept under (length does not change it). */
export function requirementKey(r: Requirement): string {
  if (r.kind === 'connect') {
    const s = [...(r.signals ?? [])].sort().join(',');
    return `connect:${endKey(r.source)}>${endKey(r.destination)}${s === '' ? '' : `[${s}]`}${r.boards === false ? ':noboards' : ''}`;
  }
  const p = [...(r.ports ?? [])].sort().join(',');
  return `enclose:${r.board}${p === '' ? '' : `[${p}]`}${r.firmware === true ? ':fw' : ''}`;
}

export function requirementProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['The requirement is not an object.'];
  const r = value as Record<string, unknown>;
  const isEnd = (e: unknown): boolean => typeof e === 'object' && e !== null && typeof (e as { device?: unknown }).device === 'string' && (e as { device: string }).device !== '';
  const strings = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if (r['kind'] === 'connect') {
    const out: string[] = [];
    if (!isEnd(r['source']) || !isEnd(r['destination'])) out.push('A connect requirement names a source and a destination device.');
    if (!strings(r['signals'])) out.push('signals is a list of signal ids.');
    if (r['lengthMm'] !== undefined && !(typeof r['lengthMm'] === 'number' && r['lengthMm'] > 0)) out.push('lengthMm is a positive number.');
    return out;
  }
  if (r['kind'] === 'enclose') {
    const out: string[] = [];
    if (typeof r['board'] !== 'string' || r['board'] === '') out.push('An enclose requirement names a board.');
    if (!strings(r['ports'])) out.push('ports is a list of port ids.');
    return out;
  }
  return ['kind is connect or enclose.'];
}

export function overrideProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return ['overrides is a list.'];
  const out: string[] = [];
  for (const o of value) {
    const r = o as Partial<ExploreOverride>;
    if (!['exclude', 'prefer', 'include', 'assume'].includes(String(r?.kind))) out.push('Each override is exclude, prefer, include or assume.');
    else if (typeof r.target !== 'string' || !/^[a-z]+:/.test(r.target)) out.push(`${r.kind}: target names what it is about (stock:<id>, fact:<key> …).`);
    else if (r.kind === 'assume' && !r.target.startsWith('fact:')) out.push('assume takes a fact:<key> target.');
    else if (r.kind === 'include' && !r.target.startsWith('stock:')) out.push('include takes a stock:<id> target.');
  }
  return out;
}

export function presetsInForce(local: readonly EnclosurePreset[] | undefined): EnclosurePreset[] {
  const byId = new Map<string, EnclosurePreset>(BUILT_IN_PRESETS.map((p) => [p.id, p]));
  for (const p of local ?? []) byId.set(p.id, p);
  return [...byId.values()];
}

/** Applies overrides; returns the targets each one touched so stale ones can be reported. */
class Decisions {
  readonly used = new Set<ExploreOverride>();
  readonly list: readonly ExploreOverride[];
  constructor(list: readonly ExploreOverride[]) {
    this.list = list;
  }
  find(kind: OverrideKind, targets: readonly string[]): ExploreOverride | undefined {
    const o = this.list.find((x) => x.kind === kind && targets.includes(x.target));
    if (o !== undefined) this.used.add(o);
    return o;
  }
  excluded(targets: readonly string[]): ExploreOverride | undefined {
    return this.find('exclude', targets);
  }
  preferred(targets: readonly string[]): boolean {
    return this.find('prefer', targets) !== undefined;
  }
  assumed(key: string): ExploreOverride | undefined {
    return this.find('assume', [`fact:${key}`]);
  }
  /** mark targets as seen (an override on a seen target is not stale even when it changed nothing) */
  seen(targets: readonly string[]): void {
    for (const o of this.list) if (targets.includes(o.target)) this.used.add(o);
  }
  includes(prefix: string): string[] {
    return this.list.filter((o) => o.kind === 'include' && o.target.startsWith(prefix)).map((o) => o.target.slice(prefix.length));
  }
  stale(): ExploreOverride[] {
    return this.list.filter((o) => !this.used.has(o));
  }
}

const targetsOf = (choices: readonly ComboChoice[], comboId: string): string[] => [
  `combo:${comboId}`,
  ...choices.map((c) => `${c.dim}:${c.id}`),
];

const comboIdOf = (choices: readonly ComboChoice[]): string => choices.map((c) => `${c.dim}=${c.id}`).join('|');

function withAvailability(lines: BomLine[], availability: Availability | undefined): { lines: BomLine[]; short: number } {
  if (availability === undefined) return { lines, short: 0 };
  let short = 0;
  const out = lines.map((l) => {
    const free = availability[`${l.kind}:${l.id}`] ?? 0;
    if (free < l.qty) short += 1;
    return { ...l, free };
  });
  return { lines: out, short };
}

function compareFit(a: readonly number[] | undefined, b: readonly number[] | undefined): number {
  if (a === undefined || b === undefined) return 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** Rank: valid, unknown, invalid; preferred first; excluded last; then the order of enumeration. */
function rankCombos(combos: Combo[]): void {
  const v: Record<Verdict, number> = { valid: 0, unknown: 1, invalid: 2 };
  const order = new Map(combos.map((c, i) => [c, i]));
  combos.sort((a, b) =>
    Number(a.excluded !== undefined) - Number(b.excluded !== undefined)
    || v[a.verdict] - v[b.verdict]
    || Number(b.preferred) - Number(a.preferred)
    || a.short - b.short
    || compareFit(a.fit, b.fit)
    || order.get(a)! - order.get(b)!);
  combos.forEach((c, i) => { c.rank = i + 1; });
}

function finish(requirement: Requirement, combos: Combo[], problems: string[], decisions: Decisions, limit: number): Exploration {
  rankCombos(combos);
  const kept = combos.slice(0, limit);
  const counts = { valid: 0, invalid: 0, unknown: 0, excluded: 0 };
  for (const c of kept) {
    if (c.excluded !== undefined) counts.excluded += 1;
    else counts[c.verdict] += 1;
  }
  return { requirement, key: requirementKey(requirement), combos: kept, more: combos.length - kept.length, problems, stale: decisions.stale(), counts };
}

/** Unknown facts → the verdict, with `assume` overrides moving facts to `assumed`. */
function settle(combo: Omit<Combo, 'verdict' | 'assumed' | 'unknowns' | 'rank'> & { pending: UnknownFact[] }, decisions: Decisions): Combo {
  const unknowns: UnknownFact[] = [];
  const assumed: Combo['assumed'] = [];
  for (const f of combo.pending) {
    const a = decisions.assumed(f.key);
    if (a === undefined) unknowns.push(f);
    else assumed.push({ ...f, ...(a.reason === undefined ? {} : { reason: a.reason }) });
  }
  const { pending: _pending, ...rest } = combo;
  const verdict: Verdict = rest.reasons.length > 0 ? 'invalid' : unknowns.length > 0 ? 'unknown' : 'valid';
  return { ...rest, verdict, unknowns, assumed, rank: 0 };
}

/* ------------------------------------------------------------------ *
 * connect
 * ------------------------------------------------------------------ */

function bomOfDesign(lib: ResolverLibrary, design: CableDesign, lengthMm: number | undefined): BomLine[] {
  const lines = new Map<string, BomLine>();
  const add = (kind: BomLine['kind'], id: string, label: string, qty: number, unit: BomLine['unit']): void => {
    const k = `${kind}:${id}`;
    const l = lines.get(k);
    if (l === undefined) lines.set(k, { kind, id, label, qty, unit });
    else l.qty += qty;
  };
  for (const c of design.instances.connectors) add('connectors', c.def, lib.connectors.find((d) => d.id === c.def)?.label ?? c.def, 1, 'ea');
  for (const c of design.instances.components) add('components', c.def, lib.components.find((d) => d.id === c.def)?.label ?? c.def, 1, 'ea');
  for (const p of design.instances.pcbas) add('pcbas', p.def, lib.pcbas.find((d) => d.id === p.def)?.label ?? p.def, 1, 'ea');
  for (const s of design.instances.segments) {
    const len = (s as { lengthMm?: number }).lengthMm ?? lengthMm;
    if (len !== undefined) add('wires', s.def, lib.wires.find((d) => d.id === s.def)?.label ?? s.def, len, 'mm');
  }
  return [...lines.values()];
}

function plugCandidates(lib: ResolverLibrary, device: string, port: string | undefined, role: 'source' | 'sink'): { id: string; label: string }[] {
  const dev = resolveDevice(lib.devices, device);
  const p = dev === undefined ? undefined : devicePort(dev, port, role);
  if (p === undefined) return [];
  return lib.connectors.filter((c) => plugsInto(lib, c, p)).map((c) => ({ id: c.id, label: c.label }));
}

/** The signals an option carries: its lines' and the signals on the positions its return and screen land on. */
function carried(option: CableOption, pins: { source: { position: string; signal?: string }[]; destination: { position: string; signal?: string }[] }): Set<string> {
  const out = new Set<string>();
  for (const l of option.links) {
    if (l.signal !== undefined) out.add(l.signal);
    if (l.toSignal !== undefined) out.add(l.toSignal);
  }
  for (const end of ['source', 'destination'] as const) {
    for (const pos of [...option.grounds[end], ...option.chassis[end]]) {
      const s = pins[end].find((p) => p.position === pos)?.signal;
      if (s !== undefined) out.add(s);
    }
  }
  return out;
}

const factKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

function exploreConnect(lib: Db, r: ConnectRequirement, ctx: ExploreContext, decisions: Decisions): Exploration {
  const limit = ctx.limit ?? 48;
  const query = { source: r.source, destination: r.destination, ...(r.boards === false ? { boards: false } : {}) };
  const resolution = resolve(lib, query);
  const problems = resolution.problems.map((p) => p.message);
  if (resolution.source === undefined || resolution.destination === undefined) return finish(r, [], problems, decisions, limit);
  const pins = { source: resolution.source.pins, destination: resolution.destination.pins };
  const declared = new Set([...pins.source, ...pins.destination].map((p) => p.signal).filter((s): s is string => s !== undefined));
  const plugs = {
    source: plugCandidates(lib, r.source.device, resolution.source.port, 'source'),
    destination: plugCandidates(lib, r.destination.device, resolution.destination.port, 'sink'),
  };
  const combos: Combo[] = [];
  const all: { option: CableOption; refused?: string[] }[] = [
    ...resolution.options.map((option) => ({ option })),
    ...resolution.rejected.map((x) => ({ option: x.option, refused: x.why.map((w) => w.message) })),
  ];
  const included = decisions.includes('stock:');
  // a cable alone connects these ports: an option through boards then adds parts it does not need
  const directWorks = resolution.options.some((o) => o.boards.length === 0 && o.missing.length === 0);

  for (const { option, refused } of all) {
    const optionChoice: ComboChoice = { dim: 'option', id: option.id, label: option.label };
    // the signals asked for
    const has = carried(option, pins);
    const reasonsBase: string[] = [...(refused ?? []).map((m) => `refused: ${m}`)];
    const pendingBase: UnknownFact[] = [];
    for (const s of r.signals ?? []) {
      if (has.has(s)) continue;
      if (declared.has(s)) reasonsBase.push(`does not carry ${s}`);
      else pendingBase.push({ key: `signal-${factKey(s)}`, text: `neither port declares ${s}` });
    }
    for (const m of option.missing) reasonsBase.push(`missing: ${m.message}`);
    for (const u of option.unverified) pendingBase.push({ key: `unverified-${factKey(u)}`, text: `unconfirmed: ${u}` });
    const warnings = option.hazards.map((h) => h.message);
    const signalGaps = (r.signals ?? []).filter((s) => !has.has(s)).length;

    // stocks: the fitting ones (top three), plus any a person included
    // ranked for a connection: the fewest misfits (no screen, no twisted pair, a logic line on a coax centre), then the
    // closest conductor count (a dropped optional line and a spare conductor weigh the same), fewer dropped lines on a tie
    const fitting = refused === undefined ? [...suggestStocks(lib, option)].sort((a, b) => a.misfit - b.misfit || (a.dropped + a.spare) - (b.dropped + b.spare) || a.dropped - b.dropped) : [];
    const stockIds = [...fitting.slice(0, 3).map((s) => s.id), ...included.filter((id) => !fitting.slice(0, 3).some((s) => s.id === id))];
    decisions.seen(fitting.map((s) => `stock:${s.id}`));
    const stocks: { id: string; label: string; fit: boolean; spare: number; dropped: number; misfit: number; reasons: string[] }[] = stockIds.map((id) => {
      const f = fitting.find((s) => s.id === id);
      const w = lib.wires.find((x) => x.id === id);
      return { id, label: w?.label ?? id, fit: f !== undefined, spare: f?.spare ?? 99, dropped: f?.dropped ?? 0, misfit: f?.misfit ?? 0, reasons: f?.reasons ?? [] };
    });
    if (stocks.length === 0) stocks.push({ id: '', label: 'no stock', fit: false, spare: 99, dropped: 0, misfit: 0, reasons: [] });

    // plugs at each end without a board
    const plugSets: Record<End, ({ id: string; label: string } | undefined)[]> = { source: [undefined], destination: [undefined] };
    for (const end of ['source', 'destination'] as const) {
      if (option.boards.some((b) => b.end === end)) continue;
      plugSets[end] = plugs[end].length === 0 ? [undefined] : plugs[end].slice(0, 3);
    }

    // firmware for the boards the option uses
    const boardIds = option.boards.map((b) => b.pcba);
    const fw = (ctx.firmware ?? []).filter((f) => f.board !== undefined && boardIds.includes(f.board));
    const fwSet: (FirmwareCandidate | undefined)[] = fw.length === 0 ? [undefined] : fw;

    for (const stock of stocks) {
      // one derivation per option × stock; plugs are swapped on it
      const derived = refused === undefined && stock.id !== ''
        ? deriveCable(lib, query, option.id, { stock: stock.id, ...(r.lengthMm === undefined ? {} : { lengthMm: r.lengthMm }) })
        : undefined;
      for (const ps of plugSets.source) for (const pd of plugSets.destination) for (const f of fwSet) {
        const choices: ComboChoice[] = [optionChoice];
        if (stock.id !== '') choices.push({ dim: 'stock', id: stock.id, label: stock.label });
        if (ps !== undefined) choices.push({ dim: 'plug:source', id: ps.id, label: ps.label });
        if (pd !== undefined) choices.push({ dim: 'plug:destination', id: pd.id, label: pd.label });
        if (f !== undefined) choices.push({ dim: 'firmware', id: f.id, label: f.label });
        const id = comboIdOf(choices);
        const reasons = [...reasonsBase];
        const pending = [...pendingBase];
        const notes: string[] = [];
        if (stock.id === '' && refused === undefined) {
          const n = stockNeeds(lib, option);
          reasons.push(`no library stock fits (${n.lines} line${n.lines === 1 ? '' : 's'}${n.ground ? ' and a return' : ''}${n.screen ? ', a screen' : ''}${n.pairs > 0 ? `, ${n.pairs} twisted pair${n.pairs === 1 ? '' : 's'}` : ''})`);
        } else if (stock.id !== '' && !stock.fit && refused === undefined) {
          reasons.push(`${stock.label} does not fit this option`);
        }
        notes.push(...stock.reasons);
        if (directWorks && option.boards.length > 0 && refused === undefined) notes.push('A cable alone also connects these ports: boards only earn their place for a reason the cable cannot meet (a longer run, isolation).');
        for (const end of ['source', 'destination'] as const) {
          if (!option.boards.some((b) => b.end === end) && plugs[end].length === 0) reasons.push(`no plug in the library mates the ${end} port`);
        }
        const fwWarn = f?.lastBuild !== undefined && f.lastBuild !== 'ok' ? [`firmware ${f.id}: last build ${f.lastBuild}`] : [];
        if (f !== undefined && f.lastBuild === undefined) pending.push({ key: `firmware-build-${f.id}`, text: `firmware ${f.id} has not been compiled` });
        let bom: BomLine[] = [];
        const facts: Record<string, string | number> = { conductors: option.conductors, parts: option.parts, kind: option.kind };
        if (r.lengthMm !== undefined) facts['lengthMm'] = r.lengthMm;
        else pending.push({ key: 'length', text: 'cable length not set (stock need unknown)' });
        let pick: Combo['pick'];
        if (derived !== undefined) {
          if (derived.ok) {
            const design = swapPlugs(derived.design, option, { source: ps?.id, destination: pd?.id });
            bom = bomOfDesign(lib, design, r.lengthMm);
            pick = { option: option.id, stock: stock.id, plugs: { ...(ps === undefined ? {} : { source: ps.id }), ...(pd === undefined ? {} : { destination: pd.id }) }, ...(f === undefined ? {} : { firmware: f.id }) };
            for (const m of derived.missing) if (!reasons.includes(`missing: ${m.message}`)) reasons.push(`missing: ${m.message}`);
          } else reasons.push(derived.reason);
        }
        const avail = withAvailability(bom, ctx.availability);
        const targets = targetsOf(choices, id);
        const ex = decisions.excluded(targets);
        combos.push(settle({
          id, choices, reasons: [...new Set(reasons)], pending, warnings: [...warnings, ...fwWarn], notes, bom: avail.lines, short: avail.short, facts,
          preferred: decisions.preferred(targets), ...(ex === undefined ? {} : { excluded: { ...(ex.reason === undefined ? {} : { reason: ex.reason }) } }),
          ...(pick === undefined ? {} : { pick }), gaps: option.missing.length > 0,
          // a direct cable before one through boards (a link is not sent through two converters when a cable alone does), then the stock's fit
          fit: [signalGaps, stock.fit ? 0 : 1, option.boards.length, stock.misfit, stock.dropped + stock.spare, stock.dropped, option.parts],
        }, decisions));
        decisions.seen(targets);
      }
    }
  }
  return finish(r, combos, problems, decisions, limit);
}

/** The derived design with other plugs at its ends (`j1` source, `j2` destination), recorded as recipe overrides. */
export function swapPlugs(design: CableDesign, option: CableOption, plugs: Partial<Record<End, string | undefined>>): CableDesign {
  const ids: Record<End, string> = { source: 'j1', destination: 'j2' };
  let changed = false;
  const connectors = design.instances.connectors.map((c) => {
    for (const end of ['source', 'destination'] as const) {
      const want = plugs[end];
      if (want === undefined || option.boards.some((b) => b.end === end) || c.id !== ids[end] || c.def === want) continue;
      changed = true;
      return { ...c, def: want };
    }
    return c;
  });
  if (!changed) return design;
  const next: CableDesign = { ...design, instances: { ...design.instances, connectors } };
  if (design.recipe === undefined) return next;
  const extra = diffBodies({ instances: design.instances, joints: design.joints }, { instances: next.instances, joints: next.joints })
    .map((o) => ({ ...o, reason: 'chosen when exploring alternatives' }) as CableOverride);
  return { ...next, recipe: { ...design.recipe, overrides: [...(design.recipe.overrides ?? []), ...extra] } };
}

/** The design a picked `connect` combination becomes (status development, its recipe on it). */
export function pickConnect(lib: Db, r: ConnectRequirement, combo: Combo, opts: { id?: string; label?: string } = {}): { ok: true; design: CableDesign } | { ok: false; reason: string } {
  if (combo.pick === undefined) return { ok: false, reason: 'that combination cannot be derived' };
  const query = { source: r.source, destination: r.destination, ...(r.boards === false ? { boards: false } : {}) };
  const derived = deriveCable(lib, query, combo.pick.option, {
    ...(combo.pick.stock === undefined ? {} : { stock: combo.pick.stock }),
    ...(r.lengthMm === undefined ? {} : { lengthMm: r.lengthMm }),
    ...(opts.id === undefined ? {} : { id: opts.id }),
    ...(opts.label === undefined ? {} : { label: opts.label }),
  });
  if (!derived.ok) return { ok: false, reason: derived.reason };
  const design = swapPlugs(derived.design, derived.option, combo.pick.plugs);
  return { ok: true, design };
}

/* ------------------------------------------------------------------ *
 * enclose
 * ------------------------------------------------------------------ */

const known = (f: EnclosureFact | undefined): number | undefined => (f === undefined || f.value === null || f.basis === 'unknown' ? undefined : f.value);

/** The board's enclosure facts: from the first enclosure that already holds it, else none stated. */
export function boardFacts(lib: Pick<Db, 'mechanicals'>, pcba: string, native?: NativeBoardFacts): { board: EnclosureBoard; from?: string; fromSource?: true } {
  let found: { board: EnclosureBoard; from?: string } = { board: { pcba, geometry: native === undefined ? 'declared' : 'native' } };
  for (const m of lib.mechanicals ?? []) {
    const b = m.enclosure?.boards.find((x) => x.pcba === pcba);
    if (b !== undefined) {
      found = { board: b, from: m.id };
      break;
    }
  }
  if (native === undefined) return found;
  // a fact the enclosure record leaves unknown is taken from the board's own source
  const open = (f: EnclosureFact | undefined): boolean => f === undefined || f.value === null || f.basis === 'unknown';
  const board: EnclosureBoard = { ...found.board };
  let used = false;
  for (const key of ['thicknessMm', 'heightAboveMm', 'heightBelowMm'] as const) {
    if (open(board[key]) && native[key] !== undefined) {
      board[key] = native[key];
      used = true;
    }
  }
  if (board.ports === undefined && native.ports !== undefined && native.ports.length > 0) {
    board.ports = native.ports;
    used = true;
  }
  return { ...found, board, ...(used ? { fromSource: true as const } : {}) };
}

function exploreEnclose(lib: Db, r: EncloseRequirement, ctx: ExploreContext, decisions: Decisions): Exploration {
  const limit = ctx.limit ?? 48;
  const pcba = lib.pcbas.find((p) => p.id === r.board);
  if (pcba === undefined) return finish(r, [], [`there is no board '${r.board}'`], decisions, limit);
  const { board, from, fromSource } = boardFacts(lib, r.board, ctx.native?.[r.board]);
  const presets = presetsInForce(ctx.presets);
  const fw = (ctx.firmware ?? []).filter((f) => f.board === r.board);
  type Fw = { kind: 'project'; f: FirmwareCandidate } | { kind: 'target'; t: FirmwareTargetRef } | undefined;
  const fwSet: Fw[] = fw.length > 0 ? fw.map((f) => ({ kind: 'project', f }) as Fw)
    : r.firmware === true && (ctx.targets ?? []).length > 0 ? (ctx.targets ?? []).map((t) => ({ kind: 'target', t }) as Fw) : [undefined];

  const printers: (PrinterCandidate | undefined)[] = (ctx.printers ?? []).length === 0 ? [undefined] : [...ctx.printers!];

  const combos: Combo[] = [];
  for (const preset of presets) {
    const p = { ...ENCLOSURE_DEFAULTS, ...preset.params };
    for (const f of fwSet) for (const printer of printers) {
      const choices: ComboChoice[] = [{ dim: 'preset', id: preset.id, label: preset.label }];
      if (printer !== undefined) choices.push({ dim: 'printer', id: printer.id, label: printer.label });
      if (f?.kind === 'project') choices.push({ dim: 'firmware', id: f.f.id, label: f.f.label });
      if (f?.kind === 'target') choices.push({ dim: 'target', id: f.t.id, label: f.t.label });
      const id = comboIdOf(choices);
      const reasons: string[] = [];
      const pending: UnknownFact[] = [];
      const warnings: string[] = [];
      const notes: string[] = [from === undefined ? (fromSource ? 'board facts from its KiCad source' : 'no enclosure holds this board yet: facts below are not stated') : `board facts from ${from}${fromSource ? ', the rest from its KiCad source' : ''}`];
      const facts: Record<string, string | number> = { wallMm: p.wallMm, standoffMm: p.standoffMm, lid: p.lid };

      // footprint
      let ix: number | undefined;
      let iy: number | undefined;
      if (board.geometry === 'native') notes.push('outline and holes read from the board source at generation');
      else {
        const w = known(board.widthMm);
        const l = known(board.lengthMm);
        if (w === undefined) pending.push({ key: `${r.board}-width`, text: `${pcba.label}: board width` });
        if (l === undefined) pending.push({ key: `${r.board}-length`, text: `${pcba.label}: board length` });
        if (w !== undefined && l !== undefined) {
          ix = w + 2 * p.clearanceMm;
          iy = l + 2 * p.clearanceMm;
        }
      }
      // height
      const thick = known(board.thicknessMm) ?? 1.6;
      if (known(board.thicknessMm) === undefined) notes.push('board thickness taken as 1.6 mm');
      const above = known(board.heightAboveMm);
      if (above === undefined) pending.push({ key: `${r.board}-height-above`, text: `${pcba.label}: tallest part above the board (assumed ${p.assumedPartHeightMm} mm)` });
      const below = known(board.heightBelowMm) ?? 0;
      const standoff = Math.max(p.standoffMm, below);
      const interior = preset.params.interiorHeightMm ?? standoff + thick + (above ?? p.assumedPartHeightMm) + p.topClearanceMm;
      const oz = p.floorMm + interior + p.lidMm;
      facts['interiorHeightMm'] = round(interior);
      facts['outerHeightMm'] = round(oz);
      if (ix !== undefined && iy !== undefined) {
        facts['outerMm'] = `${round(ix + 2 * p.wallMm)} × ${round(iy + 2 * p.wallMm)} × ${round(oz)}`;
        const max = preset.maxOuterMm;
        if (max?.x !== undefined && ix + 2 * p.wallMm > max.x) reasons.push(`outside width ${round(ix + 2 * p.wallMm)} mm exceeds ${max.x} mm`);
        if (max?.y !== undefined && iy + 2 * p.wallMm > max.y) reasons.push(`outside depth ${round(iy + 2 * p.wallMm)} mm exceeds ${max.y} mm`);
      }
      if (preset.maxOuterMm?.z !== undefined && oz > preset.maxOuterMm.z) reasons.push(`outside height ${round(oz)} mm exceeds ${preset.maxOuterMm.z} mm`);

      // the printer: the base and the lid each lie on the plate (turned 90° if that fits), the base open side up
      if (printer !== undefined) {
        const [bx, by] = printer.bedMm;
        if (ix !== undefined && iy !== undefined) {
          const ox = ix + 2 * p.wallMm;
          const oy = iy + 2 * p.wallMm;
          if (!((ox <= bx && oy <= by) || (ox <= by && oy <= bx))) reasons.push(`${round(ox)} × ${round(oy)} mm does not fit the ${round(bx)} × ${round(by)} mm plate`);
        }
        const baseZ = p.lid === 'split' && preset.params.splitHeightMm !== undefined ? Math.max(p.floorMm + preset.params.splitHeightMm, oz - p.floorMm - preset.params.splitHeightMm) : oz - p.lidMm;
        if (printer.maxHeightMm !== undefined && baseZ > printer.maxHeightMm) reasons.push(`base height ${round(baseZ)} mm exceeds the ${round(printer.maxHeightMm)} mm build height`);
        if (printer.nozzleMm !== undefined && p.wallMm < 2 * printer.nozzleMm) warnings.push(`wall ${p.wallMm} mm is under two ${printer.nozzleMm} mm perimeters`);
      }

      // the ports asked for
      for (const want of r.ports ?? []) {
        const port = (board.ports ?? []).find((x) => x.id === want || x.ref === want);
        if (port === undefined) {
          pending.push({ key: `${r.board}-port-${factKey(want)}`, text: `${pcba.label}: where port ${want} sits (edge, position, size)` });
          continue;
        }
        if (port.basis === 'unknown') pending.push({ key: `${r.board}-port-${factKey(want)}`, text: `${pcba.label}: port ${want} position unconfirmed` });
        const top = standoff + thick + port.zMm + port.heightMm / 2;
        if (top > interior) reasons.push(`port ${want} opening (top ${round(top)} mm) runs into the lid (interior ${round(interior)} mm)`);
        const reach = (port.protrudeMm ?? 0) - p.clearanceMm - p.wallMm;
        if (reach < -3) warnings.push(`port ${want} sits ${round(-reach)} mm behind the outside face`);
        if (p.lid === 'split' && preset.params.splitHeightMm !== undefined) {
          const split = p.floorMm + preset.params.splitHeightMm;
          const bottom = standoff + thick + port.zMm - port.heightMm / 2 + p.floorMm;
          if (bottom < split && top + p.floorMm > split) warnings.push(`port ${want} opening crosses the split line`);
        }
      }
      if (f?.kind === 'target') pending.push({ key: `${r.board}-firmware-${f.t.id}`, text: `no firmware project for ${pcba.label} on ${f.t.label} yet` });
      if (f?.kind === 'project' && f.f.lastBuild === undefined) pending.push({ key: `firmware-build-${f.f.id}`, text: `firmware ${f.f.id} has not been compiled` });
      if (f?.kind === 'project' && f.f.lastBuild !== undefined && f.f.lastBuild !== 'ok') warnings.push(`firmware ${f.f.id}: last build ${f.f.lastBuild}`);

      const bom = withAvailability([{ kind: 'pcbas', id: pcba.id, label: pcba.label, qty: 1, unit: 'ea' }], ctx.availability);
      const targets = targetsOf(choices, id);
      const ex = decisions.excluded(targets);
      combos.push(settle({
        id, choices, reasons, pending, warnings, notes, bom: bom.lines, short: bom.short, facts,
        preferred: decisions.preferred(targets), ...(ex === undefined ? {} : { excluded: { ...(ex.reason === undefined ? {} : { reason: ex.reason }) } }),
        enclosure: { preset: preset.id, params: { ...preset.params }, ...(f?.kind === 'project' ? { firmware: f.f.id } : {}), ...(f?.kind === 'target' ? { target: f.t.id } : {}), ...(printer === undefined ? {} : { printer: printer.id }) },
        gaps: false,
      }, decisions));
      decisions.seen(targets);
    }
  }
  return finish(r, combos, [], decisions, limit);
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** The draft enclosure record a picked `enclose` combination becomes (a shell mechanical). */
export function pickEnclose(lib: Db, r: EncloseRequirement, combo: Combo, opts: { id?: string; label?: string; /** the board has a native source: read its outline there */ native?: boolean } = {}): { ok: true; record: MechanicalDefinition } | { ok: false; reason: string } {
  const pcba = lib.pcbas.find((p) => p.id === r.board);
  if (pcba === undefined || combo.enclosure === undefined) return { ok: false, reason: 'that combination is not an enclosure' };
  const taken = new Set((lib.mechanicals ?? []).map((m) => m.id));
  let id = opts.id ?? `${pcba.id}-enclosure-${combo.enclosure.preset}`;
  for (let n = 2; opts.id === undefined && taken.has(id); n += 1) id = `${pcba.id}-enclosure-${combo.enclosure.preset}-${n}`;
  const { board: stated, from } = boardFacts(lib, r.board);
  // a board with a native source and no enclosure yet: its outline, thickness and heights are read there at generation
  const board: EnclosureBoard = from === undefined && opts.native === true ? { ...stated, geometry: 'native' } : stated;
  const spec: EnclosureSpec = { boards: [board], occurrences: [{ id: 'a', pcba: pcba.id }], params: combo.enclosure.params };
  return {
    ok: true,
    record: {
      id, label: opts.label ?? `${pcba.label} enclosure (${combo.choices[0]?.label ?? combo.enclosure.preset})`, kind: 'shell',
      src: `Enclosure design parameters for ${pcba.label}, preset ${combo.enclosure.preset}; the solids are generated from them (WireHub enclosure tool pack).`,
      enclosure: spec,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function explore(lib: Db, requirement: Requirement, ctx: ExploreContext = {}, overrides: readonly ExploreOverride[] = []): Exploration {
  const decisions = new Decisions(overrides);
  return requirement.kind === 'connect' ? exploreConnect(lib, requirement, ctx, decisions) : exploreEnclose(lib, requirement, ctx, decisions);
}

/** Free quantity per item from inventory lots (`onHand − reserved`, base units). */
export function availabilityOf(lots: readonly { item: { kind: string; id: string }; onHand: number; reserved: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lots) {
    const k = `${l.item.kind}:${l.item.id}`;
    out[k] = (out[k] ?? 0) + Math.max(0, l.onHand - l.reserved);
  }
  return out;
}
