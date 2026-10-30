/**
 * OrcaSlicer as a second slicer for print preparation (`tools/slicer-orcaslicer/`). Where the
 * PrusaSlicer pack slices with the hub's own printer/material/process profiles (PrusaSlicer keys,
 * `profiles.ts`), this one slices with the presets OrcaSlicer ships per printer maker (QIDI and
 * Bambu Lab by default): a person picks a printer preset, then a filament and a process preset
 * OrcaSlicer offers for it.
 *
 * The pack's `profiles` op lists those presets with a hash each. It runs as a print-prepare job
 * (`task: 'profiles'`) and registers its `profiles.json` like any tool run, against the record
 * `tools/slicer-orcaslicer`; the API reads the newest one made by the current pack version.
 */

import { createHash } from 'node:crypto';

import type { WorkbenchDeps } from '../api.ts';
import { TOOL_PACKS } from '../tools/packs.ts';
import type { PrintAdjustments, PrintProfileKind, PrintSettingValue } from './profiles.ts';

export const ORCA_PACK = 'slicer-orcaslicer';
export const ORCA_PROFILES_OP = 'profiles';
/** the tool-run record the preset list registers against */
export const ORCA_PROFILES_RECORD = 'tools/slicer-orcaslicer';
export const SLICERS = ['prusaslicer', 'orcaslicer'] as const;
export type SlicerId = (typeof SLICERS)[number];

/** Profile folders the hub lists (`WIREHUB_ORCA_VENDORS`, comma separated; default QIDI and Bambu Lab). */
export function orcaVendors(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const raw = env.WIREHUB_ORCA_VENDORS?.split(',').map((v) => v.trim()).filter((v) => /^[A-Za-z0-9 _.-]{1,64}$/.test(v)) ?? [];
  return raw.length > 0 ? raw : ['BBL', 'Qidi'];
}

export interface OrcaPrinter {
  name: string;
  vendor: string;
  model?: string;
  nozzle?: number;
  bed?: [number, number];
  height?: number;
  flavor?: string;
  output: 'gcode' | 'gcode+3mf';
  defaultProcess: string;
  defaultMaterial: string;
  sha256: string;
  /** indexes into the catalog's processes / materials */
  processes: number[];
  materials: number[];
}

export interface OrcaCatalog {
  orcaVersion: string;
  vendors: { id: string; name: string; profileVersion: string }[];
  printers: OrcaPrinter[];
  processes: { name: string; vendor: string; layerHeight?: number; sha256: string }[];
  materials: { name: string; vendor: string; type?: string; sha256: string }[];
}

/** what the panel needs: the same lists without the hashes */
export function catalogView(c: OrcaCatalog): Record<string, unknown> {
  return {
    orcaVersion: c.orcaVersion,
    vendors: c.vendors,
    printers: c.printers.map(({ sha256: _s, ...p }) => p),
    processes: c.processes.map((p) => ({ name: p.name, ...(p.layerHeight === undefined || p.layerHeight === null ? {} : { layerHeight: p.layerHeight }) })),
    materials: c.materials.map((m) => ({ name: m.name, ...(m.type === undefined || m.type === null ? {} : { type: m.type }) })),
  };
}

const cache = new Map<string, OrcaCatalog>();

/** The newest preset list the current pack version made, or undefined (none yet, or another version's). */
export async function readOrcaCatalog(deps: WorkbenchDeps): Promise<{ catalog: OrcaCatalog; runId: string; createdAt: string } | undefined> {
  if (deps.toolOutputs === undefined) return undefined;
  const version = TOOL_PACKS[ORCA_PACK]!.version;
  const runs = await deps.toolOutputs.runs(ORCA_PROFILES_RECORD, { limit: 10 });
  const run = runs.find((r) => r.pack === ORCA_PACK && r.op === ORCA_PROFILES_OP && r.status === 'ok' && r.packVersion === version);
  const out = run?.outputs.find((o) => o.role === 'profiles');
  if (run === undefined || out === undefined) return undefined;
  let catalog = cache.get(out.sha256);
  if (catalog === undefined) {
    const file = await deps.toolOutputs.file(out.sha256);
    if (file === undefined) return undefined;
    catalog = JSON.parse(new TextDecoder().decode(file.bytes)) as OrcaCatalog;
    cache.set(out.sha256, catalog);
  }
  return { catalog, runId: run.id, createdAt: run.createdAt };
}

/** The OrcaSlicer settings a panel adjustment stands for (supports and brim). */
export function orcaAdjustmentSettings(a: PrintAdjustments): Record<string, PrintSettingValue> {
  const out: Record<string, PrintSettingValue> = {};
  if (a.supports === 'off') out['enable_support'] = false;
  if (a.supports === 'auto' || a.supports === 'buildplate') Object.assign(out, { enable_support: true, support_on_build_plate_only: a.supports === 'buildplate' });
  if (a.brimMm !== undefined) Object.assign(out, a.brimMm === 0 ? { brim_type: 'no_brim' } : { brim_type: 'outer_only', brim_width: a.brimMm });
  return out;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Hub-saved tweaks per OrcaSlicer printer preset: a few OrcaSlicer settings (walls, infill, layer
 * height …) applied over the presets whenever that printer is sliced; the panel's supports/brim win.
 */
export const ORCA_TWEAKS_PATH = 'data/print/orca-tweaks.json';
export type OrcaTweaks = Record<string, Record<string, PrintSettingValue>>;
const TWEAK_KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** reach outside the slice, or are the pack's own (it refuses them too) */
const TWEAK_FORBIDDEN = /^(post_process|host_type|print_host|print_host_webui|printhost_.*|bbl_use_printhost|thumbnails_format|thumbnails|name|inherits|from|type|compatible_printers.*|printer_model|printer_settings_id|filament_settings_id|print_settings_id)$/;
export const MAX_TWEAKS = 40;

/** One printer's tweaks, checked, or what is wrong with them. */
export function parseOrcaTweaks(value: unknown): { settings: Record<string, PrintSettingValue> } | { error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'Tweaks are an object of OrcaSlicer settings.' };
  const out: Record<string, PrintSettingValue> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_TWEAKS) return { error: `At most ${MAX_TWEAKS} tweaks per printer.` };
  for (const [key, v] of entries) {
    if (!TWEAK_KEY.test(key)) return { error: `${JSON.stringify(key)} is not an OrcaSlicer setting name.` };
    if (TWEAK_FORBIDDEN.test(key)) return { error: `${key} cannot be tweaked here.` };
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return { error: `${key} must be text, a number or true/false.` };
    if (typeof v === 'number' && !Number.isFinite(v)) return { error: `${key} is not a finite number.` };
    if (typeof v === 'string' && v.length > 200) return { error: `${key} is too long.` };
    out[key] = v;
  }
  return { settings: out };
}

/** The saved document, keeping only well-formed entries. */
export function readOrcaTweaks(saved: unknown): OrcaTweaks {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
  const out: OrcaTweaks = {};
  for (const [printer, settings] of Object.entries(saved as Record<string, unknown>)) {
    const parsed = parseOrcaTweaks(settings);
    if (!('error' in parsed) && Object.keys(parsed.settings).length > 0) out[printer] = parsed.settings;
  }
  return out;
}

export interface OrcaProfile {
  /** OrcaSlicer settings over the presets (the printer's hub tweaks, then the panel's adjustments) */
  config: Record<string, PrintSettingValue>;
  /** the hub's tweaks for this printer that went into config */
  tweaks?: Record<string, PrintSettingValue>;
  sha256: string;
  parts: Record<PrintProfileKind, { id: string; label: string; sha256: string }>;
  adjustments?: PrintAdjustments;
  presets: { printer: string; material: string; process: string };
  vendor: string;
  output: 'gcode' | 'gcode+3mf';
}

/**
 * The presets a request names (or the printer's defaults), checked against the catalog, with the
 * adjustments as OrcaSlicer settings and one hash over all of it.
 */
export function orcaProfile(catalog: OrcaCatalog, wanted: { printer?: unknown; material?: unknown; process?: unknown }, adjustments: PrintAdjustments = {}, tweaks: OrcaTweaks = {}): OrcaProfile | { error: string } {
  const printer = typeof wanted.printer === 'string' ? catalog.printers.find((p) => p.name === wanted.printer) : catalog.printers[0];
  if (printer === undefined) return { error: `OrcaSlicer ${catalog.orcaVersion} has no printer preset ${JSON.stringify(wanted.printer)} in the listed makers.` };
  const processes = printer.processes.map((i) => catalog.processes[i]!);
  const materials = printer.materials.map((i) => catalog.materials[i]!);
  const process = processes.find((p) => p.name === (typeof wanted.process === 'string' ? wanted.process : printer.defaultProcess));
  const material = materials.find((m) => m.name === (typeof wanted.material === 'string' ? wanted.material : printer.defaultMaterial));
  if (process === undefined) return { error: `${printer.name} has no process preset ${JSON.stringify(wanted.process)}.` };
  if (material === undefined) return { error: `${printer.name} has no filament preset ${JSON.stringify(wanted.material)}.` };
  const tweaked = tweaks[printer.name] ?? {};
  const config = { ...tweaked, ...orcaAdjustmentSettings(adjustments) };
  const adjusted = Object.keys(adjustments).length > 0;
  const parts = {
    printer: { id: printer.name, label: printer.name, sha256: printer.sha256 },
    material: { id: material.name, label: material.name, sha256: material.sha256 },
    process: { id: process.name, label: process.name, sha256: process.sha256 },
  };
  const presets = { printer: printer.name, material: material.name, process: process.name };
  const sha256 = createHash('sha256').update(canonical({ slicer: 'orcaslicer', orca: catalog.orcaVersion, presets: { printer: printer.sha256, material: material.sha256, process: process.sha256 }, config, ...(adjusted ? { adjustments } : {}) })).digest('hex');
  return { config, sha256, parts, presets, vendor: printer.vendor, output: printer.output, ...(adjusted ? { adjustments } : {}), ...(Object.keys(tweaked).length > 0 ? { tweaks: tweaked } : {}) };
}
