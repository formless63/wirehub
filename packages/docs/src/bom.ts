/**
 * `deriveBom(design, db)` — every physical part the cable consumes.
 *
 * The BOM is not authored anywhere. It is a fold of the design's instances
 * against the definition library: four connector instances of the same def
 * with the same role are one line of quantity four; three 220 µF tantalums at
 * the SCART head are one line of quantity three at that location; a 1830 mm
 * trunk is one line whose length is printed in both millimetres (what the
 * spec says) and feet and inches (what the bench cuts to).
 *
 * Three rules the shape follows:
 *
 * 1. **Every line names the instances that produced it.** `provenance` is not
 *    decoration: a tech holding a sheet that says "3 × 220 µF" needs to know
 *    they are `c1`, `c2`, `c3` and which signal each couples, and a buyer
 *    reconciling a count needs to see the fold.
 * 2. **A PCBA is one part, not its contents.** The board's own capacitors are
 *    the board vendor's BOM. What this document must pin down is *which*
 *    board: part number, revision and build, because `PCA-00101 Rev6 CPL
 *    Basic` and `PCA-00101 Rev6 CPL Full` are the same PCB and different
 *    cables.
 * 3. **Missing identity is reported, never invented.** Where a definition
 *    carries no part number the line says so and the gap is listed, rather
 *    than a plausible number being folded out of a citation string.
 */

import {
  designInstances,
  findComponent,
  findConnector,
  findInstance,
  findMechanical,
  findPcba,
  findWire,
  kitsContaining,
  passThroughRuns,
  validateDesign,
  wireEndsOf,
  type CableDesign,
  type Db,
  type Issue,
} from '@wirehub/model';

import { byKeys, compareStrings, facts } from './text.ts';
import { wireDisplayName } from '@wirehub/model';
import { lengthFromMm, type Length } from './units.ts';
import { suppliedEnds } from './supplied.ts';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type BomCategory = 'wire' | 'assembly' | 'pcba' | 'connector' | 'shell' | 'hardware' | 'component';

/**
 * Print order: what you cut, what you populate, what you terminate with, what
 * houses it, what fastens the housing shut, what you solder in loose
 * (: shells and hardware sit between the connector they
 * enclose and the discretes, matching build order — house the plug, close the
 * shell, then the inline components).
 */
export const BOM_CATEGORY_ORDER: readonly BomCategory[] = [
  'wire',
  'assembly',
  'pcba',
  'connector',
  'shell',
  'hardware',
  'component',
];

const CATEGORY_LABEL: Readonly<Record<BomCategory, string>> = {
  wire: 'Wire stock',
  assembly: 'Sub-assembly',
  pcba: 'PCBA',
  connector: 'Connector',
  shell: 'Shell',
  hardware: 'Hardware',
  component: 'Component',
};

export interface BomLine {
  /** deterministic identity of this fold; stable across runs */
  key: string;
  category: BomCategory;
  /** pieces for `ea`; the same number of pieces for wire, whose length is separate */
  qty: number;
  unit: 'ea';
  /** definition id the line folds */
  ref: string;
  label: string;
  /** catalog / manufacturer part number, when the definition carries one */
  partNumber?: string;
  /** the value a buyer orders on: `220 µF`, `Rev6 · CPL Basic`, `1830 mm (6 ft 0 in)` */
  value?: string;
  /** where in the assembly it sits */
  location: string;
  /** secondary identity: family, gender, spec ref, per-instance notes */
  detail?: string;
  /** per-piece length, for wire lines */
  length?: Length;
  /** qty × per-piece length, for wire lines */
  totalMm?: number;
  /** instance ids that produced this line, sorted */
  provenance: string[];
  /** the definition's own citation */
  src?: string;
}

/** A branch of the assembly — an audio whip, a light-gun leg, a TRS pigtail. */
export interface BomAssembly {
  key: string;
  kind: 'whip' | 'leg' | 'branch';
  label: string;
  segment?: {
    instance: string;
    ref: string;
    label: string;
    length?: Length;
  };
  terminations: {
    instance: string;
    ref: string;
    label: string;
    role?: string;
  }[];
  provenance: string[];
}

/** A build-or-buy topic a note touches. */
export type BomTopic =
  | 'drain-policy'
  | 'housing'
  | 'wire-stock'
  | 'component-value'
  | 'unwired'
  | 'build-option'
  | 'prep'
  | 'length';

export interface BomNote {
  /** `notes[0]`, `w1.role`, `u2.note` — where the sentence actually lives */
  source: string;
  /** 0-based index into `design.notes`, when it is a design note */
  noteIndex?: number;
  text: string;
  topics: BomTopic[];
}

export interface Bom {
  designId: string;
  designLabel: string;
  productRef?: string;
  lines: BomLine[];
  assemblies: BomAssembly[];
  /** the notes that change what you buy or how you build it */
  notes: BomNote[];
  /** identities the catalog cannot supply today, stated rather than invented */
  gaps: string[];
  /** the trunk stock line, when the design has wire in it */
  trunk?: BomLine;
  issues: Issue[];
}

/* ------------------------------------------------------------------ *
 * Where an instance sits
 * ------------------------------------------------------------------ */

/**
 * Which wire ends an instance is soldered to, derived from the joints.
 *
 * End `a` is the console side and end `b` the destination side by house
 * convention, so this is how a board or a plug learns which end of the cable
 * it lives on without anyone authoring it twice.
 */
function attachedEnds(design: CableDesign, instanceId: string): Set<string> {
  return new Set(wireEndsOf(design, instanceId).map((e) => `${e.segment}@${e.end}`));
}

function endSummary(ends: Set<string>): string {
  if (ends.size === 0) return 'no wire joint';
  return [...ends].sort(compareStrings).join(', ');
}

/** `source end (a)` / `destination end (b)` / `both ends`, from the wire ends. */
function sideOf(ends: Set<string>): string {
  const sides = new Set([...ends].map((entry) => entry.slice(-1)));
  if (sides.size === 0) return 'standalone (no wire)';
  if (sides.size > 1) return 'both ends';
  return sides.has('a') ? 'source end (a)' : 'destination end (b)';
}

/* ------------------------------------------------------------------ *
 * Notes roll-up
 * ------------------------------------------------------------------ */

const TOPIC_PATTERNS: readonly (readonly [BomTopic, RegExp])[] = [
  ['drain-policy', /\bdrain\b/i],
  ['housing', /\bhousing|hood|shell|strain relief|overmold/i],
  ['wire-stock', /\bmini[- ]?coax|\bcoax|wire stock|core-\w/i],
  ['component-value', /\d\s*(Ω|µF|nF|pF|ohms?)\b/i],
  [
    'unwired',
    /\bunwired|not connected|not populated|left unconnected|deliberately cut|unterminated|no use for it\b/i,
  ],
  ['build-option', /\bJP\d|jumper|build option|populated|CPL (Basic|Full)|bridged|SP3T\b/i],
  ['prep', /\btrim(?:med)?|twist(?:ed)?|strip(?:ping)?|splice[sd]?|crimp|solder/i],
  ['length', /\b\d+(?:\.\d+)?\s*(mm|in|ft)\b|\b\d+\s*(?:in|ft)\b/i],
];

function topicsOf(text: string): BomTopic[] {
  return TOPIC_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
}

/**
 * Every sentence in the design that changes what you buy or how you build it.
 *
 * The catalog puts these in three places — `design.notes`, an instance `note`,
 * and a segment `role` (that is where "bonded multi-core-only housing (SHL-00101)"
 * actually lives) — and a buyer should not have to know which. Sentences that
 * touch no build-or-buy topic are dropped: a roll-up that reprints everything
 * is a roll-up nobody reads.
 */
function rollUpNotes(design: CableDesign): BomNote[] {
  const candidates: { source: string; noteIndex?: number; text: string }[] = [];

  (design.notes ?? []).forEach((text, index) => {
    candidates.push({ source: `notes[${index}]`, noteIndex: index, text });
  });
  for (const instance of design.instances.connectors) {
    if (instance.role !== undefined) candidates.push({ source: `${instance.id}.role`, text: instance.role });
    if (instance.note !== undefined) candidates.push({ source: `${instance.id}.note`, text: instance.note });
  }
  for (const instance of design.instances.segments) {
    if (instance.role !== undefined) candidates.push({ source: `${instance.id}.role`, text: instance.role });
  }
  for (const instance of design.instances.components) {
    if (instance.note !== undefined) candidates.push({ source: `${instance.id}.note`, text: instance.note });
  }
  for (const instance of design.instances.pcbas) {
    if (instance.note !== undefined) candidates.push({ source: `${instance.id}.note`, text: instance.note });
  }

  const out: BomNote[] = [];
  for (const candidate of candidates) {
    const topics = topicsOf(candidate.text);
    if (topics.length === 0) continue;
    // A `role` is already printed in the BOM's Location column, and every role
    // names a length ("trunk (6 ft)", "3.5 mm TRS whip"). Only promote one
    // into the roll-up when it says something a length does not — which is
    // how "bonded multi-core-only housing (SHL-00101)" earns its place and
    // "trunk (6 ft)" does not.
    if (candidate.source.endsWith('.role') && topics.every((topic) => topic === 'length')) {
      continue;
    }
    out.push({
      source: candidate.source,
      ...(candidate.noteIndex === undefined ? {} : { noteIndex: candidate.noteIndex }),
      text: candidate.text,
      topics,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * deriveBom
 * ------------------------------------------------------------------ */

interface Fold {
  line: Omit<BomLine, 'qty' | 'provenance'>;
  provenance: string[];
}

function foldInto(map: Map<string, Fold>, key: string, line: Fold['line'], instance: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, { line, provenance: [instance] });
  else existing.provenance.push(instance);
}

const WHIP = /\bwhip|pigtail\b/i;
const LEG = /\bleg\b/i;
const TRUNK = /\btrunk\b/i;

export function deriveBom(design: CableDesign, db: Db): Bom {
  const folds = new Map<string, Fold>();
  const gaps: string[] = [];
  // Mechanical instances carry their own qty per entry ("4 screws" is one
  // instance, not four) — folded lines' qty comes from summing these rather
  // than from provenance.length like every other category.
  const mechanicalQtyByKey = new Map<string, number>();

  /* --- wire stock ------------------------------------------------- */
  // a run that passes through a breakout mould uncut is its trunk's own cut
  // (the jacket stripped back past the mould): no wire of its own — the trunk
  // is cut to its length plus the longest run
  const runs = passThroughRuns(design, db);
  const runIds = new Set(runs.map((r) => r.segment));
  // an end the contract manufacturer delivers terminated: its parts (and the trunk) are the one sub-assembly
  const supplied = suppliedEnds(design, db);
  const covered = new Set(supplied.flatMap((s) => [...s.covers]));
  for (const instance of design.instances.segments) {
    if (runIds.has(instance.id) || covered.has(instance.id)) continue;
    const wire = findWire(db, instance.def);
    const role = instance.role ?? 'wire run';
    const own = runs.filter((r) => r.trunk === instance.id);
    let cutMm = instance.lengthMm;
    let runText: string | undefined;
    if (own.length > 0) {
      const lengths = own.map((r) => r.lengthMm);
      const ids = own.map((r) => r.segment).join(', ');
      if (cutMm !== undefined && lengths.every((l): l is number => l !== undefined)) {
        const longest = Math.max(...lengths);
        cutMm += longest;
        runText = `incl. ${longest} mm run out of the breakout (${ids})`;
      } else {
        runText = `plus the runs out of the breakout (${ids}), length TBD`;
        gaps.push(`segment ${instance.id}: the runs out of breakout ${own[0]!.breakout} (${ids}) have no length — the ${wire === undefined ? instance.def : wireDisplayName(db, instance.def)} cut is ${instance.lengthMm ?? '?'} mm plus the longest run`);
      }
    }
    const key = `wire|${instance.def}|${role}|${cutMm ?? 'unspecified'}`;
    const length = cutMm === undefined ? undefined : lengthFromMm(cutMm);
    if (wire === undefined) {
      gaps.push(`segment ${instance.id}: wire definition '${instance.def}' is not in the catalog`);
    } else if (wire.partNumber === undefined) {
      gaps.push(`wire '${wire.id}': the definition carries no part number`);
    }
    if (instance.lengthMm === undefined) {
      gaps.push(`segment ${instance.id}: no length recorded — cut length must come from the SWI`);
    }
    foldInto(
      folds,
      key,
      {
        key,
        category: 'wire',
        unit: 'ea',
        ref: instance.def,
        // the neutral construction name, never the maker (owner 2026-09-25/26)
        label: wire === undefined ? instance.def : wireDisplayName(db, instance.def),
        ...(wire?.partNumber === undefined ? {} : { partNumber: wire.partNumber }),
        value: length?.text ?? 'length not specified',
        location: role,
        // never the maker here either (owner 2026-09-25/26 supersedes pci.29's
        // "the maker, not a source document's number" — it stays in the wire's
        // own detail view and the wire spec sheet only); a figure-8 gives both
        // dimensions
        detail: facts([
          wire?.profile !== undefined
            ? `${wire.profile.widthMm} × ${wire.profile.heightMm} mm figure-8`
            : wire?.odMm === undefined
              ? undefined
              : `Ø ${wire.odMm} mm`,
          runText,
        ]),
        ...(length === undefined ? {} : { length }),
        ...(wire?.src === undefined ? {} : { src: wire.src }),
      },
      instance.id,
    );
    // one piece per trunk; its runs ride on its line (provenance), not as pieces
    mechanicalQtyByKey.set(key, (mechanicalQtyByKey.get(key) ?? 0) + 1);
    if (own.length > 0) folds.get(key)!.provenance.push(...own.map((r) => r.segment));
  }

  /* --- PCBAs ------------------------------------------------------ */
  for (const instance of design.instances.pcbas) {
    if (covered.has(instance.id)) continue;
    const pcba = findPcba(db, instance.def);
    const side = sideOf(attachedEnds(design, instance.id));
    const key = `pcba|${instance.def}|${side}`;
    if (pcba === undefined) {
      gaps.push(`pcba ${instance.id}: definition '${instance.def}' is not in the catalog`);
    }
    foldInto(
      folds,
      key,
      {
        key,
        category: 'pcba',
        unit: 'ea',
        ref: instance.def,
        label: pcba?.label ?? instance.def,
        ...(pcba?.partNumber === undefined ? {} : { partNumber: pcba.partNumber }),
        value: facts([pcba?.revision, pcba?.build]),
        location: side,
        detail: facts([
          pcba?.kicadProject,
          pcba?.integratedConnectors === undefined || pcba.integratedConnectors.length === 0
            ? undefined
            : `integrated: ${pcba.integratedConnectors
                .map((integrated) => integrated.connectorDefId)
                .sort(compareStrings)
                .join(', ')}`,
        ]),
        ...(pcba?.src === undefined ? {} : { src: pcba.src }),
      },
      instance.id,
    );
  }

  /* --- connectors ------------------------------------------------- */
  for (const instance of design.instances.connectors) {
    if (covered.has(instance.id)) continue;
    const connector = findConnector(db, instance.def);
    const role = instance.role ?? 'unspecified';
    const key = `connector|${instance.def}|${role}`;
    // A connector is orderable by its own part number. One with none keeps
    // the honest "order by description" gap — a kit is
    // a different stock item (data model v2 §7.1), never a stand-in for it.
    const identity = connector?.partNumber;
    // the kits that ship this connector, as information beside the line
    const kits = connector === undefined
      ? []
      : kitsContaining(db, { kind: 'connector', def: connector.id }).map((kit) => kit.sku).sort(compareStrings);
    // pre-made-lead (owner 2026-09-29: RCA male/female,
    // BNC male are bought as finished whips) — the connector is the
    // factory-terminated end of a purchased lead, not a part the bench
    // solders or crimps; the line stays a 'connector' BOM line (still
    // orderable, still shown at its role) but flags that no termination step
    // belongs to it.
    const preMadeLead = connector?.sourcing === 'pre-made-lead';
    if (connector === undefined) {
      gaps.push(`connector ${instance.id}: definition '${instance.def}' is not in the catalog`);
    } else if (identity === undefined) {
      const gap = `connector '${connector.id}': no part number in the catalog — order by description`;
      if (!gaps.includes(gap)) gaps.push(gap);
    }
    foldInto(
      folds,
      key,
      {
        key,
        category: 'connector',
        unit: 'ea',
        ref: instance.def,
        label: connector?.label ?? instance.def,
        ...(identity === undefined ? {} : { partNumber: identity }),
        value: facts([connector?.family, connector?.gender]),
        location: role,
        detail: facts([
          preMadeLead ? 'purchased pre-made lead — not terminated on the bench' : undefined,
          connector === undefined ? undefined : `${connector.pins.length} pins`,
          kits.length === 0 ? undefined : `kit ${kits.join(', ')}`,
          `attaches: ${endSummary(attachedEnds(design, instance.id))}`,
        ]),
        ...(connector?.src === undefined ? {} : { src: connector.src }),
      },
      instance.id,
    );
  }

  /* --- discrete components ---------------------------------------- */
  const componentNotes = new Map<string, string[]>();
  for (const instance of design.instances.components) {
    if (covered.has(instance.id)) continue;
    const component = findComponent(db, instance.def);
    const location = instance.location ?? 'inline';
    const key = `component|${instance.def}|${location}`;
    if (component === undefined) {
      gaps.push(`component ${instance.id}: definition '${instance.def}' is not in the catalog`);
    } else if (component.partNumber === undefined) {
      const gap = `component '${component.id}' (${component.value ?? component.label}): no part number in the catalog`;
      if (!gaps.includes(gap)) gaps.push(gap);
    }
    if (instance.note !== undefined) {
      const bucket = componentNotes.get(key);
      const entry = `${instance.id}: ${instance.note}`;
      if (bucket === undefined) componentNotes.set(key, [entry]);
      else bucket.push(entry);
    }
    foldInto(
      folds,
      key,
      {
        key,
        category: 'component',
        unit: 'ea',
        ref: instance.def,
        label: component?.label ?? instance.def,
        ...(component?.partNumber === undefined ? {} : { partNumber: component.partNumber }),
        ...(component?.value === undefined ? {} : { value: component.value }),
        location,
        ...(component?.src === undefined ? {} : { src: component.src }),
      },
      instance.id,
    );
  }

  /* --- mechanical: shells and hardware ----------------------------- */
  for (const instance of design.instances.mechanical ?? []) {
    if (covered.has(instance.id)) continue;
    const def = findMechanical(db, instance.def);
    const bought = supplied.find((s) => s.instance === instance.id);
    const category: BomCategory = bought !== undefined ? 'assembly' : def?.kind === 'shell' ? 'shell' : 'hardware';
    const attached = instance.attachedTo === undefined ? undefined : findInstance(design, instance.attachedTo);
    const attachedConnector =
      attached?.kind === 'connector'
        ? design.instances.connectors.find((c) => c.id === attached.id)
        : undefined;
    const location =
      bought !== undefined
        ? `${bought.side === 'a' ? 'source' : 'destination'} end — supplied terminated by the contract manufacturer`
        : (attachedConnector?.role ?? (instance.attachedTo === undefined ? 'unspecified' : instance.attachedTo));
    const key = `mechanical|${instance.def}|${instance.attachedTo ?? 'unspecified'}`;
    if (def === undefined) {
      gaps.push(`mechanical instance ${instance.id}: definition '${instance.def}' is not in the catalog`);
    } else if (def.partNumber === undefined) {
      const gap = `mechanical '${def.id}': no part number in the catalog`;
      if (!gaps.includes(gap)) gaps.push(gap);
    }
    foldInto(
      folds,
      key,
      {
        key,
        category,
        unit: 'ea',
        ref: instance.def,
        label: def?.label ?? instance.def,
        ...(def?.partNumber === undefined ? {} : { partNumber: def.partNumber }),
        ...(def?.revision === undefined ? {} : { value: `Rev${def.revision}` }),
        location,
        ...(bought !== undefined
          ? { detail: `in it: ${[...bought.covers].sort(compareStrings).join(', ')}` }
          : instance.attachedTo === undefined
            ? {}
            : { detail: `attaches: ${instance.attachedTo}` }),
        ...(def?.src === undefined ? {} : { src: def.src }),
      },
      instance.id,
    );
    // the parts inside it ride on its line (provenance), not as lines of their own
    if (bought !== undefined) folds.get(key)!.provenance.push(...[...bought.covers].sort(compareStrings));
    mechanicalQtyByKey.set(key, (mechanicalQtyByKey.get(key) ?? 0) + instance.qty);
  }

  /* --- finish the lines ------------------------------------------- */
  const lines: BomLine[] = [...folds.values()].map((fold) => {
    const provenance = [...fold.provenance].sort(compareStrings);
    const notes = componentNotes.get(fold.line.key);
    const detail =
      notes === undefined
        ? fold.line.detail
        : facts([fold.line.detail, [...notes].sort(compareStrings).join('; ')]);
    const line: BomLine = {
      ...fold.line,
      ...(detail === undefined || detail === '' ? {} : { detail }),
      qty: mechanicalQtyByKey.get(fold.line.key) ?? provenance.length,
      provenance,
    };
    if (line.category === 'wire' && line.length !== undefined) {
      line.totalMm = line.length.mm * line.qty;
    }
    if (line.detail === '') delete line.detail;
    if (line.value === '') delete line.value;
    return line;
  });

  lines.sort(
    byKeys<BomLine>(
      (line) => String(BOM_CATEGORY_ORDER.indexOf(line.category)),
      (line) => line.partNumber ?? '~',
      (line) => line.ref,
      (line) => line.location,
    ),
  );

  const trunk =
    lines.find((line) => line.category === 'wire' && TRUNK.test(line.location)) ??
    lines.find((line) => line.category === 'wire');

  return {
    designId: design.id,
    designLabel: design.label,
    ...(design.productRef === undefined ? {} : { productRef: design.productRef }),
    lines,
    assemblies: deriveAssemblies(design, db),
    notes: rollUpNotes(design),
    gaps: [...gaps].sort(compareStrings),
    ...(trunk === undefined ? {} : { trunk }),
    issues: validateDesign(design, db),
  };
}

/* ------------------------------------------------------------------ *
 * Whips and legs
 * ------------------------------------------------------------------ */

/**
 * The branches of the assembly, as things you build separately.
 *
 * A whip is usually a segment (a 450 mm 2-core audio lead) with its
 * own plugs on the far end — but not always: a TRS jack inset in a hood or a
 * board-mounted jack are legs with no wire stock of their own, and a build sheet that
 * only looked at segments would silently drop them.
 */
function deriveAssemblies(design: CableDesign, db: Db): BomAssembly[] {
  const out: BomAssembly[] = [];
  const claimed = new Set<string>();

  const connectorsOn = (segmentId: string): BomAssembly['terminations'] => {
    const ids = new Set<string>();
    for (const joint of design.joints) {
      for (const [near, far] of [
        [joint.a, joint.b],
        [joint.b, joint.a],
      ] as const) {
        if (near.instance !== segmentId) continue;
        if (design.instances.connectors.some((c) => c.id === far.instance)) ids.add(far.instance);
      }
    }
    return [...ids]
      .sort(compareStrings)
      .map((id) => {
        const instance = design.instances.connectors.find((c) => c.id === id);
        const def = instance?.def ?? '';
        const connector = findConnector(db, def);
        return {
          instance: id,
          ref: def,
          label: connector?.label ?? def,
          ...(instance?.role === undefined ? {} : { role: instance.role }),
        };
      });
  };

  for (const segment of design.instances.segments) {
    const role = segment.role ?? '';
    if (TRUNK.test(role)) continue;
    const wire = findWire(db, segment.def);
    const terminations = connectorsOn(segment.id);
    for (const termination of terminations) claimed.add(termination.instance);
    out.push({
      key: `assembly|${segment.id}`,
      kind: LEG.test(role) ? 'leg' : WHIP.test(role) ? 'whip' : 'branch',
      label: role === '' ? `branch ${segment.id}` : role,
      segment: {
        instance: segment.id,
        ref: segment.def,
        label: wire === undefined ? segment.def : wireDisplayName(db, segment.def),
        ...(segment.lengthMm === undefined ? {} : { length: lengthFromMm(segment.lengthMm) }),
      },
      terminations,
      provenance: [segment.id, ...terminations.map((t) => t.instance)].sort(compareStrings),
    });
  }

  for (const connector of design.instances.connectors) {
    const role = connector.role ?? '';
    if (claimed.has(connector.id)) continue;
    if (!WHIP.test(role) && !LEG.test(role)) continue;
    const definition = findConnector(db, connector.def);
    out.push({
      key: `assembly|${connector.id}`,
      kind: LEG.test(role) ? 'leg' : 'whip',
      label: role,
      terminations: [
        {
          instance: connector.id,
          ref: connector.def,
          label: definition?.label ?? connector.def,
          role,
        },
      ],
      provenance: [connector.id],
    });
  }

  out.sort(byKeys<BomAssembly>((assembly) => assembly.key));
  return out;
}

/** Human label for a category, for renderers that group by it. */
export function bomCategoryLabel(category: BomCategory): string {
  return CATEGORY_LABEL[category];
}

/** Total wire consumed per stock definition, in millimetres. */
export function wireConsumption(bom: Bom): { ref: string; label: string; mm: number }[] {
  const totals = new Map<string, { ref: string; label: string; mm: number }>();
  for (const line of bom.lines) {
    if (line.category !== 'wire' || line.totalMm === undefined) continue;
    const existing = totals.get(line.ref);
    if (existing === undefined) {
      totals.set(line.ref, { ref: line.ref, label: line.label, mm: line.totalMm });
    } else {
      existing.mm += line.totalMm;
    }
  }
  return [...totals.values()].sort(byKeys((entry) => entry.ref));
}

/** Every instance the design declares that produced no BOM line — a leak check. */
export function unaccountedInstances(design: CableDesign, bom: Bom): string[] {
  const accounted = new Set(bom.lines.flatMap((line) => line.provenance));
  return designInstances(design)
    .map((instance) => instance.id)
    .filter((id) => !accounted.has(id))
    .sort(compareStrings);
}
