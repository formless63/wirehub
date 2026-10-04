/**
 * The drawing sheet — the owner's ANSI A engineering drawing, generated.
 * See `model.ts` for what it says and `render.ts` for how it is laid out.
 */

export {
  deriveDrawing,
  trunkSegment,
  GROUND_FILL,
  PIN_COLORS,
  UNUSED_FILL,
} from './model.ts';
export type {
  BomRow,
  Breakout,
  Drawing,
  DrawingFace,
  FaceBridge,
  DrawingMeta,
  SheetSettings,
  DrawingPlug,
  DrawingPort,
  LengthVariant,
  PinState,
  Remark,
  WireRow,
} from './model.ts';
export { drawingToSvg, faceArtMarkup, renderDrawingSheet, textWidth, SHEET_HEIGHT, SHEET_WIDTH } from './render.ts';
export type { DrawingSheetOptions, DrawingSvgOptions } from './render.ts';
export { faceEdgeTop, faceEdgeX, faceFor, flattenPath, genericFace, materialFromLabel, plugFor, tracedFaceIds, tracedPlugIds } from './faces.ts';
export type { FaceArt, FaceArtPath, FacePin, FaceSource, PlugGeometry } from './faces.ts';
export { drawnFace } from './drawn-faces.ts';
export { cutawayFor, drawCutaway, hasCutawayArt } from './cutaway.ts';
export type { Cutaway } from './cutaway.ts';
