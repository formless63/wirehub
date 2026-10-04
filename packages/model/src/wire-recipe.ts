/**
 * Wire stocks built from parts (data-model v2 §6).
 *
 * A **wire part** is one thing a vendor sheet specifies once: a conductor
 * (strands × diameter, material), an insulation or dielectric, a shield
 * (braid / spiral / foil / tape), a jacket — or a **core**, the composite
 * sub-assembly a sheet tables as one row (a coax, a shielded core, a plain
 * insulated core) made of those parts. A **wire recipe** composes cores and
 * overall layers with a lay, and `compileWire` turns it into today's
 * `WireDefinition` — the structure tree, every `odMm`, `layOrder` and
 * `bonded` — so nothing downstream changes.
 *
 * What is **entered** (from the vendor sheet) and what is **derived** is the
 * point of the exercise (§6.2). Every derived number is reported with the
 * formula that produced it (`CompiledWire.derived`), so the builder can show
 * it read-only with its working on hover, and every value that rests on an
 * assumption rather than a sheet carries `inferred` — the compiled element's
 * `src` says INFERRED, the same house rule every catalog record follows.
 *
 * Pure and deterministic like the rest of core: no IO, no clock.
 */

import { LAY_ARRANGEMENT_RING_COUNT } from './model.ts';
import type {
  ConductorElement,
  Element,
  GroupElement,
  InsulationElement,
  Issue,
  ShieldElement,
  WireBondedSet,
  WireDefinition,
  WireLayOrder,
  WireProfile,
  WireVendorDoc,
} from './model.ts';
import { resolveElementPath } from './paths.ts';
import { validateWireLayOrder } from './validate.ts';

/* ------------------------------------------------------------------ *
 * Parts
 * ------------------------------------------------------------------ */

export type ShieldConstruction = ShieldElement['construction'];

interface PartBase {
  id: string;
  /** what the library list calls it — "OFC 7×0.12 mm (the vendor)" */
  label: string;
  /** who makes it — an id in the `manufacturers` vocab list, when a sheet says */
  manufacturer?: string;
  /**
   * The words a compiled element is called by, when this part fixes them —
   * a template: `{signal}` and `{colour}` are the core's.
   */
  elementLabel?: string;
  src: string;
}

/** Stranded or solid copper. */
export interface ConductorPart extends PartBase {
  kind: 'conductor';
  material: string;
  /** strand count; absent when the sheet does not say (a drain of unknown gauge) */
  strands?: number;
  /** strand diameter, mm */
  strandMm?: number;
  /** ± on the strand diameter, mm, as the sheet prints it */
  strandTolMm?: number;
  /** the sheet's nominal area, mm² — derived n·π·d²/4 when absent */
  areaMm2?: number;
  /** outer Ø over the bare copper, mm — derived from the strand count when absent */
  odMm?: number;
  /** the sheet's nominal Ø (some sheets print nominal and outer), mm — spec sheet only */
  nominalMm?: number;
  /** "28 AWG" — spec sheet only */
  awg?: string;
  /** how the formation is written; derived `<prefix> <n>x<d> mm` when absent */
  formation?: string;
}

/** A dielectric, a core insulation or a coax sheath. */
export interface InsulationPart extends PartBase {
  kind: 'insulation';
  material: string;
  /** Ø over it, mm */
  odMm?: number;
  /** wall thickness, mm — Ø derived as the inner Ø + 2 × wall when `odMm` is absent */
  wallMm?: number;
  tolMm?: number;
  /**
   * a fixed colour, when the layer is not the core's own colour — a
   * figure-8 leg's black jacket over a red or white core. Absent: a coloured
   * layer (insulation, sheath) takes the core's colour.
   */
  color?: string;
}

export interface ShieldPart extends PartBase {
  kind: 'shield';
  construction: ShieldConstruction;
  material: string;
  coveragePct?: string;
  strands?: number;
  strandMm?: number;
  /** lay length of a spiral / braid, mm — spec sheet only */
  layMm?: number;
  layTolMm?: number;
  hand?: 'S' | 'Z';
  /** thickness of a foil / tape layer, mm — Ø derived as inner + 2 × t */
  thicknessMm?: number;
}

export interface JacketPart extends PartBase {
  kind: 'jacket';
  material: string;
  odMm: number;
  tolMm?: number;
  color?: string;
}

/**
 * A composite core: the sub-assembly a sheet tables as one row. `builtAs`
 * decides the element tree — `coax` and `shielded-core` are groups
 * (`center` + `dielectric`/`insulation` + `shield` + `sheath`, each optional
 * but the conductor), `plain` is a single conductor element carrying its
 * insulation Ø (`insulatedOdMm`), so its terminal path is the core id itself.
 */
export interface CorePart extends PartBase {
  kind: 'core';
  builtAs: 'coax' | 'shielded-core' | 'plain';
  conductor: string;
  /** a coax's dielectric — element id `dielectric` */
  dielectric?: string;
  /** a shielded core's (or a plain core's) insulation — element id `insulation` */
  insulation?: string;
  shield?: string;
  /**
   * Ø over the shield as documented or measured for this assembly, mm. A
   * braid's Ø depends on what it is braided over, so it belongs to the
   * assembly, not the braid; absent, it is derived from the strand size.
   */
  shieldOdMm?: number;
  shieldOdSrc?: string;
  sheath?: string;
}

export type WirePart = ConductorPart | InsulationPart | ShieldPart | JacketPart | CorePart;
export type WirePartKind = WirePart['kind'];

export const WIRE_PART_KINDS: readonly WirePartKind[] = [
  'core',
  'conductor',
  'insulation',
  'shield',
  'jacket',
];

/* ------------------------------------------------------------------ *
 * Recipes
 * ------------------------------------------------------------------ */

export interface RecipeCore {
  /** element id, `core-red` */
  id: string;
  /** colour name the drawings paint (`red`, `purple`) */
  colour: string;
  /** the composite core part */
  part: string;
  /** what the core carries, as words ("Video R") — defaults from the colour code */
  signal?: string;
  /** swap one layer of the assembly for another part, this core only */
  conductor?: string;
  dielectric?: string;
  insulation?: string;
  shield?: string;
  sheath?: string;
}

/** The lay: `WireLayOrder` plus the assembly facts a sheet states. */
export interface RecipeLay {
  arrangement: WireLayOrder['arrangement'];
  direction: WireLayOrder['direction'];
  viewedFrom?: WireLayOrder['viewedFrom'];
  ring: string[];
  center?: string;
  inner?: string[];
  /** assembly lay length, mm (the vendor "140 ± 10 mm") — spec sheet only */
  layLengthMm?: number;
  layLengthTolMm?: number;
  hand?: 'S' | 'Z';
  src: string;
}

export interface RecipeOverall {
  shield?: string;
  /** Ø over the overall shield, documented or measured, mm */
  shieldOdMm?: number;
  shieldOdSrc?: string;
  drain?: string;
  /** a non-electrical filler / grouping tape, as the sheet lists it */
  filler?: string;
  /** the overall shield's element id — `overall-shield` unless the stock says otherwise */
  shieldId?: string;
}

/**
 * Words a compiled element is called by. Templates: `{signal}` and
 * `{colour}` are filled from the core.
 */
export type LabelSlot =
  | 'group'
  | 'center'
  | 'dielectric'
  | 'insulation'
  | 'shield'
  | 'sheath'
  | 'plain'
  | 'drain';

/**
 * One recorded element fact the parts do not produce — kept, and said why,
 * rather than silently letting a compile differ from the stock on file.
 */
export interface RecipeOverride {
  /** element path (`core-brown`, `core-red.center`) */
  path: string;
  set?: Partial<{
    label: string;
    material: string;
    formation: string;
    areaMm2: number;
    odMm: number;
    insulatedOdMm: number;
    coveragePct: string;
    color: string;
  }>;
  unset?: ('formation' | 'areaMm2' | 'material' | 'coveragePct' | 'color')[];
  why: string;
}

/** A performance figure reproduced on the spec sheet as given. */
export interface RecipePerformance {
  name: string;
  value: string;
  src: string;
}

/**
 * The web of a `figure-8` stock: the moulding that joins the two legs'
 * jackets side by side. Geometry only — the legs' own jackets are their
 * `sheath` layer.
 */
export interface RecipeWeb {
  material: string;
  color?: string;
  /** clear gap between the two legs' jackets, mm (0 = moulded touching) */
  gapMm?: number;
  /** thickness of the neck joining them, mm — absent: 0.6 × leg Ø, INFERRED */
  thicknessMm?: number;
  src: string;
}

export interface RecipeRevision {
  rev: string;
  date: string;
  note: string;
}

export interface WireRecipe {
  id: string;
  label: string;
  partNumber?: string;
  /** the document the values were taken from — a citation, never our number */
  specRef?: string;
  /** who makes the stock — an id in the `manufacturers` vocab list; absent = not known */
  manufacturer?: string;
  /** the manufacturer's own documents, held in the shared asset store */
  vendorDocs?: WireVendorDoc[];
  /** the colour → signal code the cores' default signal words come from */
  colourCode?: string;
  /** one line for the spec sheet's description */
  description?: string;
  /** the root group's label ("WIR-00101 cable") */
  rootLabel?: string;
  cores: RecipeCore[];
  lay?: RecipeLay;
  overall?: RecipeOverall;
  jacket?: string;
  /** a `figure-8` stock's web (no overall `jacket`: each leg carries its own) */
  web?: RecipeWeb;
  bonded?: WireBondedSet[];
  /** per-slot label templates for this stock */
  labels?: Partial<Record<LabelSlot, string>>;
  overrides?: RecipeOverride[];
  /** the whole construction is assumed, not from a sheet: every element src says so */
  constructionInferred?: boolean;
  performance?: RecipePerformance[];
  revisions?: RecipeRevision[];
  src: string;
}

export interface WireLibrary {
  parts: WirePart[];
  recipes: WireRecipe[];
}

/* ------------------------------------------------------------------ *
 * The colour code
 * ------------------------------------------------------------------ */

/**
 * The words a core's signal is shown as: what the recipe says it carries, else
 * its colour. Which lane a colour stands for is the stock's colour code (vocab
 * `colour-codes`), never a table in code.
 */
export function signalWordsOf(core: RecipeCore): string {
  return core.signal ?? core.colour;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** Round to `dp` decimals without `-0`. */
export function roundTo(value: number, dp: number): number {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function mm(value: number): string {
  return roundTo(value, 3).toString();
}

/** A number the compile derived, with its working. */
export interface DerivedValue {
  /** element path, or `stock` for stock-level values */
  path: string;
  field: string;
  value: number;
  /** the formula with the numbers put in — shown on hover */
  formula: string;
  /** rests on an assumption, not a sheet */
  inferred: boolean;
}

/** Conductor area, n·π·d²/4, mm². */
export function conductorArea(strands: number, strandMm: number): number {
  return (strands * Math.PI * strandMm * strandMm) / 4;
}

/**
 * Outer Ø over a stranded conductor. A 7-strand concentric lay is exactly
 * three strands across; any other count is approximated as 1.15·√n·d (the
 * usual bunched-strand packing factor), which is why it is flagged inferred.
 */
export function strandedOd(strands: number, strandMm: number): { od: number; formula: string; inferred: boolean } {
  if (strands === 1) return { od: strandMm, formula: `solid: d = ${mm(strandMm)}`, inferred: false };
  if (strands === 7) return { od: 3 * strandMm, formula: `7-strand concentric: 3·d = 3 × ${mm(strandMm)}`, inferred: true };
  const od = 1.15 * Math.sqrt(strands) * strandMm;
  return { od, formula: `bunched: 1.15·√n·d = 1.15 × √${strands} × ${mm(strandMm)}`, inferred: true };
}

/**
 * Ø of the round bundle a lay makes, mm — ring cores on the pitch circle
 * where neighbours just touch (`d / (2·sin(π/n))`), opened up if the centre
 * (or the centre pair, side by side) needs the room. The same geometry the
 * cutaway draws (`@wirehub/layout` `crossSectionLayout`).
 */
export function layEnvelope(
  arrangement: WireLayOrder['arrangement'],
  ringOdMm: number,
  centerOdMm = 0,
  innerOdsMm: readonly number[] = [],
): { od: number; pitchRadius: number; formula: string } {
  const n = LAY_ARRANGEMENT_RING_COUNT[arrangement];
  const rc = ringOdMm / 2;
  if (arrangement === 'figure-8') {
    // two legs side by side: the envelope is the width, legs touching
    return { od: 2 * ringOdMm, pitchRadius: rc, formula: `figure-8: width = 2·d = 2 × ${mm(ringOdMm)} = ${mm(2 * ringOdMm)}` };
  }
  const innerSpan = innerOdsMm.reduce((sum, d) => sum + d / 2, 0);
  const centerR = Math.max(centerOdMm / 2, innerSpan);
  const touching = rc / Math.sin(Math.PI / n);
  const pitchRadius = Math.max(touching, rc + centerR);
  const od = 2 * (pitchRadius + rc);
  const which =
    pitchRadius === touching
      ? `R = d/(2·sin(π/${n})) = ${mm(ringOdMm)}/(2·sin(π/${n})) = ${mm(pitchRadius)}`
      : `R = d/2 + centre = ${mm(rc)} + ${mm(centerR)} = ${mm(pitchRadius)}`;
  return { od, pitchRadius, formula: `${arrangement}: ${which}; Ø = 2·(R + d/2) = ${mm(od)}` };
}

/* ------------------------------------------------------------------ *
 * Compile
 * ------------------------------------------------------------------ */

export interface CompiledWire {
  wire: WireDefinition;
  derived: DerivedValue[];
  issues: Issue[];
  /** the cores' bundle Ø from the lay, when it can be computed */
  envelopeMm?: number;
}

const DEFAULT_LABELS: Record<'coax' | 'shielded-core', Record<LabelSlot, string>> = {
  coax: {
    group: '{signal} coax ({colour})',
    center: '{signal} centre conductor',
    dielectric: 'Dielectric',
    insulation: 'Insulation',
    shield: '{signal} coax shield',
    sheath: 'Coax sheath ({colour})',
    plain: '{signal} ({colour}, unshielded)',
    drain: 'Drain wire (bare)',
  },
  'shielded-core': {
    group: '{signal} shielded core ({colour})',
    center: '{signal} centre conductor',
    dielectric: 'Dielectric',
    insulation: 'Core insulation',
    shield: '{signal} core shield',
    sheath: 'Core sheath ({colour})',
    plain: '{signal} ({colour}, unshielded)',
    drain: 'Drain wire (bare)',
  },
};

function fill(template: string, core: RecipeCore | undefined): string {
  if (core === undefined) return template;
  return template.replaceAll('{signal}', signalWordsOf(core)).replaceAll('{colour}', core.colour);
}

/** `OFC 7x0.12 mm` — the prefix a sheet writes for the material. */
export function formationOf(part: ConductorPart): string | undefined {
  if (part.formation !== undefined) return part.formation;
  if (part.strands === undefined || part.strandMm === undefined) return undefined;
  const m = part.material.toLowerCase();
  const prefix = m.includes('ofc') ? 'OFC ' : m.includes('tinned') ? 'TC ' : m.includes('bare') ? 'BC ' : '';
  return `${prefix}${part.strands}x${part.strandMm.toFixed(2)} mm`;
}

function inferredTag(inferred: boolean): string {
  return inferred ? ' INFERRED' : '';
}

function issue(code: string, message: string, where: string, severity: 'error' | 'warning' = 'error'): Issue {
  return { code, severity, message, where };
}

/** Part lookup by id, kind-checked. */
function lookup<K extends WirePartKind>(
  parts: ReadonlyMap<string, WirePart>,
  id: string | undefined,
  kind: K,
  where: string,
  issues: Issue[],
): Extract<WirePart, { kind: K }> | undefined {
  if (id === undefined) return undefined;
  const part = parts.get(id);
  if (part === undefined) {
    issues.push(issue('wire-part-unknown', `${where} names part '${id}', which is not in the parts library`, where));
    return undefined;
  }
  if (part.kind !== kind) {
    issues.push(issue('wire-part-kind', `${where} needs a ${kind} part; '${id}' is a ${part.kind}`, where));
    return undefined;
  }
  return part as Extract<WirePart, { kind: K }>;
}

/**
 * Compile a recipe into today's `WireDefinition`. Never throws: an unknown
 * part is an issue and the element it would have made is left out, so the
 * builder can show a half-finished stock while it is being put together.
 */
export function compileWire(recipe: WireRecipe, library: readonly WirePart[]): CompiledWire {
  const parts = new Map(library.map((part) => [part.id, part]));
  const issues: Issue[] = [];
  const derived: DerivedValue[] = [];
  const stockInferred = recipe.constructionInferred === true;
  const where = `wire-recipes/${recipe.id}`;

  const srcOf = (part: WirePart | undefined, extra: string[] = []): string | undefined => {
    const bits = [part?.src, ...extra].filter((bit): bit is string => bit !== undefined && bit !== '');
    if (stockInferred) bits.push('Construction INFERRED — see the stock src.');
    return bits.length === 0 ? undefined : bits.join(' ');
  };
  const note = (value: DerivedValue): void => {
    derived.push({ ...value, value: roundTo(value.value, 4) });
  };
  const labelFor = (slot: LabelSlot, builtAs: 'coax' | 'shielded-core', core: RecipeCore | undefined, part?: WirePart): string =>
    fill(recipe.labels?.[slot] ?? part?.elementLabel ?? DEFAULT_LABELS[builtAs][slot], core);

  /* --- conductors ------------------------------------------------- */

  const conductorElement = (
    id: string,
    part: ConductorPart,
    path: string,
    extra: Partial<ConductorElement>,
  ): ConductorElement => {
    const element: ConductorElement = { kind: 'conductor', id, ...extra };
    element.material = part.material;
    const formation = formationOf(part);
    if (formation !== undefined) element.formation = formation;
    const notes: string[] = [];
    if (part.areaMm2 !== undefined) {
      element.areaMm2 = part.areaMm2;
    } else if (part.strands !== undefined && part.strandMm !== undefined) {
      const area = roundTo(conductorArea(part.strands, part.strandMm), 3);
      element.areaMm2 = area;
      note({ path, field: 'areaMm2', value: area, formula: `n·π·d²/4 = ${part.strands}·π·${mm(part.strandMm)}²/4`, inferred: false });
    }
    if (part.odMm !== undefined) {
      element.odMm = part.odMm;
    } else if (part.strands !== undefined && part.strandMm !== undefined) {
      const od = strandedOd(part.strands, part.strandMm);
      element.odMm = roundTo(od.od, 2);
      note({ path, field: 'odMm', value: element.odMm, formula: od.formula, inferred: od.inferred });
      notes.push(`Ø over the copper derived (${od.formula})${inferredTag(od.inferred)}.`);
    }
    const src = srcOf(part, notes);
    if (src !== undefined) element.src = src;
    return element;
  };

  /* --- cores ------------------------------------------------------ */

  const coreOds = new Map<string, number>();
  const children: Element[] = [];
  const coreIds = new Set<string>();

  for (const [index, core] of recipe.cores.entries()) {
    const at = `${where}/cores/${core.id || index}`;
    if (coreIds.has(core.id)) issues.push(issue('wire-core-duplicate', `core id '${core.id}' is used twice`, at));
    coreIds.add(core.id);
    const assembly = lookup(parts, core.part, 'core', at, issues);
    if (assembly === undefined) continue;
    const conductor = lookup(parts, core.conductor ?? assembly.conductor, 'conductor', at, issues);
    if (conductor === undefined) continue;
    const builtAs = assembly.builtAs;

    if (builtAs === 'plain') {
      const insulation = lookup(parts, core.insulation ?? assembly.insulation, 'insulation', at, issues);
      const element = conductorElement(core.id, conductor, core.id, {
        label: labelFor('plain', 'coax', core),
        color: core.colour,
      });
      if (insulation !== undefined) {
        element.material = `${conductor.material}, ${insulation.material} insulated`;
        const od = insulation.odMm ?? (insulation.wallMm !== undefined && element.odMm !== undefined ? element.odMm + 2 * insulation.wallMm : undefined);
        if (od !== undefined) {
          element.insulatedOdMm = roundTo(od, 3);
          if (insulation.odMm === undefined) {
            note({ path: core.id, field: 'insulatedOdMm', value: od, formula: `inner + 2·wall = ${mm(element.odMm!)} + 2 × ${mm(insulation.wallMm!)}`, inferred: false });
          }
        }
        element.src = [element.src, `Insulation: ${insulation.src}`].filter((bit) => bit !== undefined).join(' ');
      }
      children.push(element);
      const outer = element.insulatedOdMm ?? element.odMm;
      if (outer !== undefined) coreOds.set(core.id, outer);
      continue;
    }

    const layers: Element[] = [];
    const center = conductorElement('center', conductor, `${core.id}.center`, {
      label: labelFor('center', builtAs, core),
      color: core.colour,
    });
    layers.push(center);
    let inner = center.odMm;

    const insulate = (slot: 'dielectric' | 'insulation', partId: string | undefined, colour: boolean): void => {
      const part = lookup(parts, partId, 'insulation', at, issues);
      if (part === undefined) return;
      const element: InsulationElement = {
        kind: 'insulation',
        id: slot,
        label: labelFor(slot, builtAs, core, part),
        material: part.material,
      };
      const notes: string[] = [];
      if (part.odMm !== undefined) element.odMm = part.odMm;
      else if (part.wallMm !== undefined && inner !== undefined) {
        element.odMm = roundTo(inner + 2 * part.wallMm, 3);
        note({ path: `${core.id}.${slot}`, field: 'odMm', value: element.odMm, formula: `inner + 2·wall = ${mm(inner)} + 2 × ${mm(part.wallMm)}`, inferred: false });
        notes.push('Ø derived from the wall.');
      }
      if (part.color !== undefined) element.color = part.color;
      else if (colour) element.color = core.colour;
      const src = srcOf(part, notes);
      if (src !== undefined) element.src = src;
      layers.push(element);
      if (element.odMm !== undefined) inner = element.odMm;
    };

    if (assembly.dielectric !== undefined || core.dielectric !== undefined) {
      insulate('dielectric', core.dielectric ?? assembly.dielectric, false);
    }
    if (assembly.insulation !== undefined || core.insulation !== undefined) {
      insulate('insulation', core.insulation ?? assembly.insulation, true);
    }

    const shieldPart = lookup(parts, core.shield ?? assembly.shield, 'shield', at, issues);
    let shieldOd: number | undefined;
    if (shieldPart !== undefined) {
      const element: ShieldElement = {
        kind: 'shield',
        id: 'shield',
        label: labelFor('shield', builtAs, core, shieldPart),
        construction: shieldPart.construction,
        material: shieldPart.material,
      };
      if (shieldPart.coveragePct !== undefined) element.coveragePct = shieldPart.coveragePct;
      const notes: string[] = [];
      const path = `${core.id}.shield`;
      if (assembly.shieldOdMm !== undefined && core.shield === undefined) {
        shieldOd = assembly.shieldOdMm;
        if (assembly.shieldOdSrc !== undefined) notes.push(assembly.shieldOdSrc);
      } else if (inner !== undefined && shieldPart.strandMm !== undefined) {
        const layersOfStrand = shieldPart.construction === 'braid' ? 4 : 2;
        shieldOd = roundTo(inner + layersOfStrand * shieldPart.strandMm, 3);
        const formula =
          shieldPart.construction === 'braid'
            ? `braid: inner + 4·strand = ${mm(inner)} + 4 × ${mm(shieldPart.strandMm)}`
            : `serve: inner + 2·strand = ${mm(inner)} + 2 × ${mm(shieldPart.strandMm)}`;
        note({ path, field: 'odMm', value: shieldOd, formula, inferred: true });
        notes.push(`Ø over the shield INFERRED (${formula}).`);
      } else if (inner !== undefined && shieldPart.thicknessMm !== undefined) {
        shieldOd = roundTo(inner + 2 * shieldPart.thicknessMm, 3);
        note({ path, field: 'odMm', value: shieldOd, formula: `inner + 2·t = ${mm(inner)} + 2 × ${mm(shieldPart.thicknessMm)}`, inferred: false });
      } else if (inner !== undefined) {
        const sheath = parts.get(core.sheath ?? assembly.sheath ?? '');
        const outer = sheath?.kind === 'insulation' ? sheath.odMm : undefined;
        if (outer !== undefined) {
          shieldOd = roundTo((inner + outer) / 2, 3);
          const formula = `midpoint of the wall: (${mm(inner)} + ${mm(outer)}) / 2`;
          note({ path, field: 'odMm', value: shieldOd, formula, inferred: true });
          notes.push(`Ø over the shield INFERRED (${formula}).`);
        }
      }
      if (shieldOd !== undefined) element.odMm = shieldOd;
      const src = srcOf(shieldPart, notes);
      if (src !== undefined) element.src = src;
      layers.push(element);
      if (shieldOd !== undefined) inner = shieldOd;
    }

    const sheathPart = lookup(parts, core.sheath ?? assembly.sheath, 'insulation', at, issues);
    if (sheathPart !== undefined) {
      const element: InsulationElement = {
        kind: 'insulation',
        id: 'sheath',
        label: labelFor('sheath', builtAs, core, sheathPart),
        material: sheathPart.material,
      };
      if (sheathPart.odMm !== undefined) element.odMm = sheathPart.odMm;
      else if (sheathPart.wallMm !== undefined && inner !== undefined) {
        element.odMm = roundTo(inner + 2 * sheathPart.wallMm, 3);
        note({ path: `${core.id}.sheath`, field: 'odMm', value: element.odMm, formula: `inner + 2·wall = ${mm(inner)} + 2 × ${mm(sheathPart.wallMm)}`, inferred: false });
      }
      element.color = sheathPart.color ?? core.colour;
      const src = srcOf(sheathPart);
      if (src !== undefined) element.src = src;
      layers.push(element);
      if (element.odMm !== undefined) inner = element.odMm;
    }

    const group: GroupElement = {
      kind: 'group',
      id: core.id,
      label: labelFor('group', builtAs, core),
      role: builtAs,
      children: layers,
    };
    const groupSrc = srcOf(assembly);
    if (groupSrc !== undefined) group.src = groupSrc;
    children.push(group);
    if (inner !== undefined) coreOds.set(core.id, inner);
  }

  /* --- the lay and the bundle ------------------------------------- */

  let envelopeMm: number | undefined;
  const lay = recipe.lay;
  if (lay !== undefined) {
    const ringOds = lay.ring.map((id) => coreOds.get(id));
    if (ringOds.length > 0 && ringOds.every((od): od is number => od !== undefined)) {
      const widest = Math.max(...ringOds);
      const centerOd = lay.center === undefined ? 0 : (coreOds.get(lay.center) ?? 0);
      const innerOds = (lay.inner ?? []).map((id) => coreOds.get(id) ?? 0);
      // a figure-8's outline is derived below, from its legs and web
      if (LAY_ARRANGEMENT_RING_COUNT[lay.arrangement] === lay.ring.length && lay.arrangement !== 'figure-8') {
        const env = layEnvelope(lay.arrangement, widest, centerOd, innerOds);
        envelopeMm = roundTo(env.od, 3);
        note({ path: 'stock', field: 'envelopeMm', value: envelopeMm, formula: env.formula, inferred: false });
      }
    }
  }

  /* --- a figure-8: two jacketed legs joined by a web --------------- */

  let profile: WireProfile | undefined;
  if (lay?.arrangement === 'figure-8') {
    const legOds = lay.ring.map((id) => coreOds.get(id));
    const web = recipe.web;
    if (web === undefined) {
      issues.push(issue('wire-figure8-web', 'a figure-8 stock needs its web (the moulding that joins the two legs)', `${where}/web`, 'warning'));
    }
    if (recipe.jacket !== undefined) {
      issues.push(issue('wire-figure8-jacket', 'a figure-8 stock has no overall jacket — each leg carries its own (its sheath)', `${where}/jacket`, 'warning'));
    }
    for (const id of lay.ring) {
      const leg = children.find((child) => child.id === id);
      const sheathed = leg?.kind === 'group' && leg.children.some((child) => child.id === 'sheath');
      if (leg !== undefined && !sheathed) {
        issues.push(issue('wire-figure8-leg', `figure-8 leg '${id}' has no jacket of its own (a sheath part)`, `${where}/cores/${id}`, 'warning'));
      }
    }
    if (web !== undefined && legOds.length === 2 && legOds.every((od): od is number => od !== undefined)) {
      const leg = Math.max(...legOds);
      const gap = web.gapMm ?? 0;
      const pitch = roundTo(leg + gap, 3);
      const width = roundTo(pitch + leg, 3);
      const thicknessInferred = web.thicknessMm === undefined;
      const webMm = roundTo(web.thicknessMm ?? 0.6 * leg, 3);
      note({ path: 'stock', field: 'pitchMm', value: pitch, formula: `leg Ø + gap = ${mm(leg)} + ${mm(gap)}`, inferred: false });
      note({ path: 'stock', field: 'widthMm', value: width, formula: `pitch + leg Ø = ${mm(pitch)} + ${mm(leg)}`, inferred: false });
      note({ path: 'stock', field: 'heightMm', value: leg, formula: `leg Ø = ${mm(leg)}`, inferred: false });
      if (thicknessInferred) {
        note({ path: 'stock', field: 'webMm', value: webMm, formula: `0.6 × leg Ø = 0.6 × ${mm(leg)}`, inferred: true });
      }
      envelopeMm = width;
      profile = {
        shape: 'figure-8',
        widthMm: width,
        heightMm: leg,
        legOdMm: leg,
        pitchMm: pitch,
        webMm,
        src: [
          web.src,
          `Width = pitch + leg Ø = ${mm(pitch)} + ${mm(leg)}; height = leg Ø.`,
          thicknessInferred ? `Web ${mm(webMm)} mm INFERRED (0.6 × leg Ø).` : '',
          stockInferred ? 'Construction INFERRED — see the stock src.' : '',
        ]
          .filter((bit) => bit !== '')
          .join(' '),
      };
      const element: InsulationElement = {
        kind: 'insulation',
        id: 'web',
        label: 'Moulded web joining the two legs',
        material: web.material,
      };
      if (web.color !== undefined) element.color = web.color;
      const src = srcOf(undefined, [web.src]);
      if (src !== undefined) element.src = src;
      children.push(element);
    }
  }

  /* --- overall layers --------------------------------------------- */

  const jacketPart = lookup(parts, recipe.jacket, 'jacket', `${where}/jacket`, issues);
  const overall = recipe.overall ?? {};
  const overallShield = lookup(parts, overall.shield, 'shield', `${where}/overall`, issues);
  let overallOd: number | undefined;
  if (overallShield !== undefined) {
    const element: ShieldElement = {
      kind: 'shield',
      id: overall.shieldId ?? 'overall-shield',
      label: fill(overallShield.elementLabel ?? 'Overall shield', undefined),
      construction: overallShield.construction,
      material: overallShield.material,
    };
    if (overallShield.coveragePct !== undefined) element.coveragePct = overallShield.coveragePct;
    const notes: string[] = [];
    if (overall.shieldOdMm !== undefined) {
      overallOd = overall.shieldOdMm;
      if (overall.shieldOdSrc !== undefined) notes.push(overall.shieldOdSrc);
    } else if (envelopeMm !== undefined && overallShield.thicknessMm !== undefined) {
      overallOd = roundTo(envelopeMm + 2 * overallShield.thicknessMm, 3);
      note({ path: 'overall-shield', field: 'odMm', value: overallOd, formula: `bundle + 2·t = ${mm(envelopeMm)} + 2 × ${mm(overallShield.thicknessMm)}`, inferred: false });
    } else if (envelopeMm !== undefined && jacketPart !== undefined) {
      overallOd = roundTo((envelopeMm + jacketPart.odMm) / 2, 3);
      const formula = `midpoint of bundle and jacket: (${mm(envelopeMm)} + ${mm(jacketPart.odMm)}) / 2`;
      note({ path: 'overall-shield', field: 'odMm', value: overallOd, formula, inferred: true });
      notes.push(`Ø INFERRED (${formula}).`);
    }
    if (overallOd !== undefined) element.odMm = overallOd;
    const src = srcOf(overallShield, notes);
    if (src !== undefined) element.src = src;
    children.push(element);
  }

  const drainPart = lookup(parts, overall.drain, 'conductor', `${where}/overall`, issues);
  if (drainPart !== undefined) {
    // a drain is drawn and keyed by its copper alone: formation and Ø
    const element: ConductorElement = {
      kind: 'conductor',
      id: 'drain',
      label: fill(recipe.labels?.drain ?? drainPart.elementLabel ?? 'Drain wire (bare)', undefined),
      bare: true,
    };
    const formation = formationOf(drainPart);
    if (formation !== undefined) element.formation = formation;
    const notes: string[] = [];
    if (drainPart.odMm !== undefined) element.odMm = drainPart.odMm;
    else if (drainPart.strands !== undefined && drainPart.strandMm !== undefined) {
      const od = strandedOd(drainPart.strands, drainPart.strandMm);
      element.odMm = roundTo(od.od, 2);
      note({ path: 'drain', field: 'odMm', value: element.odMm, formula: od.formula, inferred: od.inferred });
      notes.push(`Ø derived (${od.formula})${inferredTag(od.inferred)}.`);
    }
    const src = srcOf(drainPart, notes);
    if (src !== undefined) element.src = src;
    children.push(element);
  }

  if (jacketPart !== undefined) {
    const element: InsulationElement = {
      kind: 'insulation',
      id: 'jacket',
      label: jacketPart.elementLabel ?? 'Outer jacket',
      material: jacketPart.material,
      odMm: jacketPart.odMm,
    };
    if (jacketPart.color !== undefined) element.color = jacketPart.color;
    const src = srcOf(jacketPart);
    if (src !== undefined) element.src = src;
    children.push(element);
    const under = overallOd ?? envelopeMm;
    if (under !== undefined) {
      const wall = roundTo((jacketPart.odMm - under) / 2, 3);
      note({
        path: 'jacket',
        field: 'wallMm',
        value: wall,
        formula: `(jacket Ø − ${overallOd === undefined ? 'bundle' : 'overall shield'} Ø) / 2 = (${mm(jacketPart.odMm)} − ${mm(under)}) / 2`,
        inferred: overallOd === undefined,
      });
      if (wall < 0.3) {
        issues.push(
          issue(
            'wire-jacket-thin',
            `the jacket wall works out at ${mm(wall)} mm — under 0.3 mm the cores will not fit this jacket`,
            `${where}/jacket`,
            'warning',
          ),
        );
      }
    }
  }

  /* --- fit check -------------------------------------------------- */

  if (envelopeMm !== undefined && profile === undefined) {
    const limit = overallOd ?? jacketPart?.odMm;
    if (limit !== undefined && envelopeMm > limit + 1e-9) {
      issues.push(
        issue(
          'wire-overfill',
          `the cores lay out at Ø ${mm(envelopeMm)} mm, larger than the ${overallOd === undefined ? 'jacket' : 'overall shield'} (Ø ${mm(limit)} mm)`,
          `${where}/lay`,
          'warning',
        ),
      );
    }
  }

  /* --- the definition --------------------------------------------- */

  const root: GroupElement = {
    kind: 'group',
    id: recipe.id,
    label: recipe.rootLabel ?? `${recipe.partNumber ?? recipe.label} cable`,
    role: 'cable',
    children,
    src: recipe.specRef ?? recipe.src,
  };

  const wire: WireDefinition = {
    id: recipe.id,
    label: recipe.label,
    ...(recipe.partNumber === undefined ? {} : { partNumber: recipe.partNumber }),
    ...(recipe.specRef === undefined ? {} : { specRef: recipe.specRef }),
    ...(recipe.manufacturer === undefined ? {} : { manufacturer: recipe.manufacturer }),
    ...(recipe.vendorDocs === undefined || recipe.vendorDocs.length === 0
      ? {}
      : { vendorDocs: recipe.vendorDocs.map((doc) => ({ ...doc })) }),
    ...(profile !== undefined ? { odMm: profile.widthMm } : jacketPart === undefined ? {} : { odMm: jacketPart.odMm }),
    ...(profile === undefined ? {} : { profile }),
    src: recipe.src,
    structure: root,
  };
  if (lay !== undefined) {
    const layOrder: WireLayOrder = {
      arrangement: lay.arrangement,
      direction: lay.direction,
      ring: [...lay.ring],
      src: lay.src,
    };
    if (lay.viewedFrom !== undefined) layOrder.viewedFrom = lay.viewedFrom;
    if (lay.center !== undefined) layOrder.center = lay.center;
    if (lay.inner !== undefined) layOrder.inner = [...lay.inner];
    wire.layOrder = layOrder;
  }
  if (recipe.bonded !== undefined && recipe.bonded.length > 0) {
    wire.bonded = recipe.bonded.map((set) => ({ members: [...set.members], src: set.src }));
  }

  /* --- recorded overrides ----------------------------------------- */

  for (const override of recipe.overrides ?? []) {
    const element = resolveElementPath(root, override.path) as Record<string, unknown> | undefined;
    if (element === undefined || element['kind'] === 'group' && override.set === undefined && override.unset === undefined) {
      if (element === undefined) {
        issues.push(issue('wire-override-unknown', `override names '${override.path}', which the recipe does not make`, `${where}/overrides`));
      }
      continue;
    }
    for (const [key, value] of Object.entries(override.set ?? {})) element[key] = value;
    for (const key of override.unset ?? []) delete element[key];
  }

  /* --- validation of the result ----------------------------------- */

  if (lay !== undefined) issues.push(...validateWireLayOrder(wire));
  for (const [index, set] of (wire.bonded ?? []).entries()) {
    for (const member of set.members) {
      if (resolveElementPath(root, member) === undefined) {
        issues.push(issue('wire-bonded-unknown', `bonded set ${index + 1} names '${member}', which the recipe does not make`, `${where}/bonded`));
      }
    }
  }

  return { wire, derived, issues, ...(envelopeMm === undefined ? {} : { envelopeMm }) };
}

/* ------------------------------------------------------------------ *
 * Bonding suggestion
 * ------------------------------------------------------------------ */

/**
 * What the construction says is one copper mass (§6.2): spiral core shields
 * with no sheath over them touch each other, the overall foil and the drain
 * all along the cable (bonded multi-core); a foil or tape with a drain laid on it is
 * one pair (mini-coax). A coax braid under its own sheath touches nothing.
 * A suggestion only — bonding is a physical fact the owner confirms.
 */
export function suggestBondedSets(wire: WireDefinition): string[][] {
  const root = wire.structure;
  const exposed: string[] = [];
  for (const child of root.children) {
    if (child.kind !== 'group') continue;
    const shield = child.children.find((c) => c.kind === 'shield');
    const sheathed = child.children.some((c) => c.id === 'sheath');
    if (shield !== undefined && !sheathed) exposed.push(`${child.id}.${shield.id}`);
  }
  const overall = root.children.find((c) => c.kind === 'shield');
  const drain = root.children.find((c) => c.kind === 'conductor' && c.bare === true);
  const outer = [overall?.id, drain?.id].filter((id): id is string => id !== undefined);
  if (exposed.length > 0 && overall !== undefined) return [[...exposed, ...outer]];
  if (overall !== undefined && drain !== undefined) return [outer];
  return [];
}

/* ------------------------------------------------------------------ *
 * Library validation
 * ------------------------------------------------------------------ */

/** Parts: unique ids, `src` present, dimensions positive, core layers resolve. */
export function validateWireParts(parts: readonly WirePart[]): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const byId = new Map(parts.map((part) => [part.id, part]));
  for (const part of parts) {
    const where = `wire-parts/${part.id}`;
    if (seen.has(part.id)) issues.push(issue('duplicate-id', `duplicate wire part id '${part.id}'`, where));
    seen.add(part.id);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part.id)) {
      issues.push(issue('wire-part-id', `wire part id '${part.id}' is not kebab-case`, where));
    }
    if (!part.src) issues.push(issue('missing-src', `wire part '${part.id}' has no src citation`, where, 'warning'));
    const numbers = Object.entries(part).filter(([, value]) => typeof value === 'number') as [string, number][];
    for (const [key, value] of numbers) {
      if (!(value > 0)) issues.push(issue('wire-part-dimension', `wire part '${part.id}' ${key} must be positive`, where));
    }
    if (part.kind === 'conductor' && part.odMm === undefined && (part.strands === undefined) !== (part.strandMm === undefined)) {
      issues.push(issue('wire-part-dimension', `conductor '${part.id}' gives a strand count without a strand Ø (or the reverse)`, where));
    }
    if (part.kind === 'core') {
      const want: [string | undefined, WirePartKind][] = [
        [part.conductor, 'conductor'],
        [part.dielectric, 'insulation'],
        [part.insulation, 'insulation'],
        [part.shield, 'shield'],
        [part.sheath, 'insulation'],
      ];
      for (const [id, kind] of want) {
        if (id === undefined) continue;
        const target = byId.get(id);
        if (target === undefined) issues.push(issue('wire-part-unknown', `core '${part.id}' names part '${id}', which is not in the library`, where));
        else if (target.kind !== kind) issues.push(issue('wire-part-kind', `core '${part.id}' needs a ${kind} for '${id}', not a ${target.kind}`, where));
      }
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * Comparing a compiled stock with a recorded one
 * ------------------------------------------------------------------ */

/** Numeric fields compared within a tolerance, mm / mm². */
const TOLERANCE: Readonly<Record<string, number>> = { odMm: 0.02, insulatedOdMm: 0.02, areaMm2: 0.002 };

/**
 * The facts of a stock: everything but element `src` prose (a citation, not
 * a value) — ids, kinds, roles, tree shape, labels, colours, materials,
 * formations, diameters, the lay and the bonded sets, stock src included.
 */
export interface WireFactDiff {
  path: string;
  field: string;
  recorded: unknown;
  compiled: unknown;
}

function elementFacts(element: Element): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element)) {
    if (key === 'src' || key === 'children') continue;
    out[key] = value;
  }
  return out;
}

/** JSON with object keys sorted — key order is not a fact. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sameValue(field: string, a: unknown, b: unknown): boolean {
  const tol = TOLERANCE[field];
  if (tol !== undefined && typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol + 1e-9;
  return canonical(a) === canonical(b);
}

/** Every fact on which `compiled` differs from `recorded`. Empty = the same stock. */
export function diffWireFacts(recorded: WireDefinition, compiled: WireDefinition): WireFactDiff[] {
  const diffs: WireFactDiff[] = [];
  const stockFields = ['id', 'label', 'partNumber', 'specRef', 'manufacturer', 'odMm', 'src'] as const;
  for (const field of stockFields) {
    if (!sameValue(field, recorded[field], compiled[field])) {
      diffs.push({ path: 'stock', field, recorded: recorded[field], compiled: compiled[field] });
    }
  }
  if (!sameValue('layOrder', recorded.layOrder ?? null, compiled.layOrder ?? null)) {
    diffs.push({ path: 'stock', field: 'layOrder', recorded: recorded.layOrder, compiled: compiled.layOrder });
  }
  if (!sameValue('bonded', recorded.bonded ?? null, compiled.bonded ?? null)) {
    diffs.push({ path: 'stock', field: 'bonded', recorded: recorded.bonded, compiled: compiled.bonded });
  }
  if (!sameValue('vendorDocs', recorded.vendorDocs ?? null, compiled.vendorDocs ?? null)) {
    diffs.push({ path: 'stock', field: 'vendorDocs', recorded: recorded.vendorDocs, compiled: compiled.vendorDocs });
  }
  // the outline's numbers, not its src prose
  const outline = (profile: WireDefinition['profile']): unknown =>
    profile === undefined ? null : { ...profile, src: undefined };
  if (!sameValue('profile', outline(recorded.profile), outline(compiled.profile))) {
    diffs.push({ path: 'stock', field: 'profile', recorded: recorded.profile, compiled: compiled.profile });
  }

  const walk = (a: Element | undefined, b: Element | undefined, path: string): void => {
    if (a === undefined || b === undefined) {
      diffs.push({ path, field: 'element', recorded: a?.kind ?? null, compiled: b?.kind ?? null });
      return;
    }
    const fa = elementFacts(a);
    const fb = elementFacts(b);
    for (const field of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
      if (!sameValue(field, fa[field], fb[field])) diffs.push({ path, field, recorded: fa[field], compiled: fb[field] });
    }
    if (a.kind === 'group' && b.kind === 'group') {
      const ids = [...new Set([...a.children.map((c) => c.id), ...b.children.map((c) => c.id)])];
      for (const id of ids) {
        walk(
          a.children.find((c) => c.id === id),
          b.children.find((c) => c.id === id),
          path === '' ? id : `${path}.${id}`,
        );
      }
      const orderA = a.children.map((c) => c.id).join(',');
      const orderB = b.children.map((c) => c.id).join(',');
      if (orderA !== orderB) diffs.push({ path, field: 'children-order', recorded: orderA, compiled: orderB });
    }
  };
  walk(recorded.structure, compiled.structure, '');
  return diffs;
}

/**
 * Elements whose recorded src flags a value as INFERRED and whose compiled
 * src does not — an assumption must never be laundered into a fact by
 * recompiling.
 */
export function lostInferredFlags(recorded: WireDefinition, compiled: WireDefinition): string[] {
  const lost: string[] = [];
  const walk = (element: Element, path: string): void => {
    if (element.kind === 'group') {
      for (const child of element.children) walk(child, `${path}.${child.id}`);
      return;
    }
    if (element.src !== undefined && /INFERRED/.test(element.src)) {
      const twin = resolveElementPath(compiled.structure, path);
      if (twin === undefined || !/INFERRED/.test(twin.src ?? '')) lost.push(path);
    }
  };
  for (const child of recorded.structure.children) {
    if (child.kind === 'group') for (const grand of child.children) walk(grand, `${child.id}.${grand.id}`);
    else walk(child, child.id);
  }
  return lost;
}

/**
 * Pull `WireRecipe`s that name a stock the library holds, by stock id.
 */
export function recipeFor(library: WireLibrary, wireId: string): WireRecipe | undefined {
  return library.recipes.find((recipe) => recipe.id === wireId);
}
