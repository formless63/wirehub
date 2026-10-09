/**
 * Label stock as data (cs-8kj.5): a preset is the geometry of one kind of
 * label stock, so the printed sheet matches it. Two shapes:
 *
 * - `sheet`: a page of die-cut labels on a grid (the A4 and Letter office stock);
 * - `roll`: a label printer's single label, one label per page, the page being the label
 *   (Brady and Dymo).
 *
 * The sizes are each product's nominal label size from the maker's catalogue.
 * Part numbers differ by region and colour, so a label printer's stock is
 * named by size; confirm a size against the cartridge before a long run.
 */

import type { LabelSheetLayout } from './labels.ts';

export interface LabelPreset {
  id: string;
  label: string;
  kind: 'sheet' | 'roll';
  layout: LabelSheetLayout;
  /** where the numbers come from */
  src: string;
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
];

export const LABEL_PRESET_IDS: readonly string[] = LABEL_PRESETS.map((p) => p.id);

export function labelPresetOf(id: string | undefined): LabelPreset | undefined {
  return id === undefined ? undefined : LABEL_PRESETS.find((p) => p.id === id);
}

/** The preset a paper's stock grid is (A4 stock, or Letter). */
export function defaultLabelPreset(paper: 'A4' | 'letter'): LabelPreset {
  return LABEL_PRESETS.find((p) => p.id === (paper === 'letter' ? 'letter-5160' : 'a4-l7160')) as LabelPreset;
}
