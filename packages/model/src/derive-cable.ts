/**
 * From a resolver option to a proposed design (`docs/resolver.md`): the
 * plugs that mate each device's jack (or the adapter board at that end), a
 * wire stock that can carry the lines, one conductor per line (a
 * differential pair on a twisted pair when the stock has one), a return
 * conductor for the grounds, the screen on the chassis pin, and the
 * conditioning parts of the recipes as component instances, wired in series,
 * to ground (shunt) or across a pair.
 *
 * The result is an ordinary `CableDesign` (status `development`) that carries
 * its `recipe`, so it can be re-derived and checked for drift
 * (`cable-recipe.ts`). Anything the library lacks — a mating plug, a part, a
 * stock big enough — is reported, never invented.
 *
 * Pure: library and choices in, a design and findings out.
 */

import { bondedSetOf, isFullyBonded, screenPaths } from './bonds.ts';
import { fillCavities, housingOf } from './crimp.ts';
import { bindPort, devicePort, policyInForce, resolveDevice, type DevicePort, type RecipePart, type ResolverLibrary } from './devices.ts';
import { valueOfText } from './link-elements.ts';
import { CURRENT_SCHEMA_VERSION, type CableDesign, type Db, type ComponentDefinition, type ComponentInstance, type ConnectorDefinition, type ConnectorInstance, type GroupElement, type Joint, type PcbaInstance, type Pigtail, type TerminalRef, type WireDefinition } from './model.ts';
import { elementPaths, resolveElementPath } from './paths.ts';
import { optionOf, resolve, type CableOption, type End, type Finding, type Link, type ResolveQuery, type Resolution } from './resolve.ts';
import type { CableRecipe } from './cable-recipe.ts';
import { vocabEntry, type SignalEntry } from './vocab.ts';

export interface DeriveCableOptions {
  /** the trunk stock; absent = the resolver's suggestion */
  stock?: string;
  lengthMm?: number;
  /** the new design's id and label */
  id?: string;
  label?: string;
}

export type DerivedCable =
  | { ok: true; design: CableDesign; option: CableOption; resolution: Resolution; stock: string; missing: Finding[] }
  | { ok: false; reason: string; resolution: Resolution; missing: Finding[] };

/* ------------------------------------------------------------------ *
 * Plugs and stocks
 * ------------------------------------------------------------------ */

/** The body that mates `bodyId`: its own `mates`, or a body that names it. */
export function matingBody(lib: Pick<ResolverLibrary, 'bodies'>, bodyId: string): string | undefined {
  const body = (lib.bodies ?? []).find((b) => b.id === bodyId);
  if (body?.mates !== undefined) return body.mates;
  return (lib.bodies ?? []).find((b) => b.mates === bodyId)?.id;
}

function oppositeGender(g: string | undefined): string | undefined {
  return g === 'male' ? 'female' : g === 'female' ? 'male' : undefined;
}

/** Whether connector `def` plugs into `port`: the port's pinout, on the body that mates its jack. */
export function plugsInto(lib: Pick<ResolverLibrary, 'bodies'>, def: ConnectorDefinition, port: DevicePort): boolean {
  if (port.interface === undefined || def.interface !== port.interface) return false;
  if (port.body !== undefined) {
    const mate = matingBody(lib, port.body);
    if (mate !== undefined) return def.body === mate;
    const bodyGender = (lib.bodies ?? []).find((b) => b.id === def.body)?.gender ?? def.gender;
    const jack = (lib.bodies ?? []).find((b) => b.id === port.body)?.gender;
    return jack === undefined || bodyGender === undefined || bodyGender === oppositeGender(jack);
  }
  if (port.gender !== undefined) {
    const want = oppositeGender(port.gender);
    const g = def.gender ?? (lib.bodies ?? []).find((b) => b.id === def.body)?.gender;
    return want === undefined || g === undefined || g === want;
  }
  return true;
}

/** The library's plug for a device port: the first connector that plugs into it. */
export function matingConnector(lib: Pick<ResolverLibrary, 'connectors' | 'bodies'>, port: DevicePort): ConnectorDefinition | undefined {
  return lib.connectors.find((c) => plugsInto(lib, c, port));
}

interface StockShape {
  conductors: string[];
  pairs: [string, string][];
  screens: string[];
}

function stockShape(wire: WireDefinition): StockShape {
  const conductors = elementPaths(wire.structure)
    .filter((e) => e.element.kind === 'conductor' && e.element.bare !== true)
    .map((e) => e.path);
  const pairs: [string, string][] = [];
  for (const e of elementPaths(wire.structure)) {
    if (e.element.kind !== 'group' || (e.element as GroupElement).role !== 'twisted-pair') continue;
    const inner = elementPaths(e.element as GroupElement).filter((x) => x.element.kind === 'conductor' && x.element.bare !== true).map((x) => `${e.path}.${x.path}`);
    if (inner.length === 2) pairs.push([inner[0]!, inner[1]!]);
  }
  return { conductors, pairs, screens: screenPaths(wire) };
}

/** What a cable for `option` needs from its stock. */
export function stockNeeds(lib: ResolverLibrary, option: CableOption): { lines: number; ground: boolean; screen: boolean; pairs: number } {
  const ground = option.grounds.source.length > 0 && option.grounds.destination.length > 0;
  const screen = option.chassis.source.length + option.chassis.destination.length > 0;
  return { lines: option.links.length, ground, screen, pairs: diffPairs(lib, option.links).length };
}

/** Links that are the two halves of one differential pair (`SignalEntry.diffPair`). */
function diffPairs(lib: ResolverLibrary, links: readonly Link[]): [number, number][] {
  const out: [number, number][] = [];
  const taken = new Set<number>();
  links.forEach((l, i) => {
    if (taken.has(i) || l.signal === undefined) return;
    const partner = vocabEntry<SignalEntry>(lib.vocab, 'signals', l.signal)?.diffPair;
    if (partner === undefined) return;
    const j = links.findIndex((m, k) => k !== i && !taken.has(k) && (m.signal === partner || m.toSignal === partner));
    if (j === -1) return;
    taken.add(i);
    taken.add(j);
    out.push([i, j]);
  });
  return out;
}

/**
 * The stocks that can carry `option`, best first: enough conductors for the
 * lines and the return; a screen when an end has a chassis pin; twisted
 * pairs for the differential pairs; the fewest spare conductors.
 */
export function suggestStocks(lib: ResolverLibrary, option: CableOption): { id: string; label: string; spare: number; reasons: string[] }[] {
  const needs = stockNeeds(lib, option);
  const kindOf = (signal: string | undefined): string | undefined => (signal === undefined ? undefined : vocabEntry<SignalEntry>(lib.vocab, 'signals', signal)?.kind);
  const optionalLines = option.links.filter((l) => kindOf(l.signal) === 'control' && kindOf(l.toSignal) === 'control').length;
  const out: { id: string; label: string; spare: number; score: number[]; reasons: string[] }[] = [];
  for (const wire of lib.wires) {
    const shape = stockShape(wire);
    const n = shape.conductors.length;
    const screenReturn = needs.ground && n < needs.lines + 1 && shape.screens.length > 0;
    const returnConductor = needs.ground && !screenReturn ? 1 : 0;
    if (n < needs.lines - optionalLines + returnConductor) continue;
    const dropped = Math.max(0, needs.lines + returnConductor - n);
    const reasons: string[] = [`${n} conductor${n === 1 ? '' : 's'} for ${needs.lines} line${needs.lines === 1 ? '' : 's'}${needs.ground ? (screenReturn ? ', the screen as the return' : ' and the return') : ''}`];
    if (dropped > 0) reasons.push(`${dropped} control line${dropped === 1 ? '' : 's'} not carried`);
    const noScreen = needs.screen && shape.screens.length === 0 ? 1 : 0;
    if (needs.screen) reasons.push(noScreen ? 'no screen for the chassis' : 'a screen for the chassis');
    const unpaired = Math.max(0, needs.pairs - shape.pairs.length);
    if (needs.pairs > 0) reasons.push(unpaired === 0 ? `${needs.pairs} twisted pair${needs.pairs === 1 ? '' : 's'} for the differential lines` : `${unpaired} differential pair${unpaired === 1 ? '' : 's'} without a twisted pair`);
    const spare = Math.max(0, n - needs.lines - returnConductor);
    out.push({ id: wire.id, label: wire.label, spare, score: [dropped, noScreen, unpaired, screenReturn ? 1 : 0, spare], reasons });
  }
  out.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return a.score[i]! - b.score[i]!;
    return a.id.localeCompare(b.id);
  });
  return out.map(({ id, label, spare, reasons }) => ({ id, label, spare, reasons }));
}

/** The component record for a recipe part: by id, else the first of its kind whose value reads the same. */
export function componentForPart(lib: Pick<ResolverLibrary, 'components'>, part: RecipePart): ComponentDefinition | undefined {
  if (part.component !== undefined) return lib.components.find((c) => c.id === part.component);
  const want = part.value === undefined ? undefined : (valueOfText(part.value) ?? part.value.trim());
  return lib.components.find((c) => c.kind === part.kind && (want === undefined || (c.value !== undefined && (valueOfText(c.value) ?? c.value.trim()) === want)));
}

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

const KIND_LETTER: Readonly<Record<string, string>> = { resistor: 'r', capacitor: 'c', inductor: 'l', diode: 'd', led: 'd', fuse: 'f', ic: 'u', switch: 's' };

const kebab = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'derived-cable';

/** A design for a resolver option (the top-ranked one when `optionId` is absent). */
export function deriveCable(lib: ResolverLibrary, query: ResolveQuery, optionId?: string, opts: DeriveCableOptions = {}): DerivedCable {
  const resolution = resolve(lib, query);
  const option = optionOf(resolution, optionId);
  if (option === undefined || resolution.source === undefined || resolution.destination === undefined) {
    return { ok: false, reason: optionId === undefined ? (resolution.problems[0]?.message ?? 'nothing connects these ports') : `no option '${optionId}'`, resolution, missing: [] };
  }
  const missing: Finding[] = [];
  const notes: string[] = [];
  const src = resolveDevice(lib.devices, query.source.device)!;
  const dst = resolveDevice(lib.devices, query.destination.device)!;
  const ports: Record<End, DevicePort> = {
    source: devicePort(src, query.source.port, 'source')!,
    destination: devicePort(dst, query.destination.port, 'sink')!,
  };

  // the stock
  const stockId = opts.stock ?? suggestStocks(lib, option)[0]?.id;
  const wire = stockId === undefined ? undefined : lib.wires.find((w) => w.id === stockId);
  if (wire === undefined) {
    const needs = stockNeeds(lib, option);
    return { ok: false, reason: stockId === undefined ? `no wire stock in the library has ${needs.lines + (needs.ground ? 1 : 0)} conductors` : `no wire stock '${stockId}'`, resolution, missing };
  }

  const connectors: ConnectorInstance[] = [];
  const pcbas: PcbaInstance[] = [];
  const components: ComponentInstance[] = [];
  const joints: Joint[] = [];

  // each end: the plug, or the adapter board (and the plug that goes onto its footprint)
  const terminalAt: Record<End, (position: string) => TerminalRef> = { source: () => ({ instance: '?', terminal: '?' }), destination: () => ({ instance: '?', terminal: '?' }) };
  for (const end of ['source', 'destination'] as const) {
    const n = end === 'source' ? 1 : 2;
    const board = option.boards.find((b) => b.end === end);
    const port = ports[end];
    if (board === undefined) {
      const plug = matingConnector(lib, port);
      if (plug === undefined) {
        missing.push({ code: 'no-mating-plug', message: `the library has no plug that mates the ${end} port (${port.interface ?? 'no pinout'}${port.body === undefined ? '' : ` on ${port.body}`})`, end });
        return { ok: false, reason: missing[0]!.message, resolution, missing };
      }
      const id = `j${n}`;
      connectors.push({ id, def: plug.id });
      terminalAt[end] = (position) => ({ instance: id, terminal: position });
      continue;
    }
    const adapter = resolveDevice(lib.devices, board.device)!;
    const mate = adapter.ports.find((p) => p.id === board.mate)!;
    const pads = adapter.ports.find((p) => p.id === board.pads)!;
    const def = lib.pcbas.find((p) => p.id === board.pcba);
    if (def === undefined) return { ok: false, reason: `no board '${board.pcba}'`, resolution, missing };
    const uid = `u${n}`;
    pcbas.push({ id: uid, def: def.id });
    const prefix = mate.terminals ?? '';
    const integrated = (def.integratedConnectors ?? []).some((ic) => ic.terminalPrefix === prefix);
    if (!integrated) {
      const plug = matingConnector(lib, port);
      if (plug === undefined) {
        missing.push({ code: 'no-mating-plug', message: `the library has no plug that mates the ${end} port for ${adapter.label}`, end });
        return { ok: false, reason: missing[0]!.message, resolution, missing };
      }
      const jid = `j${n}`;
      connectors.push({ id: jid, def: plug.id });
      const terminals = new Set(def.terminals.map((t) => t.id));
      for (const pin of bindPort(lib, port)) {
        const pad = `${prefix}.${pin.position}`;
        if (!terminals.has(pad) || pin.class === 'nc') continue;
        const plugSide: TerminalRef = { instance: jid, terminal: pin.position };
        const boardSide: TerminalRef = { instance: uid, terminal: pad };
        joints.push(end === 'source' ? { a: plugSide, b: boardSide } : { a: boardSide, b: plugSide });
      }
    }
    const padPrefix = pads.terminals ?? '';
    terminalAt[end] = (position) => ({ instance: uid, terminal: padPrefix === '' ? position : `${padPrefix}.${position}` });
  }

  // conductors: differential pairs onto twisted pairs, then the rest, then the return.
  // A stock too small for every line carries the essential ones: control lines (handshakes) go first.
  const shape = stockShape(wire);
  const needGround = option.grounds.source.length > 0 && option.grounds.destination.length > 0;
  const kindOf = (signal: string | undefined): string | undefined => (signal === undefined ? undefined : vocabEntry<SignalEntry>(lib.vocab, 'signals', signal)?.kind);
  const optional = (l: Link): boolean => kindOf(l.signal) === 'control' && kindOf(l.toSignal) === 'control';
  const screenCanReturn = shape.screens.length > 0;
  let links = [...option.links];
  const room = (): number => shape.conductors.length - (needGround ? 1 : 0);
  if (links.length > room()) {
    const dropped = links.filter(optional);
    links = links.filter((l) => !optional(l));
    if (dropped.length > 0) notes.push(`not carried (the stock has too few conductors for every line): the control lines ${dropped.map((l) => `${l.signal} → ${l.toSignal}`).join(', ')}`);
  }
  const free = [...shape.conductors];
  const take = (path: string): string => {
    free.splice(free.indexOf(path), 1);
    return path;
  };
  const conductorOf = new Map<number, string>();
  const pairsFree = [...shape.pairs];
  for (const [i, j] of diffPairs(lib, links)) {
    const pair = pairsFree.shift();
    if (pair === undefined) break;
    conductorOf.set(i, take(pair[0]));
    conductorOf.set(j, take(pair[1]));
  }
  // single lines prefer conductors outside twisted pairs left whole
  const inFreePair = new Set(pairsFree.flat());
  links.forEach((_, i) => {
    if (conductorOf.has(i)) return;
    const path = free.find((p) => !inFreePair.has(p)) ?? free[0];
    if (path !== undefined) conductorOf.set(i, take(path));
  });
  const groundPath = needGround ? free[0] : undefined;
  if (groundPath !== undefined) take(groundPath);
  // no conductor left for the return: the screen carries it (a balanced audio lead's pin 1)
  const groundOnScreen = needGround && groundPath === undefined && screenCanReturn;
  if (conductorOf.size < links.length || (needGround && groundPath === undefined && !groundOnScreen)) {
    return { ok: false, reason: `${wire.label} has ${shape.conductors.length} conductors; this cable needs ${links.length + (needGround ? 1 : 0)}`, resolution, missing };
  }

  // parts
  const counters = new Map<string, number>();
  const locations = new Set((lib.vocab?.['locations']?.entries ?? []).map((e) => e.id));
  const placePart = (part: RecipePart, recipeId: string, end: End, location: string | undefined): string | undefined => {
    const def = componentForPart(lib, part);
    if (def === undefined) {
      missing.push({ code: 'part-not-in-library', message: `recipe ${recipeId} needs ${part.component ?? `${part.kind ?? 'a part'} ${part.value ?? ''}`.trim()}, which is not in the library`, end });
      return undefined;
    }
    const letter = KIND_LETTER[def.kind] ?? 'x';
    const n = (counters.get(letter) ?? 0) + 1;
    counters.set(letter, n);
    const id = `${letter}${n}`;
    const where = location ?? (end === 'source' ? 'source-hood' : 'dest-head');
    components.push({ id, def: def.id, ...(locations.has(where) ? { location: where } : {}) });
    return id;
  };
  const groundAt = (end: End): TerminalRef | undefined => {
    const g = option.grounds[end][0] ?? option.chassis[end][0];
    return g === undefined ? undefined : terminalAt[end](g);
  };
  const recipeOf = (id: string) => (lib.conditioningRecipes ?? []).find((r) => r.id === id);

  /** Join `pin` to `wireEnd` through the series parts, and hang the shunt parts off the pin. */
  const landLine = (end: End, pin: TerminalRef, wireEnd: TerminalRef, recipes: string[]): void => {
    let at: TerminalRef = pin;
    for (const rid of recipes) {
      const recipe = recipeOf(rid);
      if (recipe === undefined) continue;
      for (const part of recipe.parts.filter((p) => p.placement === 'series')) {
        const cid = placePart(part, rid, end, recipe.location);
        if (cid === undefined) continue;
        joints.push(end === 'source' ? { a: at, b: { instance: cid, terminal: 'a' } } : { a: { instance: cid, terminal: 'a' }, b: at });
        at = { instance: cid, terminal: 'b' };
      }
      for (const part of recipe.parts.filter((p) => p.placement !== 'series')) {
        const ground = groundAt(end);
        if (ground === undefined) {
          missing.push({ code: 'no-ground-for-part', message: `recipe ${rid} puts a part to ground at the ${end} end, which has no ground pin`, end });
          continue;
        }
        const cid = placePart(part, rid, end, recipe.location);
        if (cid === undefined) continue;
        joints.push({ a: pin, b: { instance: cid, terminal: 'a' } });
        joints.push({ a: { instance: cid, terminal: 'b' }, b: ground });
      }
    }
    joints.push(end === 'source' ? { a: at, b: wireEnd } : { a: wireEnd, b: at });
  };

  links.forEach((link, i) => {
    const path = conductorOf.get(i)!;
    const a: TerminalRef = { instance: 'w1', terminal: path, end: 'a' };
    const b: TerminalRef = { instance: 'w1', terminal: path, end: 'b' };
    const at = link.at ?? 'destination';
    landLine('source', terminalAt.source(link.from), a, at === 'source' ? link.recipes : []);
    landLine('destination', terminalAt.destination(link.to), b, at === 'destination' ? link.recipes : []);
  });

  // port requirements: parts across the two positions, or from one position to ground
  for (const req of option.requirements) {
    const recipe = recipeOf(req.recipe);
    if (recipe === undefined) continue;
    for (const part of recipe.parts) {
      const first = terminalAt[req.end](req.positions[0]!);
      if (part.placement === 'across' && req.positions.length === 2) {
        const cid = placePart(part, recipe.id, req.end, recipe.location);
        if (cid === undefined) continue;
        joints.push({ a: first, b: { instance: cid, terminal: 'a' } });
        joints.push({ a: { instance: cid, terminal: 'b' }, b: terminalAt[req.end](req.positions[1]!) });
        continue;
      }
      const ground = groundAt(req.end);
      if (ground === undefined) {
        missing.push({ code: 'no-ground-for-part', message: `recipe ${recipe.id} puts a part to ground at the ${req.end} end, which has no ground pin`, end: req.end });
        continue;
      }
      const cid = placePart(part, recipe.id, req.end, recipe.location);
      if (cid === undefined) continue;
      joints.push({ a: first, b: { instance: cid, terminal: 'a' } });
      joints.push({ a: { instance: cid, terminal: 'b' }, b: ground });
    }
  }

  // the screen: the drain (or the bonded mass's first member); a bonded mass is landed through a pigtail
  const policy = policyInForce(lib);
  const screen = (() => {
    const first = shape.screens[0];
    if (first === undefined) return undefined;
    const set = bondedSetOf(wire, first);
    const drain = set?.members.find((m) => {
      const el = resolveElementPath(wire.structure, m);
      return el?.kind === 'conductor' && el.bare === true;
    });
    return drain ?? set?.members[0] ?? first;
  })();
  const screenSet = screen === undefined ? undefined : bondedSetOf(wire, screen);
  const pigtails: Pigtail[] = [];
  const screenEnd = (end: 'a' | 'b'): TerminalRef => {
    if (screenSet === undefined) return { instance: 'w1', terminal: screen!, end };
    if (!pigtails.some((p) => p.end === end)) pigtails.push({ id: 'screen', end, ...(isFullyBonded(wire) ? {} : { members: [...screenSet.members] }) });
    return { instance: 'w1', terminal: 'pigtail:screen', end };
  };

  // the return: a conductor, or the screen when the stock has none to spare
  const chassisS = option.chassis.source[0];
  const chassisD = option.chassis.destination[0];
  const bridge = (end: End, from: string, to: string): void => void joints.push({ a: terminalAt[end](from), b: terminalAt[end](to) });
  if (groundPath !== undefined) {
    for (const g of option.grounds.source) joints.push({ a: terminalAt.source(g), b: { instance: 'w1', terminal: groundPath, end: 'a' } });
    for (const g of option.grounds.destination) joints.push({ a: { instance: 'w1', terminal: groundPath, end: 'b' }, b: terminalAt.destination(g) });
  } else if (groundOnScreen) {
    // the screen lands once per end, on the first ground pin; the other grounds and the chassis are bridged to it
    const [gs, ...moreS] = option.grounds.source;
    const [gd, ...moreD] = option.grounds.destination;
    joints.push({ a: terminalAt.source(gs!), b: screenEnd('a') });
    joints.push({ a: screenEnd('b'), b: terminalAt.destination(gd!) });
    for (const g of [...moreS, ...(chassisS === undefined ? [] : [chassisS])]) bridge('source', gs!, g);
    for (const g of [...moreD, ...(chassisD === undefined ? [] : [chassisD])]) bridge('destination', gd!, g);
    notes.push('the screen carries the return');
  }

  // the screen onto the chassis pins
  if (!groundOnScreen && screen !== undefined && (chassisS !== undefined || chassisD !== undefined)) {
    const landS = chassisS !== undefined;
    const landD = chassisD !== undefined && (policy.screens === 'both' || chassisS === undefined);
    if (landS) joints.push({ a: terminalAt.source(chassisS!), b: screenEnd('a') });
    if (landD) joints.push({ a: screenEnd('b'), b: terminalAt.destination(chassisD!) });
    if (landS && !landD) notes.push(`w1:${screen}@b is left open: the screen is grounded at the source end only`);
    if (landD && !landS) notes.push(`w1:${screen}@a is left open: the screen is grounded at the destination end only`);
  } else if (screen === undefined && chassisS !== undefined && chassisD !== undefined) {
    notes.push('the stock has no screen: the chassis pins are not joined');
  }

  const recipe: CableRecipe = {
    source: { device: src.id, port: ports.source.id },
    destination: { device: dst.id, port: ports.destination.id },
    option: option.id,
    stock: wire.id,
    ...(opts.lengthMm === undefined ? {} : { lengthMm: opts.lengthMm }),
  };
  const label = opts.label ?? `${src.label} → ${dst.label}`;
  const design: CableDesign = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: opts.id ?? kebab(`${src.id}-to-${dst.id}`),
    label,
    status: 'development',
    instances: {
      connectors,
      segments: [{ id: 'w1', def: wire.id, ...(opts.lengthMm === undefined ? {} : { lengthMm: opts.lengthMm }), ...(pigtails.length === 0 ? {} : { pigtails }) }],
      components,
      pcbas,
    },
    joints,
    notes: [`Derived by the resolver: ${src.label}, ${ports.source.label ?? ports.source.id} → ${dst.label}, ${ports.destination.label ?? ports.destination.id}; option "${option.label}" (${option.id}).`, ...notes, ...missing.map((m) => `Missing: ${m.message}`)],
    recipe,
    src: `derived by the resolver from the device profiles ${src.id} and ${dst.id}`,
  };
  // crimp housings: every cavity's contact, seal and plug from the library, by the wire landed in it
  let filled = design;
  for (const c of connectors) {
    const def = lib.connectors.find((x) => x.id === c.def);
    if (def !== undefined && housingOf(def, lib as Db) !== undefined) filled = fillCavities(filled, lib as Db, c.id);
  }
  return { ok: true, design: filled, option, resolution, stock: wire.id, missing };
}
