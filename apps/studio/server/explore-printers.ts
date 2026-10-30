/**
 * The hub's printer profiles as exploration's printer dimension (`PrinterCandidate`): the plate from
 * `bed_shape` (FDM bed or resin display), `max_print_height`, and an FDM printer's nozzle.
 */

import type { PrinterCandidate } from '@wirehub/model';

import type { WorkbenchDeps } from './api.ts';
import { effectiveProfiles, PRINT_PROFILES_PATH, type PrintProfile } from './print/profiles.ts';
import { printTechnology, withResinStarters } from './print/resin.ts';

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function printerCandidate(p: PrintProfile): PrinterCandidate | undefined {
  if (p.kind !== 'printer') return undefined;
  const pts = String(p.settings['bed_shape'] ?? '').split(',').map((xy) => xy.split('x').map(Number)).filter((xy) => xy.length === 2 && xy.every(Number.isFinite));
  if (pts.length < 3) return undefined;
  const xs = pts.map((xy) => xy[0]!);
  const ys = pts.map((xy) => xy[1]!);
  const bed: [number, number] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  if (bed[0] <= 0 || bed[1] <= 0) return undefined;
  const height = num(p.settings['max_print_height']);
  const nozzle = printTechnology(p) === 'fdm' ? num(String(p.settings['nozzle_diameter'] ?? '').split(',')[0]) : undefined;
  return { id: p.id, label: p.label, bedMm: bed, ...(height === undefined ? {} : { maxHeightMm: height }), ...(nozzle === undefined ? {} : { nozzleMm: nozzle }) };
}

export async function explorePrinters(deps: WorkbenchDeps): Promise<PrinterCandidate[]> {
  const { profiles } = withResinStarters(effectiveProfiles(await deps.docs?.read(PRINT_PROFILES_PATH)));
  return profiles.map(printerCandidate).filter((p): p is PrinterCandidate => p !== undefined);
}
