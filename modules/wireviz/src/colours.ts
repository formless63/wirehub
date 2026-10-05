/**
 * WireViz colour abbreviations (two uppercase letters, a striped wire is two
 * of them joined: `WHBU`) and the named colour codes, written from WireViz's
 * public syntax documentation. The names are the ones the base's `colours`
 * vocabulary uses (`white-blue` is white with a blue stripe).
 */

export const COLOUR_NAME: Readonly<Record<string, string>> = {
  BK: 'black',
  BN: 'brown',
  RD: 'red',
  OG: 'orange',
  YE: 'yellow',
  GN: 'green',
  BU: 'blue',
  VT: 'purple',
  GY: 'grey',
  WH: 'white',
  PK: 'pink',
  TQ: 'turquoise',
  SR: 'silver',
  GD: 'gold',
};

const CODE_OF = new Map(Object.entries(COLOUR_NAME).map(([code, name]) => [name, code]));
CODE_OF.set('gray', 'GY');
CODE_OF.set('violet', 'VT');

/** `WHBU` -> `white-blue`, `RD` -> `red`, `#FFFF00` kept; `undefined` when it is not a colour this reads. */
export function colourFromCode(code: string): string | undefined {
  const text = code.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
  const upper = text.toUpperCase();
  if (upper.length === 0 || upper.length % 2 !== 0) return undefined;
  const parts: string[] = [];
  for (let i = 0; i < upper.length; i += 2) {
    const name = COLOUR_NAME[upper.slice(i, i + 2)];
    if (name === undefined) return undefined;
    parts.push(name);
  }
  return parts.join('-');
}

/** `white-blue` -> `WHBU`; `undefined` for a colour with no abbreviation. */
export function colourToCode(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (/^#[0-9a-fA-F]{6}$/.test(name)) return name.toUpperCase();
  const parts = name.trim().toLowerCase().split('-');
  const codes = parts.map((p) => CODE_OF.get(p));
  return codes.every((c) => c !== undefined) && codes.length > 0 && codes.length <= 2 ? codes.join('') : undefined;
}

const IEC = ['BN', 'RD', 'OG', 'YE', 'GN', 'BU', 'VT', 'GY', 'WH', 'BK'];

/** Colour codes this reads; DIN, TEL and TELALT are listed as not read (the sequences are not reproduced here). */
const CODES: Readonly<Record<string, readonly string[]>> = {
  IEC,
  T568A: ['WHGN', 'GN', 'WHOG', 'BU', 'WHBU', 'OG', 'WHBN', 'BN'],
  T568B: ['WHOG', 'OG', 'WHGN', 'BU', 'WHBU', 'GN', 'WHBN', 'BN'],
};

/** The colours of the first `count` wires of a named colour code, or `undefined` when the code is not one this knows. */
export function codeColours(code: string, count: number): string[] | undefined {
  const name = code.toUpperCase();
  if (name === 'BW') return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 'black' : 'white'));
  const sequence = CODES[name];
  if (sequence === undefined) return undefined;
  return Array.from({ length: count }, (_, i) => {
    // beyond the sequence a code repeats with the next colour's stripe: not modelled, repeat plainly
    const c = colourFromCode(sequence[i % sequence.length] as string);
    return c as string;
  });
}

const MM2_PER_AWG = (n: number): number => {
  // AWG diameter: 0.127 mm x 92^((36-n)/39), the standard definition
  const d = 0.127 * 92 ** ((36 - n) / 39);
  return (Math.PI / 4) * d * d;
};

/** A WireViz `gauge` ("0.25 mm2", "24 AWG", 0.5) as a conductor area in mm2, with whether it was converted. */
export function gaugeToMm2(gauge: unknown): { areaMm2: number; converted: boolean } | undefined {
  if (typeof gauge === 'number' && Number.isFinite(gauge) && gauge > 0) return { areaMm2: gauge, converted: false };
  if (typeof gauge !== 'string') return undefined;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(mm2|mm²|awg)?\s*$/i.exec(gauge);
  if (m === null) return undefined;
  const value = Number(m[1]);
  if ((m[2] ?? 'mm2').toLowerCase() === 'awg') return value >= 0 && value <= 40 ? { areaMm2: Math.round(MM2_PER_AWG(value) * 1000) / 1000, converted: true } : undefined;
  return value > 0 ? { areaMm2: value, converted: false } : undefined;
}

/** A WireViz `length` (metres by default, or with a unit) in millimetres. */
export function lengthToMm(length: unknown): number | undefined {
  if (typeof length === 'number' && Number.isFinite(length) && length >= 0) return Math.round(length * 1000 * 1000) / 1000;
  if (typeof length !== 'string') return undefined;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(mm|cm|m|in|ft|yd)?\s*$/i.exec(length);
  if (m === null) return undefined;
  const factor: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, yd: 914.4 };
  return Math.round(Number(m[1]) * (factor[(m[2] ?? 'm').toLowerCase()] as number) * 1000) / 1000;
}
