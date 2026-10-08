/**
 * The frame of a sheet made from a design: the title block's facts (the same
 * header the build sheet, BOM and continuity spec print) as a `SheetFrameSpec`.
 * One function, so the formboard, the label sheet and the schematic carry the
 * same org, title, part number, revision, state and paper as the text sheets.
 */

import type { CableDesign, Db } from '@wirehub/model';

import { headerFrame } from './bench/header.ts';
import { sheetHeaderOf } from './bom-sheet.ts';
import { benchOptions, type BuildSheetOptions } from './build-sheet.ts';
import type { SheetFrameSpec } from './frame/index.ts';

export function sheetFrameFor(
  design: CableDesign,
  db: Db,
  options: BuildSheetOptions,
  kind: string,
  orientation: 'portrait' | 'landscape',
  variant: 'full' | 'strip' = 'full',
): SheetFrameSpec {
  return headerFrame(sheetHeaderOf(design, db, benchOptions(options), kind), variant, orientation);
}
