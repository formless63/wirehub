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
  findMechanical,
  type CableDesign,
  type Db,
  type WireDefinition,
} from '@cable-studio/model';

import type { BenchEnd } from './model.ts';

export interface Step {
  text: string;
  /** where the step comes from (a work instruction, a standard, "generic practice") */
  src: string;
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
export function prepSteps(wire: WireDefinition, bonded: boolean): Step[] {
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

export const SOLDER_STEP: Step = { text: 'Solder each landing with a fillet that wets both surfaces; no cold or disturbed joints.', src: GENERIC };

/** What to do at an end before the first landing. The base adds nothing board-specific. */
export function endSteps(_end: BenchEnd, _db: Db, _other?: BenchEnd): Step[] {
  return [];
}

/** The mechanical parts on one end, grouped under the shell they belong to. */
export interface ShellSet {
  /** the instance the shell encloses */
  attachedTo?: string;
  shell?: { id: string; label: string; partNumber?: string; qty: number };
  parts: { id: string; label: string; partNumber?: string; qty: number; kind: string }[];
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
export function assemblySteps(_design: CableDesign, _db: Db, _end: BenchEnd, sets: readonly ShellSet[], _trunkWire: WireDefinition | undefined): Step[] {
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
export const QA_STEPS: readonly Step[] = [
  { text: 'Run the continuity and isolation checks on the test page; then a functional check with the equipment the cable is for.', src: GENERIC },
];
