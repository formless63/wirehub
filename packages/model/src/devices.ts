/**
 * Device profiles, conditioning recipes, hazards and the ranking policy — the
 * library data the device resolver (`resolve.ts`) reads. All of it is data a
 * catalog or a pack ships: `devices.json`, `conditioning-recipes.json`,
 * `hazards.json`, `resolver-policy.json` (`docs/resolver.md`).
 *
 * A **device** is anything a cable plugs into: a computer, an instrument, a
 * sensor, a control unit — or an **adapter board** that sits inside a cable
 * (`board` names its PCBA). It has **ports**; a port carries a pinout (an
 * interface, `Db.interfaces`) on a jack (a body, or just a gender), and states
 * per position what the device does there: the signal it offers or accepts,
 * the direction, the level, what the cable must add (`needs`). A variant
 * (`extends`) states only what differs from its parent.
 *
 * A **conditioning recipe** is declarative: "a signal at level A into an input
 * that takes level B needs component C of value V in series / shunt / across".
 * A **hazard** is a pattern over the two pins a connection joins ("a power pin
 * onto a data pin"); the base has built-in ones and data adds or overrides by id.
 * The **policy** orders the criteria the resolver ranks options by.
 *
 * Pure: records in, records and issues out. Nothing here reads a file.
 */

import type { ConnectorGender, Db, Issue } from './model.ts';
import type { Confidence, Interface } from './interfaces.ts';
import { recordMetaIssues, type RecordMeta } from './provenance.ts';
import { CHASSIS_SIGNAL } from './signal-words.ts';
import { signalIds, vocabEntry, type SignalEntry, type SignalId, type Vocab } from './vocab.ts';

/* ------------------------------------------------------------------ *
 * Types — devices
 * ------------------------------------------------------------------ */

/** A pin's direction, as seen from the device that owns the port. */
export type PinDir = 'out' | 'in' | 'bidir' | 'passive';

/** What a device does on one position of a port. */
export interface PinOffer {
  /** vocab `signals` */
  signal: SignalId;
  dir?: PinDir;
  /** vocab `levels`: what an output drives, or what an input expects; absent = not stated */
  level?: string;
  /** an input's further levels it takes as they are (a tolerant input) */
  accepts?: string[];
  /** vocab `conditioning`: what the cable must add on this line, whatever the far end is */
  needs?: string[];
  confidence?: Confidence;
  note?: string;
  src?: string;
}

/** A pin binding: what the device does there, or `nc` — it leaves the position unconnected. */
export type PinBinding = PinOffer | 'nc';

/**
 * Something a port needs from any cable, beyond pairing its pins: a
 * termination across a pair, a pull-up, a bias. `conditioning` names what (a
 * vocab `conditioning` id); a recipe that realises it supplies the parts.
 */
export interface PortRequirement {
  id: string;
  /** vocab `conditioning` */
  conditioning: string;
  /** the positions it acts on: one (series or to ground) or two (across) */
  positions: string[];
  text?: string;
  src: string;
}

export type PortRole = 'source' | 'sink' | 'both';

export interface DevicePort {
  /** `com1`, `line-out`, `sensor` */
  id: string;
  label?: string;
  /** the pinout the port carries (`Db.interfaces`); a variant's port may leave it to its parent */
  interface?: string;
  /** the device's own jack (`Db.bodies`); the cable's plug is its mate */
  body?: string;
  /** the jack's gender when no body is named (the plug is the other one) */
  gender?: ConnectorGender;
  role?: PortRole;
  /** per-position facts laid over the interface; a port without an interface lists every position here */
  pins?: Record<string, PinBinding>;
  requires?: PortRequirement[];
  /**
   * Adapter boards only: how the port's positions are named on the board.
   * A prefix (`j1`) makes position `3` the terminal `j1.3` — a footprint or an
   * integrated connector; `''` makes the position the terminal id itself (the
   * board's cable pads).
   */
  terminals?: string;
  note?: string;
}

export type DeviceStatus = 'active' | 'development' | 'legacy' | 'retired';

export interface DeviceProfile extends RecordMeta {
  id: string;
  label: string;
  /** free kebab word: `computer`, `instrument`, `sensor`, `controller`, `adapter` … */
  kind?: string;
  manufacturer?: string;
  model?: string;
  /** a variant: the parent whose ports it changes (chains are followed, loops refused) */
  extends?: string;
  aliases?: string[];
  /** a variant's port with the same id is laid over the parent's */
  ports: DevicePort[];
  /** an adapter board: the PCBA definition (`Db.pcbas`) placed inside a cable */
  board?: string;
  status?: DeviceStatus;
  note?: string;
  src: string;
}

/* ------------------------------------------------------------------ *
 * Types — conditioning recipes, hazards, policy
 * ------------------------------------------------------------------ */

/** One part a recipe places. */
export interface RecipePart {
  /** a component record (`Db.components`); else the first record of this kind and value */
  component?: string;
  /** vocab `component-kinds` */
  kind?: string;
  /** `10 kΩ`, `100 nF` */
  value?: string;
  /** in the line; from the line to the end's ground; between the two positions of a requirement */
  placement: 'series' | 'shunt' | 'across';
  note?: string;
}

/** What a recipe takes or gives: a signal (or any signal of a kind) at a level. */
export interface RecipeSignal {
  signal?: SignalId;
  /** vocab signal kind (`audio`, `data`, `power`) when any signal of it will do */
  kind?: string;
  level?: string;
}

export interface ConditioningRecipe extends RecordMeta {
  id: string;
  label: string;
  /** vocab `conditioning`: what it realises (`attenuation`, `termination`, `pull-up`) */
  conditioning: string;
  /** the input it takes; absent = any line (a termination) */
  from?: RecipeSignal;
  /** what it delivers (the level after it) */
  to?: RecipeSignal;
  parts: RecipePart[];
  /** vocab `locations` its parts go in; absent = the receiving end */
  location?: string;
  /** works in both directions (a bidirectional bus can take it) */
  bidirectional?: boolean;
  note?: string;
  src: string;
}

/** One side of a connection, as a hazard matches it. Every field given must hold. */
export interface PinPattern {
  /** signal kinds (`power`, `ground`, `data` …) */
  kinds?: string[];
  notKinds?: string[];
  signals?: SignalId[];
  notSignals?: SignalId[];
  dirs?: PinDir[];
  levels?: string[];
}

export interface HazardRule extends RecordMeta {
  id: string;
  label: string;
  /** `reject`: an option that makes the connection is refused; `warning`: it is listed with the warning */
  severity: 'reject' | 'warning';
  /** the two pins of a connection, matched both ways round */
  a: PinPattern;
  b: PinPattern;
  /** how the two must relate, besides each matching its pattern */
  relation?: 'same-signal' | 'different-signal' | 'different-level';
  /** `{a}` and `{b}` stand for the two pins */
  text: string;
  /** false switches a built-in (or a pack's) hazard off */
  enabled?: boolean;
  src: string;
}

/** What the resolver ranks options by, lowest first, in `order`. */
export type RankCriterion =
  /** fewest missing pieces (an unpaired input, a level nothing converts, a part the library lacks) */
  | 'missing'
  /** fewest hazard warnings */
  | 'hazards'
  /** fewest facts nobody confirmed (`confidence: inferred | unknown`) */
  | 'unverified'
  /** fewest boards: plain wire first */
  | 'boards'
  /** most boards: an adapter first */
  | 'prefer-boards'
  /** fewest discrete parts */
  | 'parts'
  /** fewest conductors */
  | 'conductors'
  /** a pin-for-pin (straight) cable first */
  | 'straight';

export const RANK_CRITERIA: readonly RankCriterion[] = ['missing', 'hazards', 'unverified', 'boards', 'prefer-boards', 'parts', 'conductors', 'straight'];

export interface ResolverPolicy {
  order: RankCriterion[];
  /** the most options listed (the rest are counted); default 12 */
  maxOptions?: number;
  /** where both ends have a chassis pin: land the screen at both (`both`, the default) or at the source end only */
  screens?: 'source' | 'both';
  src: string;
}

export const DEFAULT_RESOLVER_POLICY: ResolverPolicy = {
  order: ['missing', 'hazards', 'unverified', 'boards', 'parts', 'conductors'],
  maxOptions: 12,
  screens: 'both',
  src: 'WireHub default: complete first, then safe, confirmed, plain wire, fewest parts',
};

/**
 * The hazards every hub has. Data adds more by id, or replaces one of these
 * (same id) — `enabled: false` switches it off.
 */
export const BUILT_IN_HAZARDS: readonly HazardRule[] = [
  {
    id: 'power-into-signal',
    label: 'Power onto a signal pin',
    severity: 'reject',
    a: { kinds: ['power'] },
    b: { notKinds: ['power', 'ground', 'none'] },
    text: '{a} is a supply and {b} is a signal: joining them can destroy the input',
    src: 'WireHub built-in hazard',
  },
  {
    id: 'power-into-ground',
    label: 'Power onto ground',
    severity: 'reject',
    a: { kinds: ['power'] },
    b: { kinds: ['ground'] },
    text: '{a} is a supply and {b} is ground: joining them is a short circuit',
    src: 'WireHub built-in hazard',
  },
  {
    id: 'power-mismatch',
    label: 'Two different supplies',
    severity: 'reject',
    a: { kinds: ['power'] },
    b: { kinds: ['power'] },
    relation: 'different-signal',
    text: '{a} and {b} are different supplies',
    src: 'WireHub built-in hazard',
  },
  {
    id: 'output-contention',
    label: 'Two outputs driving one line',
    severity: 'reject',
    a: { dirs: ['out'], notKinds: ['ground', 'none', 'power'] },
    b: { dirs: ['out'], notKinds: ['ground', 'none', 'power'] },
    text: '{a} and {b} are both outputs: they would fight over the line',
    src: 'WireHub built-in hazard',
  },
  {
    id: 'parallel-supplies',
    label: 'Two supplies in parallel',
    severity: 'warning',
    a: { kinds: ['power'], dirs: ['out'] },
    b: { kinds: ['power'], dirs: ['out'] },
    relation: 'same-signal',
    text: '{a} and {b} both supply the rail: check that the two may be paralleled',
    src: 'WireHub built-in hazard',
  },
];

/** What the resolver reads from the library. */
export type ResolverLibrary = Pick<Db, 'connectors' | 'wires' | 'components' | 'pcbas' | 'bodies' | 'interfaces' | 'vocab' | 'devices' | 'conditioningRecipes' | 'hazards' | 'resolverPolicy' | 'tags' | 'mechanicals'>;

/* ------------------------------------------------------------------ *
 * Lookups and inheritance
 * ------------------------------------------------------------------ */

export function findDevice(devices: readonly DeviceProfile[] | undefined, id: string): DeviceProfile | undefined {
  return (devices ?? []).find((d) => d.id === id);
}

/** The `extends` chain from `id` up (the device first), or `undefined` when it breaks or loops. */
export function deviceLineage(devices: readonly DeviceProfile[] | undefined, id: string): DeviceProfile[] | undefined {
  const chain: DeviceProfile[] = [];
  const seen = new Set<string>();
  let at: string | undefined = id;
  while (at !== undefined) {
    if (seen.has(at)) return undefined;
    seen.add(at);
    const device = findDevice(devices, at);
    if (device === undefined) return undefined;
    chain.push(device);
    at = device.extends;
  }
  return chain;
}

function mergePorts(parent: readonly DevicePort[], child: readonly DevicePort[]): DevicePort[] {
  const out = parent.map((p) => ({ ...p, ...(p.pins === undefined ? {} : { pins: { ...p.pins } }) }));
  for (const port of child) {
    const at = out.findIndex((p) => p.id === port.id);
    if (at === -1) {
      out.push({ ...port });
      continue;
    }
    const base = out[at]!;
    out[at] = {
      ...base,
      ...port,
      pins: { ...(base.pins ?? {}), ...(port.pins ?? {}) },
      ...(base.requires === undefined && port.requires === undefined ? {} : { requires: [...(base.requires ?? []).filter((r) => !(port.requires ?? []).some((x) => x.id === r.id)), ...(port.requires ?? [])] }),
    };
  }
  return out;
}

/**
 * A device with its `extends` chain laid in: scalar fields from the nearest
 * record that states them, ports merged by id (the child's pins over the
 * parent's). `undefined` for an unknown id or a broken chain.
 */
export function resolveDevice(devices: readonly DeviceProfile[] | undefined, id: string): DeviceProfile | undefined {
  const lineage = deviceLineage(devices, id);
  if (lineage === undefined) return undefined;
  let merged: DeviceProfile | undefined;
  for (const device of [...lineage].reverse()) {
    if (merged === undefined) {
      merged = { ...device, ports: mergePorts([], device.ports) };
      continue;
    }
    const { ports, ...rest } = device;
    merged = { ...merged, ...rest, ports: mergePorts(merged.ports, ports) };
  }
  return merged;
}

/** A port by id, else the device's first port of that role (or its first port). */
export function devicePort(device: DeviceProfile, id?: string, role?: 'source' | 'sink'): DevicePort | undefined {
  if (id !== undefined) return device.ports.find((p) => p.id === id);
  return device.ports.find((p) => role === undefined || (p.role ?? 'both') === role || p.role === 'both') ?? device.ports[0];
}

/* ------------------------------------------------------------------ *
 * Binding a port
 * ------------------------------------------------------------------ */

/** How the resolver treats a position. */
export type PinClass = 'signal' | 'power' | 'ground' | 'chassis' | 'nc' | 'open';

/** One position of a port as the device drives or takes it. */
export interface BoundPin {
  position: string;
  label: string;
  /** what is there; `undefined` for an open pin (`{ oneOf }`) the device does not bind */
  signal?: SignalId;
  class: PinClass;
  /** the vocab kind of the signal */
  kind?: string;
  dir?: PinDir;
  level?: string;
  accepts?: string[];
  needs?: string[];
  confidence: Confidence;
  /** the shell or a key of the body */
  shell?: boolean;
  note?: string;
}

const CONFIDENCE_ORDER: readonly Confidence[] = ['net-verified', 'documented', 'inferred', 'unknown'];

/** The less certain of two confidences. */
export function worstConfidence(a: Confidence, b: Confidence | undefined): Confidence {
  if (b === undefined) return a;
  return CONFIDENCE_ORDER.indexOf(a) >= CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

function classOf(vocab: Vocab | undefined, signal: SignalId | undefined, shell: boolean): { class: PinClass; kind?: string } {
  if (signal === undefined) return { class: 'open' };
  const kind = vocabEntry<SignalEntry>(vocab, 'signals', signal)?.kind;
  if (signal === 'nc' || kind === 'none') return { class: 'nc', ...(kind === undefined ? {} : { kind }) };
  if (signal === CHASSIS_SIGNAL || (shell && kind === 'ground')) return { class: 'chassis', kind: kind ?? 'ground' };
  if (kind === 'ground' || signal === 'gnd') return { class: 'ground', kind: 'ground' };
  if (kind === 'power') return { class: 'power', kind };
  return { class: 'signal', ...(kind === undefined ? {} : { kind }) };
}

/**
 * The positions of a port as the device has them: the interface's pins with
 * the device's bindings laid over, in the interface's order (then any
 * position only the port names). A plain interface pin the device does not
 * mention keeps the interface's signal, direction and confidence.
 */
export function bindPort(db: Pick<Db, 'interfaces' | 'bodies' | 'vocab'>, port: DevicePort): BoundPin[] {
  const iface: Interface | undefined = port.interface === undefined ? undefined : (db.interfaces ?? []).find((i) => i.id === port.interface);
  const bodyIds = [port.body, ...(iface?.bodies ?? [])].filter((b): b is string => b !== undefined);
  const shellIds = new Set<string>();
  for (const id of bodyIds) for (const p of (db.bodies ?? []).find((b) => b.id === id)?.positions ?? []) if (p.kind === 'shell') shellIds.add(p.id);
  const positions = [...Object.keys(iface?.pins ?? {}), ...Object.keys(port.pins ?? {}).filter((p) => iface?.pins[p] === undefined)];
  const out: BoundPin[] = [];
  for (const position of positions) {
    const fn = iface?.pins[position];
    const binding = port.pins?.[position];
    const shell = shellIds.has(position) || position === 'shell';
    const label = fn?.label ?? position;
    if (binding === 'nc') {
      out.push({ position, label, signal: 'nc', class: 'nc', confidence: 'documented', shell });
      continue;
    }
    const signal = binding?.signal ?? (fn === undefined ? undefined : typeof fn.signal === 'string' ? fn.signal : undefined);
    const cls = classOf(db.vocab, signal, shell);
    const dir = binding?.dir ?? fn?.dir;
    const confidence = worstConfidence(binding?.confidence ?? fn?.confidence ?? 'documented', iface?.confidence);
    out.push({
      position,
      label: binding === undefined ? label : `${label}`,
      ...(signal === undefined ? {} : { signal }),
      class: cls.class,
      ...(cls.kind === undefined ? {} : { kind: cls.kind }),
      ...(dir === undefined ? {} : { dir }),
      ...(binding?.level === undefined ? {} : { level: binding.level }),
      ...(binding?.accepts === undefined ? {} : { accepts: binding.accepts }),
      ...(binding?.needs === undefined ? {} : { needs: binding.needs }),
      confidence,
      shell,
      ...(binding?.note === undefined ? {} : { note: binding.note }),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Hazards and recipes from the library
 * ------------------------------------------------------------------ */

/** The hazards in force: the built-ins, replaced or extended by the library's, without the switched-off ones. */
export function hazardsInForce(db: Pick<Db, 'hazards'>): HazardRule[] {
  const own = db.hazards ?? [];
  const byId = new Map<string, HazardRule>();
  for (const h of BUILT_IN_HAZARDS) byId.set(h.id, h);
  for (const h of own) byId.set(h.id, h);
  return [...byId.values()].filter((h) => h.enabled !== false);
}

/** The ranking policy in force: the library's, else the default. */
export function policyInForce(db: Pick<Db, 'resolverPolicy'>): ResolverPolicy {
  const own = db.resolverPolicy;
  if (own === undefined || !Array.isArray(own.order)) return DEFAULT_RESOLVER_POLICY;
  return { ...DEFAULT_RESOLVER_POLICY, ...own, order: own.order.filter((c) => (RANK_CRITERIA as readonly string[]).includes(c)) };
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIRS: readonly string[] = ['out', 'in', 'bidir', 'passive'];
const PLACEMENTS: readonly string[] = ['series', 'shunt', 'across'];

function issue(code: string, message: string, where: string, severity: Issue['severity'] = 'error'): Issue {
  return { code, severity, message, where };
}

/**
 * Everything wrong with the devices, recipes, hazards and policy of a library:
 * duplicates, broken `extends`, ports naming unknown interfaces or bodies,
 * bindings on positions the interface does not have, vocabulary references the
 * lists lack, recipes without parts, hazards without patterns, missing `src`.
 * Unknown references are errors; a missing citation or an unbound open pin is a warning.
 */
export function deviceLibraryIssues(db: Pick<Db, 'devices' | 'conditioningRecipes' | 'hazards' | 'resolverPolicy' | 'interfaces' | 'bodies' | 'pcbas' | 'components' | 'vocab'>): Issue[] {
  const issues: Issue[] = [];
  const vocab = db.vocab;
  const vocabRef = (list: string, id: string, where: string): void => {
    if (vocab?.[list] === undefined) return;
    if (vocabEntry(vocab, list, id, { includePending: true }) === undefined) issues.push(issue('vocab-unknown', `'${id}' is not in the '${list}' list`, where));
  };
  const seen = new Set<string>();
  for (const device of db.devices ?? []) {
    const at = `devices/${device.id}`;
    if (typeof device.id !== 'string' || !KEBAB.test(device.id)) issues.push(issue('device-bad-id', `'${String(device.id)}' is not a kebab-case id`, at));
    if (seen.has(device.id)) issues.push(issue('device-duplicate', `two devices '${device.id}'`, at));
    seen.add(device.id);
    if (typeof device.label !== 'string' || device.label.trim() === '') issues.push(issue('device-no-label', `device '${device.id}' has no label`, at));
    if (!device.src) issues.push(issue('missing-src', `device '${device.id}' has no src`, at, 'warning'));
    issues.push(...recordMetaIssues(device, at));
    if (!Array.isArray(device.ports)) {
      issues.push(issue('device-ports', `device '${device.id}' has no ports list`, at));
      continue;
    }
    if (device.extends !== undefined && findDevice(db.devices, device.extends) === undefined) {
      issues.push(issue('device-extends-unknown', `'${device.id}' extends unknown device '${device.extends}'`, at));
      continue;
    }
    const resolved = resolveDevice(db.devices, device.id);
    if (resolved === undefined) {
      issues.push(issue('device-extends-cycle', `'${device.id}' has a looping extends chain`, at));
      continue;
    }
    if (resolved.board !== undefined && !(db.pcbas ?? []).some((p) => p.id === resolved.board)) {
      issues.push(issue('device-board-unknown', `'${device.id}' names unknown board '${resolved.board}'`, at));
    }
    if (resolved.ports.length === 0) issues.push(issue('device-no-port', `'${device.id}' has no port`, at, 'warning'));
    const portIds = new Set<string>();
    for (const port of resolved.ports) {
      const pw = `${at}/ports/${port.id}`;
      if (portIds.has(port.id)) issues.push(issue('device-port-duplicate', `two ports '${port.id}'`, pw));
      portIds.add(port.id);
      const iface = port.interface === undefined ? undefined : (db.interfaces ?? []).find((i) => i.id === port.interface);
      if (port.interface !== undefined && iface === undefined) issues.push(issue('device-port-interface', `port '${port.id}' names unknown interface '${port.interface}'`, pw));
      if (port.interface === undefined && Object.keys(port.pins ?? {}).length === 0) issues.push(issue('device-port-empty', `port '${port.id}' names no interface and lists no pins`, pw));
      if (port.body !== undefined && !(db.bodies ?? []).some((b) => b.id === port.body)) issues.push(issue('device-port-body', `port '${port.id}' names unknown body '${port.body}'`, pw));
      if (port.role !== undefined && !['source', 'sink', 'both'].includes(port.role)) issues.push(issue('device-port-role', `port '${port.id}' has role '${String(port.role)}'`, pw));
      for (const [position, binding] of Object.entries(port.pins ?? {})) {
        const where = `${pw}/${position}`;
        if (iface !== undefined && iface.pins[position] === undefined) issues.push(issue('device-pin-unknown', `pin '${position}' is not a position ${iface.id} assigns`, where));
        if (binding === 'nc') continue;
        if (typeof binding !== 'object' || binding === null || typeof binding.signal !== 'string') {
          issues.push(issue('device-pin-bad', `pin '${position}' must be 'nc' or { signal, … }`, where));
          continue;
        }
        vocabRef('signals', binding.signal, where);
        if (binding.dir !== undefined && !DIRS.includes(binding.dir)) issues.push(issue('device-pin-bad', `pin '${position}' has direction '${String(binding.dir)}'`, where));
        if (binding.level !== undefined) vocabRef('levels', binding.level, where);
        for (const l of binding.accepts ?? []) vocabRef('levels', l, where);
        for (const c of binding.needs ?? []) vocabRef('conditioning', c, where);
      }
      for (const req of port.requires ?? []) {
        const where = `${pw}/requires/${req.id}`;
        vocabRef('conditioning', req.conditioning, where);
        if (!Array.isArray(req.positions) || req.positions.length === 0 || req.positions.length > 2) issues.push(issue('device-requirement', `requirement '${req.id}' acts on one or two positions`, where));
        for (const p of req.positions ?? []) if (iface !== undefined && iface.pins[p] === undefined && port.pins?.[p] === undefined) issues.push(issue('device-pin-unknown', `requirement '${req.id}' names position '${p}' the port does not have`, where));
        if (!req.src) issues.push(issue('missing-src', `requirement '${req.id}' has no src`, where, 'warning'));
      }
      if (iface !== undefined) {
        for (const pin of bindPort(db, port)) {
          if (pin.class === 'open') issues.push(issue('device-pin-unbound', `open pin ${pin.position} (${signalIds(iface.pins[pin.position]!.signal).join(' | ')}) is not bound`, pw, 'warning'));
        }
      }
    }
  }

  const recipeIds = new Set<string>();
  for (const recipe of db.conditioningRecipes ?? []) {
    const at = `conditioning-recipes/${recipe.id}`;
    if (typeof recipe.id !== 'string' || !KEBAB.test(recipe.id)) issues.push(issue('recipe-bad-id', `'${String(recipe.id)}' is not a kebab-case id`, at));
    if (recipeIds.has(recipe.id)) issues.push(issue('recipe-duplicate', `two recipes '${recipe.id}'`, at));
    recipeIds.add(recipe.id);
    if (!recipe.src) issues.push(issue('missing-src', `recipe '${recipe.id}' has no src`, at, 'warning'));
    issues.push(...recordMetaIssues(recipe, at));
    if (typeof recipe.conditioning !== 'string') issues.push(issue('recipe-conditioning', `recipe '${recipe.id}' names no conditioning`, at));
    else vocabRef('conditioning', recipe.conditioning, at);
    if (recipe.location !== undefined) vocabRef('locations', recipe.location, at);
    for (const side of [recipe.from, recipe.to]) {
      if (side?.signal !== undefined) vocabRef('signals', side.signal, at);
      if (side?.level !== undefined) vocabRef('levels', side.level, at);
    }
    if (!Array.isArray(recipe.parts) || recipe.parts.length === 0) {
      issues.push(issue('recipe-no-parts', `recipe '${recipe.id}' places no parts`, at));
      continue;
    }
    for (const [i, part] of recipe.parts.entries()) {
      const where = `${at}/parts/${i}`;
      if (!PLACEMENTS.includes(part.placement)) issues.push(issue('recipe-part', `part ${i + 1} has placement '${String(part.placement)}'`, where));
      if (part.component !== undefined && !(db.components ?? []).some((c) => c.id === part.component)) issues.push(issue('recipe-part-unknown', `part ${i + 1} names unknown component '${part.component}'`, where));
      if (part.component === undefined && part.kind === undefined) issues.push(issue('recipe-part', `part ${i + 1} names neither a component nor a kind`, where));
      if (part.kind !== undefined) vocabRef('component-kinds', part.kind, where);
    }
  }

  const hazardIds = new Set<string>();
  for (const hazard of db.hazards ?? []) {
    const at = `hazards/${hazard.id}`;
    if (typeof hazard.id !== 'string' || !KEBAB.test(hazard.id)) issues.push(issue('hazard-bad-id', `'${String(hazard.id)}' is not a kebab-case id`, at));
    if (hazardIds.has(hazard.id)) issues.push(issue('hazard-duplicate', `two hazards '${hazard.id}'`, at));
    hazardIds.add(hazard.id);
    if (hazard.severity !== 'reject' && hazard.severity !== 'warning') issues.push(issue('hazard-severity', `hazard '${hazard.id}' has severity '${String(hazard.severity)}'`, at));
    if (typeof hazard.a !== 'object' || typeof hazard.b !== 'object' || hazard.a === null || hazard.b === null) issues.push(issue('hazard-pattern', `hazard '${hazard.id}' needs the patterns a and b`, at));
    if (typeof hazard.text !== 'string' || hazard.text === '') issues.push(issue('hazard-text', `hazard '${hazard.id}' has no text`, at));
    if (!hazard.src) issues.push(issue('missing-src', `hazard '${hazard.id}' has no src`, at, 'warning'));
  }

  const policy = db.resolverPolicy;
  if (policy !== undefined) {
    if (!Array.isArray(policy.order)) issues.push(issue('policy-order', 'the ranking policy needs an order', 'resolver-policy'));
    else for (const c of policy.order) if (!(RANK_CRITERIA as readonly string[]).includes(c)) issues.push(issue('policy-order', `'${String(c)}' is not a ranking criterion (${RANK_CRITERIA.join(', ')})`, 'resolver-policy'));
  }
  return issues;
}
