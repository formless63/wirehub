/**
 * @wirehub/catalog — the catalog loaders, the starter catalog and the example designs.
 *
 *   import { loadDb, loadDesign } from '@wirehub/catalog';
 *   const db = loadDb();
 *   const design = loadDesign('db9-serial-null-modem');
 *
 * The JSON under `data/` is the authoritative record; every record carries a
 * `src` citation. Loading is a pure read: each call returns fresh objects, so
 * callers can never mutate a shared singleton.
 *
 * **The design list is the directory.** `listDesignIds()` reads
 * `data/designs/` on every call, so a file dropped in (by hand, by the studio's
 * workbench API, by a script) is loadable everywhere with no code edit. There
 * is no hardcoded roster to keep in sync — an earlier `DESIGN_IDS` constant
 * was exactly that, and it went stale the first time the GUI could save.
 */


import { fileURLToPath } from 'node:url';

import { createCatalog, type Catalog } from './catalog.ts';
import { fsCatalogSource, type CatalogSource } from './source.ts';

export { createCatalog, designVersionsDir, isDesignId } from './catalog.ts';
export type { Catalog, DesignId } from './catalog.ts';
export { fsCatalogSource, memoryCatalogSource } from './source.ts';
export type { CatalogSource } from './source.ts';

/** Absolute path of a file inside this package's `data/` directory — the live catalog. */
export function dataPath(relative: string): string {
  return fileURLToPath(new URL(`../data/${relative}`, import.meta.url));
}

/** The live catalog's source: `packages/catalog/data/`, read per call. */
export function liveCatalogSource(): CatalogSource {
  return fsCatalogSource(dataPath(''), 'the catalog');
}

/**
 * The live catalog's loaders. Every top-level `load…` export below is one of
 * these, so `loadDb()` and `liveCatalog().loadDb()` are the same read.
 */
const live: Catalog = createCatalog(liveCatalogSource());
export function liveCatalog(): Catalog {
  return live;
}

/**
 * The frozen fixture catalog (`fixtures/<version>/`):
 * a representative handful of designs and exactly the definitions, rules,
 * drawings and part-number files they need. Snapshot tests render from this,
 * so a normal edit to the live catalog never breaks a golden; invariant sweeps
 * (validation, audits, round trips) keep running over the live catalog.
 * Never edited by hand — see `fixtures/README.md`.
 */
export function fixtureCatalogRoot(version = 'v1'): string {
  return fileURLToPath(new URL(`../fixtures/${version}/`, import.meta.url));
}
export function fixtureCatalog(version = 'v1'): Catalog {
  return createCatalog(fsCatalogSource(`${fixtureCatalogRoot(version)}data`, `the fixture catalog ${version}`));
}
/** The fixture catalog's own depiction tree (a subset of `depictions/`, frozen with it). */
export function fixtureDepictionsRoot(version = 'v1'): string {
  return `${fixtureCatalogRoot(version)}depictions`;
}

/* ------------------------------------------------------------------ *
 * The live catalog's loaders (see `catalog.ts` for what each reads)
 * ------------------------------------------------------------------ */

export const listDesignIds = (): string[] => live.listDesignIds();
export const listDesignSummaries = (): { id: string; label: string }[] => live.listDesignSummaries();
export const designExists = (id: string): boolean => live.designExists(id);
export const loadDesign: Catalog['loadDesign'] = (id) => live.loadDesign(id);
export const loadDesigns: Catalog['loadDesigns'] = () => live.loadDesigns();
export const loadCatalog: Catalog['loadCatalog'] = () => live.loadCatalog();
export const listDesignRevisions: Catalog['listDesignRevisions'] = (id) => live.listDesignRevisions(id);
export const loadDesignVersion: Catalog['loadDesignVersion'] = (id, rev) => live.loadDesignVersion(id, rev);
export const loadLatestDesignVersion: Catalog['loadLatestDesignVersion'] = (id) => live.loadLatestDesignVersion(id);
export const loadConnectors: Catalog['loadConnectors'] = () => live.loadConnectors();
export const loadConnectorRecords: Catalog['loadConnectorRecords'] = () => live.loadConnectorRecords();
export const loadBodies: Catalog['loadBodies'] = () => live.loadBodies();
export const loadInterfaces: Catalog['loadInterfaces'] = () => live.loadInterfaces();
export const loadWires: Catalog['loadWires'] = () => live.loadWires();
export const loadComponents: Catalog['loadComponents'] = () => live.loadComponents();
export const loadKits: Catalog['loadKits'] = () => live.loadKits();
export const loadMechanicals: Catalog['loadMechanicals'] = () => live.loadMechanicals();
export const loadCuratedPcbas: Catalog['loadCuratedPcbas'] = () => live.loadCuratedPcbas();
export const loadPcbaStatus: Catalog['loadPcbaStatus'] = () => live.loadPcbaStatus();
export const loadPcbas: Catalog['loadPcbas'] = () => live.loadPcbas();
export const loadWireParts: Catalog['loadWireParts'] = () => live.loadWireParts();
export const loadWireRecipes: Catalog['loadWireRecipes'] = () => live.loadWireRecipes();
export const loadWireLibrary: Catalog['loadWireLibrary'] = () => live.loadWireLibrary();
export const loadStripPractice: Catalog['loadStripPractice'] = () => live.loadStripPractice();
export const loadPcbaPads: Catalog['loadPcbaPads'] = () => live.loadPcbaPads();
export const listVocabIds: Catalog['listVocabIds'] = () => live.listVocabIds();
export const loadVocabList: Catalog['loadVocabList'] = (id) => live.loadVocabList(id);
export const loadVocab: Catalog['loadVocab'] = () => live.loadVocab();
export const loadSignalTags: Catalog['loadSignalTags'] = () => live.loadSignalTags();
export const loadPartNumberScheme: Catalog['loadPartNumberScheme'] = () => live.loadPartNumberScheme();
export const loadDb: Catalog['loadDb'] = () => live.loadDb();

/* ------------------------------------------------------------------ *
 * Depictions — presentation artwork, keyed by definition id
 * ------------------------------------------------------------------ */

/**
 * Depictions are **presentation assets, not truth**: nothing in `core` or in
 * the electrical JSON above references one. They live under
 * `depictions/<def-id>/`, and a consumer that cannot use one falls back to the
 * abstract block. Only the asset API is re-exported here — the house-style SVG
 * primitives and the pinmaps-driven generator stay behind
 * `src/depictions/index.ts`, where the scripts that need them import by path.
 */
export {
  ANCHOR_SIDES,
  DEPICTION_VIEWS,
  HOUSE_STYLE,
  PART_PACKAGE_FAMILIES,
  SIDE_VIEW,
  anchorPads,
  anchorsFor,
  componentsFor,
  anchorsMm,
  boardOutlineFromSvg,
  definitionTerminalIds,
  definitionTerminals,
  expectedTerminals,
  depictionDir,
  depictionsRoot,
  isDepictionView,
  listDepictionDefIds,
  loadDepiction,
  outlineExit,
  loadDepictions,
  readDepictionAsset,
  readDepictionAssetDataUri,
  parseDepictionMeta,
  parseEntryGuides,
  sideAnchors,
  validateDepiction,
  viewsOf,
} from './depictions/index.ts';
export type {
  AnchorPad,
  AnchorSide,
  AssetKind,
  BoardComponents,
  BoardPart,
  BoardPartKind,
  BoardPartState,
  DepictionAsset,
  DepictionIndex,
  DepictionMeta,
  DepictionSourceFile,
  DepictionValidationOptions,
  DepictionView,
  EntryGuide,
  LoadedDepiction,
  LoadedDepictions,
  MirrorAxis,
  OutlineXY,
  PadPosition,
  ParsedDepiction,
  PartPackage,
  PartPad,
  PartPackageFamily,
  PinAnchor,
  SourceKind,
} from './depictions/index.ts';

