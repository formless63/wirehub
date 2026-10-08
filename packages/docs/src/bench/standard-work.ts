/**
 * Generic bench steps, as the build sheet prints them.
 *
 * The base ships a small, deliberately generic set — common soldering and
 * cable-prep practice, the kind any workmanship standard (e.g. IPC/WHMA-A-620)
 * describes — chosen by facts of the design: the stock's construction, which
 * end, the shell. A deployment with its own written work instructions
 * replaces these through a module (`docs/modules.md`, extension point
 * "documents"); every step cites where it comes from.
 */

import {
  benchRuleProblems,
  benchRulesProvider,
  findMechanical,
  type BenchEnd,
  type BenchStepsProvider,
  type CableDesign,
  type Db,
  type ShellSet,
  type Step,
  type WireDefinition,
} from '@wirehub/model';

export type { BenchStepsProvider, ShellSet, Step };

const providers: BenchStepsProvider[] = [];

/** Register a work-instruction provider; returns the function that removes it. */
export function registerBenchSteps(provider: BenchStepsProvider): () => void {
  providers.push(provider);
  return () => {
    const at = providers.indexOf(provider);
    if (at !== -1) providers.splice(at, 1);
  };
}

/**
 * The provider the catalog's own rules stand for (`Db.benchRules`, the catalog's
 * `bench-rules.json`: this hub's, plus those of installed data packs), built once per
 * rules list. It sits after the providers a module registered (an operator's code wins,
 * as a module's drawing art beats a setting) and before the generic steps. Reading the
 * db at each render means an install or removal of a pack takes effect at once.
 */
const dataProviders = new WeakMap<object, BenchStepsProvider>();
function dataProvider(db: Db | undefined): BenchStepsProvider | undefined {
  const rules = db?.benchRules;
  if (!Array.isArray(rules) || rules.length === 0) return undefined;
  let provider = dataProviders.get(rules);
  if (provider === undefined) {
    // an unusable rule is skipped here (validateDb reports it): the sheet still prints
    provider = benchRulesProvider(rules.filter((r) => benchRuleProblems([r]).length === 0));
    dataProviders.set(rules, provider);
  }
  return provider;
}

function all(db: Db | undefined): BenchStepsProvider[] {
  const data = dataProvider(db);
  return data === undefined ? providers : [...providers, data];
}

function supplied<T>(db: Db | undefined, ask: (p: BenchStepsProvider) => T | undefined): T | undefined {
  for (const provider of all(db)) {
    const answer = ask(provider);
    if (answer !== undefined) return answer;
  }
  return undefined;
}

const GENERIC = 'generic practice (synthetic example; see IPC/WHMA-A-620 for workmanship criteria)';

function hasShieldedCores(wire: WireDefinition): boolean {
  return wire.structure.children.some((c) => c.kind === 'group' && (c.role === 'coax' || c.role === 'shielded-core'));
}

function hasDrain(wire: WireDefinition): boolean {
  return wire.structure.children.some((c) => c.kind === 'conductor' && c.bare === true);
}

function hasOverallShield(wire: WireDefinition): boolean {
  return wire.structure.children.some((c) => c.kind === 'shield');
}

/** Preparing one piece of stock at both ends, before anything is soldered. */
export function prepSteps(wire: WireDefinition, bonded: boolean, db?: Db): Step[] {
  const own = supplied(db, (p) => p.prep?.(wire, bonded));
  if (own !== undefined) return own;
  const steps: Step[] = [{ text: 'Cut to length; strip the outer jacket at both ends to the strip lengths shown.', src: GENERIC }];
  if (hasOverallShield(wire)) {
    steps.push({
      text: bonded
        ? 'Comb out the overall shield and twist it with the drain into one pigtail, as the end pages number it.'
        : 'Trim any foil back to the jacket; dress braids and drains into the pigtails the end pages number.',
      src: GENERIC,
    });
  }
  if (hasDrain(wire)) steps.push({ text: 'Drain: land it where the end pages say; where an end leaves it unconnected, cut it flush and insulate it.', src: GENERIC });
  if (hasShieldedCores(wire)) steps.push({ text: 'Strip each shielded core; twist each core shield into its pigtail before stripping the centre conductor.', src: GENERIC });
  steps.push({ text: 'Strip and pre-tin every conductor that is soldered; do not nick strands.', src: GENERIC });
  return steps;
}

const GENERIC_SOLDER: Step = { text: 'Solder each landing with a fillet that wets both surfaces; no cold or disturbed joints.', src: GENERIC };

/** The soldering step: a provider's, else the generic one. */
export function solderStep(db?: Db): Step {
  return all(db).find((p) => p.solder !== undefined)?.solder ?? GENERIC_SOLDER;
}

/** What to do at an end before the first landing. The base adds nothing board-specific; a provider may. */
export function endSteps(end: BenchEnd, db: Db, other?: BenchEnd): Step[] {
  return supplied(db, (p) => p.end?.(end, db, other)) ?? [];
}

export function shellSets(design: CableDesign, db: Db, instances: ReadonlySet<string>): ShellSet[] {
  const mech = design.instances.mechanical ?? [];
  const out: ShellSet[] = [];
  for (const m of mech) {
    const def = findMechanical(db, m.def);
    if (def?.kind !== 'shell' || m.attachedTo === undefined || !instances.has(m.attachedTo)) continue;
    const parts = mech
      .filter((p) => p.attachedTo === m.id)
      .map((p) => {
        const d = findMechanical(db, p.def);
        return { id: p.id, label: d?.label ?? p.def, ...(d?.partNumber === undefined ? {} : { partNumber: d.partNumber }), qty: p.qty, kind: d?.kind ?? 'other' };
      });
    out.push({
      attachedTo: m.attachedTo,
      shell: { id: m.id, label: def.label, ...(def.partNumber === undefined ? {} : { partNumber: def.partNumber }), qty: m.qty },
      parts,
    });
  }
  return out;
}

/** Closing one end: strain relief and housing, per the shell at that end. */
export function assemblySteps(design: CableDesign, db: Db, end: BenchEnd, sets: readonly ShellSet[], trunkWire: WireDefinition | undefined): Step[] {
  const own = supplied(db, (p) => p.assembly?.(design, db, end, sets, trunkWire));
  if (own !== undefined) return own;
  const steps: Step[] = [];
  const moulded = sets.some((s) => /overmo?uld/i.test(s.shell?.id ?? '') || /overmo?uld/i.test(s.shell?.label ?? ''));
  if (moulded) {
    steps.push({ text: 'Moulded end: overmoulded after test — no shell work here.', src: GENERIC });
    return steps;
  }
  steps.push({ text: 'Slide on heat-shrink and any boot before soldering; shrink over each landing afterwards.', src: GENERIC });
  if (sets.length > 0) steps.push({ text: 'Close the shell: clamp the jacket in the strain relief, then fit the hardware listed.', src: GENERIC });
  return steps;
}

/** The functional check after continuity. */
const GENERIC_QA: readonly Step[] = [
  { text: 'Run the continuity and isolation checks on the test page; then a functional check with the equipment the design is for.', src: GENERIC },
];

export function qaSteps(db?: Db): readonly Step[] {
  return all(db).find((p) => p.qa !== undefined)?.qa ?? GENERIC_QA;
}
