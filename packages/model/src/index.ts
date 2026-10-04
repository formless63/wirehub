/**
 * @wirehub/model — the canonical cable model.
 *
 *   import { validateDesign, deriveNets, trace } from '@wirehub/model';
 *
 * core owns truth: it knows nothing about SVG, React Flow, coordinates or the
 * database. Every derived artifact is a pure function of the serialized
 * definitions plus a design document.
 */

export * from './model.ts';
export {
  isGroup,
  isElectricalElement,
  elementPaths,
  electricalPaths,
  resolveElementPath,
  resolveWirePath,
  duplicateSiblingIds,
} from './paths.ts';
export type { ElementAtPath } from './paths.ts';
export {
  terminalKey,
  parseTerminalKey,
  resolveTerminal,
  designInstances,
  findInstance,
  pcbaTerminalIds,
  terminalsOf,
  validateDb,
  validateDesign,
  validateWireLayOrder,
  noteIndexReferencingTerminal,
  noteReferencesTerminal,
} from './validate.ts';
export type {
  DesignInstanceRef,
  ResolvedTerminal,
  ResolveResult,
} from './validate.ts';
export {
  addInstance,
  addJoint,
  dropUnlandedPigtails,
  moveJointEnds,
  describeJointMove,
  jointMoveText,
  nextInstanceId,
  parseDesignJson,
  removeInstance,
  removeJoint,
  removeJoints,
  updateInstance,
} from './design-edit.ts';
export type { InstancePatch, JointEndMove, ParseResult } from './design-edit.ts';
export {
  compatibilityIssues,
  hintOfTags,
  jointCompatibility,
  profileDesignTerminal,
  profileTerminal,
  signalFromLabel,
} from './compat.ts';
export type {
  CompatibilityCode,
  InstanceTerminal,
  JointVerdict,
  SignalHint,
  TerminalClass,
  TerminalProfile,
} from './compat.ts';
export {
  buildGraph,
  deriveNets,
  netForTerminal,
  trace,
  reachedTerminal,
} from './nets.ts';
export type {
  DesignGraph,
  EdgeKind,
  GraphEdge,
  Net,
  Passage,
  TraceResult,
  TraceStep,
} from './nets.ts';
export {
  bondedSetOf,
  findPigtail,
  isFullyBonded,
  isScreenPath,
  pigtailKey,
  pigtailMembers,
  pigtailOfTerminal,
  pigtailsAt,
  screenPaths,
  screenTerminations,
  isFoilPath,
  isTrimmedFoil,
} from './bonds.ts';
export type { ScreenTermination } from './bonds.ts';
export {
  SIGNAL_KINDS,
  VOCAB_LIST_IDS,
  signalKinds,
  appendVocabEntry,
  resolveVocab,
  signalIds,
  validateVocab,
  validateVocabList,
  vocabChangeIssues,
  vocabEntry,
  vocabKey,
  vocabList,
  vocabReferenceIssues,
} from './vocab.ts';
export type {
  AppendResult,
  ColourCodeEntry,
  LaneEntry,
  PadRoleEntry,
  PcbaTerminalTags,
  SignalEntry,
  SignalId,
  SignalKind,
  SignalRef,
  SignalTags,
  Vocab,
  VocabEntry,
  VocabList,
  VocabLookupOptions,
  VocabMatch,
  WireTags,
} from './vocab.ts';
export { colourCodeOf, kindOfSignal, laneOfPadRole, signalOf } from './signals.ts';
export {
  CHASSIS_SIGNAL,
  GROUND_SIGNAL,
  isGroundSignal,
  laneOfSignal,
  readSignalLabels,
  readSignalWords,
  returnOf,
  signalOfLane,
} from './signal-words.ts';
export type { TerminalTags } from './signals.ts';
export {
  FLEET_SIGNAL_WORDS,
  WIRE_PART_KINDS,
  compileWire,
  conductorArea,
  diffWireFacts,
  formationOf,
  layEnvelope,
  lostInferredFlags,
  recipeFor,
  roundTo,
  signalWordsOf,
  strandedOd,
  suggestBondedSets,
  validateWireParts,
} from './wire-recipe.ts';
export type {
  CompiledWire,
  ConductorPart,
  CorePart,
  DerivedValue,
  InsulationPart,
  JacketPart,
  LabelSlot,
  RecipeCore,
  RecipeLay,
  RecipeOverall,
  RecipeOverride,
  RecipePerformance,
  RecipeRevision,
  RecipeWeb,
  ShieldConstruction,
  ShieldPart,
  WireFactDiff,
  WireLibrary,
  WirePart,
  WirePartKind,
  WireRecipe,
} from './wire-recipe.ts';
export { stripPracticeProblems } from './strip-practice.ts';
export type { StripDrainTreatment, StripPractice, StripShieldTreatment } from './strip-practice.ts';
export {
  composeConnector,
  composeConnectors,
  composePins,
  connectorConstruction,
  connectorsOnBody,
  decomposeConnector,
  findBody,
  findInterface,
  interfacesOnBody,
  validateInterfaces,
} from './interfaces.ts';
export type {
  BodyPosition,
  Confidence,
  ConnectorBody,
  ConnectorRecord,
  Interface,
  InterfaceLibrary,
  PinFunction,
} from './interfaces.ts';
export { boardBuildsKey, buildPopulation, carrierRoute, definitionsOfBuild, validateBoardBuilds } from './builds.ts';
// ---- board parts: what is placed on each PCBA, as component records ----
export {
  boardBuildOf,
  boardComponentRows,
  boardPartsOf,
  boardPartsWithBuilds,
  compareRefs,
  componentBuildUses,
  componentCategory,
  compressRefs,
} from './board-parts.ts';
export type { BoardComponentRow, ComponentBuildUse } from './board-parts.ts';
export type {
  BoardBuild,
  BoardBuilds,
  BoardCapability,
  BoardCarrier,
  BoardFootprint,
  BuildCheckLibrary,
  BuildHazard,
  BuildSetting,
  CapabilityPath,
  DeclaredPassages,
  PartPassage,
  SettingRule,
  SignalSpec,
} from './builds.ts';

// ---- kits, usage, connector mounting ----
export { KIT_PART_KINDS, KIT_SKU, findKit, kitCoverage, kitPartExists, kitPartLabel, kitsContaining, validateKits } from './kits.ts';
export type { KitCoverage, KitDefinition, KitLine, KitPartKind, PartRef } from './kits.ts';
export { definitionUsage, usageCounts } from './usage.ts';
export type { DefinitionUse, UsageKind } from './usage.ts';
export { connectorMountingOfInstance, connectorMountingUsage } from './connector-mounting.ts';
export type { ConnectorMounting, ConnectorMountingUsage, MountingDesign } from './connector-mounting.ts';

// ---- design bodies and the override patch language ----
export {
  applyOverrides,
  designBody,
  diffBodies,
  jointKey,
  landingKey,
  materialiseBody,
  parseLandingKey,
  physicalInstance,
  physicalSignature,
  samePhysicalBody,
} from './body.ts';
export type {
  DesignBody,
  InstanceListKey,
  OverrideJoint,
  OverrideMiss,
  OverrideReason,
  CableOverride,
  UnreasonedOverride,
} from './body.ts';
export {
  DEFAULT_PART_NUMBER_SCHEME,
  DEFAULT_PREFIX_SCHEME_CONFIG,
  PN_KINDS,
  canonicalPartNumber,
  knownPartNumbers,
  parsePrefixSchemeConfig,
  prefixPartNumberScheme,
} from './part-numbers.ts';
export type {
  KnownPartNumber,
  PartNumberScheme,
  PnIssue,
  PnIssueCode,
  PnKind,
  PnSubject,
  PnSuggestion,
  PrefixSchemeConfig,
} from './part-numbers.ts';
export {
  DESIGN_VERSION_FORMAT,
  DESIGN_VERSION_FORMAT_V1,
  artworkBlobName,
  canonicalVersionFile,
  createVersion,
  designsDiffer,
  diffIsEmpty,
  designChangeLines,
  diffLines,
  diffVersions,
  editVersion,
  formatVersionJson,
  freezeDefinitions,
  jointText,
  nextRevision,
  referencedDefinitionIds,
  relockVersion,
  stableJson,
  unlockVersion,
  validateVersion,
  versionArtwork,
  versionDb,
  versionSummary,
} from './versions.ts';
export type {
  ArtworkFiles,
  DesignDiff,
  DesignVersionFile,
  FrozenDefinitions,
  InstanceChange,
  NewVersionInput,
  VersionContent,
  VersionHistoryAction,
  VersionHistoryEntry,
  VersionSummary,
  VersionUnlock,
} from './versions.ts';

// Assembly sides and commoning facts
export {
  assemblySideOf,
  assemblySides,
  commoningFacts,
  unwiredTerminals,
  wireEndsOf,
} from './assembly.ts';
export type { AssemblySide, CommoningFact, WireEnd } from './assembly.ts';
export {
  VIA_SEPARATOR,
  linkDesignators,
  linkElements,
  linkVia,
  ohmsOfText,
  parseLinkElement,
  parseVia,
  valueOfText,
  viaText,
} from './link-elements.ts';

// Breakouts: pass-through vs terminated conductors at a mould
export { BREAKOUT_SCHEMA_VERSION, MAX_SCHEMA_VERSION } from './model.ts';
export type { BreakoutConductor, BreakoutFate, BreakoutInstance } from './model.ts';
export { schemaVersionFor } from './body.ts';
// one schema version on disk; the only reader of older ones
export { READABLE_SCHEMA_VERSIONS, isReadableSchemaVersion, upgradeDesignSchema } from './migrate-schema.ts';
export {
  attachBreakoutLeg,
  breakoutAt,
  breakoutEndOf,
  breakoutEntryPaths,
  breakoutFates,
  breakoutIssues,
  breakoutJoints,
  breakoutsOf,
  breakoutViews,
  inScope,
  passThroughRuns,
  removeBreakout,
  segmentElectricalPaths,
  setBreakoutFate,
  splitSegmentAtBreakout,
  throughPairs,
} from './breakouts.ts';
export type {
  BreakoutElementFate,
  BreakoutLegView,
  BreakoutRow,
  BreakoutView,
  FateOptions,
  LegOptions,
  PassThroughRun,
  SplitOptions,
  ThroughPair,
} from './breakouts.ts';
export { constructionTag, stripMakerSuffix, wireDisplayName } from './wire-display.ts';


// Board authoring helpers: pads on the art, footprint interface, builds
export {
  buildsFileFor,
  buildsFileName,
  canonicalBuildsFile,
  conditioningFromVia,
  conductorLandings,
  exclusiveGroups,
  footprintPadMap,
  partPopulation,
  rankFootprintInterfaces,
  suggestFootprintPads,
  withPartState,
  withSettingState,
} from './board-journey.ts';
export type {
  ConductorLanding,
  ExclusiveGroupState,
  FootprintMap,
  FootprintPadMapOptions,
  FootprintPadRow,
  FootprintPadStatus,
  PartBuildState,
  PartOnBuild,
} from './board-journey.ts';

// Shield bonding: per-screen ground joints → pigtails, grouped by board face
export {
  comparePortPartitions,
  formatBondMigrationReport,
  migrateShieldBonds,
} from './migrate-bonds.ts';
export type {
  BondMigrationEntry,
  BondMigrationReport,
  BondMigrationResult,
} from './migrate-bonds.ts';
export {
  assignShellPads,
  formatFaceRegroupReport,
  nearestPad,
  regroupPigtailsByFace,
} from './ground-faces.ts';
export type { FaceRegroupReport, FaceRegroupResult } from './ground-faces.ts';
