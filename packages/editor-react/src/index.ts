/**
 * @wirehub/editor-react — the authoring GUI, as a component.
 *
 *   import { CableEditor } from '@wirehub/editor-react';
 *   import '@xyflow/react/dist/style.css';
 *   import '@wirehub/editor-react/editor.css';
 *
 *   <CableEditor design={design} db={db} onDesignChange={save} />
 *
 * The host supplies the definition library and a design; the editor hands back
 * accepted designs. It never persists anything and never calls out — handed a
 * `PersistenceAdapter` it *asks the host to*, which is how Save / New /
 * Duplicate / Rename / Delete work without a URL ever appearing in here.
 *
 * The rule this package exists to obey: **the CableDesign is the state.** React
 * Flow draws a projection of it (`derive.ts`) and reports intentions; the store
 * (`store.ts`) turns each intention into a candidate design and commits it only
 * if `validateDesign` finds no errors. Coordinates, selection and zoom live
 * beside the design, never inside it.
 */

export { CableEditor } from './CableEditor.tsx';
export type {
  CableEditorProps,
  CanvasTool,
  EditorChromeState,
  EditorHandle,
  EditorStatus,
  View as EditorView,
} from './CableEditor.tsx';
/* The design lifecycle's state machine — `chrome="host"` hosts drive it
 * through `EditorHandle.openLifecycle`; `DesignActions` (`chrome="full"`)
 * drives it directly. See `panels/useDesignLifecycle.ts`. */
export { useDesignLifecycle } from './panels/useDesignLifecycle.ts';
export { useUnsavedChangesGuard } from './panels/useUnsavedChangesGuard.ts';
export { EditSessionContext, useEditLocked, useEditSession, type EditSession } from './panels/edit-session.ts';
export type {
  DesignLifecycleApi,
  DesignLifecycleProps,
  DialogKind,
  LifecycleAction,
} from './panels/useDesignLifecycle.ts';
export { DesignLifecycleDialogs } from './panels/DesignLifecycleDialogs.tsx';
export type { DesignLifecycleDialogsProps } from './panels/DesignLifecycleDialogs.tsx';

/* Persistence — the host's side of the design lifecycle. */
export {
  blankDesign,
  isDesignId,
  isDirty,
  slugify,
  suggestDesignId,
} from './persistence.ts';
export type { DesignSummary, Outcome, PersistenceAdapter } from './persistence.ts';
export {
  createDesign,
  createWiredDesign,
  deleteDesign,
  duplicateDesign,
  problemOf,
  renameDesign,
  saveDesign,
} from './lifecycle.ts';
export type {
  CatalogChange,
  LifecycleProblem,
  LifecycleResult,
  Refusal,
} from './lifecycle.ts';
export { DesignActions } from './panels/DesignActions.tsx';
export type { DesignActionsProps } from './panels/DesignActions.tsx';

/* The new-cable wizard — the guided flow that produces a wired design. */
export {
  LENGTH_PRESETS,
  roleLabel,
  STEP_SAY,
  STEP_TITLES,
  WIZARD_STEPS,
  connectorTerminals,
  describeLength,
  drainNote,
  initialWizardState,
  maxLengthOf,
  openChoices,
  parseLengthMm,
  pcbaTerminals,
  planCable,
  plugPrefixes,
  readingsOfLabels,
  roleOfLabels,
  roleOfTags,
  stepBlockers,
  wireLines,
  wizardReducer,
} from './wizard.ts';
export type {
  CablePlan,
  EndChoice,
  EndSide,
  EndTerminal,
  GroundClass,
  OpenChoice,
  Role,
  Unconnected,
  WireLine,
  WizardAction,
  WizardState,
  WizardStep,
} from './wizard.ts';
export { NewCableWizard } from './panels/NewCableWizard.tsx';
export type { NewCableWizardProps } from './panels/NewCableWizard.tsx';

/* The parts library — the host's side of definition editing. */
export {
  DEFINITION_BLURBS,
  DEFINITION_KINDS,
  DEFINITION_LABELS,
  DEFINITION_NOUNS,
  checkDefinition,
  createDefinition,
  deleteDefinition as deleteDefinitionRecord,
  isDefinitionId,
  saveDefinition,
  usageNames,
  usageSentence,
} from './definitions.ts';
export type {
  DefinitionChange,
  DefinitionKind,
  DefinitionList,
  DefinitionRecord,
  DefinitionResult,
  DefinitionUsage,
  DefinitionsAdapter,
} from './definitions.ts';
export {
  COMPONENT_KINDS,
  KNOWN_COLORS,
  blankComponentDraft,
  blankConnectorDraft,
  blankCoreDraft,
  blankDraftOf,
  blankPcbaDraft,
  blankWireDraft,
  componentDraftOf,
  componentOf,
  connectorDraftOf,
  connectorOf,
  corePaths,
  countLabel,
  definitionDetail,
  definitionSummary,
  isOldRevision,
  draftFieldIssues,
  draftIssues,
  draftOfRecord,
  duplicateRowIds,
  isNumberField,
  matchesDefinition,
  numberOf,
  pcbaDraftOf,
  pcbaOf,
  pcbaTerminalChoices,
  pinRowsReducer,
  recordOfDraft,
  rowsReducer,
  terminalRowsReducer,
  wireDefinitionOf,
  wireFormIssues,
  wireFormOf,
} from './library.ts';
export type {
  ComponentDraft,
  ConnectorDraft,
  CoreDraft,
  CoreKind,
  DefinitionDraft,
  DefinitionSummary,
  FieldIssue,
  PcbaDraft,
  PinRow,
  RowAction,
  /** the component-terminal row builder's row; `TerminalRow` is derive.ts's */
  TerminalRow as ComponentTerminalRow,
  WireDraft,
} from './library.ts';
export { Library } from './panels/Library.tsx';
export type { LibraryProps } from './panels/Library.tsx';
/* the Library's tables and naming rule */
export { facetOptions, filterRows, isInferred, libraryColumns, libraryRows, loadColumnPrefs, partNumberCell, rowMatches, saveColumnPrefs, shellFits, sortRows, toggleColumn, visibleColumns } from './library-table.ts';
export type { ColumnPrefs, LibraryCell, LibraryColumn, LibraryFlag, LibraryRow, LibrarySort, LibraryTableContext } from './library-table.ts';
export { LibraryTable } from './panels/LibraryTable.tsx';
export { CONNECTOR_NAMING_RULE, CONSTRUCTION_SHORT, connectorNameOf, constructionLabel, variantIdOf, withConstructionInLabel } from './naming.ts';
export { ConnectorEditor } from './panels/ConnectorEditor.tsx';
export { ComponentEditor } from './panels/ComponentEditor.tsx';
export { Cutaway, WireStockEditor } from './panels/WireStockEditor.tsx';
export type { CrossSectionRenderer, CutawayProps } from './panels/WireStockEditor.tsx';
export { PcbaEditor } from './panels/PcbaEditor.tsx';
export { changedTags, tableTagsFor, tagsOfDraft } from './library.ts';
/* Part numbers: scheme checks and Suggest beside every part-number box. */
export { PartNumberField } from './panels/PartNumberField.tsx';
export type { PartNumberFieldProps } from './panels/PartNumberField.tsx';
export { PartNumberContext, partNumberScope, usePartNumbers } from './part-numbers.ts';
export type { LabeledSuggestion, PartNumberData, PartNumberScope, PartNumberTarget, SuggestResult } from './part-numbers.ts';

/* Controlled lists (data model v2 §5) — the pickers and the host's vocab adapter. */
export {
  VocabContext,
  exactOption,
  rankOptions,
  signalRefOf,
  signalText,
  useVocab,
  vocabIdOf,
  vocabOptions,
} from './vocab.ts';
export type { NewVocabEntry, PickOption, RecordTags, SavedTags, VocabAdapter, VocabScope } from './vocab.ts';
export { Pick } from './panels/Pick.tsx';
export type { PickProps } from './panels/Pick.tsx';
export {
  E12,
  E24,
  formatFarads,
  formatOhms,
  isTemplateTerminals,
  standardValues,
  suggestComponentId,
  suggestComponentLabel,
  terminalTemplate,
} from './standard-values.ts';
export { NewPartDialog, WireBuilder } from './panels/WireBuilder.tsx';
export type { WireBuilderProps } from './panels/WireBuilder.tsx';
export { WireSpecPane, WireStockDetail } from './panels/WireStockDetail.tsx';
export type { WireDetailTab, WireStockDetailProps } from './panels/WireStockDetail.tsx';
export {
  addCore,
  applyPartToAll,
  blankRecipe,
  bondingSuggestions,
  duplicateRecipe,
  flipViewedFrom,
  layFor,
  memoryWireLibraryAdapter,
  otherEndReading,
  recipeProblems,
  recolourCore,
  removeCore,
  slotOf,
  stepInRing,
  swapInLay,
  withArrangement,
  addVendorDoc,
  removeVendorDoc,
} from './wire-builder.ts';
export type { LaySlot, VendorDocument, VendorDocumentsAdapter, WireLibraryAdapter } from './wire-builder.ts';

export {
  addInstance,
  addJoint,
  commit,
  describeErrors,
  describeIssue,
  explainIssues,
  explainWarnings,
  editorReducer,
  exportDesignJson,
  initialEditorState,
  jointIndexFor,
  nextInstanceId,
  parseDesignJson,
  redoDescription,
  removeInstance,
  removeJoint,
  removeJoints,
  setCommitHook,
  undoDescription,
  updateInstance,
  updateJointNote,
  HISTORY_LIMIT,
} from './store.ts';
export type {
  CommitHook,
  EditorAction,
  EditorState,
  HistoryEntry,
  InstancePatch,
  ParseResult,
  Selection,
} from './store.ts';

/* The connection model (spec: ui-redesign, Canvas v2 item 6 — e5c.5). */
export {
  connectionEndKey,
  connectionForSelection,
  connectionKey,
  connectionLabel,
  connectionOfJoint,
  connectionOfTerminal,
  connectionsOf,
  connectionsOfInstance,
  endOfTerminal,
  isSegmentInstance,
  orientJoint,
} from './connection.ts';
export type { Connection, ConnectionEnd } from './connection.ts';
export { connectionRows, groupGroundRows } from './panels/connection-rows.ts';
export type {
  BoardPadSide,
  ConnectionRow,
  ConnectionRowOrGroup,
  GroundGroup,
} from './panels/connection-rows.ts';

export {
  NODE_DRAG_HANDLE,
  NODE_METRICS,
  autoLayout,
  deriveEdges,
  deriveFlow,
  deriveNodes,
  handleIdFor,
  jointedKeys,
  segmentFlips,
} from './derive.ts';
/* Breakouts: port columns, stubs, ground bundles and their pigtails, face turns (e5c.3, e5c.11). */
export {
  BREAKOUT_LAYOUT,
  LEAD_FILLET,
  anchorOf,
  edgeRoute,
  inversions,
  pigtailExit,
  planBreakouts,
  routeLeadRun,
  routePath,
  routePolyline,
} from './breakout.ts';
export type {
  Anchor,
  BreakoutPort,
  EdgeRoute,
  EndBreakout,
  Pigtail,
  PortKind,
  WireBreakout,
} from './breakout.ts';
export { BreakoutEdge, edgeTypes } from './edges.tsx';
/* Board artwork on the canvas: faces, rotation, pad handles (e5c.1). */
export {
  BOARD_LAYOUT,
  DEFAULT_TURN,
  ORIENTATION_OVERRIDES,
  PAD_HANDLE_SEPARATOR,
  boardArt,
  boardScale,
  isConnectorTerminal,
  isGerberBoard,
  padsOnSide,
  placedTerminals,
  rotatePoint,
  rotatedSize,
  rotationTransform,
  terminalKeyOfHandle,
  turnToward,
} from './board-art.ts';
export type {
  BoardArt,
  BoardArtInput,
  BoardHandleArt,
  BoardSide,
  BoardViewArt,
  Facing,
  Pad as BoardPad,
  QuarterTurn,
} from './board-art.ts';
/* How big a node draws: the geometry `autoLayout` places and the shell renders. */
export {
  BOARD_HEAD,
  BOX,
  NODE_BASE_WIDTH,
  WIDTH_HEADROOM,
  estimateNodeSize,
  monoWidth,
  nodeHeading,
  nodeRect,
  overlappingPairs,
  rectsOverlap,
  textWidth,
} from './layout-size.ts';
export type { NodeHeading, NodeRect, NodeSize } from './layout-size.ts';
export type {
  ComponentNodeData,
  ConnectorNodeData,
  DeriveOptions,
  EditorEdge,
  EditorEdgeData,
  EditorEdgeKind,
  EditorNode,
  EditorNodeData,
  ElementRow,
  Flow,
  PcbaNodeData,
  SegmentNodeData,
  TerminalRole,
  TerminalRow,
  XY,
} from './derive.ts';

/* Where the *look* of the workbench is kept — the host's side of it. */
export { NO_LAYOUT_STORE, memoryLayoutStore } from './layout-store.ts';
export type { EditorLayoutStore } from './layout-store.ts';
/* Level of detail: Parts cards and bundles, Pins full detail (e5c.7). */
export { CARD_LAYOUT, LOD_ZOOM, cardDataOf, cardSize, partsFlow } from './lod.ts';
export type { BundleEdgeData, CanvasDetail, CardNodeData, PartsFlow } from './lod.ts';
/* Auto-arrange: columns and ELK (e5c.7). */
export { designRanks, facingByColumns } from './ranks.ts';
export type { Ranks } from './ranks.ts';
export { ELK_OPTIONS, elkLayout } from './elk.ts';
export {
  CANVAS_MIN,
  DEFAULT_PANES,
  PANE_KEY_STEP,
  PANE_MIN,
  SPLITTER_SIZE,
  clampPane,
  isPaneSizes,
  paneColumns,
  paneLimit,
  paneSizesOf,
  resetPane,
  resizePane,
} from './splitters.ts';
export type { PaneKey, PaneSizes } from './splitters.ts';
export { Splitter, usePanes } from './panels/Splitter.tsx';
export type { Panes, SplitterProps } from './panels/Splitter.tsx';
export { POSITION_SAVE_DEBOUNCE_MS, useRememberedPositions } from './remember.ts';

export { ComponentNode, ConnectorNode, PcbaNode, WireNode, nodeTypes } from './nodes/index.tsx';
export { PART_MIME, Palette, matchesQuery, paletteEntries } from './panels/Palette.tsx';
export type { PaletteEntry } from './panels/Palette.tsx';
/* The node picker's compatibility rule (e5c.6). */
export {
  anchorSide,
  autoWireTerminal,
  compatibleTerminals,
  defTerminals,
  fitsAnchor,
  rankDefinitions,
  rankTerminals,
} from './picker.ts';
export type { CandidateTerminal, PickerDefinition, RankedTerminal } from './picker.ts';
export { NodePicker } from './panels/NodePicker.tsx';
export type { NodePickerProps } from './panels/NodePicker.tsx';
export { ConnectionPanel, PartPanel } from './panels/Inspector.tsx';
export { IssuesPanel, NetsPanel, TracePanel } from './panels/Derived.tsx';
export { JsonPane } from './panels/JsonPane.tsx';
export { PreviewPane, renderPreview } from './panels/Preview.tsx';
export type { PreviewProps } from './panels/Preview.tsx';
export { SchematicPane } from './panels/Schematic.tsx';
export type { SchematicPaneProps } from './panels/Schematic.tsx';
export { DocumentsPane, printDocumentFrame, DOCUMENT_DEBOUNCE_MS } from './panels/Documents.tsx';
export type { DocumentsProps } from './panels/Documents.tsx';
export {
  DOCUMENT_BLURBS,
  DOCUMENT_KINDS,
  DOCUMENT_LABELS,
  DRAWING_FIELD_LABELS,
  blockerSentence,
  describeConflictValue,
  documentBlockers,
  draftStatus,
  formatLengths,
  isEmptyDesign,
  isStaleWrite,
  mergeDrawingMeta,
  mergeField,
  parseLengths,
  renderDocument,
  sameDesign,
} from './documents.ts';
export type {
  DocumentKind,
  DocumentOptions,
  DocumentResult,
  DraftStatus,
  DrawingAdapter,
  DrawingConflict,
  DrawingFieldConflict,
  DrawingSidecar,
  SaveState,
} from './documents.ts';
export { DrawingForm, dataUriBytes, downscalePhoto, downscaleTarget, drawingDate, PHOTO_MIN_QUALITY, PHOTO_SIZE_LIMIT } from './panels/DrawingForm.tsx';
export type { DrawingFormProps } from './panels/DrawingForm.tsx';
/* Artwork — uploading depictions and anchoring their pins. */
export {
  EMPTY_OVERLAY,
  IDENTITY_VIEW,
  ZOOM_RANGE,
  anchorAt,
  anchorProgress,
  anchorsDiffer,
  armTerminal,
  beginAnchoring,
  clampToFrame,
  clearAnchor,
  derivedAnchors,
  endDrag,
  fitScale,
  isAnchored,
  mirrorCounterpart,
  moveAnchor,
  nextUnanchored,
  overlayIsEmpty,
  overlaySource,
  overlayWith,
  panBy,
  placeArmed,
  placement,
  reflectAnchor,
  roundUnits,
  startDrag,
  toArtwork,
  toStage,
  unanchoredSentence,
  zoomAbout,
} from './artwork.ts';
export type {
  AnchorProgress,
  AnchorWrite,
  EntryGuide,
  AnchoringState,
  ArtworkAdapter,
  ArtworkDefinition,
  ArtworkDetail,
  ArtworkOutcome,
  ArtworkOverlay,
  ArtworkTerminal,
  ArtworkView,
  DepictionMeta,
  Frame,
  PinAnchor,
  Placement,
  Stage,
  UploadFile,
  UploadReport,
  UploadRequest,
  ViewTransform,
  XY as ArtworkXY,
} from './artwork.ts';
export { ArtworkDetailPane, ArtworkPane, artworkSrc, depictableDefinitions } from './panels/Artwork.tsx';
export type { ArtworkProps, DetailProps as ArtworkDetailProps } from './panels/Artwork.tsx';

/* Shared, reusable image assets — pick an existing photo instead of
 * re-uploading it. */
export {
  formatAssetSize,
  matchesAssetQuery,
  orderAssets,
  RECENT_ASSETS_LIMIT,
  withAssetUsed,
} from './assets.ts';
export type { AssetsAdapter, SharedAsset } from './assets.ts';
export { AssetPicker } from './panels/AssetPicker.tsx';

/** the shape a host builds to give the preview artwork; see `depictionSource` */
export type { DepictionArtwork, DepictionSource } from '@wirehub/render-svg';
export { EditorContext, useEditorApi } from './context.ts';
export type { EditorApi } from './context.ts';
/* The same cable on another trunk stock. */
export { canSwapTrunkStock, withTrunkStock } from './stock-swap.ts';
export type { StockSwapResult } from './stock-swap.ts';

/* Library tabs, shells and kits */
export { LIBRARY_KINDS, isLibraryKind } from './definitions.ts';
export type { LibraryKind } from './definitions.ts';
/* The board journey (pci.10): pads on the art, footprint interface, build editor. */
export {
  allTerminals,
  boardBuildsFile,
  boardSiblings,
  cablePads,
  connectorPrefixes,
  journeySteps,
  padLandings,
  padTags,
  uncertainPads,
} from './board-journey.ts';
export type { BoardJourneyHost, BuildsAdapter, BuildsFileView, PadMapEdits, StepId, StepStatus } from './board-journey.ts';
export { BoardJourneyStep, BoardJourneyStrip, starterBuilds, useBoardJourney } from './panels/BoardJourney.tsx';
export { BuildEditor, duplicateBuild } from './panels/BuildEditor.tsx';
export type { BuildEditorProps } from './panels/BuildEditor.tsx';
export { PadMapArt } from './panels/PadMapArt.tsx';
export type { ArtPad, PadMapArtProps, PadTone } from './panels/PadMapArt.tsx';
export { defaultDocumentTarget, targetRevision, withUnreleasedMark } from './release.ts';
export type { DocumentRelease, DocumentTarget, ReleaseShowing } from './release.ts';


/* 3D models of Library parts — the viewer itself is a lazy chunk. */
export { ModelPanel } from './panels/ModelPanel.tsx';
export type { ModelPanelProps } from './panels/ModelPanel.tsx';
export { MODEL_ACCEPT, MODEL_KINDS, MODEL_SOURCE_LABEL, isModelFileName } from './models.ts';
export type { ModelLinkView, ModelsAdapter, ModelSourceKind, ModelUploadStats, StoredModel, ViewPreset } from './models.ts';

export { BoardComponentsSection } from './panels/BoardComponentsSection.tsx';
export type { BoardComponentsSectionProps } from './panels/BoardComponentsSection.tsx';

export { downloadOutput } from './extensions.ts';
export type { EditorExtensions, EditorSlotContext, ExtraDocumentOutput, ExtraExporter } from './extensions.ts';
