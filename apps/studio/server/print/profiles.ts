/**
 * Print profiles (WF-PRINT): printer, material and process settings for FDM print preparation.
 * A profile is a small set of slicer settings (PrusaSlicer keys) with a label and a `src`; the
 * slicer pack merges printer → material → process (later wins) over its own defaults and returns
 * every setting it actually used, so a run is reproducible from its recorded profile hash.
 *
 * The hub's profiles are one catalog document, `data/print/profiles.json`, written through a
 * change set (history, revert). Until someone saves, the starter set below is used. The starter
 * values are generic starting points, not tuned for any machine.
 */

import { createHash } from 'node:crypto';

import { printTechnology, resinAdjustmentSettings } from './resin.ts';

export type PrintProfileKind = 'printer' | 'material' | 'process';
export type PrintSettingValue = string | number | boolean;

export interface PrintProfile {
  id: string;
  kind: PrintProfileKind;
  label: string;
  src: string;
  settings: Record<string, PrintSettingValue>;
}

export const PRINT_PROFILES_PATH = 'data/print/profiles.json';
export const PROFILE_KINDS: readonly PrintProfileKind[] = ['printer', 'material', 'process'];

const STARTER_SRC = 'synthetic example: generic starting values for a 0.4 mm FDM machine, not tuned for any particular printer or filament';

export const STARTER_PROFILES: readonly PrintProfile[] = [
  {
    id: 'generic-fdm-0.4', kind: 'printer', label: 'Generic FDM, 0.4 mm nozzle, 220 × 220 mm', src: STARTER_SRC,
    settings: {
      printer_technology: 'FFF', gcode_flavor: 'marlin2', bed_shape: '0x0,220x0,220x220,0x220', max_print_height: 250,
      nozzle_diameter: 0.4, retract_length: 0.8, retract_speed: 35, retract_lift: 0.2, use_relative_e_distances: true, layer_gcode: 'G92 E0', binary_gcode: false,
      start_gcode: 'G90\\nM83\\nG28 ; home\\nG1 Z5 F3000\\nG92 E0',
      end_gcode: 'M104 S0\\nM140 S0\\nM107\\nG91\\nG1 Z10 F3000\\nG90\\nM84',
    },
  },
  {
    id: 'generic-pla', kind: 'material', label: 'Generic PLA 1.75 mm', src: STARTER_SRC,
    settings: {
      filament_type: 'PLA', filament_diameter: 1.75, filament_density: 1.24, filament_cost: 20,
      temperature: 210, first_layer_temperature: 215, bed_temperature: 60, first_layer_bed_temperature: 60,
      cooling: true, min_fan_speed: 100, max_fan_speed: 100, disable_fan_first_layers: 1,
    },
  },
  {
    id: 'generic-petg', kind: 'material', label: 'Generic PETG 1.75 mm', src: STARTER_SRC,
    settings: {
      filament_type: 'PETG', filament_diameter: 1.75, filament_density: 1.27, filament_cost: 25,
      temperature: 240, first_layer_temperature: 240, bed_temperature: 80, first_layer_bed_temperature: 85,
      cooling: true, min_fan_speed: 30, max_fan_speed: 50, disable_fan_first_layers: 3,
    },
  },
  {
    id: 'standard-0.20', kind: 'process', label: 'Standard 0.20 mm, 2 walls, 20 % infill', src: STARTER_SRC,
    settings: {
      layer_height: 0.2, first_layer_height: 0.2, perimeters: 2, top_solid_layers: 5, bottom_solid_layers: 4,
      fill_density: '20%', fill_pattern: 'gyroid', support_material: false, skirts: 1, skirt_distance: 3,
    },
  },
  {
    id: 'sturdy-0.20', kind: 'process', label: 'Sturdy 0.20 mm, 4 walls, 40 % infill', src: STARTER_SRC,
    settings: {
      layer_height: 0.2, first_layer_height: 0.2, perimeters: 4, top_solid_layers: 6, bottom_solid_layers: 5,
      fill_density: '40%', fill_pattern: 'gyroid', support_material: false, skirts: 1, skirt_distance: 3,
    },
  },
];

const ID = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** settings that would reach outside the slice (post-processing scripts, printer hosts) */
const FORBIDDEN_KEY = /^(post_process|host_type|print_host|printhost_.*)$/;

/** Read a saved profile list, or say what is wrong with it. */
export function parseProfiles(value: unknown): { profiles: PrintProfile[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'Profiles are a list.' };
  const seen = new Set<string>();
  const out: PrintProfile[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return { error: 'Each profile is an object.' };
    const p = raw as Record<string, unknown>;
    const id = p['id'];
    if (typeof id !== 'string' || !ID.test(id)) return { error: `Profile id ${JSON.stringify(id)} is not kebab-case.` };
    if (seen.has(id)) return { error: `Profile ${id} is listed twice.` };
    seen.add(id);
    const kind = p['kind'];
    if (typeof kind !== 'string' || !(PROFILE_KINDS as readonly string[]).includes(kind)) return { error: `${id}: kind is printer, material or process.` };
    const label = typeof p['label'] === 'string' && p['label'].trim() !== '' ? p['label'].trim() : id;
    const src = typeof p['src'] === 'string' && p['src'].trim() !== '' ? p['src'].trim() : 'entered by a user';
    const settings = p['settings'];
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return { error: `${id}: settings is an object.` };
    const clean: Record<string, PrintSettingValue> = {};
    for (const [key, v] of Object.entries(settings as Record<string, unknown>)) {
      if (!KEY.test(key)) return { error: `${id}: ${JSON.stringify(key)} is not a slicer setting name.` };
      if (FORBIDDEN_KEY.test(key)) return { error: `${id}: ${key} is not allowed (it reaches outside the slice).` };
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return { error: `${id}: ${key} must be text, a number or true/false.` };
      if (typeof v === 'number' && !Number.isFinite(v)) return { error: `${id}: ${key} is not a finite number.` };
      if (typeof v === 'string' && v.length > 4000) return { error: `${id}: ${key} is too long.` };
      clean[key] = v;
    }
    out.push({ id, kind: kind as PrintProfileKind, label, src, settings: clean });
  }
  return { profiles: out };
}

/** The hub's profiles: the saved document when there is one, else the starter set. */
export function effectiveProfiles(saved: unknown): { profiles: PrintProfile[]; saved: boolean } {
  if (saved === undefined || saved === null) return { profiles: STARTER_PROFILES.map((p) => ({ ...p, settings: { ...p.settings } })), saved: false };
  const parsed = parseProfiles(saved);
  return 'error' in parsed ? { profiles: [...STARTER_PROFILES], saved: false } : { profiles: parsed.profiles, saved: true };
}

/** JSON with sorted keys, so equal profiles hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function profileHash(profile: PrintProfile): string {
  return createHash('sha256').update(canonical({ id: profile.id, kind: profile.kind, settings: profile.settings })).digest('hex');
}

export interface PrintProfileChoice {
  printer: PrintProfile;
  material: PrintProfile;
  process: PrintProfile;
}

/**
 * Per-slice choices the print panel offers over the process profile: supports and a brim. Absent
 * means "as the process profile says". They map to PrusaSlicer keys, are merged after the process
 * profile, and are part of the profile hash, so a run still names exactly what it used.
 */
export interface PrintAdjustments {
  supports?: 'off' | 'auto' | 'buildplate';
  /** brim width in mm; 0 = no brim */
  brimMm?: number;
}
export const SUPPORT_CHOICES = ['off', 'auto', 'buildplate'] as const;
export const MAX_BRIM_MM = 20;

/** Read the panel's adjustments, or say what is wrong. */
export function parseAdjustments(value: unknown): { adjustments: PrintAdjustments } | { error: string } {
  if (value === undefined || value === null) return { adjustments: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'Adjustments are an object ({ supports, brimMm }).' };
  const v = value as Record<string, unknown>;
  const out: PrintAdjustments = {};
  if (v['supports'] !== undefined) {
    if (!(SUPPORT_CHOICES as readonly unknown[]).includes(v['supports'])) return { error: `Supports are ${SUPPORT_CHOICES.join(', ')}, or left to the process profile.` };
    out.supports = v['supports'] as PrintAdjustments['supports'];
  }
  if (v['brimMm'] !== undefined) {
    const mm = v['brimMm'];
    if (typeof mm !== 'number' || !Number.isFinite(mm) || mm < 0 || mm > MAX_BRIM_MM) return { error: `A brim is 0 to ${MAX_BRIM_MM} mm wide.` };
    out.brimMm = Math.round(mm * 10) / 10;
  }
  return { adjustments: out };
}

/** The PrusaSlicer settings an adjustment stands for. */
export function adjustmentSettings(a: PrintAdjustments): Record<string, PrintSettingValue> {
  const out: Record<string, PrintSettingValue> = {};
  if (a.supports === 'off') out['support_material'] = false;
  if (a.supports === 'auto' || a.supports === 'buildplate') {
    Object.assign(out, { support_material: true, support_material_auto: true, support_material_buildplate_only: a.supports === 'buildplate' });
  }
  if (a.brimMm !== undefined) Object.assign(out, a.brimMm === 0 ? { brim_width: 0 } : { brim_width: a.brimMm, brim_type: 'outer_only' });
  return out;
}

/** The merged settings the pack receives (printer, then material, then process, then the panel's adjustments) and their hash. */
export function mergedProfile(choice: PrintProfileChoice, adjustments: PrintAdjustments = {}): { config: Record<string, PrintSettingValue>; sha256: string; parts: Record<PrintProfileKind, { id: string; label: string; sha256: string }>; adjustments?: PrintAdjustments } {
  const adjusted = Object.keys(adjustments).length > 0;
  const forAdjustments = printTechnology(choice.printer) === 'resin' ? resinAdjustmentSettings : adjustmentSettings;
  const config = { ...choice.printer.settings, ...choice.material.settings, ...choice.process.settings, ...forAdjustments(adjustments) };
  const parts = {
    printer: { id: choice.printer.id, label: choice.printer.label, sha256: profileHash(choice.printer) },
    material: { id: choice.material.id, label: choice.material.label, sha256: profileHash(choice.material) },
    process: { id: choice.process.id, label: choice.process.label, sha256: profileHash(choice.process) },
  };
  // without adjustments the hash is what it was before they existed, so earlier runs still compare
  const sha256 = createHash('sha256').update(canonical({ config, parts: { printer: parts.printer.id, material: parts.material.id, process: parts.process.id }, ...(adjusted ? { adjustments } : {}) })).digest('hex');
  return { config, sha256, parts, ...(adjusted ? { adjustments } : {}) };
}
