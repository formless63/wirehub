/**
 * A footprint's height when neither the board's 3D export nor a `Height` property states it:
 * an estimate read from the footprint itself, always `basis: 'estimated'` and saying which rule.
 *
 * - A footprint with no 3D model that is board-only, left out of the BOM (or of the placement
 *   files), or is a test point, fiducial, logo, net tie, solder jumper or mounting hole, has no part
 *   standing on it: 0 mm (`padsOnly`). Custom landing pads and hole footprints are usually marked
 *   that way rather than named after KiCad's library.
 * - KiCad's standard library names carry a body size often enough: an explicit `_H<n>mm`,
 *   an SMD electrolytic's `<D>x<H>`, a package family with a typical body height (chip sizes,
 *   SOIC, QFN, TO-220 standing up, 2.54 mm headers…). The footprint's own name is tried first, then
 *   its 3D model file names. Typical bodies are not the part on this board: the person can set it.
 *
 * Pure. Nothing here is board- or shop-specific; the table is KiCad's public naming conventions.
 */

export interface FootprintHeightInput {
  /** `Lib:Name` as the board file has it */
  footprint: string;
  /** 3D model paths the footprint shows (hidden ones left out) */
  models: readonly string[];
  /** footprint attributes: `smd`, `through_hole`, `board_only`, `exclude_from_bom`, … */
  attrs: readonly string[];
}

export interface FootprintHeightEstimate { mm: number; note: string }

const NO_PART = /^(TestPoint_Pad|TestPoint_Plated|Fiducial|.*Logo|NetTie|SolderJumper|MountingHole|Symbol_|KiCad-Logo)/i;

/** Chip sizes (imperial code) → typical body height, mm: the taller of resistor and capacitor bodies. */
const CHIP: Record<string, number> = {
  '01005': 0.2, '0201': 0.33, '0402': 0.55, '0603': 0.9, '0805': 1.35, '1206': 1.8, '1210': 2.7,
  '1812': 2.0, '2010': 0.7, '2512': 0.7,
};

/** Package families: first match wins (name without the library). */
const FAMILIES: readonly [RegExp, number, string][] = [
  [/^TO-220.*Vertical/i, 19, 'TO-220 standing up'],
  [/^TO-247.*Vertical/i, 25, 'TO-247 standing up'],
  [/^TO-220.*Horizontal/i, 4.6, 'TO-220 laid flat'],
  [/^TO-92/i, 7, 'TO-92'],
  [/^TO-263/i, 4.8, 'D²PAK'],
  [/^TO-252/i, 2.4, 'DPAK'],
  [/^SOT-223/i, 1.8, 'SOT-223'],
  [/^(SOT|SC-70|SOD)-/i, 1.35, 'small-outline transistor/diode'],
  [/^D_(SMA|SMB|SMC)\b/i, 2.6, 'SMA/SMB/SMC diode'],
  [/^(SOIC|SOP|SO)-\d/i, 1.75, 'SOIC'],
  [/^(TSSOP|MSOP|SSOP|VSSOP|TSOP)-/i, 1.2, 'thin small-outline package'],
  [/^(QFN|DFN|VQFN|WQFN|UQFN|TDFN|WSON|SON|LGA)-/i, 1.0, 'leadless package'],
  [/^(LQFP|TQFP|QFP)-/i, 1.6, 'quad flat package'],
  [/^BGA-/i, 1.7, 'BGA'],
  [/^DIP-\d+.*Socket/i, 8.5, 'DIP in a socket'],
  [/^DIP-/i, 5.1, 'DIP'],
  [/^Pin(Header|Socket)_.*_P2\.54mm.*Vertical/i, 8.6, '2.54 mm header standing up'],
  [/^Pin(Header|Socket)_.*_P2\.00mm.*Vertical/i, 6.1, '2.00 mm header standing up'],
  [/^Pin(Header|Socket)_.*_P1\.27mm.*Vertical/i, 4.4, '1.27 mm header standing up'],
  [/^Pin(Header|Socket)_.*_P2\.54mm.*Horizontal/i, 2.6, '2.54 mm header laid flat'],
  [/^IDC-Header_.*Vertical/i, 9.0, 'boxed header standing up'],
  [/^USB_C_/i, 3.5, 'USB-C receptacle'],
  [/^USB_Micro/i, 3.0, 'micro-USB receptacle'],
  [/^USB_Mini/i, 4.0, 'mini-USB receptacle'],
  [/^USB_A_.*Vertical/i, 15, 'USB-A standing up'],
  [/^USB_A_/i, 7.5, 'USB-A receptacle'],
  [/^BarrelJack/i, 11, 'barrel jack'],
  [/^RJ45/i, 13.5, 'RJ45 jack'],
  [/^Jack_3\.5mm/i, 6, '3.5 mm jack'],
  [/^Crystal_HC49-U_Vertical/i, 13.5, 'HC-49/U crystal standing up'],
  [/^Crystal_HC49-4H|^Crystal_HC49-U/i, 3.8, 'HC-49 low-profile crystal'],
  [/^Crystal_SMD/i, 1.2, 'SMD crystal'],
  [/^TerminalBlock/i, 10, 'terminal block'],
  [/^Relay_/i, 15.5, 'relay'],
  [/^SW_PUSH_6mm/i, 5, '6 mm tactile switch'],
  [/^SW_SPST_/i, 3.5, 'small SMD switch'],
  [/^LED_D3\.0mm/i, 5.3, '3 mm LED'],
  [/^LED_D5\.0mm/i, 8.7, '5 mm LED'],
  [/^Fuseholder/i, 10, 'fuse holder'],
  [/^Converter_DCDC/i, 10, 'DC/DC module'],
];

const num = (s: string): number => Number(s.replace(',', '.'));
const ok = (v: number): boolean => Number.isFinite(v) && v >= 0 && v < 300;

/** One name (`R_0603_1608Metric`, `CP_Elec_6.3x7.7`) → an estimate, or undefined. */
function fromName(name: string): FootprintHeightEstimate | undefined {
  const h = /_H(\d+(?:[.,]\d+)?)mm/i.exec(name);
  if (h !== null && ok(num(h[1]!))) return { mm: num(h[1]!), note: `the name states H${h[1]}mm` };
  // KiCad's moulded tantalum/polymer names: EIA-<LLWW>-<HH>, HH the body height in 0.1 mm
  const eia = /^CP?_EIA-(\d{4})-(\d{2})/i.exec(name);
  if (eia !== null && ok(num(eia[2]!) / 10)) return { mm: num(eia[2]!) / 10, note: `EIA ${eia[1]}-${eia[2]} moulded body` };
  const elec = /^CP?_Elec_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/i.exec(name);
  if (elec !== null && ok(num(elec[2]!))) return { mm: num(elec[2]!), note: `SMD electrolytic ${elec[1]} × ${elec[2]} mm` };
  const buzzer = /^Buzzer_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/i.exec(name);
  if (buzzer !== null && ok(num(buzzer[2]!))) return { mm: num(buzzer[2]!), note: `buzzer ${buzzer[1]} × ${buzzer[2]} mm` };
  // radial electrolytic: the name gives the diameter only; a typical can is about 1.6 × D, at least 11 mm
  const radial = /^CP_Radial_D(\d+(?:\.\d+)?)mm/i.exec(name);
  if (radial !== null) return { mm: Math.round(Math.max(num(radial[1]!) * 1.6, 11) * 10) / 10, note: `radial electrolytic ⌀${radial[1]} mm, typical can height` };
  const chip = /^(?:R|C|L|D|LED|Fuse|F|CP|FB)_(\d{4,5})(?:_|$)/i.exec(name);
  if (chip !== null && CHIP[chip[1]!] !== undefined) return { mm: CHIP[chip[1]!]!, note: `${chip[1]} chip, typical body` };
  for (const [re, mm, what] of FAMILIES) if (re.test(name)) return { mm, note: `${what}, typical body` };
  return undefined;
}

const baseName = (path: string): string => (path.split(/[\\/]/).pop() ?? path).replace(/\.(step|stp|wrl|vrml|igs|iges)$/i, '');

/** Attributes that say no part is placed on the footprint (KiCad's footprint `attr`). */
const NOT_PLACED = ['board_only', 'exclude_from_bom', 'exclude_from_pos_files'];

/**
 * A footprint with nothing standing on it: no 3D model, and board-only, left out of the BOM or the
 * placement files, or named as a test point, fiducial, logo, jumper or mounting hole. Not a part
 * whose height is unknown.
 */
export function padsOnly(f: FootprintHeightInput): boolean {
  const name = f.footprint.split(':').pop() ?? f.footprint;
  return f.models.length === 0 && (f.attrs.some((a) => NOT_PLACED.includes(a)) || NO_PART.test(name));
}

export function estimateFootprintHeight(f: FootprintHeightInput): FootprintHeightEstimate | undefined {
  const name = f.footprint.split(':').pop() ?? f.footprint;
  if (padsOnly(f)) {
    return { mm: 0, note: 'no 3D model and a pads-only footprint (board-only, not in the BOM, test point, fiducial, logo, jumper or mounting hole): nothing stands on it' };
  }
  for (const candidate of [name, ...f.models.map(baseName)]) {
    const e = fromName(candidate);
    if (e !== undefined) return { mm: e.mm, note: `estimated from the footprint (${candidate}): ${e.note}` };
  }
  return undefined;
}
