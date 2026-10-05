/**
 * The component journey (data model v2 §8 J4): pick the kind, and the
 * terminals and the standard value list follow from it — picked, not typed.
 *
 * - **Terminals per kind.** A resistor is `a`/`b`; a capacitor is `a`/`b`
 *   with `+`/`-` polarity (the catalog's polarised caps are tantalum and
 *   electrolytic); a switch is `a`/`b`. An IC or "other" has no template: its
 *   legs are the part's own.
 * - **Values per kind.** Resistors from the E24 series, 1 Ω – 10 MΩ;
 *   capacitors from E12, 10 pF – 4700 µF; each written the way the catalog
 *   writes values (`330 Ω`, `4.7 kΩ`, `220 µF`) so a picked value and a typed
 *   one never disagree on spelling. Series from IEC 60063.
 *
 * Pure: nothing here knows about React or the catalog.
 */

import type { ComponentDefinition } from '@wirehub/model';

type Kind = ComponentDefinition['kind'];

/** IEC 60063 preferred numbers, one decade (×10). */
export const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82] as const;
export const E24 = [
  10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91,
] as const;

export const E_SERIES_SRC = 'IEC 60063 preferred number series (E12, E24)';

/** Two significant figures, no float noise: 4.7, 33, 0.82. */
function tidy(value: number): string {
  return String(Number(value.toPrecision(3)));
}

/** `ohms` as the catalog writes it: `330 Ω`, `4.7 kΩ`, `1 MΩ`. */
export function formatOhms(ohms: number): string {
  if (ohms >= 1e6) return `${tidy(ohms / 1e6)} MΩ`;
  if (ohms >= 1e3) return `${tidy(ohms / 1e3)} kΩ`;
  return `${tidy(ohms)} Ω`;
}

/** `farads` as the catalog writes it: `22 pF`, `100 nF`, `220 µF`. */
export function formatFarads(farads: number): string {
  if (farads >= 1e-6 - 1e-18) return `${tidy(farads * 1e6)} µF`;
  if (farads >= 1e-9 - 1e-21) return `${tidy(farads * 1e9)} nF`;
  return `${tidy(farads * 1e12)} pF`;
}

function series(base: readonly number[], fromExp: number, toExp: number, max: number): number[] {
  const out: number[] = [];
  for (let exp = fromExp; exp <= toExp; exp += 1) {
    for (const n of base) {
      const value = (n / 10) * 10 ** exp;
      if (value <= max * (1 + 1e-9)) out.push(value);
    }
  }
  return out;
}

export interface StandardValue {
  /** what is stored in `value` */
  value: string;
  /** the decade heading it is listed under: `Ω`, `kΩ`, `µF` … */
  unit: string;
}

/** The standard values a kind is picked from; empty for kinds with no series. */
export function standardValues(kind: Kind): StandardValue[] {
  const unitOf = (text: string): string => text.split(' ')[1] ?? '';
  if (kind === 'resistor') {
    return series(E24, 0, 7, 10e6).map((ohms) => {
      const value = formatOhms(ohms);
      return { value, unit: unitOf(value) };
    });
  }
  if (kind === 'capacitor') {
    return series(E12, -11, -3, 4700e-6).map((farads) => {
      const value = formatFarads(farads);
      return { value, unit: unitOf(value) };
    });
  }
  return [];
}

export interface TerminalTemplate {
  id: string;
  label: string;
  polarity: '' | '+' | '-';
}

/**
 * The legs a kind starts with; `undefined` where the part decides (IC,
 * other). A capacitor is polarised (`+`/`-`, tantalum or electrolytic) unless
 * its value is in pF or nF — those are ceramics, either way round.
 */
export function terminalTemplate(kind: Kind, value = ''): TerminalTemplate[] | undefined {
  const ceramic = kind === 'capacitor' && /\s[pn]F$/.test(value.trim());
  switch (kind) {
    case 'resistor':
    case 'switch':
      return [
        { id: 'a', label: '', polarity: '' },
        { id: 'b', label: '', polarity: '' },
      ];
    case 'capacitor':
      if (ceramic) {
        return [
          { id: 'a', label: '', polarity: '' },
          { id: 'b', label: '', polarity: '' },
        ];
      }
      return [
        { id: 'a', label: '+', polarity: '+' },
        { id: 'b', label: '-', polarity: '-' },
      ];
    case 'ic':
    case 'other':
      return undefined;
    default:
      // a kind added to the component-kinds list in-app: a generic two-leg part to start from
      return [
        { id: 'a', label: '', polarity: '' },
        { id: 'b', label: '', polarity: '' },
      ];
  }
}

/** True when `rows` are still what a kind's template (or a blank form) made — safe to replace. */
export function isTemplateTerminals(rows: readonly TerminalTemplate[]): boolean {
  const plain = rows.map((row) => `${row.id.trim()}|${row.label.trim()}|${row.polarity}`).join(',');
  if (plain === '' || rows.every((row) => row.id.trim() === '' && row.label.trim() === '')) return true;
  return (['resistor', 'capacitor', 'switch'] as const).some(
    (kind) => (terminalTemplate(kind) ?? []).map((row) => `${row.id}|${row.label}|${row.polarity}`).join(',') === plain,
  );
}

/** the built-in kinds' words; a kind added in-app uses its own id */
const KIND_NOUN: Partial<Record<Kind, string>> = {
  resistor: 'resistor',
  capacitor: 'capacitor',
  ic: 'IC',
  switch: 'switch',
  other: 'part',
};

const KIND_PREFIX: Partial<Record<Kind, string>> = {
  resistor: 'r',
  capacitor: 'cap',
  ic: 'ic',
  switch: 'sw',
  other: 'part',
};

/** The name a picked kind and value suggest: `330 Ω resistor`. */
export function suggestComponentLabel(kind: Kind, value: string): string {
  const v = value.trim();
  return v === '' ? '' : `${v} ${KIND_NOUN[kind] ?? kind.replace(/-/g, ' ')}`;
}

/** The id they suggest, in the catalog's style: `r-330`, `r-4-7k`, `cap-220uf`. */
export function suggestComponentId(kind: Kind, value: string): string {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[µμ]/g, 'u')
    .replace(/[Ωω]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return v === '' ? '' : `${KIND_PREFIX[kind] ?? kind}-${v}`;
}

/**
 * The ways a value gets typed: `4.7k`, `4k7`, `220u`, `220uf`, `100n` — what
 * the value picker's filter also matches, so nobody has to find the Ω key.
 */
export function valueAliases(value: string): string[] {
  const compact = value.replace(/\s+/g, '');
  const ascii = compact.replace(/[µμ]/g, 'u').replace(/Ω/g, '').toLowerCase();
  const out = new Set<string>([compact, ascii, ascii.replace(/f$/i, '')]);
  // RKM code: 4.7k → 4k7, 2.2u → 2u2
  const rkm = /^(\d+)\.(\d+)([a-z])/i.exec(ascii.replace(/f$/i, ''));
  if (rkm !== null) out.add(`${rkm[1]}${rkm[3]}${rkm[2]}`);
  out.delete(value);
  out.delete('');
  return [...out];
}
