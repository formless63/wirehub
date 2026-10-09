/**
 * Label stock as data (cs-8kj.5): a preset is the geometry of one kind of
 * label stock, so the printed sheet matches it. Two shapes:
 *
 * - `sheet`: a page of die-cut labels on a grid (the A4 and Letter office stock);
 * - `roll`: a label printer's single label, one label per page, the page being the label
 *   (Brady and Dymo);
 * - `tape`: a Brother P-touch TZe laminated tape (cs-gqbj), one label per page, the page being
 *   the tape's width by the label's length; the tape's colour, ink colour and P-touch paper
 *   values ride on `tape`. The length is fixed, or `auto` (as long as the text).
 *
 * The sizes are each product's nominal label size from the maker's catalogue.
 * Part numbers differ by region and colour, so a label printer's stock is
 * named by size; confirm a size against the cartridge before a long run.
 */

import type { LabelSheetLayout } from './labels.ts';

export interface LabelPreset {
  id: string;
  label: string;
  kind: 'sheet' | 'roll' | 'tape';
  layout: LabelSheetLayout;
  /** a P-touch tape's stock: only on `kind: 'tape'` */
  tape?: TapeStock;
  /** where the numbers come from */
  src: string;
}

/**
 * One P-touch tape width. `printableDots` is the print head's height in dots at 180 dpi for that
 * width (0.4 pt a dot); `paperPt` and `marginPt` are the values P-touch Editor writes in an `.lbx`
 * (`style:paper` width, and the margin to the printable area). `format` is Editor's paper-format id.
 * `inferred` lists what is not confirmed against a P-touch Editor file.
 */
export interface TapeWidth {
  mm: number;
  printableDots: number;
  paperPt: number;
  marginPt: number;
  format: number;
  inferred: readonly ('paperPt' | 'marginPt' | 'format')[];
}

const PT_PER_DOT = 0.4;
const widthOf = (mm: number, printableDots: number, paperPt: number, format: number, inferred: TapeWidth['inferred']): TapeWidth => ({
  mm, printableDots, paperPt, marginPt: Math.round(((paperPt - printableDots * PT_PER_DOT) / 2) * 10) / 10, format, inferred,
});

/**
 * The TZe widths. Printable dots: Brother's printable-width figures for the PT range (24, 32, 50, 70, 112, 128
 * and, for the 36 mm printers, 192 dots at 180 dpi). 12 mm (33.6 pt tape, 2.8 pt margin, format 259) is
 * what P-touch Editor writes (checked against real files). The other widths' `.lbx` paper size and format id are the
 * values the MIT `bil-lbx` library tabulates from P-touch files (3.5 mm 10 pt / 257, 6 mm 17 / 258, 9 mm 25.5 / 264,
 * 18 mm 51 / 260, 24 mm 68 / 261, 36 mm 102 / 262); the margin to the printable band is derived from the head's dots
 * and is inferred. Editor re-reads the tape from the connected printer when a file is opened.
 */
export const TAPE_WIDTHS: readonly TapeWidth[] = [
  widthOf(3.5, 24, 10, 257, ['marginPt']),
  widthOf(6, 32, 17, 258, ['marginPt']),
  widthOf(9, 50, 25.5, 264, ['marginPt']),
  widthOf(12, 70, 33.6, 259, []),
  widthOf(18, 112, 51, 260, ['marginPt']),
  widthOf(24, 128, 68, 261, ['marginPt']),
  widthOf(36, 192, 102, 262, ['marginPt']),
];

export function tapeWidthOf(mm: number): TapeWidth | undefined {
  return TAPE_WIDTHS.find((w) => w.mm === mm);
}

/** A tape: its width, colours and length. `length` is millimetres, or `auto`. */
export interface TapeStock {
  /** the Brother product code, `TZe-335` */
  code: string;
  width: TapeWidth;
  /** the tape's colour and the ink's, `#rrggbb`; a clear tape is drawn tinted */
  tapeColor: string;
  inkColor: string;
  /** `white on black` */
  colors: string;
  clear: boolean;
  length: 'auto' | number;
  /** the shortest an auto-length label is (mm) */
  minLengthMm: number;
}

const TAPE_BLACK = '#000000';
const TAPE_WHITE = '#ffffff';
/** clear tape is shown a pale grey-blue so the print on it reads; P-touch Editor shows it white */
const TAPE_CLEAR = '#e6edf2';

interface TapeColour {
  name: string;
  tape: string;
  ink: string;
  clear?: true;
  /** the Brother code per width (mm) */
  codes: Readonly<Record<number, string>>;
}

const TAPE_COLOURS: readonly TapeColour[] = [
  { name: 'white on black', tape: TAPE_BLACK, ink: TAPE_WHITE, codes: { 6: 'TZe-315', 9: 'TZe-325', 12: 'TZe-335', 18: 'TZe-345', 24: 'TZe-355', 36: 'TZe-365' } },
  { name: 'black on white', tape: TAPE_WHITE, ink: TAPE_BLACK, codes: { 3.5: 'TZe-N201', 6: 'TZe-211', 9: 'TZe-221', 12: 'TZe-231', 18: 'TZe-241', 24: 'TZe-251', 36: 'TZe-261' } },
  { name: 'black on clear', tape: TAPE_CLEAR, ink: TAPE_BLACK, clear: true, codes: { 6: 'TZe-111', 9: 'TZe-121', 12: 'TZe-131', 18: 'TZe-141', 24: 'TZe-151', 36: 'TZe-161' } },
];

const SRC_TAPE =
  "Brother TZe laminated tape product data (brother.com TZe tape catalogue): the width, tape colour and ink colour of each code. " +
  "Only the 12 mm codes (TZe-335, TZe-231, TZe-131) are confirmed; the other widths' codes follow Brother's code pattern per colour (the digit before the last is the width) and are inferred. " +
  'The P-touch paper values: 12 mm from real P-touch Editor files, the other widths from the bil-lbx table with derived margins (see TAPE_WIDTHS). The PT-D610BT prints up to 24 mm; 36 mm is for the wider P-touch printers.';

function tapePresets(): LabelPreset[] {
  const out: LabelPreset[] = [];
  for (const colour of TAPE_COLOURS) {
    for (const width of TAPE_WIDTHS) {
      const code = colour.codes[width.mm];
      if (code === undefined) continue;
      const minLengthMm = 20;
      out.push({
        id: `tze-${width.mm}-${code.replace(/^TZe-/, '').toLowerCase()}`,
        label: `Brother ${code} (${width.mm} mm, ${colour.name})`,
        kind: 'tape',
        layout: { pageWidth: 50, pageHeight: width.mm, columns: 1, rows: 1, labelWidth: 50, labelHeight: width.mm, marginLeft: 0, marginTop: 0, gapX: 0, gapY: 0 },
        tape: { code, width, tapeColor: colour.tape, inkColor: colour.ink, colors: colour.name, clear: colour.clear === true, length: 'auto', minLengthMm },
        src: width.mm === 12 ? SRC_TAPE : `${SRC_TAPE} This code and width are inferred.`,
      });
    }
  }
  return out;
}

const roll = (width: number, height: number): LabelSheetLayout => ({
  pageWidth: width, pageHeight: height, columns: 1, rows: 1, labelWidth: width, labelHeight: height, marginLeft: 0, marginTop: 0, gapX: 0, gapY: 0,
});

export const LABEL_PRESETS: readonly LabelPreset[] = [
  {
    id: 'a4-l7160',
    label: 'A4 sheet, 3 × 7 (63.5 × 38.1 mm)',
    kind: 'sheet',
    layout: { pageWidth: 210, pageHeight: 297, columns: 3, rows: 7, labelWidth: 63.5, labelHeight: 38.1, marginLeft: 7.2, marginTop: 15.1, gapX: 2.5, gapY: 0 },
    src: 'The common L7160 address-label grid on A4.',
  },
  {
    id: 'letter-5160',
    label: 'Letter sheet, 3 × 10 (66.7 × 25.4 mm)',
    kind: 'sheet',
    layout: { pageWidth: 215.9, pageHeight: 279.4, columns: 3, rows: 10, labelWidth: 66.7, labelHeight: 25.4, marginLeft: 4.8, marginTop: 12.7, gapX: 3.1, gapY: 0 },
    src: 'The common 5160 address-label grid on US Letter.',
  },
  { id: 'dymo-30336', label: 'Dymo LabelWriter 30336 (25 × 54 mm)', kind: 'roll', layout: roll(54, 25), src: 'Dymo LabelWriter small multi-purpose label, nominal 1 in × 2-1/8 in.' },
  { id: 'dymo-30334', label: 'Dymo LabelWriter 30334 (32 × 57 mm)', kind: 'roll', layout: roll(57, 32), src: 'Dymo LabelWriter medium multi-purpose label, nominal 1-1/4 in × 2-1/4 in.' },
  { id: 'dymo-30252', label: 'Dymo LabelWriter 30252 (28 × 89 mm)', kind: 'roll', layout: roll(89, 28), src: 'Dymo LabelWriter address label, nominal 1-1/8 in × 3-1/2 in.' },
  { id: 'dymo-99012', label: 'Dymo LabelWriter 99012 (36 × 89 mm)', kind: 'roll', layout: roll(89, 36), src: 'Dymo LabelWriter large address label, nominal 1-3/8 in × 3-1/2 in.' },
  { id: 'brady-m21-19x38', label: 'Brady M21 wire marker (19 × 38 mm)', kind: 'roll', layout: roll(38.1, 19.05), src: 'Brady BMP21 / M210 series label, nominal 3/4 in × 1-1/2 in; confirm against the cartridge.' },
  { id: 'brady-m21-25x51', label: 'Brady M21 label (25 × 51 mm)', kind: 'roll', layout: roll(50.8, 25.4), src: 'Brady BMP21 / M210 series label, nominal 1 in × 2 in; confirm against the cartridge.' },
  { id: 'brady-m61-25x76', label: 'Brady M611 label (25 × 76 mm)', kind: 'roll', layout: roll(76.2, 25.4), src: 'Brady M611 / BMP61 series label, nominal 1 in × 3 in; confirm against the cartridge.' },
  ...tapePresets(),
];

export const LABEL_PRESET_IDS: readonly string[] = LABEL_PRESETS.map((p) => p.id);

export function labelPresetOf(id: string | undefined): LabelPreset | undefined {
  return id === undefined ? undefined : LABEL_PRESETS.find((p) => p.id === id);
}

/** The preset a paper's stock grid is (A4 stock, or Letter). */
export function defaultLabelPreset(paper: 'A4' | 'letter'): LabelPreset {
  return LABEL_PRESETS.find((p) => p.id === (paper === 'letter' ? 'letter-5160' : 'a4-l7160')) as LabelPreset;
}
