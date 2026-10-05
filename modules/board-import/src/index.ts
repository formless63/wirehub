/**
 * Board import — bring a PCBA in from its open fabrication files, for any
 * shop (`docs/modules.md`, "Board import"):
 *
 * | extension point | what it does                                                              |
 * | --------------- | ------------------------------------------------------------------------- |
 * | importer        | `kicad-board`: `.kicad_pcb` / `.net` → a PCBA (terminals, pads, links) and `kicad`-tier art |
 * | importer        | `gerbers`: a Gerber set `.zip` → the board's `gerber`-tier art (top, bottom, anchors) |
 * | importer        | `fab-bom`: a BOM / placement `.csv` (or both, `.board-bom.json`) → components and placed parts |
 * | UI route        | `/m/board-import/boards`: the review step — options, column mapping, plan, publish, 3D model |
 *
 * Every import is a proposal: the host runs it as a job, shows the plan and
 * publishes it as one change set (`POST /api/jobs/:id/publish`). The 3D model
 * of a board comes from the same `.kicad_pcb`, uploaded as the board's model
 * source (`POST /api/models/pcbas/:id/upload`): the server's model-cache job
 * builds it, fetching the KiCad library models the board names at a pinned
 * commit — those models are CC-BY-SA and are never committed.
 *
 * Code MIT. Pure where it runs in the browser too; no dependency beyond the
 * module contract.
 */

import { defineModule } from '@wirehub/modules';

import { fabBomImporter, gerberImporter, kicadBoardImporter } from './importers.ts';
import { BoardImportPage, MODULE_ID } from './ui.ts';

export { kicadDepiction, anchorsOf, padsOfPcba } from './art.ts';
export { boardParts, detectColumns, parseCsv, readBom, readPlacement, splitRefs, tableOf } from './bom.ts';
export type { BomField, ColumnMapping, CplField, FabFile } from './bom.ts';
export { deriveBoard, isPlaneNet, netLabel } from './derive.ts';
export type { DeriveOptions, DerivedBoard, TerminalPad } from './derive.ts';
export { boardShape, gerberDepiction, layerRole, readGerberSet } from './gerber-art.ts';
export { parseExcellon, plotGerber } from './gerber.ts';
export { BOARD_BOM_FORMAT, fabBomImporter, gerberImporter, kicadBoardImporter, resolveBoard, sha256Hex } from './importers.ts';
export { parseKicadNetlist, parseKicadPcb } from './kicad.ts';
export type { BoardSource, FootprintSource, PadSource } from './kicad.ts';
export { readZip, writeZip } from './zip.ts';
export { BoardImportPage, MODULE_ID };

export const boardImport = defineModule({
  id: MODULE_ID,
  label: 'Board import (KiCad, Gerber, fab BOM)',
  version: '0.1.0',
  license: 'MIT',
  importers: [kicadBoardImporter, gerberImporter, fabBomImporter],
  routes: [{ path: 'boards', label: 'Board import', icon: 'IconTool', component: BoardImportPage }],
});
