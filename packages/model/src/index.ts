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
export { DESIGN_TAG, MAX_DESIGN_TAGS, cleanTags, isDesignTag, retagDesign, withDesignTags } from './design-tags.ts';
export { AMPACITY_SRC, DEFAULT_AMPACITY, DEFAULT_ELECTRICAL_RULES, ampacityOfArea, electricalIssues, designElectricalProblems, electricalReport, electricalRulesProblems } from './electrical.ts';
export type { AmpacityRow, ContactRow, DbRules, DesignElectrical, ElectricalReport, ElectricalRow, ElectricalRules } from './electrical.ts';
export { costIssues, costingRulesProblems, costUnit, isCurrencyCode, unitPriceAt } from './cost.ts';
export type { CostingRules, PartCost, PriceBreak } from './cost.ts';
export { MASS_MAX, MASS_UNIT_GRAMS, PER_LENGTH_METRES, effectivePieceMass, formatGrams, formatMassValue, fromGrams, massIssues, roundMass, toGrams, toGramsPerMetre, wireMassPerMetre } from './mass.ts';
export type { MassBound, MassMissing, MassUnit, MassValue, PerLengthUnit, PieceKind, RecordMass, RecordMassPerLength } from './mass.ts';
export { PARAMETRIC_PARAMS, PARAMETRIC_SHAPES, isParametricAssetId, isParametricShape, parametricAssetId, parametricProblems } from './parametric.ts';
export type { ParametricShape, ParametricSpec } from './parametric.ts';
export { ENCLOSURE_DEFAULTS, ENCLOSURE_EDGES, FACT_BASES, enclosureProblems } from './enclosure.ts';
export { DEVICE_ANCHORS, IDENTITY as DEVICE_IDENTITY, deviceLayoutProblems, deviceParts, deviceScene, enclosureAnchors, nodesOfInstances, openingFrame, polylineLength } from './device.ts';
export type { DeviceAnchor, DeviceEnclosureResult, DeviceFinding, DeviceLayout, DevicePart, DevicePlacement, DevicePortRow, DeviceRoute, DeviceRouteEnd, DeviceScene, DeviceSceneInput, Mat4 as DeviceMat4, SceneNode as DeviceSceneNode, SceneNodeKind as DeviceSceneNodeKind, Vec3 as DeviceVec3 } from './device.ts';
export type { EnclosureBoard, EnclosureEdge, EnclosureFact, EnclosureOccurrence, EnclosureOpening, EnclosureParams, EnclosurePort, EnclosureSpec, FactBasis } from './enclosure.ts';
export { PROVENANCE_METHODS, isSourceUrl, isSpdxLike, recordMetaIssues } from './provenance.ts';
export type { DerivedFrom, ProvenanceMethod, ProvenanceReview, ProvenanceSource, RecordMeta, RecordProvenance, VendorDoc } from './provenance.ts';
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
  stockScreens,
  drainCutAt,
  pigtailLandedScreens,
  massWords,
} from './bonds.ts';
export type { ScreenTermination, StockScreens } from './bonds.ts';
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
export { colourCodeOf, kindOfSignal, laneOfPadRole, laneSourceOf, signalOf } from './signals.ts';
export { hasOwnWords, readConductor, readsAsRail, withoutColourWords } from './conductor-reading.ts';
export type { ConductorBasis, ConductorReading } from './conductor-reading.ts';
export {
  CHASSIS_SIGNAL,
  GROUND_SIGNAL,
  isGroundSignal,
  laneOfSignal,
  readSignalLabels,
  readSignalWords,
  returnOf,
  signalOfLane,
  voltageOfSignal,
} from './signal-words.ts';
export type { TerminalTags } from './signals.ts';
export {
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
export { boardBuildsKey, buildPopulation, carrierRoute, definitionsOfBuild, oneBoardPerFork, validateBoardBuilds } from './builds.ts';
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

// ---- crimp contacts, seals, plugs and tools ----
export {
  TERMINATION_PART_KINDS,
  awgOfMm2,
  cavityIssues,
  cavityPins,
  cavityRows,
  cavityToolId,
  contactTools,
  crimpHeightFor,
  designCavities,
  designTools,
  fillCavities,
  fitsHousing,
  housingOf,
  insulationRangeText,
  isTerminationPart,
  setCavity,
  terminationDbIssues,
  terminationParts,
  wireRangeText,
  wiresAtPin,
  withCavities,
} from './crimp.ts';
export type { CavityAssignment, CavityRow, CavityWire, CrimpHeight, HousingSpec, TerminationPartKind, TerminationSpec, ToolCrimp } from './crimp.ts';
// ---- kits, usage, connector mounting ----
export { KIT_PART_KINDS, KIT_SKU, findKit, kitCoverage, kitPartExists, kitPartLabel, kitsContaining, validateKits } from './kits.ts';
export type { KitCoverage, KitDefinition, KitLine, KitPartKind, PartRef } from './kits.ts';
export { definitionUsage, usageCounts } from './usage.ts';
export type { DefinitionUse, UsageKind } from './usage.ts';
export { connectorMountingOfInstance, connectorMountingUsage, integratedConnectorDuplicates } from './connector-mounting.ts';
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
export { proposeKnownJoints } from './connect-known.ts';
export type { AmbiguousLanding, ConnectPlan, JointProposal, ProposalKind } from './connect-known.ts';
export { duplicatesOf, holdersOfNumber, partNumberHolders, partNumberReport, pnDuplicateIssues, pnRevisionKey } from './part-number-health.ts';
export type { PartNumberReport, PnDisagreement, PnDrawings, PnDuplicate, PnFormatFinding, PnHolder, PnUnnumbered } from './part-number-health.ts';
export {
  DEFAULT_PART_NUMBER_SCHEME,
  DEFAULT_PREFIX_SCHEME_CONFIG,
  PN_KINDS,
  canonicalPartNumber,
  knownPartNumbers,
  parsePrefixSchemeConfig,
  prefixPartNumberScheme,
  schemeFromConfig,
} from './part-numbers.ts';
export {
  MAX_SEGMENTS,
  declarativePartNumberScheme,
  declarativeSchemeProblems,
  isDeclarativeSchemeConfig,
  parseDeclarativeSchemeConfig,
  regexProblem,
} from './pn-declarative.ts';
export type { ChoiceSegment, ChoiceValue, CounterRange, CounterSegment, DeclarativeSchemeConfig, SchemeSegment, VariantSegment } from './pn-declarative.ts';
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
  EFFECTIVE_INPUTS_FORMAT,
  UNCAPTURABLE_CODES,
  versionIntegrityIssues,
  approvalStepProblem,
  approveVersion,
  artworkBlobName,
  canonicalVersionFile,
  createVersion,
  designsDiffer,
  workingDiffers,
  diffIsEmpty,
  designChangeLines,
  designChangeSummary,
  diffLines,
  diffVersions,
  editVersion,
  formatVersionJson,
  freezeDefinitions,
  jointText,
  nextRevision,
  referencedDefinitionIds,
  rejectVersion,
  relockVersion,
  releasedRevision,
  stableJson,
  submitVersion,
  unlockVersion,
  validateVersion,
  devicePinAt,
  versionArtwork,
  versionDb,
  versionSummary,
} from './versions.ts';
export type {
  ApprovalState,
  ArtworkFiles,
  DesignDiff,
  DesignVersionFile,
  DeviceVersionPins,
  PinnedEnclosureRun,
  EffectiveInput,
  EffectiveInputKind,
  EffectiveInputs,
  FrozenDefinitions,
  InstanceChange,
  NewVersionInput,
  VersionContent,
  VersionHistoryAction,
  VersionApproval,
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
export {
  SUBASSEMBLY_ID_SEPARATOR,
  flatTerminal,
  flattenSubassemblies,
  hasSubassemblies,
  parseSubassemblyPortId,
  openPlaced,
  pinSubassemblies,
  placedDesign,
  placedDesignIds,
  portsOfSubassembly,
  releasedRevisions,
  subassembliesOf,
  subassemblyIssues,
  subassemblyParents,
  subassemblyPortId,
  subassemblyPorts,
  withAssemblies,
} from './subassemblies.ts';
export type {
  AssemblyLibrary,
  AssemblyVersion,
  FlatDesign,
  PlacedDesign,
  PlacedResult,
  SubassemblyPort,
  SubassemblyPortKind,
} from './subassemblies.ts';

export {
  DESIGN_RULE_SUBJECTS,
  LIBRARY_RULE_SUBJECTS,
  MAX_RULES,
  RULE_SUBJECTS,
  fillTemplate,
  ruleIssuesForDesign,
  ruleIssuesForLibrary,
  ruleListProblems,
  ruleProblems,
  matchingSubjects,
  selectorProblems,
} from './rules.ts';
export type { Aggregated, Condition, Literal, Operand, Quantified, RuleSelector, RuleSubject, ValidationRule } from './rules.ts';
export {
  MAX_DECLARED_PROCESSES,
  MAX_DERIVE_PER_PROCESS,
  MAX_PROCESSES,
  MAX_PROCESS_MATCHES,
  MAX_PROCESS_NOTE,
  PROCESS_LIMITS,
  captureProcesses,
  declaredProcessIssues,
  declaredProcessProblems,
  processLibraryIssues,
  processListProblems,
  processProblems,
  processesInForce,
  requiredProcesses,
} from './processes.ts';
export type { DeclaredProcess, ProcessDefinition, ProcessDerive, ProcessMatch, ProcessSubject, RequiredProcess } from './processes.ts';

// ---- bench build sheet types and the work-instruction hook ----
export { benchRuleProblems, benchRulesProvider } from './bench-types.ts';
export type { Bench, BenchEnd, BenchPhase, BenchStepRule, BenchStepsProvider, BoardFace, Bridge, EndSide, Landing, LandingElement, LandingTarget, SegmentEnd, ShellSet, Step, StockElement, StripRow, StripTreatment, Termination } from './bench-types.ts';

// ---- the device resolver: devices, conditioning recipes, hazards, ranked options, derived designs, recipes ----
export {
  BUILT_IN_HAZARDS,
  DEFAULT_RESOLVER_POLICY,
  RANK_CRITERIA,
  bindPort,
  deviceLibraryIssues,
  deviceLineage,
  devicePort,
  findDevice,
  hazardsInForce,
  policyInForce,
  resolveDevice,
  worstConfidence,
} from './devices.ts';
export type {
  BoundPin,
  ConditioningRecipe,
  DevicePort,
  DeviceProfile,
  DeviceStatus,
  HazardRule,
  PinBinding,
  PinClass,
  PinDir,
  PinOffer,
  PinPattern,
  PortRequirement,
  PortRole,
  RankCriterion,
  RecipePart,
  RecipeSignal,
  ResolverLibrary,
  ResolverPolicy,
} from './devices.ts';
export { hazardsOf, levelConversions, optionOf, pairPins, pinRelation, recipesFor, resolve, signalsPair } from './resolve.ts';
export type { BoardUse, BoundEnd, CableOption, End, Finding, Link, OptionKind, RequirementUse, Resolution, ResolveQuery } from './resolve.ts';
export { componentForPart, deriveCable, diffPairs, matingBody, matingConnector, plugsInto, stockNeeds, stockShape, suggestStocks } from './derive-cable.ts';
export type { DeriveCableOptions, DerivedCable, StockShape } from './derive-cable.ts';
export { alignIds, derivedBody, isDeviceEnd, describeOverride, inferCableRecipe, recipeDrift, recipeIssues, recipeJointProposals, rederive, renameBody } from './cable-recipe.ts';
export type { CableRecipe, RecipeEnd, RecipeDrift, RecipeInference } from './cable-recipe.ts';

// ---- products, variants, the lineup, and how a part is sourced ----
export {
  PART_ROUTES,
  ROUTE_LABELS,
  findProduct,
  isVariantNumber,
  lineupCsv,
  lineupRows,
  mergeProducts,
  productIssues,
  productPartNumbers,
  productsOfDesign,
  routeIssues,
  sourcingShapeIssues,
  splitProduct,
  suggestVariantNumber,
} from './products.ts';
export type { LineupInputs, LineupRow, PartRoute, PartSupplier, ProductCheckContext, ProductEdit, ProductFamily, ProductOptionAxis, ProductOptionValue, ProductVariant, Sourcing } from './products.ts';

// ---- revisions of library records ----
export {
  REVISION_KINDS,
  findLibraryRecord,
  isRevisionKind,
  recordRevisionProblems,
  revisionFilePath,
  revisionOfRecord,
  revisionsWhereUsed,
  sameRecord,
  saveRecordRevision,
} from './record-revisions.ts';
export type { ExternalRevision, NewRevisionInput, RecordRevision, RecordRevisionFile, RevisionArt, RevisionKind, RevisionUse, RevisionWhereUsed } from './record-revisions.ts';
export { ADOPT_KINDS, adoptImpact, adoptRevision, compareRevisions, impactNeedsLook, impactSummary, isAdoptKind, newerRevisionsInDesign, newestRevision, olderRevisions, placesRecord, revisionFamily } from './revision-adopt.ts';
export type { AdoptImpact, AdoptKind, LostLanding, RevisionSibling, TerminalName } from './revision-adopt.ts';
export { adoptSubassemblyRevision, newerReleasedRevision, newerSubassemblyRevisions, subassemblyAdoptImpact, subassemblyImpactSummary } from './subassembly-adopt.ts';
export type { PortName, SubassemblyAdoptImpact } from './subassembly-adopt.ts';

// ---- board and adapter proposals from resolver gaps ----
export { openProposals, proposalPcba, proposalProblems, proposeBoards } from './proposals.ts';
export type { BoardProposal, ProposalDecision, ProposalState, ProposedNet, ProposedPart } from './proposals.ts';
export * from './names.ts';
export { isSupplyNet, traceConductor } from './board-trace.ts';
export type {
  BoardAnchor,
  BoardTraceView,
  ConductorTrace,
  HopCarrier,
  HopKind,
  TraceFinding,
  TraceFindingKind,
  TraceHop,
  TracedEnd,
} from './board-trace.ts';
export { INTEGRITY_CODES, findingCounts, integrityIssues, isIntegrityIssue, savedWithFindings } from './save-policy.ts';

// ---- solution exploration over the resolver, stocks, plugs, firmware and enclosure presets ----
export { BUILT_IN_PRESETS, availabilityOf, boardFacts, explore, overrideProblems, pickConnect, pickEnclose, presetsInForce, requirementKey, requirementProblems, swapPlugs } from './explore.ts';
export type { BomLine, ChoiceDim, Combo, ComboChoice, ConnectRequirement, EncloseRequirement, EnclosurePreset, Exploration, ExploreContext, ExploreOverride, FirmwareCandidate, FirmwareTargetRef, NativeBoardFacts, OverrideKind, PrinterCandidate, Requirement, UnknownFact, Verdict } from './explore.ts';
