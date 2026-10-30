/**
 * Resin (masked-LCD SLA) print preparation beside FDM: the same print panel, job and profile
 * document, a second pinned pack (`tools/slicer-resin/`: PrusaSlicer SLA mode, then UVtools to the
 * printer's own format, e.g. Elegoo `.goo`). A printer profile whose settings say
 * `printer_technology = SLA` is a resin printer; the job then runs the resin pack, and only
 * material and process profiles that also say SLA go with it.
 *
 * The starter resin profiles below are added to a hub's profile list while it has no resin printer
 * of its own, so a hub that saved its FDM profiles before resin existed still offers one.
 */

import type { PrintAdjustments, PrintProfile, PrintSettingValue } from './profiles.ts';

export const RESIN_PACK = 'slicer-resin';
/** Every pack the print panel's runs and variants may come from. */
export const PRINT_PACKS: readonly string[] = ['slicer-prusaslicer', RESIN_PACK, 'slicer-orcaslicer'];

export type PrintTechnology = 'fdm' | 'resin';

export function printTechnology(profile: Pick<PrintProfile, 'settings'>): PrintTechnology {
  return String(profile.settings['printer_technology'] ?? '').toUpperCase() === 'SLA' ? 'resin' : 'fdm';
}

const MARS_SRC = 'Elegoo Mars 5 Ultra published specifications (7" mono LCD, 8520 x 4320 px, 18 µm pixels, 153.36 x 77.76 x 165 mm build volume); display mirror and tilting-vat handling as UVtools 7.0.2 ships them for this printer. Not tested on a printer by WireHub: print a small test part first.';
const RESIN_SRC = 'synthetic example: generic starting values for a standard 405 nm resin on a mono-LCD printer, not tuned for any resin; run an exposure test for yours';

export const RESIN_STARTER_PROFILES: readonly PrintProfile[] = [
  {
    id: 'elegoo-mars-5-ultra', kind: 'printer', label: 'Elegoo Mars 5 Ultra (resin, .goo)', src: MARS_SRC,
    settings: {
      printer_technology: 'SLA', display_pixels_x: 8520, display_pixels_y: 4320, display_width: 153.36, display_height: 77.76,
      display_orientation: 'landscape', display_mirror_x: true, display_mirror_y: false, bed_shape: '0x0,153.36x0,153.36x77.76,0x77.76',
      max_print_height: 165, resin_format: 'goo', resin_machine_name: 'ELEGOO Mars 5 Ultra',
    },
  },
  {
    id: 'generic-standard-resin', kind: 'material', label: 'Standard resin (starting point)', src: RESIN_SRC,
    settings: { printer_technology: 'SLA', exposure_time: 2.5, initial_exposure_time: 25, faded_layers: 4, material_density: 1.1 },
  },
  {
    id: 'resin-0.05-supported', kind: 'process', label: 'Resin 0.05 mm, auto supports and pad', src: RESIN_SRC,
    settings: {
      printer_technology: 'SLA', layer_height: 0.05, initial_layer_height: 0.05,
      supports_enable: true, support_tree_type: 'default', support_object_elevation: 5, support_points_density_relative: 100,
      pad_enable: true, hollowing_enable: false,
    },
  },
];

/** The hub's profiles plus the resin starters while it has no resin printer of its own. */
export function withResinStarters<T extends { profiles: PrintProfile[] }>(found: T): T {
  if (found.profiles.some((p) => p.kind === 'printer' && printTechnology(p) === 'resin')) return found;
  const ids = new Set(found.profiles.map((p) => p.id));
  return { ...found, profiles: [...found.profiles, ...RESIN_STARTER_PROFILES.filter((p) => !ids.has(p.id)).map((p) => ({ ...p, settings: { ...p.settings } }))] };
}

/** The PrusaSlicer SLA settings the panel's support choice stands for (a brim has no resin meaning). */
export function resinAdjustmentSettings(a: PrintAdjustments): Record<string, PrintSettingValue> {
  if (a.supports === 'off') return { supports_enable: false, pad_enable: false };
  if (a.supports === 'auto') return { supports_enable: true, support_buildplate_only: false, pad_enable: true };
  if (a.supports === 'buildplate') return { supports_enable: true, support_buildplate_only: true, pad_enable: true };
  return {};
}
