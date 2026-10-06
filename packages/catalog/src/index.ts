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


import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog, type Catalog } from './catalog.ts';
import { catalogWithPacksSource } from './packs.ts';
import { fsCatalogSource, type CatalogSource } from './source.ts';

export { ART_PIN_FORMS, ART_RECORD_VIEWS, ART_TONES, loadPackArt, parseBodyLayouts, parseConnectorArt } from './art.ts';
export type {
  ArtLabelRecord,
  ArtPinFormName,
  ArtRecordView,
  ArtPinRecord,
  ArtShapeRecord,
  ArtToneName,
  BodyLayoutRecord,
  ConnectorArtRecord,
  PackArt,
} from './art.ts';
export { createCatalog, designVersionsDir, isDesignId } from './catalog.ts';
export type { Catalog, DesignId } from './catalog.ts';
export { fsCatalogSource, memoryCatalogSource } from './source.ts';
export type { CatalogSource } from './source.ts';
export {
  PACK_MANIFEST,
  PACK_HOST_CONTROL_FILES,
  isPackHostControlPath,
  applyPackAssets,
  applyPackLibrary,
  assetPath,
  assetSha,
  flatAssetPath,
  dataRelativeOf,
  packOwnedAssets,
  reconcileAssets,
  catalogWithPacksSource,
  installPack,
  installPackLayer,
  setInstalledPackOrigin,
  setInstalledModuleTrust,
  installedRecordOf,
  isAuxiliaryFile,
  PCBA_PADS_FILE,
  DRAWING_ART_FILE,
  KEYED_FILES,
  packAssetFiles,
  installedPackDir,
  installedPackSources,
  localPartOf,
  canonicalPackText,
  isSrcExempt,
  packDocumentSrcProblems,
  layeredCatalogSource,
  mergeCatalogFile,
  packFiles,
  planPackInstall,
  readInstalledPacks,
  writeFileReplacing,
  readPackManifest,
} from './packs.ts';
export {
  applyPackDisable,
  applyPackUpdate,
  catalogRecords,
  compareVersions,
  diffRecords,
  fieldChanges,
  installedAcross,
  newErrors,
  ownedRecords,
  packSourceProblems,
  planNewPack,
  planPackDisable,
  planPackUpdate,
  recordKey,
  recordKindOf,
  referencesTo,
} from './pack-lifecycle.ts';
export type { ChangedRecord, FieldChange, InstalledAcross, LocatedRecord, PackDiff, PackDisablePlan, PackInstallPreview, PackReference, PackUpdatePlan, RecordRef } from './pack-lifecycle.ts';
export {
  STORE_DISCLAIMER,
  STORE_INDEX_FORMAT,
  STORE_SIGNATURE_SUFFIX,
  buildStoreIndex,
  latestVersion,
  normalStoreKey,
  offeredVersion,
  parseStoreIndex,
  publisherKeys,
  reviewOf,
  revokedKeysOf,
  versionVisible,
  parseStorePublicKey,
  signStoreIndex,
  storeKeyFingerprint,
  storeKeyId,
  storePrivateKey,
  storePublicKeyFile,
  storePublicKeyOf,
  verifyStoreSignature,
} from './store-index.ts';
export type { StoreBundle, StoreIndex, StoreIndexModule, StoreIndexPack, StoreIndexVersion, StoreMeta, StorePublisher, StoreReview, StoreRevokedKey, StoreSignatureCheck, StoreYank } from './store-index.ts';
export { PACK_SIGNATURE, packDigests, packFileDigest, packFileProblems, packManifestMessage, signPackManifest, splitPackSignatures, verifyPackSignature } from './pack-signature.ts';
export type { PackSignatureCheck } from './pack-signature.ts';
export type { AssetOps, InstalledModule, InstalledPack, InstalledPacks, PackInstallPlan, PackLayerInstall, PackManifest, PackModule } from './packs.ts';

/** Absolute path of a file inside this package's `data/` directory — the live catalog. */
export function dataPath(relative: string): string {
  // a catalog elsewhere (a copy for tests, a mounted volume): WIREHUB_CATALOG_DIR names its data/ directory
  const elsewhere = typeof process === 'undefined' ? undefined : process.env?.WIREHUB_CATALOG_DIR;
  if (elsewhere !== undefined && elsewhere !== '') return `${elsewhere.replace(/\/+$/, '')}/${relative}`;
  return fileURLToPath(new URL(`../data/${relative}`, import.meta.url));
}

/**
 * Where the live catalog's installed packs are: `WIREHUB_PACKS_DIR`, read per
 * call; `undefined` when it is unset — then the live catalog is the data
 * directory alone. The studio's hosts set it (the container image to
 * `/data/packs`, a checkout to its gitignored `data/packs/`), so packs that
 * first-run setup installs never land in the starter catalog. Test runs leave
 * it unset and always read the starter catalog as committed.
 */
export function livePacksDir(): string | undefined {
  const dir = process.env['WIREHUB_PACKS_DIR'];
  return dir === undefined || dir === '' ? undefined : dir;
}

/** Derived files kept beside the packs (`<packs>/derived/`, e.g. tag tables that cover pack records). */
export function derivedDir(packsDir: string): string {
  return join(packsDir, 'derived');
}

/**
 * The live catalog's source: `packages/catalog/data/`, read per call, with the
 * packs installed in `livePacksDir()` under it and the derived files beside
 * them above it.
 */
export function liveCatalogSource(): CatalogSource {
  const root = dataPath('');
  return {
    name: 'the catalog',
    root,
    read(relative) {
      return current().read(relative);
    },
    list(relativeDir) {
      return current().list(relativeDir);
    },
  };
  function current(): CatalogSource {
    const packs = livePacksDir();
    if (packs === undefined) return fsCatalogSource(root, 'the catalog');
    return catalogWithPacksSource(root, packs, { name: 'the catalog', first: () => [fsCatalogSource(derivedDir(packs), 'derived files')] });
  }
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

