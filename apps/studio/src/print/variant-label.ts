import { localDate } from '../when.ts';

/** "0.20mm Standard @Qidi Q1 Pro 0.4 nozzle" → "0.20mm Standard": the printer is named beside it. */
export const presetName = (name: string): string => name.replace(/\s+@.*$/, '') || name;

export interface VariantNaming {
  savedAt: string;
  profile: { printer: string; material: string; process: string; labels?: { printer: string; material: string; process: string } };
}

/** A manufacturing variant as a person picks it: printer · material · process · date. */
export function variantLabel(v: VariantNaming): string {
  const l = v.profile.labels ?? v.profile;
  return `${l.printer} · ${presetName(l.material)} · ${presetName(l.process)} · ${localDate(v.savedAt)}`;
}
