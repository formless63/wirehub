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
  SL: 'slate',
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

/**
 * The named colour codes WireViz's public syntax documentation lists, checked
 * against the sequences in WireViz's colour table (read for the facts only: the
 * sequences are the standards' own, IEC 60757 colour letters in the order
 * brown, red, orange, yellow, green, blue, violet, grey, white, black; DIN 47100;
 * the 25-pair telephone code, ring then tip (TEL) or tip then ring (TELALT);
 * and the two Ethernet pair orders).
 */
const IEC = ['BN', 'RD', 'OG', 'YE', 'GN', 'BU', 'VT', 'GY', 'WH', 'BK'];

const DIN = [
  'WH', 'BN', 'GN', 'YE', 'GY', 'PK', 'BU', 'RD', 'BK', 'VT', 'GYPK', 'RDBU',
  'WHGN', 'BNGN', 'WHYE', 'YEBN', 'WHGY', 'GYBN', 'WHPK', 'PKBN', 'WHBU', 'BNBU',
  'WHRD', 'BNRD', 'WHBK', 'BNBK', 'GYGN', 'YEGY', 'PKGN', 'YEPK', 'GNBU', 'YEBU',
  'GNRD', 'YERD', 'GNBK', 'YEBK', 'GYBU', 'PKBU', 'GYRD', 'PKRD', 'GYBK', 'PKBK',
  'BUBK', 'RDBK', 'WHBNBK', 'YEGNBK', 'GYPKBK', 'RDBUBK', 'WHGNBK', 'BNGNBK',
  'WHYEBK', 'YEBNBK', 'WHGYBK', 'GYBNBK', 'WHPKBK', 'PKBNBK', 'WHBUBK',
  'BNBUBK', 'WHRDBK', 'BNRDBK',
];

/** 25 pairs: five major colours (white, red, black, yellow, violet) against five minor (blue, orange, green, brown, slate). */
const MAJOR = ['WH', 'RD', 'BK', 'YE', 'VT'];
const MINOR = ['BU', 'OG', 'GN', 'BN', 'SL'];
/** TEL: ring (minor+major) then tip (major+minor) of each pair; TELALT: tip then ring, the first five pairs' ring being the plain minor colour */
const TEL: string[] = [];
const TELALT: string[] = [];
MAJOR.forEach((major, mi) => {
  MINOR.forEach((minor) => {
    TEL.push(`${minor}${major}`, `${major}${minor}`);
    TELALT.push(`${major}${minor}`, mi === 0 ? minor : `${minor}${major}`);
  });
});

/** Colour codes this reads: IEC, DIN, BW, TEL, TELALT, T568A and T568B. */
const CODES: Readonly<Record<string, readonly string[]>> = {
  IEC,
  DIN,
  BW: ['BK', 'WH'],
  TEL,
  TELALT,
  T568A: ['WHGN', 'GN', 'WHOG', 'BU', 'WHBU', 'OG', 'WHBN', 'BN'],
  T568B: ['WHOG', 'OG', 'WHGN', 'BU', 'WHBU', 'GN', 'WHBN', 'BN'],
};

/** The names of the codes `codeColours` reads. */
export const COLOUR_CODE_NAMES: readonly string[] = Object.keys(CODES);

/**
 * The colours of the first `count` wires of a named colour code, or `undefined` when the code is not one this
 * knows. A code with fewer colours than `count` gives only the colours it has (WireViz refuses such a cable).
 */
export function codeColours(code: string, count: number): string[] | undefined {
  const sequence = CODES[code.trim().toUpperCase()];
  if (sequence === undefined) return undefined;
  return sequence.slice(0, Math.max(0, count)).map((c) => colourFromCode(c) as string);
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
