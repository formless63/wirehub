/**
 * @wirehub/docs — the build documents.
 *
 *   import { deriveBom, deriveTestSpec, renderBuildSheet } from '@wirehub/docs';
 *
 * SPEC's mission names four artifacts that derive from the canonical model:
 * schematics, build sheets, BOMs and continuity/test specifications. The
 * schematic lives in `@wirehub/render-svg`; the other three live here.
 *
 * The house rules, same as everywhere else in this repo:
 *
 * - **`model` owns truth.** Nothing here authors an electrical fact. A BOM is
 *   a fold of `design.instances`; a test spec is a fold of `deriveNets` and
 *   `trace`. When this package needs to *interpret* a fact — "does a meter
 *   beep across this?" — it says so out loud (`src/passages.ts`) rather than
 *   smuggling the judgement into `core`.
 * - **Deterministic.** No clock, no randomness, no locale-dependent
 *   formatting, no network. Identical input yields a byte-identical document;
 *   a timestamp only appears if the caller passes one in.
 * - **Self-contained output.** The build sheet references no font, no
 *   stylesheet, no script and no image outside its own bytes, and every class
 *   name is `cs-`-prefixed so a host app cannot collide with it.
 */

export { deriveBom, bomCategoryLabel, wireConsumption, unaccountedInstances, BOM_CATEGORY_ORDER } from './bom.ts';
export type {
  Bom,
  BomAssembly,
  BomCategory,
  BomLine,
  BomNote,
  BomTopic,
} from './bom.ts';
export { bomToHtml, bomToMarkdown } from './bom-render.ts';

export { deriveTestSpec, designPorts, SIDE_WORD } from './test-spec.ts';
export { deriveGroundLandings, massText, screensText } from './landings.ts';
export type { GroundLanding } from './landings.ts';
export type {
  GroundLandingCheck,
  IsolationCheck,
  NetCheck,
  OpenCheck,
  OpenKind,
  PathCheck,
  Port,
  Side,
  SignalClass,
  TestCheck,
  TestSpec,
} from './test-spec.ts';
export { meterWord, testSpecToHtml, testSpecToMarkdown } from './test-spec-render.ts';

export {
  formatOhms,
  parsePassageElement,
  passageElements,
  passageKey,
  passagesText,
  pathBehaviour,
} from './passages.ts';
export type {
  ElementDc,
  ElementRole,
  PassageElement,
  PathBehaviour,
  PathVerdict,
} from './passages.ts';

export { benchOptions, buildSheetBody, renderBuildSheet, scopeSvgStyles, terminationLine } from './build-sheet.ts';
export { deriveBench, landingKey, stockElements, trunkSides } from './bench/model.ts';
export type { Bench, BenchEnd, Landing, LandingElement, LandingTarget, SegmentEnd, StripRow, Termination } from './bench/model.ts';
export { DEFAULT_DESIGNER, headerHtml, sheetHeader, variationsOf } from './bench/header.ts';
export type { DocumentFacts, SheetHeader, Variation } from './bench/header.ts';
export { benchSheetBody } from './bench/render.ts';
export { suppliedEnds, type SuppliedEnd } from './supplied.ts';
export { breakoutSection } from './bench/breakouts.ts';
export { BOM_SECTIONS, bomSheetBody, bomSheetMarkdown, deriveBomSheet } from './bom-sheet.ts';
export type { BomSection, BomSheet, BomSheetLine, BomSheetOptions } from './bom-sheet.ts';
export type { BuildSheetOptions, DocumentIdentity, SheetOptions } from './build-sheet.ts';
export {
  documentBody,
  renderBomMarkdown,
  renderBomSheet,
  renderTestSpecSheet,
  standaloneDocument,
} from './standalone.ts';
export { SHEET_STYLESHEET } from './styles.ts';

export { feetAttribute, feetFromMm, feetText, lengthFromMm, mmFromFeet, num, round } from './units.ts';
export type { Length } from './units.ts';

export * from './drawing/index.ts';

export {
  groundingNotes,
  renderWireSpecSheet,
  wireSpecDocNumber,
  wireSpecFileName,
  wireSpecFileStem,
  wireManufacturerName,
  WIRE_SPEC_STANDARD,
  WIRE_SPEC_FILE_PREFIX,
  wireSpecScale,
  WIRE_SPEC_STYLESHEET,
} from './wire-spec.ts';
export type { WireSpecOptions } from './wire-spec.ts';

export { constructionTag, stripMakerSuffix, wireDisplayName } from '@wirehub/model';
export { registerBenchSteps } from './bench/standard-work.ts';
export type { BenchStepsProvider, ShellSet, Step as BenchStep } from './bench/standard-work.ts';
