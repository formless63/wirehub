/**
 * @cable-studio/layout — the positioned diagram model.
 *
 *   import { layoutSchematic } from '@cable-studio/layout';
 *   const diagram = layoutSchematic(design, db);
 *
 * Pure data in, pure data out: millimetre coordinates, colour *names* rather
 * than paint, and no SVG anywhere. `@cable-studio/render-svg` consumes this.
 * Layout is fully deterministic — identical input yields identical numbers.
 */

export { layoutSchematic } from './layout.ts';
export type { LayoutOptions } from './layout.ts';
export { bondedMassLabel, bondedRepresentative, bondFoldedPaths, isFoilElement, representativeLabel } from './bond-fold.ts';
export {
  boardFaces,
  cableRowOutward,
  facePoint,
  isConnectorSideTerminal,
  rotatePoint,
  rotatedSize,
  rotationTransform,
  turnToward,
  wireDirection,
} from './board-faces.ts';
export type { BoardFaceSide, BoardFacesSource, FacePad, FacePlan, QuarterTurn } from './board-faces.ts';
export { orderLanes, crossingsLeftOf } from './lanes.ts';
export type { LaneRun } from './lanes.ts';
export { optimiseTrackOrder, orderCost } from './track-order.ts';
export type { TrackLanding, TrackUnits } from './track-order.ts';
export { BODY_DRAWINGS, DSUB_SHELLS, bodyDrawing, connectorArt } from './connector-art.ts';
export type {
  ArtLabel,
  ArtShape,
  ArtTone,
  ArtView,
  BodyDrawing,
  ConnectorArt,
  ConnectorArtInput,
  ConnectorPinArt,
  DsubShell,
  Facing,
  PinForm,
} from './connector-art.ts';
export { planPinLeads } from './connector-leads.ts';
export type { PinLead, PinLeadOptions } from './connector-leads.ts';
export { crossSectionLayout } from './cross-section.ts';
export { BARE_END, coreConstruction, stripFromPractice, stripPresets, wireModel } from './wire-model.ts';
export type {
  CapKind,
  StripEnd,
  StripPreset,
  Vec3,
  WireEndShown,
  WireMaterialKind,
  WireModel,
  WireModelOptions,
  WirePiece,
  WirePieceKind,
} from './wire-model.ts';
export { figure8Path } from './figure8.ts';
export type { Lobe } from './figure8.ts';
export type { CrossSectionOptions } from './cross-section.ts';
export { endFaceLayout } from './end-face.ts';
export type {
  EndFace,
  EndFaceCore,
  EndFaceOptions,
  EndFaceRing,
  EndFaceTerminal,
  EndFaceTerminalRole,
  WireEnd,
} from './end-face.ts';
export {
  DEPICTION_VIEW_PREFERENCE,
  catalogDepictions,
  depictionsFromRoot,
  pickDepictionView,
  resetDepictionCache,
  resolveDepiction,
} from './depictions.ts';
export type {
  DepictionArtwork,
  DepictionResolution,
  DepictionSource,
  DepictionStatus,
  ResolvedDepiction,
} from './depictions.ts';
export * from './entry-guides.ts';
export { METRICS } from './metrics.ts';
export type { Metrics } from './metrics.ts';
export * from './model.ts';
export {
  analyzeTopology,
  buildTerminalGraph,
  jointRecords,
  carriedConnectors,
  mountedConnectors,
  throughView,
  trackBarycenter,
} from './structure.ts';
export type { ThroughLanding } from './structure.ts';
export type {
  BranchInfo,
  CarriedMount,
  ConnectorMount,
  JointRecord,
  TerminalGraph,
  Topology,
} from './structure.ts';
export { bandTrackSpecs } from './tracks.ts';
export type { GroupSpec, TrackSpec } from './tracks.ts';
export {
  compareTerminalIds,
  FONT_FAMILY,
  fitText,
  maxTextWidth,
  summarizeIds,
  textWidth,
  wrapText,
} from './text.ts';
export type { FontWeight } from './text.ts';
