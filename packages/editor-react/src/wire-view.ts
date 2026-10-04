/**
 * The parametric 3D wire view's state and the plain helpers around it
 *. No three.js here, so the main bundle can hold it:
 * the Library, the wire builder and the Inspector decide *what* to show
 * (a stock, its recipe's lay, the strip presets, a design's strip plan);
 * the lazy chunk (`panels/WireModel3d.tsx`) draws it.
 */

import type { StripPractice, WireDefinition, WireRecipe } from '@wirehub/model';
import { BARE_END, stripPresets, type StripEnd, type StripPreset, type WireEndShown, type WireModelOptions } from '@wirehub/render-svg';

/** Facts the recipe knows that the compiled stock does not carry. */
export interface WireLayFacts {
  /** assembly lay length, mm (the vendor "140 ± 10 mm") */
  layLengthMm?: number;
  hand?: 'S' | 'Z';
  /** the sheet lists a filler / strings */
  filler?: boolean;
}

export function layFactsOf(recipe: WireRecipe | undefined): WireLayFacts {
  if (recipe === undefined) return {};
  return {
    ...(recipe.lay?.layLengthMm === undefined ? {} : { layLengthMm: recipe.lay.layLengthMm }),
    ...(recipe.lay?.hand === undefined ? {} : { hand: recipe.lay.hand }),
    ...(recipe.overall?.filler === undefined ? {} : { filler: true }),
  };
}

export interface WireViewState {
  /** a preset id, or `custom` once a layer is moved */
  preset: string;
  strip: { a: StripEnd; b: StripEnd };
  lengthMm: number;
  show: WireEndShown;
  /** 0–1 */
  explode: number;
  twist: boolean;
  xray: boolean;
}

/** 6 ft: "bonded multi-core, in general, is always 6ft" (owner, decisions page 2026-09-29, pci.35). */
export const DEFAULT_LENGTH_MM = 1829;

/** The presets for a stock: "Bare cut" plus the practice written for its construction. */
export function presetsFor(wire: WireDefinition, practice: readonly StripPractice[]): StripPreset[] {
  return stripPresets(wire, practice);
}

/** Where a view starts: the first practice preset (a stripped end), end `a`, straight. */
export function initialWireView(presets: readonly StripPreset[], options: { lengthMm?: number; show?: WireEndShown; preset?: string } = {}): WireViewState {
  const chosen = presets.find((p) => p.id === options.preset) ?? presets[1] ?? presets[0];
  return {
    preset: chosen?.id ?? 'bare',
    strip: chosen?.strip ?? { a: BARE_END, b: BARE_END },
    lengthMm: options.lengthMm ?? DEFAULT_LENGTH_MM,
    show: options.show ?? 'a',
    explode: 0,
    twist: false,
    xray: false,
  };
}

/** The generator's options for a view state. */
export function modelOptionsOf(state: WireViewState, wire: WireDefinition, facts: WireLayFacts): WireModelOptions {
  const od = wire.odMm ?? 6;
  return {
    lengthMm: state.lengthMm,
    show: state.show,
    // a one-end view is about the strip: a short run of cable behind it
    windowMm: 12,
    strip: state.strip,
    explode: { radialMm: state.explode * od * 0.9, axialMm: state.explode * 2.5 },
    twist: state.twist,
    ...(facts.layLengthMm === undefined ? {} : { layLengthMm: facts.layLengthMm }),
    ...(facts.hand === undefined ? {} : { hand: facts.hand }),
    ...(facts.filler === true ? { filler: true } : {}),
    xray: state.xray,
  };
}

/** One layer moved at the end(s) being shown: the view becomes `custom`. */
export function withStrip(state: WireViewState, patch: Partial<StripEnd>): WireViewState {
  const a = state.show === 'b' ? state.strip.a : { ...state.strip.a, ...patch };
  const b = state.show === 'a' ? state.strip.b : { ...state.strip.b, ...patch };
  return { ...state, preset: 'custom', strip: { a: tidy(a), b: tidy(b) } };
}

/** Keep the layers in order: nothing inside is stripped further back than what is over it. */
function tidy(end: StripEnd): StripEnd {
  const sheathMm = Math.min(end.sheathMm, end.jacketMm);
  const outer = Math.max(sheathMm, end.jacketMm);
  return { ...end, sheathMm, insulationMm: Math.min(end.insulationMm, outer) };
}

/** The end whose strip the sliders show. */
export function editedEnd(state: WireViewState): StripEnd {
  return state.show === 'b' ? state.strip.b : state.strip.a;
}

/**
 * A design's strip plan at one end (the bench sheet's `SegmentEnd` rows, as
 * `stripFigure` draws them) laid over a base strip: cores the plan cuts back
 * are cut flush at the jacket, and the drain lands or is cut as the plan says.
 * `faces` (pigtail id → the board face it lands on, from the bench landings)
 * aims each twisted screen lead, the drain and a bonded mass at that face.
 */
export function stripFromPlan(
  base: StripEnd,
  rows: readonly { element: { path: string; kind: 'core' | 'screen' | 'drain'; group?: string }; treatment: { kind: string; pigtail?: string } }[],
  faces: ReadonlyMap<string, 'top' | 'bottom'> = new Map(),
): StripEnd {
  const cutCores = new Set<string>(base.cutCores ?? []);
  let drain = base.drain;
  const leads: Record<string, 'top' | 'bottom'> = {};
  for (const row of rows) {
    const cut = row.treatment.kind === 'cut';
    if (row.element.kind === 'drain') drain = cut ? 'cut' : 'land';
    if (row.element.kind === 'core' && cut) cutCores.add(row.element.group ?? row.element.path.split('.')[0] ?? row.element.path);
    const face = row.treatment.kind === 'twist' && row.treatment.pigtail !== undefined ? faces.get(row.treatment.pigtail) : undefined;
    if (face === undefined || row.element.kind === 'core') continue;
    const key = row.element.path === 'mass' ? 'mass' : row.element.kind === 'drain' ? 'drain' : (row.element.group ?? row.element.path.split('.')[0] ?? row.element.path);
    leads[key] = face;
  }
  return {
    ...base,
    drain,
    ...(cutCores.size === 0 ? {} : { cutCores: [...cutCores].sort() }),
    ...(Object.keys(leads).length === 0 ? {} : { leads }),
  };
}
