/**
 * Depictions — imported/generated artwork for connector and PCBA blocks.
 *
 *   import { loadDepictions, anchorsFor } from '@cable-studio/catalog/src/depictions/index.ts';
 *
 * Presentation assets only: nothing here is truth, and nothing in `core` or in
 * the catalog's electrical JSON references a depiction. A block with no
 * depiction — or with a broken one — renders as today's abstract block.
 *
 * The asset API (loader, anchors, validation, model types) is re-exported from
 * the package root too — `import { loadDepictions } from '@cable-studio/catalog'`.
 * This module additionally exposes the house-style SVG primitives, the
 * importer normaliser and the pinmaps-driven generator, which only the
 * catalog's own scripts and tests need.
 */

export {
  ANCHOR_SIDES,
  ASSET_KINDS,
  BOARD_PART_KINDS,
  BOARD_PART_STATES,
  DEPICTION_VIEWS,
  HOUSE_STYLE,
  MIRROR_AXES,
  PART_PACKAGE_FAMILIES,
  SOURCE_KINDS,
  isDepictionView,
  round,
} from './model.ts';
export type {
  AnchorPad,
  AnchorSide,
  AssetKind,
  BoardColor,
  BoardComponents,
  BoardPart,
  BoardPartKind,
  BoardPartState,
  DepictionAsset,
  DepictionIndex,
  DepictionMeta,
  DepictionSourceFile,
  DepictionView,
  EntryGuide,
  MirrorAxis,
  PartPackage,
  PartPad,
  PartPackageFamily,
  PinAnchor,
  SourceKind,
} from './model.ts';

export {
  COPPER_FINISH_HEX,
  MASK_COLOR_HEX,
  SILK_COLOR_HEX,
  TRACESPACE_DEFAULT_COPPER_HEX,
  TRACESPACE_DEFAULT_MASK_HEX,
  TRACESPACE_DEFAULT_SILK_HEX,
  maskHexOf,
  recolorBoardSvg,
  silkHexOf,
} from './color.ts';

export {
  SIDE_VIEW,
  anchorPads,
  anchorsFor,
  anchorsMm,
  reflect,
  sideAnchors,
  viewsOf,
} from './anchors.ts';
export type { PadPosition } from './anchors.ts';

export {
  definitionTerminalIds,
  definitionTerminals,
  expectedTerminals,
  parseDepictionMeta,
  parseEntryGuides,
  validateDepiction,
} from './validate.ts';
export type { DepictionValidationOptions, ParsedDepiction } from './validate.ts';

export {
  depictionDir,
  depictionsRoot,
  listDepictionDefIds,
  loadDepiction,
  loadDepictions,
  readDepictionAsset,
  readDepictionAssetDataUri,
} from './load.ts';
export type { LoadedDepiction, LoadedDepictions } from './load.ts';


export { circle, escapeXml, num, oneLine, rect, svgDocument, text } from './svg.ts';



export { boardOutlineFromSvg, outlineExit } from './outline.ts';
export type { OutlineXY } from './outline.ts';

export { componentsFor } from './components.ts';

export {
  CLI_VOICE,
  classifyImport,
  houseStrokeWidth,
  importGuidance,
  jpegSize,
  mergeDepictionMeta,
  normalizeSvg,
  parseLength,
  pngSize,
  prepareDepictionImport,
  sanitizeSvgBody,
} from './import.ts';
export type {
  DepictionImportPlan,
  DepictionImportRefusal,
  DepictionImportRequest,
  DepictionImportResult,
  FormatVerdict,
  GuidanceInput,
  ImportFormat,
  ImportVoice,
  Length,
  NormalizeSvgOptions,
  NormalizeSvgResult,
  PixelSize,
} from './import.ts';
