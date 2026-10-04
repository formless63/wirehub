/**
 * How the bench strips a stock's end: the standard
 * work's steps as data, so the 3D wire view can offer them as presets instead
 * of numbers baked into a component.
 *
 * A record states, per layer, how far back from the tip that layer is taken
 * off, what happens to the screens (trimmed, folded back, gathered into one
 * mass) and whether the drain is used at each end. Lengths the standard work
 * does not state are still recorded — a picture needs a number — but the
 * record names them in `inferred`, and its `src` says so in words.
 *
 * Pure data like everything in core: no IO, no clock.
 */

/** What is done to a core's screen once the layer over it is stripped. */
export type StripShieldTreatment =
  /** part of the exposed screen is cut off and the rest twisted into a pigtail (SW "Stripping Coax": ~80 % cut off) */
  | 'trim'
  /** the exposed screen is folded back over the layer outside it */
  | 'fold'
  /** unwound back to the jacket mouth and gathered into one pigtail (a bonded bonded multi-core mass) */
  | 'gather'
  /** left as it is, down to where the insulation under it starts */
  | 'keep';

export type StripDrainTreatment = 'land' | 'cut';

export interface StripPractice {
  id: string;
  /** the preset's name in the 3D view ("As stripped for the SCART board") */
  label: string;
  /**
   * the stocks it is written for: `coax` (cores built as coax), `bonded-mass`
   * (every core screen in one bonded set — bonded multi-core), or any stock
   */
  appliesTo: 'coax' | 'bonded-mass' | 'any';
  /** the overall jacket taken off from the tip, mm */
  jacketMm: number;
  /** a coax's own sheath taken off from the tip, mm (a shielded core has none) */
  sheathMm?: number;
  shield: StripShieldTreatment;
  /** `trim`: the share of the exposed screen left on, % */
  shieldKeepPct?: number;
  /** the dielectric / core insulation taken off from the tip — the bare conductor, mm */
  insulationMm: number;
  /**
   * The stripped insulation is left on the conductor ("strip … but do not
   * remove"), slid this far toward the tip, mm. Absent: removed.
   */
  insulationSlidMm?: number;
  /** is the drain landed or cut back flush, at each end (`a` = source, `b` = destination) */
  drain: { source: StripDrainTreatment; destination: StripDrainTreatment };
  /** the fields whose values are not stated by the source — named, so a view can say so */
  inferred?: (keyof StripPractice)[];
  src: string;
}

const TREATMENTS: readonly StripShieldTreatment[] = ['trim', 'fold', 'gather', 'keep'];

/** Problems with a practice record, in words — empty when it is usable. */
export function stripPracticeProblems(practice: StripPractice): string[] {
  const out: string[] = [];
  const where = `strip practice '${practice.id}'`;
  const length = (name: string, value: number | undefined): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value < 0) out.push(`${where}: ${name} must be a length of 0 mm or more.`);
  };
  if (practice.id === '' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(practice.id)) out.push(`${where}: the id must be kebab-case.`);
  if (practice.label.trim() === '') out.push(`${where}: it has no label.`);
  if (practice.src.trim() === '') out.push(`${where}: it does not cite where its steps come from.`);
  length('jacketMm', practice.jacketMm);
  length('sheathMm', practice.sheathMm);
  length('insulationMm', practice.insulationMm);
  length('insulationSlidMm', practice.insulationSlidMm);
  if (!TREATMENTS.includes(practice.shield)) out.push(`${where}: '${String(practice.shield)}' is not a screen treatment.`);
  if (practice.shieldKeepPct !== undefined && (practice.shieldKeepPct < 0 || practice.shieldKeepPct > 100)) {
    out.push(`${where}: shieldKeepPct is a share, 0 to 100.`);
  }
  if (practice.sheathMm !== undefined && practice.sheathMm > practice.jacketMm) {
    out.push(`${where}: the sheath cannot be stripped further back than the jacket.`);
  }
  if (practice.insulationMm > Math.max(practice.sheathMm ?? 0, practice.jacketMm)) {
    out.push(`${where}: the insulation cannot be stripped further back than the layers over it.`);
  }
  return out;
}
