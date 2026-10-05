/**
 * Part values and kinds as boards and BOMs print them: `4k7`, `120R`, `100n`,
 * `0.1uF` → `4.7 kΩ`, `120 Ω`, `100 nF`; a reference designator's prefix →
 * what the part is. Pure.
 */

import type { ComponentCategory, PcbaLinkElementKind } from '@wirehub/model';

const MULT: Readonly<Record<string, number>> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1, r: 1, R: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** `4k7` → 4700, `120R` → 120, `1M` → 1e6, `330 Ω` → 330; undefined when it is not a resistance. */
export function parseOhms(text: string): number | undefined {
  const t = text.trim().replace(/\s*(Ω|ohms?|Ohms?)$/u, '').replace(/\s+/g, '');
  // 4k7 / 2R2 / 1M5: the multiplier stands for the decimal point
  let m = /^(\d+)([RrkKM])(\d+)$/.exec(t);
  if (m !== null) return Number(`${m[1]}.${m[3]}`) * MULT[m[2]!]!;
  m = /^(\d+(?:\.\d+)?)([RrkKMG]?)$/.exec(t);
  if (m !== null) return Number(m[1]) * MULT[m[2] ?? '']!;
  return undefined;
}

function trim(n: number): string {
  return String(Number(n.toPrecision(4)));
}

/** 4700 → `4.7 kΩ`, 120 → `120 Ω`, 0 → `0 Ω`. */
export function formatOhms(ohms: number): string {
  if (ohms >= 1e6) return `${trim(ohms / 1e6)} MΩ`;
  if (ohms >= 1e3) return `${trim(ohms / 1e3)} kΩ`;
  return `${trim(ohms)} Ω`;
}

/** `100n`, `100nF`, `0.1uF`, `4u7`, `10 µF` → farads; undefined when it is not a capacitance. */
export function parseFarads(text: string): number | undefined {
  const t = text.trim().replace(/\s+/g, '').replace(/F$/i, '');
  let m = /^(\d+)([pnuµμm])(\d+)$/u.exec(t);
  if (m !== null) return Number(`${m[1]}.${m[3]}`) * MULT[m[2]!]!;
  m = /^(\d+(?:\.\d+)?)([pnuµμm])$/u.exec(t);
  if (m !== null) return Number(m[1]) * MULT[m[2]!]!;
  return undefined;
}

/** 1e-7 → `100 nF`, 2.2e-5 → `22 µF`. */
export function formatFarads(farads: number): string {
  const units: [number, string][] = [
    [1e-3, 'mF'],
    [1e-6, 'µF'],
    [1e-9, 'nF'],
    [1e-12, 'pF'],
  ];
  for (const [scale, unit] of units) if (farads >= scale * 0.9999) return `${trim(farads / scale)} ${unit}`;
  return `${trim(farads / 1e-12)} pF`;
}

/** What a reference designator's prefix says the part is. */
export function categoryOfRef(ref: string, lib = ''): ComponentCategory {
  const prefix = /^[A-Za-z]+/.exec(ref)?.[0]?.toUpperCase() ?? '';
  if (/SolderJumper|Jumper/i.test(lib) || prefix === 'JP') return 'jumper';
  if (prefix === 'SW' || prefix === 'S') return 'switch';
  if (prefix === 'R' || prefix === 'RN') return 'resistor';
  if (prefix === 'C') return 'capacitor';
  if (prefix === 'L' || prefix === 'FB') return 'inductor';
  if (prefix === 'D' || prefix === 'LED') return 'diode';
  if (prefix === 'Q') return 'transistor';
  if (prefix === 'U' || prefix === 'IC') return 'ic';
  if (prefix === 'VR') return 'regulator';
  if (prefix === 'J' || prefix === 'P' || prefix === 'CN' || prefix === 'X' || prefix === 'CON' || /^Connector/i.test(lib)) return 'connector';
  return 'other';
}

/** A category as a link element's kind. */
export function elementKindOf(category: ComponentCategory): PcbaLinkElementKind {
  switch (category) {
    case 'resistor':
    case 'capacitor':
    case 'inductor':
    case 'ic':
    case 'jumper':
    case 'switch':
      return category;
    case 'regulator':
    case 'transistor':
      return 'ic';
    default:
      return 'other';
  }
}

/** A category as the `component-kinds` vocabulary has it (a regulator is an `ic`, a jumper `other`). */
export function componentKindOf(category: ComponentCategory): 'resistor' | 'capacitor' | 'ic' | 'switch' | 'other' {
  if (category === 'resistor' || category === 'capacitor' || category === 'ic' || category === 'switch') return category;
  if (category === 'regulator' || category === 'transistor') return 'ic';
  return 'other';
}

/** The value as a person reads it: a resistance or capacitance normalised, anything else trimmed. */
export function displayValue(category: ComponentCategory, raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '' || value === '~') return undefined;
  if (category === 'resistor' || category === 'jumper') {
    const ohms = parseOhms(value);
    if (ohms !== undefined) return formatOhms(ohms);
  }
  if (category === 'capacitor') {
    const farads = parseFarads(value);
    if (farads !== undefined) return formatFarads(farads);
  }
  return value;
}

/** The case a footprint name says (`R_0603_1608Metric` → `0603`, `SOIC-8_3.9x4.9mm…` → `SOIC-8`). */
export function packageOf(footprint: string | undefined): string | undefined {
  if (footprint === undefined || footprint.trim() === '') return undefined;
  const name = footprint.includes(':') ? footprint.slice(footprint.indexOf(':') + 1) : footprint;
  const chip = /(?:^|_)(0201|0402|0603|0805|1206|1210|1812|2010|2512)(?:_|$)/.exec(name);
  if (chip !== null) return chip[1];
  const pkg = /^((?:SOIC|SOP|SSOP|TSSOP|MSOP|QFN|QFP|LQFP|TQFP|DFN|SOT|TO|DIP|SOD)-?\d+[A-Z]*)/i.exec(name);
  if (pkg !== null) return pkg[1]!.toUpperCase();
  return name;
}

/** kebab-case: lower-case letters, digits and single hyphens. */
export function kebab(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/µ|μ/g, 'u')
    .replace(/Ω/g, 'r')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/(?<!\d)\.|\.(?!\d)/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
