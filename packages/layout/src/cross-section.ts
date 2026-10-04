/**
 * `crossSectionLayout(wire)` — the cable seen end-on, true to the spec sheet.
 *
 * The KTL standards draw every stock as a cutaway, and the drawing is not
 * decoration: it is where the mandatory lay order lives ("Adhere to color
 * order shown"). This pass turns a `WireDefinition` into positioned circles —
 * nothing here picks paint, hatch or fonts.
 *
 * How the geometry is built, all of it from documented diameters:
 *
 * - **Rings.** Each element of a core contributes one ring whose outer radius
 *   is its own diameter; rings sort by diameter and each starts where the
 *   previous one ended, so the annulus widths are exactly what the spec sheet
 *   implies. No wall thickness is ever invented.
 * - **The lay.** Ring cores sit on a pitch circle at the radius where
 *   neighbours just touch (`rc / sin(π/n)`), widened if the centre core needs
 *   the room. They are placed in `layOrder.ring` order, the first at 12
 *   o'clock, running counter-clockwise on the page for `direction: 'ccw'`.
 * - **The drain** is not on the pitch circle: it sits in the angular gap
 *   between two ring cores (the first one, clockwise/ccw from the lay's own
 *   12 o'clock start — every such gap is the same width, the ring cores
 *   being evenly spaced, so "the widest gap" is a deterministic pick, not a
 *   search) but pushed all the way out to touch the inside of the overall
 *   shield, not tangent to its neighbours — owner
 *   2026-09-24: "in a gap near the outer edge, right up against the shield
 *   ... not super close to two color conductors like coax has it now."
 *
 * - **A figure-8** (: the 2×RCA lead — "two black
 *   jackets molded together like a figure 8") has no round jacket at all:
 *   its two legs sit side by side, left then right, `profile.pitchMm`
 *   apart, each drawn with its own black jacket, and the web between them is
 *   the `outline` — two joined circles, never one big one. `odMm` (and the
 *   `jacket` ring, kept as the bounding circle for anything that sizes by a
 *   single Ø) is the width, the larger dimension.
 *
 * Everything is deterministic arithmetic over the declared order — no
 * iteration over unordered sets, no clock, no randomness.
 */

import { isGroup, resolveElementPath, stripMakerSuffix } from '@cable-studio/model';
import type {
  ConductorElement,
  Element,
  InsulationElement,
  ShieldElement,
  WireDefinition,
} from '@cable-studio/model';

import { figure8Path } from './figure8.ts';
import { METRICS as M } from './metrics.ts';
import type {
  CrossSection,
  CrossSectionCore,
  CrossSectionKeyEntry,
  CrossSectionOutline,
  CrossSectionRing,
  Point,
} from './model.ts';
import { maxTextWidth, textWidth } from './text.ts';

export interface CrossSectionOptions {
  /** paper mm per cable mm (default `METRICS.crossSectionScale`) */
  scale?: number;
  /** top-left corner of the panel (default the page origin) */
  origin?: Point;
  /** override the panel heading (default the stock's label) — sizes the box */
  title?: string;
}

/* ------------------------------------------------------------------ *
 * Reading diameters out of the element tree
 * ------------------------------------------------------------------ */

/** Diameter over an element, mm — `undefined` when the stock doesn't say. */
function outerDiameter(element: Element): number | undefined {
  switch (element.kind) {
    case 'conductor':
      return element.insulatedOdMm ?? element.odMm;
    case 'insulation':
      return element.odMm;
    case 'shield':
      return element.odMm;
    case 'group':
      return undefined;
  }
}

interface RingSpec {
  elementPath: string;
  kind: 'conductor' | 'insulation' | 'shield';
  label: string;
  odMm: number;
  colorName?: string;
  bare?: boolean;
  construction?: 'braid' | 'spiral' | 'foil' | 'tape';
}

function labelFor(path: string, element: Element): string {
  return element.label === undefined ? path : `${path} · ${element.label}`;
}

function conductorSpec(path: string, element: ConductorElement, odMm: number): RingSpec {
  return {
    elementPath: path,
    kind: 'conductor',
    label: labelFor(path, element),
    odMm,
    ...(element.color === undefined ? {} : { colorName: element.color }),
    ...(element.bare === true ? { bare: true } : {}),
  };
}

function insulationSpec(path: string, element: InsulationElement, odMm: number): RingSpec {
  return {
    elementPath: path,
    kind: 'insulation',
    label: labelFor(path, element),
    odMm,
    ...(element.color === undefined ? {} : { colorName: element.color }),
  };
}

function shieldSpec(path: string, element: ShieldElement, odMm: number): RingSpec {
  return {
    elementPath: path,
    kind: 'shield',
    label: labelFor(path, element),
    odMm,
    construction: element.construction,
  };
}

/**
 * The rings of one core, innermost first.
 *
 * A core is normally a group (conductor → dielectric → shield → sheath), but
 * the mini-coax `core-brown` is a bare `conductor` element carrying its own
 * insulation diameter, because its terminal path has to stay `core-brown`.
 */
function coreRingSpecs(path: string, element: Element): RingSpec[] {
  const specs: RingSpec[] = [];
  if (isGroup(element)) {
    for (const child of element.children) {
      const childPath = `${path}.${child.id}`;
      const od = outerDiameter(child);
      if (od === undefined || od <= 0) continue;
      if (child.kind === 'conductor') specs.push(conductorSpec(childPath, child, od));
      else if (child.kind === 'insulation') specs.push(insulationSpec(childPath, child, od));
      else if (child.kind === 'shield') specs.push(shieldSpec(childPath, child, od));
    }
  } else if (element.kind === 'conductor') {
    const copper = element.odMm ?? 0;
    if (copper > 0) specs.push(conductorSpec(path, element, copper));
    if (element.insulatedOdMm !== undefined && element.insulatedOdMm > copper) {
      specs.push({
        elementPath: path,
        kind: 'insulation',
        label: `${path} · insulation`,
        odMm: element.insulatedOdMm,
        ...(element.color === undefined ? {} : { colorName: element.color }),
      });
    }
  }
  // physically the cross-section is ordered by diameter; declaration order is
  // only a tie-break, so a stock authored out of order still draws correctly
  return specs
    .map((spec, index) => ({ spec, index }))
    .sort((x, y) => (x.spec.odMm === y.spec.odMm ? x.index - y.index : x.spec.odMm - y.spec.odMm))
    .map((entry) => entry.spec);
}

function materialise(
  specs: readonly RingSpec[],
  cx: number,
  cy: number,
  scale: number,
): CrossSectionRing[] {
  const rings: CrossSectionRing[] = [];
  let inner = 0;
  for (const spec of specs) {
    const r = (spec.odMm / 2) * scale;
    rings.push({
      elementPath: spec.elementPath,
      kind: spec.kind,
      label: spec.label,
      cx,
      cy,
      r,
      rInner: Math.min(inner, r),
      odMm: spec.odMm,
      ...(spec.colorName === undefined ? {} : { colorName: spec.colorName }),
      ...(spec.bare === undefined ? {} : { bare: spec.bare }),
      ...(spec.construction === undefined ? {} : { construction: spec.construction }),
    });
    inner = Math.max(inner, r);
  }
  return rings;
}

/* ------------------------------------------------------------------ *
 * crossSectionLayout
 * ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

/** Angles are reported in [0, 360) so a reader can compare them directly. */
function normalizeAngle(angleDeg: number): number {
  return ((angleDeg % 360) + 360) % 360;
}

/** Screen point at `radius` and `angleDeg` CCW from 12 o'clock (y runs down). */
function polar(cx: number, cy: number, radius: number, angleDeg: number): Point {
  return {
    x: cx + radius * Math.cos(angleDeg * DEG),
    y: cy - radius * Math.sin(angleDeg * DEG),
  };
}

/**
 * The positioned cutaway, or `undefined` when the stock's geometry is not
 * documented well enough to draw one honestly (no jacket diameter, or a core
 * with no diameters at all). Callers treat `undefined` as "no inset".
 */
export function crossSectionLayout(
  wire: WireDefinition,
  options: CrossSectionOptions = {},
): CrossSection | undefined {
  const scale = options.scale ?? M.crossSectionScale;
  const origin = options.origin ?? { x: 0, y: 0 };
  const root = wire.structure;

  /* --- 1 · the outer layers ---------------------------------------- */

  // the jacket is the widest insulation the root group carries
  const jacketElement = root.children
    .filter(
      (child): child is InsulationElement =>
        child.kind === 'insulation' && child.odMm !== undefined && child.odMm > 0,
    )
    .reduce<InsulationElement | undefined>(
      (widest, child) =>
        widest === undefined || (child.odMm ?? 0) > (widest.odMm ?? 0) ? child : widest,
      undefined,
    );
  const odMm = jacketElement?.odMm ?? wire.odMm;
  if (odMm === undefined || odMm <= 0 || scale <= 0) return undefined;

  const overallShieldElement = root.children.find(
    (child): child is ShieldElement =>
      child.kind === 'shield' && child.odMm !== undefined && child.odMm > 0,
  );
  const drainElement = root.children.find(
    (child): child is ConductorElement =>
      child.kind === 'conductor' &&
      child.bare === true &&
      child.odMm !== undefined &&
      child.odMm > 0,
  );

  /* --- 2 · which elements are cores, and in what order -------------- */

  const layOrder = wire.layOrder;
  const ringPaths =
    layOrder === undefined
      ? root.children.filter(isGroup).map((child) => child.id)
      : layOrder.ring;
  const centerPath = layOrder?.center;
  const direction = layOrder?.direction ?? 'ccw';
  if (ringPaths.length < 2) return undefined;
  const figure8 = layOrder?.arrangement === 'figure-8';

  interface CorePlan {
    path: string;
    label: string;
    specs: RingSpec[];
    r: number;
    colorName?: string;
  }

  const planFor = (path: string): CorePlan | undefined => {
    const element = resolveElementPath(root, path);
    if (element === undefined) return undefined;
    const specs = coreRingSpecs(path, element);
    if (specs.length === 0) return undefined;
    const outer = specs[specs.length - 1]!;
    const colorName =
      specs.find((spec) => spec.kind === 'conductor')?.colorName ?? outer.colorName;
    return {
      path,
      label: labelFor(path, element),
      specs,
      r: (outer.odMm / 2) * scale,
      ...(colorName === undefined ? {} : { colorName }),
    };
  };

  const ringPlans: CorePlan[] = [];
  for (const path of ringPaths) {
    const plan = planFor(path);
    if (plan === undefined) return undefined;
    ringPlans.push(plan);
  }
  const centerPlan = centerPath === undefined ? undefined : planFor(centerPath);
  // a centre pair (6-around-2): side by side across the axis
  const innerPlans: CorePlan[] = [];
  for (const path of layOrder?.inner ?? []) {
    const plan = planFor(path);
    if (plan !== undefined) innerPlans.push(plan);
  }

  /* --- 3 · the lay: pitch circle and angles ------------------------- */

  const count = ringPlans.length;
  const coreR = ringPlans.reduce((widest, plan) => Math.max(widest, plan.r), 0);
  const innerSpan = innerPlans.reduce((sum, plan) => sum + plan.r, 0);
  const centerR = Math.max(centerPlan?.r ?? 0, innerSpan);
  // neighbours just touching, opened up if the centre core needs more room;
  // a figure-8's legs sit left and right, its stated pitch apart
  const pitchR = figure8
    ? Math.max(((wire.profile?.pitchMm ?? 0) / 2) * scale, coreR)
    : Math.max(coreR / Math.sin(Math.PI / count), coreR + centerR);
  const step = figure8 ? 180 : direction === 'ccw' ? 360 / count : -360 / count;
  const angleOf = (index: number): number => (figure8 ? 180 : 90) + step * index;
  const bundleR = Math.max(pitchR + coreR, centerR);

  /* --- 4 · outer rings, and the panel box they need ----------------- */

  const jacketR = (odMm / 2) * scale;
  const shieldR =
    overallShieldElement?.odMm === undefined
      ? undefined
      : Math.min((overallShieldElement.odMm / 2) * scale, jacketR);
  const shieldInner =
    shieldR === undefined ? undefined : Math.max(0, Math.min(bundleR, shieldR - 0.3));
  const insideR = shieldInner ?? Math.max(0, Math.min(bundleR, jacketR - 0.3));

  const halfBox = jacketR + M.crossSectionCallout;
  // a figure-8 is only a leg tall, and its callouts run out sideways
  const halfBoxY = figure8
    ? Math.min(halfBox, ((wire.profile?.heightMm ?? odMm) / 2) * scale + M.crossSectionCallout / 2)
    : halfBox;
  const pad = M.crossSectionPad;

  const title = options.title ?? stripMakerSuffix(wire.label, wire.manufacturer);
  // our own number, never a source document's (owner 2026-09-25, pci.29)
  const subtitleParts = [
    wire.partNumber ?? wire.id,
    figure8
      ? `cross-section · figure-8, legs left to right looking into the ${layOrder?.viewedFrom ?? 'cut'} end`
      : `cross-section · lay order ${direction.toUpperCase()} from 12 o'clock`,
  ];
  const subtitle = subtitleParts.join(' · ');

  const titleY = origin.y + pad + M.fontBlockTitle;
  const subtitleY = titleY + M.fontBlockSub + 1.4;
  const circleTop = subtitleY + 3;
  const cx = origin.x + pad + halfBox;
  const cy = circleTop + halfBoxY;

  /* --- 5 · the cores ------------------------------------------------ */

  const cores: CrossSectionCore[] = [];

  const addCore = (
    plan: CorePlan,
    center: Point,
    tag: string,
    layIndex: number,
    leaderAngle: number,
    leaderFrom: number,
  ): void => {
    const start = polar(cx, cy, leaderFrom, leaderAngle);
    const end = polar(cx, cy, jacketR + M.crossSectionLeader, leaderAngle);
    const tagPoint = polar(cx, cy, jacketR + M.crossSectionLeader + 1.4, leaderAngle);
    const cosine = Math.cos(leaderAngle * DEG);
    const anchor: 'start' | 'middle' | 'end' =
      Math.abs(cosine) < 0.2 ? 'middle' : cosine > 0 ? 'start' : 'end';
    const rings = materialise(plan.specs, center.x, center.y, scale);
    // a figure-8 leg's outermost insulation is its jacket
    const outer = rings[rings.length - 1];
    if (figure8 && layIndex >= 0 && outer?.kind === 'insulation') outer.jacket = true;
    cores.push({
      elementPath: plan.path,
      label: plan.label,
      tag,
      layIndex,
      angleDeg: normalizeAngle(leaderAngle),
      cx: center.x,
      cy: center.y,
      r: plan.r,
      ...(plan.colorName === undefined ? {} : { colorName: plan.colorName }),
      rings,
      leader: [start, end],
      tagX: tagPoint.x,
      tagY: tagPoint.y + M.fontCrossSectionTag * 0.35,
      tagAnchor: anchor,
    });
  };

  ringPlans.forEach((plan, index) => {
    const angle = angleOf(index);
    addCore(plan, polar(cx, cy, pitchR, angle), String(index + 1), index, angle, pitchR);
  });

  // the valley between the last ring core and the first: the drain lives in
  // one of them, the centre core is called out through the opposite one
  const valleyStep = step / 2;
  const drainAngle = angleOf(0) - valleyStep;
  // opposite a valley is a valley only when the ring is even; with an odd
  // ring (7 around 1) it is a core, so step half a pitch back into a valley
  const centerAngle = drainAngle + 180 + (count % 2 === 1 ? valleyStep : 0);

  if (centerPlan !== undefined) {
    addCore(centerPlan, { x: cx, y: cy }, 'C', -1, centerAngle, centerR);
  }

  let innerX = cx - innerSpan;
  innerPlans.forEach((plan, index) => {
    const at = { x: innerX + plan.r, y: cy };
    innerX += plan.r * 2;
    // called out through the valley opposite the drain, fanned apart
    const angle = centerAngle + (index - (innerPlans.length - 1) / 2) * 14;
    addCore(plan, at, `C${index + 1}`, -1, angle, Math.hypot(at.x - cx, at.y - cy) + plan.r);
  });

  const drainOd = drainElement?.odMm;
  if (drainElement !== undefined && drainOd !== undefined) {
    const drainR = (drainOd / 2) * scale;
    //: seated against the inside of the overall shield —
    // not tangent to its two neighbouring ring cores (that read as "stuck
    // between two coloured conductors", the owner's complaint, and was this
    // seat's whole rule before). `tangentR` is kept only as a floor, in case
    // a stock's declared shield is tighter than its own bundle needs (a data
    // inconsistency the catalog doesn't have today) — never seat the drain
    // closer to centre than the point it would overlap a neighbour.
    const halfAngle = Math.abs(valleyStep) * DEG;
    const reach = (coreR + drainR) ** 2 - (pitchR * Math.sin(halfAngle)) ** 2;
    const tangentR = reach < 0 ? pitchR : pitchR * Math.cos(halfAngle) + Math.sqrt(reach);
    const seatR = Math.max(tangentR, insideR - drainR);
    addCore(
      {
        path: drainElement.id,
        label: labelFor(drainElement.id, drainElement),
        specs: [conductorSpec(drainElement.id, drainElement, drainOd)],
        r: drainR,
      },
      polar(cx, cy, seatR, drainAngle),
      'D',
      -2,
      drainAngle,
      seatR + drainR,
    );
  }

  /* --- 6 · outer rings --------------------------------------------- */

  const overallShield: CrossSectionRing | undefined =
    overallShieldElement === undefined || shieldR === undefined
      ? undefined
      : {
          elementPath: overallShieldElement.id,
          kind: 'shield',
          label: labelFor(overallShieldElement.id, overallShieldElement),
          cx,
          cy,
          r: shieldR,
          rInner: shieldInner ?? 0,
          odMm: overallShieldElement.odMm!,
          construction: overallShieldElement.construction,
        };

  const webElement = figure8
    ? root.children.find((child): child is InsulationElement => child.kind === 'insulation' && child.id === 'web')
    : undefined;
  const jacketColor = jacketElement?.color ?? webElement?.color;
  const jacket: CrossSectionRing = {
    elementPath: jacketElement?.id ?? webElement?.id ?? 'jacket',
    kind: 'insulation',
    label: figure8
      ? 'figure-8 jackets (legs + web)'
      : jacketElement === undefined
        ? 'jacket'
        : labelFor(jacketElement.id, jacketElement),
    cx,
    cy,
    r: jacketR,
    rInner: overallShield?.r ?? Math.min(bundleR, jacketR),
    odMm,
    ...(jacketColor === undefined ? {} : { colorName: jacketColor }),
    jacket: true,
  };

  let outline: CrossSectionOutline | undefined;
  const legs = cores.filter((core) => core.layIndex >= 0);
  if (figure8 && legs.length === 2) {
    const [left, right] = legs as [CrossSectionCore, CrossSectionCore];
    const r = Math.max(left.r, right.r);
    const webHalf = Math.min(((wire.profile?.webMm ?? (2 * r * 0.6) / scale) / 2) * scale, r);
    const heightMm = wire.profile?.heightMm ?? (2 * r) / scale;
    outline = {
      shape: 'figure-8',
      lobes: legs.map((leg) => ({ cx: leg.cx, cy: leg.cy, r })),
      webHalf,
      d: figure8Path({ x: left.cx, y: left.cy }, { x: right.cx, y: right.cy }, r, webHalf),
      widthMm: wire.profile?.widthMm ?? odMm,
      heightMm,
    };
  }

  /* --- 7 · dimension callout and ruler ------------------------------ */

  const dimensionY = cy + halfBoxY + 2;
  const dimension = {
    y: dimensionY,
    x1: cx - jacketR,
    x2: cx + jacketR,
    label:
      outline === undefined
        ? `Ø ${odMm.toFixed(2)} mm over the jacket`
        : `${outline.widthMm.toFixed(2)} × ${outline.heightMm.toFixed(2)} mm`,
    labelX: cx,
    labelY: dimensionY + M.fontCrossSectionKey + 1,
  };

  const spanMm = 5 * scale <= 2 * jacketR ? 5 : 2;
  const rulerY = dimension.labelY + 4.5;
  const ticks: number[] = [];
  for (let step_ = 0; step_ <= spanMm; step_ += 1) {
    ticks.push(cx - jacketR + step_ * scale);
  }
  const ruler = {
    x: cx - jacketR,
    y: rulerY,
    length: spanMm * scale,
    spanMm,
    ticks,
    label: `${spanMm} mm`,
    labelX: cx - jacketR + spanMm * scale + 1.5,
    labelY: rulerY + M.fontCrossSectionKey * 0.35,
  };

  /* --- 8 · the key -------------------------------------------------- */

  const keyX = cx + halfBox + M.crossSectionKeyGap;
  const keyEntries: {
    tag: string;
    text: string;
    kind: 'core' | 'shield' | 'jacket';
    colorName?: string;
    construction?: 'braid' | 'spiral' | 'foil' | 'tape';
  }[] = [];

  /*
   *: the key names copper only. A foil or tape
   * shield is trimmed back at both ends and never landed (owner, 2026-09-25:
   * "the foil doesn't typically get any indication on our drawings"), so its
   * ring still draws — it is the cable's real, to-scale geometry, and the
   * drain's seat is drawn against it — but it gets no key row, tag or note.
   * A fully bonded stock's core shields (bonded multi-core) are keyed once, as one
   * copper mass ("we treat all of the shielding material the same on
   * bonded multi-core and would indicate it together").
   */
  const allCoreShieldPaths = cores
    .flatMap((core) => core.rings)
    .filter((ring) => ring.kind === 'shield')
    .map((ring) => ring.elementPath);
  const massSet = (wire.bonded ?? []).find(
    (set) => allCoreShieldPaths.length > 0 && allCoreShieldPaths.every((path) => set.members.includes(path)),
  );
  const massHasDrain =
    massSet !== undefined &&
    massSet.members.some((path) => {
      const element = resolveElementPath(root, path);
      return element?.kind === 'conductor' && element.bare === true;
    });

  for (const core of cores) {
    const suffix =
      core.layIndex === -1
        ? ' — centre of the lay'
        : core.layIndex === -2
          ? ` — interstitial, not on the pitch circle${massSet !== undefined && massSet.members.includes(core.elementPath) ? ' — bonded with every core shield (one copper mass)' : ''}`
          : '';
    keyEntries.push({
      tag: core.tag,
      text: `${core.label}${suffix}`,
      kind: 'core',
      ...(core.colorName === undefined ? {} : { colorName: core.colorName }),
    });
  }

  const coreShield = cores
    .flatMap((core) => core.rings)
    .find((ring) => ring.construction !== undefined);
  if (coreShield !== undefined) {
    const element = resolveElementPath(root, coreShield.elementPath);
    const coverage =
      element !== undefined && element.kind === 'shield' && element.coveragePct !== undefined
        ? `, ${element.coveragePct}`
        : '';
    const material =
      element !== undefined && element.kind === 'shield' && element.material !== undefined
        ? `${element.material} `
        : '';
    const mass =
      massSet === undefined ? '' : ` — all bonded${massHasDrain ? ' with the drain' : ''}, one copper mass`;
    keyEntries.push({
      tag: '',
      text: `core shields · ${material}${coreShield.construction}${coverage}${mass}`,
      kind: 'shield',
      construction: coreShield.construction!,
    });
  }
  if (
    overallShield !== undefined &&
    overallShieldElement !== undefined &&
    overallShieldElement.construction !== 'foil' &&
    overallShieldElement.construction !== 'tape'
  ) {
    // a copper overall screen (a braid or spiral) keys like any other
    const coverage =
      overallShieldElement.coveragePct === undefined ? '' : `, ${overallShieldElement.coveragePct}`;
    const material =
      overallShieldElement.material === undefined ? '' : `${overallShieldElement.material} `;
    keyEntries.push({
      tag: '',
      text: `${overallShield.label} · ${material}${overallShield.construction}${coverage}`,
      kind: 'shield',
      construction: overallShield.construction!,
    });
  }
  keyEntries.push({
    tag: '',
    text:
      outline === undefined
        ? `${jacket.label} · Ø ${odMm.toFixed(2)} mm`
        : `${jacket.label} · ${outline.widthMm.toFixed(2)} × ${outline.heightMm.toFixed(2)} mm`,
    kind: 'jacket',
    ...(jacket.colorName === undefined ? {} : { colorName: jacket.colorName }),
  });

  // one character fits 3.4 mm; a centre-pair tag ("C1") needs another 1.8
  const tagColumnW = 3.4 + (Math.max(1, ...keyEntries.map((entry) => entry.tag.length)) - 1) * 1.8;
  const key: CrossSectionKeyEntry[] = keyEntries.map((entry, index) => {
    const y = circleTop + 2 + index * M.crossSectionKeyPitch;
    return {
      tag: entry.tag,
      text: entry.text,
      kind: entry.kind,
      ...(entry.colorName === undefined ? {} : { colorName: entry.colorName }),
      ...(entry.construction === undefined ? {} : { construction: entry.construction }),
      swatchX: keyX + M.crossSectionSwatchR,
      swatchY: y,
      swatchR: M.crossSectionSwatchR,
      tagX: keyX + 2 * M.crossSectionSwatchR + 1.4,
      textX: keyX + 2 * M.crossSectionSwatchR + 1.4 + tagColumnW,
      textY: y + M.fontCrossSectionKey * 0.35,
    };
  });

  /* --- 9 · the panel box -------------------------------------------- */

  const keyTextW = maxTextWidth(
    key.map((entry) => entry.text),
    M.fontCrossSectionKey,
  );
  const keyRight =
    key.length === 0 ? cx + halfBox : (key[0]?.textX ?? keyX) + keyTextW;
  const headingRight =
    origin.x +
    pad +
    Math.max(textWidth(title, M.fontBlockTitle, 'bold'), textWidth(subtitle, M.fontBlockSub));
  const right = Math.max(cx + halfBox, keyRight, headingRight);
  const keyBottom =
    key.length === 0 ? 0 : (key[key.length - 1]?.textY ?? 0) + M.crossSectionKeyPitch;
  const bottom = Math.max(ruler.y + 3, keyBottom, cy + halfBoxY);

  return {
    wire: wire.id,
    title,
    subtitle,
    rect: {
      x: origin.x,
      y: origin.y,
      w: right - origin.x + pad,
      h: bottom - origin.y + pad,
    },
    titleX: origin.x + pad,
    titleY,
    subtitleY,
    cx,
    cy,
    scale,
    odMm,
    direction,
    arrangement: layOrder?.arrangement ?? `${count} cores`,
    jacket,
    ...(outline === undefined ? {} : { outline }),
    ...(overallShield === undefined ? {} : { overallShield }),
    cores,
    key,
    dimension,
    ruler,
  };
}
