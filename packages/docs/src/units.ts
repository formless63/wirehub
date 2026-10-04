/**
 * Length formatting for build documents.
 *
 * The catalog stores every length in millimetres, because that is what the
 * cable specs are written in. The bench floor works in feet and inches — a
 * "6 ft" trunk is 1830 mm, an "18 in" whip is 457 mm — so every length a
 * document prints carries both, and the imperial half is *derived*, never
 * authored. Rounding is fixed and locale-free so two runs cannot disagree.
 */

const MM_PER_INCH = 25.4;
const INCHES_PER_FOOT = 12;

/** A length seen three ways: raw mm, imperial, and the printable string. */
export interface Length {
  mm: number;
  feet: number;
  inches: number;
  /** e.g. `1830 mm (6 ft 0 in)` */
  text: string;
}

/** Round to `places` decimals without exponent notation or locale drift. */
export function round(value: number, places = 0): number {
  const factor = 10 ** places;
  // + 0 normalises -0 to 0 so a formatted zero is never "-0"
  return Math.round(value * factor) / factor + 0;
}

/** Fixed-decimal string; no `toLocaleString`, ever. */
export function num(value: number, places = 0): string {
  return round(value, places).toFixed(places);
}

/**
 * mm → `{ mm, feet, inches, text }`. Inches are rounded to the nearest 0.1 in
 * before the feet split, so 1830 mm reads `6 ft 0 in` rather than
 * `5 ft 11.98 in` — the bench cuts to a mark, not to four decimals.
 */
export function lengthFromMm(mm: number): Length {
  const totalInches = round(mm / MM_PER_INCH, 1);
  const feet = Math.floor(totalInches / INCHES_PER_FOOT);
  const inches = round(totalInches - feet * INCHES_PER_FOOT, 1);
  // a whole number of inches prints without the decimal: `6 ft 0 in`, not
  // `6 ft 0.0 in` — the bench reads a tape, not a caliper
  const inchText = num(inches, Number.isInteger(inches) ? 0 : 1);
  const imperial = feet === 0 ? `${inchText} in` : `${feet} ft ${inchText} in`;
  return { mm: round(mm, 1), feet, inches, text: `${num(mm, 0)} mm (${imperial})` };
}

/* ------------------------------------------------------------------ *
 * Feet for integrations
 * ------------------------------------------------------------------ */

const MM_PER_FOOT = 304.8;
/** a length within this many mm of a ladder rung is that rung */
const LADDER_TOLERANCE_MM = 5;

/**
 * ft → mm on the owner's ladder: `ft × 304.8` rounded to the nearest 5 mm.
 * 1 → 305, 1.5 → 455, 4 → 1220, 6 → 1830, 8 → 2440, 10 → 3050 — exactly what
 * the owner's drawings print (`-36 = 1830 MM`).
 */
export function mmFromFeet(ft: number): number {
  return 5 * Math.round((ft * MM_PER_FOOT) / 5);
}

/**
 * mm → ft, as an integration is sent it. When a rung of the 0.5 ft ladder sits within
 * ±5 mm, that rung exactly (`1830` → 6, `455` → 1.5, `300` → 1); otherwise
 * `mm / 304.8` to two decimals (`400` → 1.31, `500` → 1.64).
 */
export function feetFromMm(mm: number): number {
  const nearest = Math.round((mm / MM_PER_FOOT) * 2) / 2;
  let best: number | undefined;
  for (const rung of [nearest - 0.5, nearest, nearest + 0.5]) {
    if (rung <= 0) continue;
    const off = Math.abs(mmFromFeet(rung) - mm);
    if (off > LADDER_TOLERANCE_MM) continue;
    if (best === undefined || off < Math.abs(mmFromFeet(best) - mm)) best = rung;
  }
  return best ?? round(mm / MM_PER_FOOT, 2);
}

/** A feet quantity as numeric-string columns take it: `6`, `1.5`, `2.62`. */
export function feetText(ft: number): string {
  return String(round(ft, 2));
}

/** A `length` variation value in feet: `6ft`, `1.5ft`. */
export function feetAttribute(ft: number): string {
  return `${feetText(ft)}ft`;
}
