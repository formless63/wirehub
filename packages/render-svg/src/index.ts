/**
 * @wirehub/render-svg — the schematic drawing.
 *
 *   import { renderCrossSection, renderSchematic } from '@wirehub/render-svg';
 *   const svg = renderSchematic(design, db);   // a plain string
 *   const cut = renderCrossSection(wire);      // the cutaway on its own
 *
 * Deterministic: identical input yields a byte-identical string. Self
 * contained: no external resources, no scripts, no `<foreignObject>`.
 */

export { depictionDiagnostics, renderDiagram, renderSchematic } from './render.ts';
export type { RenderOptions } from './render.ts';
/**
 * Re-exported so a caller that supplies its own artwork (the browser editor
 * assembles one from bundled assets) can name the type without depending on
 * `@wirehub/layout` directly. Types only — the implementation, and the
 * catalog-backed default, stay where they are.
 */
export type { DepictionArtwork, DepictionDiagnostic, DepictionSource } from '@wirehub/layout';
/**
 * The cut end faces the editor canvas draws its wire nodes with — layout's
 * geometry, re-exported for the same reason as the depiction types.
 */
export { endFaceLayout } from '@wirehub/layout';
/** A figure-8 stock's end face outline — two joined circles. */
export { figure8Path } from '@wirehub/layout';
/** The parametric 3D wire: pure pieces the lazy viewer sweeps into meshes. */
export { BARE_END, coreConstruction, stripFromPractice, stripPresets, wireModel } from '@wirehub/layout';
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
} from '@wirehub/layout';
/**
 * Which bonded screens a presentation drops in favour of their set's
 * representative ("the drain stands for the bonded
 * mass") — re-exported so the editor's fallback element rows fold the same
 * way `endFaceLayout`'s terminals already do, and so a joint that names a
 * folded screen directly still resolves to a handle.
 */
export { bondedMassLabel, bondedRepresentative, bondFoldedPaths, isFoilElement, representativeLabel } from '@wirehub/layout';
/**
 * Which connectors a design mounts on a board — one rule for the canvas's
 * dock bay and the schematic's docked block.
 */
export { carriedConnectors, mountedConnectors } from '@wirehub/layout';
export type { CarriedMount, ConnectorMount } from '@wirehub/layout';
export type {
  EndFace,
  EndFaceCore,
  EndFaceOptions,
  EndFaceRing,
  EndFaceTerminal,
  EndFaceTerminalRole,
  WireEnd,
} from '@wirehub/layout';
/**
 * Connector artwork — every family's mating face or side profile and its pin
 * points. Layout's geometry, which the schematic draws
 * connector blocks with; re-exported so the canvas's connector node draws the
 * very same drawing without depending on layout directly.
 */
export { BODY_DRAWINGS, bodyDrawing, connectorArt, registerConnectorArt, registeredConnectorArt } from '@wirehub/layout';
export type {
  ArtLabel,
  ArtShape,
  ArtTone,
  ArtView,
  BodyDrawing,
  ConnectorArt,
  ConnectorArtInput,
  ConnectorPinArt,
  PinForm,
} from '@wirehub/layout';
export { inlineVectorAsset, prefixIds, svgBody, usesXlink } from './depiction.ts';
/** A board's mounted parts over its artwork, for any drawing that depicts a board. */
export { placePartLabels, renderBoardParts } from './board-parts.ts';
export type { BoardPart } from '@wirehub/catalog';
export { drawnPinPoints, partBodyShapes, partPadMismatches, resistorMarking } from './part-body.ts';
export type { DrawnPinPoint, PartDetailShape, PartPadMismatch, PartTone } from './part-body.ts';
export {
  crossSectionAnnotationBounds,
  renderCrossSection,
  renderCrossSectionPanel,
  ringPaint,
} from './cross-section.ts';
export type { CrossSectionOptions } from './cross-section.ts';
/**
 * The cutaway's geometry and key — layout's, re-exported so the editor's
 * Library can crop the drawing to the cable and print the key as a legible
 * legend of its own without depending on layout.
 */
export { crossSectionLayout } from '@wirehub/layout';
/**
 * Angled-row entry guides — layout's geometry,
 * re-exported so the canvas and the Library guide editor share it.
 */
export {
  angledRow,
  boardOutlineFromSvg,
  cableRowOutward,
  copperFromPads,
  copperPads,
  defaultEntryGuides,
  exitSlot,
  extendGuideTo,
  guideFrame,
  guideSlots,
  offsetGuideTo,
  outlineExit,
  padPolygon,
  segmentHitsPolygon,
  segmentsIntersect,
  slotOfPad,
  wireDirection,
} from '@wirehub/layout';
export type { CopperPad, GuideSlot, GuideXY } from '@wirehub/layout';
export type { CrossSection, CrossSectionKeyEntry } from '@wirehub/layout';
export { CONNECTOR_ART_STYLESHEET, DEPICTION_STYLESHEET, INK, STYLESHEET, conductorPaint, jointStyle, trackStyle } from './theme.ts';
export type { StrokeStyle } from './theme.ts';

