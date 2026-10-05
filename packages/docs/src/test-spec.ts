/**
 * `deriveTestSpec(design, db)` — what a bench tech or a QA dong verifies.
 *
 * Everything here folds out of `deriveNets` and `trace`. Three kinds of
 * assertion, and they are not interchangeable:
 *
 * - **Continuity.** Either "these ports are one piece of copper" (a net
 *   check), or "this port reaches that port *through something*" (a path
 *   check). The second kind is where the document earns its keep, because the
 *   thing in the way decides whether a meter reads anything at all — see
 *   `passages.ts` for the rules and the reasoning.
 * - **Isolation.** "These two must NOT be connected." Derived from signal
 *   classes rather than from the net partition, on purpose: asking "are the
 *   video ports and the ground ports in different nets?" catches a design
 *   that shorted them, whereas enumerating existing net *pairs* would just
 *   never emit the check and call the cable good.
 * - **Deliberate opens.** The cut drain at end b, the conductor nobody
 *   terminates, the connector pin this build does not populate. Printed so a
 *   tech reading a dead pin reaches for the notes instead of the iron.
 *
 * Every check carries a rationale in words, because a check a tech does not
 * understand is a check a tech overrides.
 */

import {
  assemblySides,
  commoningFacts,
  deriveNets,
  findConnector,
  findPcba,
  isGroundSignal,
  kindOfSignal,
  noteIndexReferencingTerminal,
  readSignalWords,
  terminalsOf,
  trace,
  unwiredTerminals,
  electricalReport,
  validateDesign,
  type CableDesign,
  type Db,
  type ElectricalReport,
  type Issue,
  type Net,
  type Passage,
  type ResolvedTerminal,
} from '@wirehub/model';

import {
  passageKey,
  passagesText,
  pathBehaviour,
  type PathBehaviour,
} from './passages.ts';
import { byKeys, compareStrings } from './text.ts';
import { deriveGroundLandings, type GroundLanding } from './landings.ts';

/* ------------------------------------------------------------------ *
 * Ports — the terminals a meter can actually touch
 * ------------------------------------------------------------------ */

/**
 * What kind of signal a port carries: the vocab `kind` of the signal its pin
 * label names (`readSignalWords` against the catalog's `signals` list —
 * `ground`, `power`, `audio`, `data`, or whatever kinds a domain module's pack
 * brings), falling back to the instance's role, else `other`. Grounds are
 * read first, so `Audio GND` is a ground, not an audio line.
 */
export type SignalClass = string;

function kindOfWords(db: Db, text: string | undefined): SignalClass | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const id = readSignalWords(db.vocab, text);
  if (id !== undefined) {
    if (isGroundSignal(db.vocab, id)) return 'ground';
    const kind = kindOfSignal(db, id);
    if (kind !== undefined && kind !== 'none') return kind;
  }
  // the base's own words, for a catalog with no vocabulary
  if (/\bgnd\b|ground|shell|chassis|\breturn\b|sleeve|\bshield\b/i.test(text)) return 'ground';
  if (/\+\s?\d+(\.\d+)?\s?v\b|\bvcc\b|\bvin\b|\bv\+/i.test(text)) return 'power';
  return undefined;
}

/**
 * Classify a port from its **pin label** first, and only fall back to the
 * instance's role when the label says nothing useful.
 *
 * This ordering is load-bearing: instance prose ("destination plug, sync
 * passthrough") mentions signals it does not carry, and letting it into the
 * classifier would reclassify every pin of that part — and then report a
 * perfectly good cable's pins as shorted to each other. Labels are per-pin
 * facts; notes are prose about the whole part. Only labels get to name a
 * pin's signal.
 */
function classifySignal(db: Db, label: string | undefined, role: string | undefined): SignalClass {
  return kindOfWords(db, label) ?? kindOfWords(db, role) ?? 'other';
}

/**
 * The family a class is held apart *as*: its kind. Two signals of one kind
 * on distinct nets must stay distinct; how a catalog groups its signals into
 * kinds (a video pack folds sync into `video`, because routing composite
 * onto a sync core is a design choice, not a defect) is the vocabulary's call.
 */
function isolationFamily(signal: SignalClass): SignalClass {
  return signal;
}

/** Which end of the finished assembly a port sits on. */
export type Side = 'a' | 'b' | 'both' | 'unassigned';

export interface Port {
  key: string;
  instance: string;
  terminal: string;
  label?: string;
  /** the instance's authored role, when it has one */
  role?: string;
  /** printable identity: `j1.7 TXD` */
  text: string;
  side: Side;
  signal: SignalClass;
  /** the net it lands in, when the design wires it at all */
  net?: string;
}

function portText(instance: string, terminal: string, label: string | undefined): string {
  return label === undefined ? `${instance}.${terminal}` : `${instance}.${terminal} ${label}`;
}

/* ------------------------------------------------------------------ *
 * Sides, derived from the joints
 * ------------------------------------------------------------------ */

/** Which end of the cable each instance lives on — core's `assemblySides`. */
function instanceSides(design: CableDesign): Map<string, Side> {
  return assemblySides(design);
}

/* ------------------------------------------------------------------ *
 * Port enumeration
 * ------------------------------------------------------------------ */

/**
 * The terminals a meter can reach on the finished assembly.
 *
 * Connector pins always count. A PCBA's *pads* never do — they are under the
 * hood — except for the pins of a connector the board carries integrated
 * (`u2:j1.15` is a connector pin you can put a probe on). The one further case
 * is a board that is the whole product: the JagSat bridge exposes its mating
 * faces as plain terminals with dotted prefixes and has no connector instance
 * jointed to it, so those become the ports rather than the document having no
 * probe points at all.
 */
export function designPorts(design: CableDesign, db: Db, nets: Net[]): Port[] {
  const sides = instanceSides(design);
  const netOf = new Map<string, string>();
  for (const net of nets) {
    for (const terminal of net.terminals) netOf.set(terminal.key, net.id);
  }

  const ports: Port[] = [];
  const push = (
    resolved: ResolvedTerminal,
    role: string | undefined,
  ): void => {
    const label = resolved.label;
    const port: Port = {
      key: resolved.key,
      instance: resolved.instance,
      terminal: resolved.terminal,
      ...(label === undefined ? {} : { label }),
      ...(role === undefined ? {} : { role }),
      text: portText(resolved.instance, resolved.terminal, label),
      side: sides.get(resolved.instance) ?? 'unassigned',
      signal: classifySignal(db, label, role),
      ...(netOf.has(resolved.key) ? { net: netOf.get(resolved.key) as string } : {}),
    };
    ports.push(port);
  };

  for (const instance of design.instances.connectors) {
    for (const resolved of terminalsOf(design, db, instance.id)) push(resolved, instance.role);
  }

  const connectorTouched = new Set<string>();
  for (const joint of design.joints) {
    for (const [near, far] of [
      [joint.a, joint.b],
      [joint.b, joint.a],
    ] as const) {
      if (design.instances.connectors.some((c) => c.id === near.instance)) {
        connectorTouched.add(far.instance);
      }
    }
  }

  for (const instance of design.instances.pcbas) {
    const pcba = findPcba(db, instance.def);
    if (pcba === undefined) continue;
    const prefixes = (pcba.integratedConnectors ?? []).map((i) => `${i.terminalPrefix}.`);
    const standalone = prefixes.length === 0 && !connectorTouched.has(instance.id);
    for (const resolved of terminalsOf(design, db, instance.id)) {
      const integrated = prefixes.some((prefix) => resolved.terminal.startsWith(prefix));
      const mating = standalone && resolved.terminal.includes('.');
      if (!integrated && !mating) continue;
      // no role: a PCBA instance note is prose about the board, not a claim
      // about what this pin carries
      push(resolved, undefined);
    }
  }

  ports.sort(byKeys<Port>((port) => port.key));
  return ports;
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

export interface NetCheck {
  id: string;
  kind: 'net';
  net: string;
  /** the ports on this net, in key order */
  ports: Port[];
  /** which ends of the assembly the net reaches */
  ends: Side[];
  signal: SignalClass;
  expected: string;
  rationale: string;
}

export interface PathCheck {
  id: string;
  kind: 'path';
  from: Port;
  to: Port;
  /** the passage descriptions, in order along the path */
  through: string[];
  behaviour: PathBehaviour;
  /** the single most important bit: will a DC meter read this at all? */
  dcContinuous: boolean;
  /** how many port pairs this one row stands for */
  covers: number;
  expected: string;
  rationale: string;
}

export interface IsolationCheck {
  id: string;
  kind: 'isolation';
  a: Port;
  b: Port;
  /** the classes being held apart: `video vs ground` */
  rule: string;
  /** the end of the assembly this check is run at */
  side: Side;
  expected: string;
  rationale: string;
  netA?: string;
  netB?: string;
  /** true when the two are in fact one net — the cable is shorted */
  violated: boolean;
  /**
   * Set when the two are one net *on purpose*: the recorded fact that says so
   * (`u1 LA tagged audio-mono (PCA-00102-rev2)`, `one source pin j1.1`).
   * Such a check is a continuity row, never a violation.
   */
  commoned?: string;
}

export type OpenKind = 'cut-end' | 'unterminated' | 'unused-pin';

export interface OpenCheck {
  id: string;
  kind: 'open';
  openKind: OpenKind;
  /** terminal key */
  key: string;
  text: string;
  expected: string;
  rationale: string;
  /** 0-based index of the design note that authorises it, when one does */
  noteIndex?: number;
}

/**
 * A pre-shell visual check of one pigtail: the twist is present, on that
 * pad, and nothing else is on it (specs/shield-bonding.md §2.4).
 */
export interface GroundLandingCheck extends GroundLanding {
  id: string;
  kind: 'ground-landing';
  expected: string;
}

export type TestCheck = NetCheck | PathCheck | IsolationCheck | OpenCheck | GroundLandingCheck;

export interface TestSpec {
  designId: string;
  designLabel: string;
  productRef?: string;
  ports: Port[];
  netChecks: NetCheck[];
  pathChecks: PathCheck[];
  isolationChecks: IsolationCheck[];
  openChecks: OpenCheck[];
  /** one visual check per pigtail per end, before the shell goes on */
  groundLandings: GroundLandingCheck[];
  /** isolation checks whose two sides turned out to be one net */
  violations: IsolationCheck[];
  /**
   * Two channels of one family on one net by design (a mono source on both
   * inputs of a stereo plug, L = R): continuity rows, each citing the
   * fact that makes it deliberate. Undeclared commoning is a violation.
   */
  commoned: IsolationCheck[];
  summary: {
    commoned: number;
    ports: number;
    nets: number;
    continuity: number;
    /** path checks a DC meter will NOT read: caps and active silicon */
    nonDcPaths: number;
    isolation: number;
    opens: number;
    groundLandings: number;
    violations: number;
  };
  /** currents declared in the design: per-conductor ampacity, contact rating and voltage drop (empty when none are declared) */
  electrical: ElectricalReport;
  issues: Issue[];
}

/* ------------------------------------------------------------------ *
 * deriveTestSpec
 * ------------------------------------------------------------------ */

const SIDE_WORD: Readonly<Record<Side, string>> = {
  a: 'source end (a)',
  b: 'destination end (b)',
  both: 'both ends',
  unassigned: 'unassigned',
};

/**
 * Isolation rules, as class-family pairs plus why a bench cares, built from
 * the kinds the design's ports actually carry (`isolationRules`).
 *
 * Classes here are *families* (`isolationFamily`). Cross-family pairs are
 * absolute: finding one net carrying both is a defect, and the check is
 * emitted as a violation. Same-family pairs are asserted only between nets
 * that are already distinct — because a design that deliberately commons two
 * nets of a family (a mono source: one net feeds both channels) is not
 * broken, and the honest output is no check rather than a false failure.
 *
 * `control` and `data` lines appear in no rule: a control line is often
 * *supposed* to sit on a rail, or to be fed from one through a resistor, and a
 * rule that called those shorts would cry wolf on every such cable.
 */
interface IsolationRule {
  a: SignalClass;
  b: SignalClass;
  why: string;
}

/** Kinds no isolation rule is about. */
const UNRULED = new Set<SignalClass>(['ground', 'power', 'control', 'data', 'none', 'other']);

/** Wording for the base's own line kinds; any other kind gets the generic sentence. */
const LINE_WORDING: Readonly<Record<string, { toGround: string; fromRail: string; withinFamily: string }>> = {
  audio: {
    toGround: 'an audio line shorted to ground is a silent channel',
    fromRail: 'the rail on an audio line is a loud DC thump and a damaged input',
    withinFamily: 'left shorted to right is a mono cable sold as stereo',
  },
};

function wordingOf(kind: SignalClass): { toGround: string; fromRail: string; withinFamily: string } {
  return (
    LINE_WORDING[kind] ?? {
      toGround: `a ${kind} line shorted to ground is a dead channel`,
      fromRail: `the rail on a ${kind} line drives the input out of range`,
      withinFamily: `separate ${kind} nets that short together bleed into one another`,
    }
  );
}

/** The rules for the line kinds present: each to ground, the rail to ground, the rail to each, across kinds, within each. */
export function isolationRules(kinds: Iterable<SignalClass>): IsolationRule[] {
  const lines = [...new Set(kinds)].filter((kind) => !UNRULED.has(kind)).sort(compareStrings);
  const rules: IsolationRule[] = [];
  for (const kind of lines) rules.push({ a: kind, b: 'ground', why: wordingOf(kind).toGround });
  rules.push({ a: 'power', b: 'ground', why: 'the rail shorted to ground draws the source device down and can damage it' });
  for (const kind of lines) rules.push({ a: 'power', b: kind, why: wordingOf(kind).fromRail });
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i] as string;
      const b = lines[j] as string;
      rules.push({ a, b, why: `${a} bleeding onto a ${b} line is interference` });
    }
  }
  for (const kind of lines) rules.push({ a: kind, b: kind, why: wordingOf(kind).withinFamily });
  return rules;
}

export interface TestSpecOptions {
  /**
   * The continuity threshold the expected readings quote (Ω). The default is
   * the base's (`DEFAULT_TEST_PARAMETERS.continuityOhmsMax`, 5 Ω).
   */
  continuityOhmsMax?: number;
}

/** The threshold the derivations' wording is written for; another value is substituted into it. */
const WORDED_OHMS = 5;
const withThreshold = (text: string, ohms: number | undefined): string =>
  ohms === undefined || ohms === WORDED_OHMS ? text : text.replace(`< ${WORDED_OHMS} Ω`, `< ${ohms} Ω`);

export function deriveTestSpec(design: CableDesign, db: Db, options: TestSpecOptions = {}): TestSpec {
  const nets = deriveNets(design, db);
  const ports = designPorts(design, db, nets);
  const netById = new Map(nets.map((net) => [net.id, net]));

  /* --- net checks: one galvanic net, one row ----------------------- */
  const netChecks: NetCheck[] = [];
  for (const net of nets) {
    const members = ports.filter((port) => port.net === net.id);
    if (members.length < 2) continue;
    const ends = [...new Set(members.map((port) => port.side))].sort(compareStrings) as Side[];
    const signal = dominantSignal(members);
    const spans = ends.includes('a') && ends.includes('b');
    netChecks.push({
      id: `net/${net.id}`,
      kind: 'net',
      net: net.id,
      ports: members,
      ends,
      signal,
      expected: withThreshold('Continuity between every pair listed — meter beeps, < 5 Ω.', options.continuityOhmsMax),
      rationale: spans
        ? `One galvanic net of plain copper spanning both ends of the assembly (${signal}). Every port listed is the same node; probe any pair.`
        : `One galvanic net of plain copper (${signal}), ${ends.map((end) => SIDE_WORD[end]).join(' + ')}. Every port listed is the same node; probe any pair.`,
    });
  }
  netChecks.sort(byKeys<NetCheck>((check) => check.net.padStart(8, '0'), (check) => check.id));

  /* --- path checks: reachable, but through something ---------------- */
  // One trace per port, then collapse by (source net, destination net, what
  // is in the way). The net checks already prove every port on a net is one
  // node, so the XCLK pulldown reaching thirteen separate ground pins is one
  // assertion covering thirteen probe pairs — not thirteen identical rows
  // that bury the three that differ.
  interface Candidate {
    from: Port;
    to: Port;
    passages: Passage[];
  }
  const groups = new Map<string, Candidate[]>();
  const seenPair = new Set<string>();
  const portByKey = new Map(ports.map((port) => [port.key, port]));
  for (const from of ports) {
    if (from.net === undefined) continue;
    const result = trace(design, db, { instance: from.instance, terminal: from.terminal });
    for (const step of result.reached) {
      if (step.passages.length === 0) continue;
      const to = portByKey.get(step.terminal.key);
      if (to === undefined || to.net === undefined) continue;
      if (compareStrings(from.key, to.key) >= 0) continue;
      const pair = `${from.key}|${to.key}`;
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);
      const groupKey = [from.net, to.net].sort(compareStrings).join('|') +
        `|${passageKey(step.passages)}`;
      const bucket = groups.get(groupKey);
      if (bucket === undefined) groups.set(groupKey, [{ from, to, passages: step.passages }]);
      else bucket.push({ from, to, passages: step.passages });
    }
  }
  const pathChecks: PathCheck[] = [];
  for (const bucket of groups.values()) {
    const sorted = [...bucket].sort(
      byKeys<Candidate>((entry) => entry.from.key, (entry) => entry.to.key),
    );
    const representative = sorted[0] as Candidate;
    pathChecks.push(
      makePathCheck(
        representative.from,
        representative.to,
        representative.passages,
        db,
        sorted.length,
      ),
    );
  }
  pathChecks.sort(byKeys<PathCheck>((check) => check.from.key, (check) => check.to.key));
  for (const check of pathChecks) check.expected = withThreshold(check.expected, options.continuityOhmsMax);

  /* --- isolation --------------------------------------------------- */
  // net pairs a path already joins are *related by design* — a core and the
  // pin it feeds sit either side of a series capacitor — so they are not isolation
  // candidates. Suppressing them here rather than in the rule table keeps the
  // rules about signals and this about topology.
  const linked = new Set<string>();
  for (const check of pathChecks) {
    if (check.from.net === undefined || check.to.net === undefined) continue;
    linked.add([check.from.net, check.to.net].sort(compareStrings).join('|'));
  }
  const commoning = deriveCommoning(design, db, ports, nets, options);
  const isolationChecks = [...deriveIsolation(ports, netById, linked), ...commoning.shorts];
  isolationChecks.sort(
    byKeys<IsolationCheck>(
      (check) => check.side,
      (check) => check.rule,
      (check) => check.a.key,
      (check) => check.b.key,
    ),
  );

  /* --- deliberate opens -------------------------------------------- */
  const openChecks = deriveOpens(design, db, nets);

  /* --- ground landings: the twists, checked by eye ------------------ */
  const groundLandings: GroundLandingCheck[] = deriveGroundLandings(design, db).map((row) => ({
    ...row,
    id: `landing/${row.key}`,
    kind: 'ground-landing',
    expected:
      row.landing === ''
        ? 'NOT LANDED — the design is missing this landing; query the designer.'
        : `Twist present, on ${row.pad === undefined ? row.landing : `pad ${row.pad}`}, nothing else on it.`,
  }));

  const violations = isolationChecks.filter((check) => check.violated);
  const nonDcPaths = pathChecks.filter((check) => !check.dcContinuous).length;

  return {
    designId: design.id,
    designLabel: design.label,
    ...(design.productRef === undefined ? {} : { productRef: design.productRef }),
    ports,
    netChecks,
    pathChecks,
    isolationChecks,
    openChecks,
    groundLandings,
    violations,
    commoned: commoning.commoned,
    summary: {
      ports: ports.length,
      nets: nets.length,
      continuity: netChecks.length + pathChecks.length,
      nonDcPaths,
      isolation: isolationChecks.length,
      opens: openChecks.length,
      groundLandings: groundLandings.length,
      violations: violations.length,
      commoned: commoning.commoned.length,
    },
    electrical: electricalReport(design, db),
    issues: validateDesign(design, db),
  };
}

function dominantSignal(ports: Port[]): SignalClass {
  const counts = new Map<SignalClass, number>();
  for (const port of ports) counts.set(port.signal, (counts.get(port.signal) ?? 0) + 1);
  let best: SignalClass = 'other';
  let bestCount = -1;
  for (const [signal, count] of [...counts.entries()].sort((x, y) => compareStrings(x[0], y[0]))) {
    if (signal === 'other') continue;
    if (count > bestCount) {
      best = signal;
      bestCount = count;
    }
  }
  return bestCount === -1 ? 'other' : best;
}

function makePathCheck(
  from: Port,
  to: Port,
  passages: Passage[],
  db: Db,
  covers: number,
): PathCheck {
  const behaviour = pathBehaviour(passages, db);
  const through = passages.map((passage) => passage.description);
  const alsoCovers =
    covers <= 1
      ? ''
      : ` This one row covers ${covers} probe pairs — every other port on the two nets is the same node.`;
  const rationale =
    behaviour.verdict === 'exclusive'
      ? `${from.text} appears to reach ${to.text} through ${passagesText(passages)}, but that path runs through one part in two states at once. No build has it. Listed so the model's own limitation is visible, not so it is tested.`
      : behaviour.verdict === 'active'
      ? `${from.text} reaches ${to.text} only through active silicon (${passagesText(passages)}). There is no galvanic path: the output is generated, not conducted. A continuity meter reading OPEN here is the correct result, and a tech who "fixes" it destroys the build.`
      : behaviour.verdict === 'blocked'
        ? `${from.text} reaches ${to.text} through ${passagesText(passages)}. A series capacitor passes signal and blocks DC by design, so a continuity meter reads OPEN. Verify with a signal, or check the capacitor in circuit — never bridge it.`
        : behaviour.verdict === 'resistive'
          ? `${from.text} reaches ${to.text} through ${passagesText(passages)}. A meter on a resistance range predicts the reading; a continuity buzzer may or may not sound depending on its threshold.`
          : behaviour.verdict === 'conditional'
            ? `${from.text} reaches ${to.text} through ${passagesText(passages)}, whose state is a build option. Read the board's build before judging the meter.`
            : `${from.text} reaches ${to.text} through ${passagesText(passages)}.`;
  return {
    id: `path/${from.key}->${to.key}`,
    kind: 'path',
    from,
    to,
    through,
    behaviour,
    dcContinuous: behaviour.dcContinuous,
    covers,
    expected: behaviour.expectation,
    rationale: `${rationale}${alsoCovers}`,
  };
}

/* ------------------------------------------------------------------ *
 * Isolation
 * ------------------------------------------------------------------ */

/**
 * Isolation, per **end of the assembly** and per **net pair** — not per pin
 * pair, and never across the length of the cable.
 *
 * Two collapses, each for a reason:
 *
 * - *Per net pair.* Six ground pins against four signal nets is four
 *   assertions, not twenty-four: the ground pins are already proven to be one
 *   node by the net check, so the cross product only buries the four facts
 *   that matter. Each row names a representative port from each net and how
 *   many further terminals ride with it.
 * - *Per end.* A short is a physical event — solder bridging two pins in one
 *   hood, or a stray braid whisker at the far head. Asserting that a pin in
 *   the source plug is isolated from a pin 1830 mm away in the far head is
 *   neither a plausible defect nor a check anyone can run with two probes in
 *   one hand. So candidates are grouped by the end they sit on.
 *
 * `linkedNets` holds net pairs a path already joins — a core either side of a series part —
 * which are related by design and so not isolation candidates at all.
 */
function deriveIsolation(
  ports: Port[],
  netById: Map<string, Net>,
  linkedNets: Set<string>,
): IsolationCheck[] {
  const wired = ports.filter((port) => port.net !== undefined);
  const sidesPresent = [...new Set(wired.map((port) => port.side))].sort(compareStrings) as Side[];

  const checks: IsolationCheck[] = [];
  const seen = new Set<string>();

  for (const side of sidesPresent) {
    const here = wired.filter((port) => port.side === side || port.side === 'both');
    const byClass = new Map<SignalClass, Port[]>();
    for (const port of here) {
      const family = isolationFamily(port.signal);
      const bucket = byClass.get(family);
      if (bucket === undefined) byClass.set(family, [port]);
      else bucket.push(port);
    }

    /** one representative port per net, for a family, on this end */
    const representatives = (signal: SignalClass): Map<string, Port> => {
      const out = new Map<string, Port>();
      for (const port of byClass.get(signal) ?? []) {
        const net = port.net as string;
        const existing = out.get(net);
        if (existing === undefined || compareStrings(port.key, existing.key) < 0) {
          out.set(net, port);
        }
      }
      return out;
    };

    const isLinked = (netA: string, netB: string): boolean =>
      linkedNets.has([netA, netB].sort(compareStrings).join('|'));

    for (const rule of isolationRules(byClass.keys())) {
      const left = representatives(rule.a);
      const right = representatives(rule.b);
      const ruleName = `${rule.a} vs ${rule.b}`;

      if (rule.a === rule.b) {
        // same family: every pair of *distinct* nets inside it must stay
        // distinct. Nets the design deliberately commons (mono audio)
        // simply produce no pair, which is the honest answer.
        const netIds = [...left.keys()].sort(compareStrings);
        for (let i = 0; i < netIds.length; i += 1) {
          for (let j = i + 1; j < netIds.length; j += 1) {
            const netA = netIds[i] as string;
            const netB = netIds[j] as string;
            if (isLinked(netA, netB)) continue;
            pushCheck(
              checks,
              seen,
              left.get(netA) as Port,
              left.get(netB) as Port,
              ruleName,
              rule.why,
              false,
              netById,
              side,
            );
          }
        }
        continue;
      }

      // cross family: a net carrying both is a defect, and saying so *is* the
      // check — this is the case a net-pair enumeration would silently skip
      const shared = [...left.keys()].filter((net) => right.has(net));
      for (const net of shared.sort(compareStrings)) {
        pushCheck(
          checks,
          seen,
          left.get(net) as Port,
          right.get(net) as Port,
          ruleName,
          rule.why,
          true,
          netById,
          side,
        );
      }
      for (const [netA, a] of [...left.entries()].sort((x, y) => compareStrings(x[0], y[0]))) {
        for (const [netB, b] of [...right.entries()].sort((x, y) => compareStrings(x[0], y[0]))) {
          if (netA === netB) continue;
          if (isLinked(netA, netB)) continue;
          pushCheck(checks, seen, a, b, ruleName, rule.why, false, netById, side);
        }
      }
    }
  }

  checks.sort(
    byKeys<IsolationCheck>(
      (check) => check.side,
      (check) => check.rule,
      (check) => check.a.key,
      (check) => check.b.key,
    ),
  );
  return checks;
}

function pushCheck(
  checks: IsolationCheck[],
  seen: Set<string>,
  a: Port,
  b: Port,
  rule: string,
  why: string,
  violated: boolean,
  netById: Map<string, Net>,
  side: Side,
): void {
  const [first, second] = compareStrings(a.key, b.key) <= 0 ? [a, b] : [b, a];
  const id = `isolation/${rule}/${first.key}|${second.key}`;
  if (seen.has(id)) return;
  seen.add(id);
  const ridersA = (netById.get(first.net ?? '')?.terminals.length ?? 1) - 1;
  const ridersB = (netById.get(second.net ?? '')?.terminals.length ?? 1) - 1;
  checks.push({
    id,
    kind: 'isolation',
    a: first,
    b: second,
    rule,
    side,
    expected: violated
      ? 'FAIL — these are one net in this design; they must not be.'
      : 'No continuity — meter reads OPEN.',
    rationale: violated
      ? `${first.text} and ${second.text} are the SAME net (${first.net}) in this design, but ${why}. This is a short, not a check.`
      : `${first.text} (net ${first.net}, ${ridersA} other terminal(s)) and ${second.text} (net ${second.net}, ${ridersB} other terminal(s)) are separate nets, and must stay separate: ${why}.`,
    ...(first.net === undefined ? {} : { netA: first.net }),
    ...(second.net === undefined ? {} : { netB: second.net }),
    violated,
  });
}

/* ------------------------------------------------------------------ *
 * Commoning — two channels on one net
 * ------------------------------------------------------------------ */

/** The mating face a port sits on: a connector instance, or one integrated connector of a board. */
function faceOf(port: Port, boards: Set<string>): string {
  if (!boards.has(port.instance)) return port.instance;
  const dot = port.terminal.indexOf('.');
  return dot === -1 ? port.instance : `${port.instance}:${port.terminal.slice(0, dot)}`;
}

/**
 * Same-family isolation can only compare *distinct* nets, so a design that
 * puts two channels of one family on one net produced no row at all — mono by
 * design (the source device, the device) and L bridged to R read the same. This looks
 * for exactly that: two ports of one family, on one mating face, on one net.
 *
 * Such a pair is **commoned by design** when the data says so — a terminal
 * of the net is tagged mono (`audio-mono`: a board's LA/RA pads, a
 * DIN mono audio pin), or the recipe's source device has mono audio — or when the
 * net fans out from **one source pin**: some other face at the source end
 * contributes exactly one port of the family. Otherwise it is a short, and
 * reported as a violation.
 */
function deriveCommoning(
  design: CableDesign,
  db: Db,
  ports: Port[],
  nets: Net[],
  options: TestSpecOptions,
): { commoned: IsolationCheck[]; shorts: IsolationCheck[] } {
  const boards = new Set(design.instances.pcbas.map((p) => p.id));
  const netById = new Map(nets.map((net) => [net.id, net]));
  const commoned: IsolationCheck[] = [];
  const shorts: IsolationCheck[] = [];
  const seen = new Set<string>();

  const groups = new Map<string, Port[]>();
  for (const port of ports) {
    if (port.net === undefined) continue;
    const family = isolationFamily(port.signal);
    if (family !== 'audio' && family !== 'video') continue;
    const key = `${port.net}|${family}|${faceOf(port, boards)}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [port]);
    else bucket.push(port);
  }

  for (const [key, members] of [...groups.entries()].sort((x, y) => compareStrings(x[0], y[0]))) {
    const channels = [...new Map(members.map((port) => [port.label ?? port.terminal, port])).values()];
    if (channels.length < 2) continue;
    const [netId, family, face] = key.split('|') as [string, 'audio' | 'video', string];
    const net = netById.get(netId) as Net;
    const facts = commoningFacts(design, db, net)
      .filter((fact) => fact.kind === family)
      .map((fact) => fact.source);
    if (facts.length === 0) {
      // one source pin: another face at the source end carries exactly one port of the family
      const byFace = new Map<string, Port[]>();
      for (const port of ports) {
        if (port.net !== netId || isolationFamily(port.signal) !== family) continue;
        const other = faceOf(port, boards);
        if (other === face || port.side !== 'a') continue;
        const bucket = byFace.get(other);
        if (bucket === undefined) byFace.set(other, [port]);
        else bucket.push(port);
      }
      const origin = [...byFace.values()].filter((list) => list.length === 1).map((list) => list[0] as Port);
      origin.sort(byKeys<Port>((port) => port.key));
      if (origin.length > 0) facts.push(`one source pin ${(origin[0] as Port).text}`);
    }
    const ordered = [...channels].sort(byKeys<Port>((port) => port.key));
    const rule = `${family} vs ${family}`;
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const a = ordered[i] as Port;
      const b = ordered[i + 1] as Port;
      const id = `${facts.length > 0 ? 'commoned' : 'isolation'}/${rule}/${a.key}|${b.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const side = a.side;
      const riders = net.terminals.length - 2;
      if (facts.length > 0) {
        const source = facts.join('; ');
        commoned.push({
          id,
          kind: 'isolation',
          a,
          b,
          rule,
          side,
          expected: 'Continuity — one net by design, meter beeps.',
          rationale: `${a.text} and ${b.text} are one net (${netId}, ${riders} other terminal(s)) on purpose — commoned by design (${source}).`,
          netA: netId,
          netB: netId,
          violated: false,
          commoned: source,
        });
      } else {
        const why = isolationRules([family]).find((r) => r.a === family && r.b === family)?.why ?? '';
        shorts.push({
          id,
          kind: 'isolation',
          a,
          b,
          rule,
          side,
          expected: 'FAIL — these are one net in this design; they must not be.',
          rationale: `${a.text} and ${b.text} are the SAME net (${netId}) in this design, and nothing records the commoning as deliberate (no mono tag, no mono source device, no single source pin): ${why}. This is a short, not a check.`,
          netA: netId,
          netB: netId,
          violated: true,
        });
      }
    }
  }
  return { commoned, shorts };
}

/* ------------------------------------------------------------------ *
 * Deliberate opens
 * ------------------------------------------------------------------ */

/**
 * Terminals that are open on purpose.
 *
 * The cut drain is the headline: house standard work terminates it at the
 * source end only, so `w1 drain@b` is unwired *by policy*, and the design
 * note says so. Core already has the "does a note name this terminal?"
 * helper, so a note that authorises the open is quoted by index rather than
 * re-detected here.
 */
function deriveOpens(design: CableDesign, db: Db, nets: Net[]): OpenCheck[] {
  // core's unwired list already drops pigtails, the foil (trimmed back at
  // both ends and never indicated) and any screen
  // a landed pigtail or landed bonded mass terminates (shield bonding)
  const unwired = unwiredTerminals(design, db);
  const unwiredKeys = new Set(unwired.map((terminal) => terminal.key));
  const inNet = new Set<string>();
  for (const net of nets) for (const terminal of net.terminals) inNet.add(terminal.key);

  const out: OpenCheck[] = [];

  for (const segment of design.instances.segments) {
    const byPath = new Map<string, ResolvedTerminal[]>();
    for (const terminal of unwired) {
      if (terminal.instance !== segment.id) continue;
      const bucket = byPath.get(terminal.terminal);
      if (bucket === undefined) byPath.set(terminal.terminal, [terminal]);
      else bucket.push(terminal);
    }
    for (const [path, open] of [...byPath.entries()].sort((x, y) => compareStrings(x[0], y[0]))) {
      // a segment path has one terminal per end
      const bothOpen = open.length === 2;
      for (const terminal of open) {
        const noteIndex = noteIndexReferencingTerminal(design, {
          instance: terminal.instance,
          terminal: terminal.terminal,
          ...(terminal.end === undefined ? {} : { end: terminal.end }),
        });
        out.push({
          id: `open/${terminal.key}`,
          kind: 'open',
          openKind: bothOpen ? 'unterminated' : 'cut-end',
          key: terminal.key,
          text: `${terminal.instance} ${path}${terminal.end === undefined ? '' : ` @${terminal.end}`}${
            terminal.label === undefined ? '' : ` (${terminal.label})`
          }`,
          expected: 'Open circuit — no continuity to anything. Leave it that way.',
          rationale: bothOpen
            ? `${path} is not terminated at either end of ${terminal.instance}: this design carries the conductor but does not use it.${
                noteIndex === undefined ? '' : ` Design note ${noteIndex + 1} covers it.`
              }`
            : `${path} is terminated at the other end of ${terminal.instance} and deliberately open here — the house drain/shield policy, not a missed joint.${
                noteIndex === undefined
                  ? ' No design note names it; treat as a query for the designer.'
                  : ` Design note ${noteIndex + 1} covers it.`
              }`,
          ...(noteIndex === undefined ? {} : { noteIndex }),
        });
      }
    }
  }

  for (const instance of design.instances.connectors) {
    const connector = findConnector(db, instance.def);
    if (connector === undefined) continue;
    for (const pin of connector.pins) {
      const key = `${instance.id}:${pin.id}`;
      if (!unwiredKeys.has(key) || inNet.has(key)) continue;
      const noteIndex = noteIndexReferencingTerminal(design, {
        instance: instance.id,
        terminal: pin.id,
      });
      out.push({
        id: `open/${key}`,
        kind: 'open',
        openKind: 'unused-pin',
        key,
        text: `${instance.id}.${pin.id} (${pin.label})`,
        expected: 'Open circuit — this pin is not populated on this build.',
        rationale: `${connector.label} pin ${pin.id} carries no connection in this design.${
          noteIndex === undefined ? '' : ` Design note ${noteIndex + 1} explains why.`
        }${pin.note === undefined ? '' : ` Pin note: ${pin.note}`}`,
        ...(noteIndex === undefined ? {} : { noteIndex }),
      });
    }
  }

  out.sort(byKeys<OpenCheck>((check) => check.openKind, (check) => check.key));
  return out;
}

export { SIDE_WORD };
