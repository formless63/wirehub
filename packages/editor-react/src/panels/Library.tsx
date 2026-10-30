import { suggestDesignId } from '../persistence.ts';
/**
 * The Library — the parts catalog, browsable and editable.
 *
 * The third top-level view beside Canvas and Documents, and the answer to the
 * founding rule this epic exists to restore: *a non-technical user must be able
 * to enter a new connector, component or wire stock without opening a file*.
 *
 * Everything about how a record is edited lives in the four editors next door.
 * What lives here is the discipline they all share, in one place so it cannot
 * drift apart:
 *
 * - **Candidate → check → save or refuse whole.** The draft is turned into a
 *   candidate record on every keystroke, run past the client's copy of
 *   `validateDb` for an immediate answer, and handed to the host — which
 *   validates the *whole* library including every design, and is the gate.
 *   A refusal leaves the draft exactly as it was, with the reasons in plain
 *   sentences beside it.
 * - **Editing something shared says so first.** A definition is not a document,
 *   it is a fact many documents depend on. Before the first field, the caution
 *   line says how many designs this record is in.
 * - **No raw JSON by default.** There is a toggle, and it is off.
 *
 * With no `DefinitionsAdapter` the whole view degrades to a browsable, readable
 * catalog rather than disappearing: knowing what is in the library is useful
 * even where changing it is not allowed.
 */

import {
  interfacesOnBody,
  kitsContaining,
  validateDb,
  type CableDesign,
  type ConnectorDefinition,
  type Db,
  type KitDefinition,
  type KitPartKind,
  type PcbaDefinition,
  type WireDefinition,
  type SignalTags,
  type Vocab,
  type VocabList,
} from '@wirehub/model';
import type { DepictionArtwork } from '@wirehub/render-svg';
import { IconChevronDown, IconDots, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconPlus } from '@tabler/icons-react';
import { Popover } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react';

import type { AssetsAdapter } from '../assets.ts';
import { CatalogValuesContext, catalogValues } from '../catalog-values.ts';
import { classes } from '../context.ts';
import {
  EMPTY_OVERLAY,
  overlayWith,
  type ArtworkAdapter,
  type ArtworkDetail,
  type ArtworkOverlay,
} from '../artwork.ts';
import {
  DEFINITION_BLURBS,
  DEFINITION_LABELS,
  LIBRARY_KINDS,
  DEFINITION_NOUNS,
  createDefinition,
  deleteDefinition,
  saveDefinition,
  usageNames,
  usageSentence,
  type DefinitionChange,
  type DefinitionKind,
  type DefinitionList,
  type DefinitionRecord,
  type DefinitionResult,
  type DefinitionUsage,
  type DefinitionsAdapter,
  type LibraryKind,
} from '../definitions.ts';
import type { LifecycleProblem } from '../lifecycle.ts';
import {
  KIT_PART_KIND_OF,
  kitWithPart,
  kitWithoutPart,
  blankDraftOf,
  changedTags,
  countLabel,
  draftFieldIssues,
  draftIssues,
  draftOfRecord,
  followNameId,
  recordOfDraft,
  type DefinitionDraft,
} from '../library.ts';
import { factColumns, libraryColumns, libraryRows, type LibraryTableContext } from '../library-table.ts';
import { LibraryTable } from './LibraryTable.tsx';
import { Tab, TabList, Tabs } from '../ui/Tabs.tsx';
import { asFindings, Button, Dialog, Field, FindingsChip, Input, Menu, notify, Section, type Finding } from '../ui/index.ts';
import { PropertiesGrid, RecordHead, SourceBlock, WhereUsed, type DesignFacts, type RecordAction } from './RecordOverview.tsx';
import {
  LIBRARY_PANE_DEFAULT,
  LIBRARY_PANE_SHORTCUT,
  clampListWidth,
  loadLibraryPane,
  saveLibraryPane,
  type LibraryPaneState,
} from '../library-pane.ts';
import { describeIssue, issuesAsFindings } from '../store.ts';
import { PartNumberContext, partNumberScope, type PartNumberData } from '../part-numbers.ts';
import { VocabContext, type RecordTags, type VocabAdapter, type VocabScope } from '../vocab.ts';
import { ArtworkDetailPane } from './Artwork.tsx';
import { ModelPanel } from './ModelPanel.tsx';
import { BuiltInConnectorArt, builtInConnectorArt } from './BuiltInArt.tsx';
import { MODEL_KINDS, type ModelCoverAdapter, type ModelsAdapter } from '../models.ts';
import { BoardComponentsSection } from './BoardComponentsSection.tsx';
import type { BoardJourneyHost } from '../board-journey.ts';
import { BoardJourneyStep, BoardJourneyStrip, BoardSourceRow, JOURNEY_STEPS, isJourneyTab, useBoardJourney } from './BoardJourney.tsx';
import { ComponentEditor } from './ComponentEditor.tsx';
import { ConnectorEditor } from './ConnectorEditor.tsx';
import { ConnectorJourney } from './ConnectorJourney.tsx';
import { KitEditor } from './KitEditor.tsx';
import { MechanicalEditor } from './MechanicalEditor.tsx';
import { Pick } from './Pick.tsx';
import { PcbaEditor } from './PcbaEditor.tsx';
import { Splitter } from './Splitter.tsx';
import { Cutaway, WireStockEditor, type CrossSectionRenderer } from './WireStockEditor.tsx';
import { WireStockDetail, type WireDetailTab } from './WireStockDetail.tsx';
import { blankRecipe, duplicateRecipe, type VendorDocumentsAdapter, type WireLibraryAdapter } from '../wire-builder.ts';
import type { HousingSpec, WireLibrary, WireRecipe } from '@wirehub/model';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard.ts';
import { useEditLocked } from './edit-session.ts';

export interface LibraryProps {
  /** Show the contents of an installed pack across the Library's category tabs. */
  packFilter?: string;
  onPackFilterChange?: (pack: string | undefined) => void;
  /** where a kind's documentation lives: an empty list offers it as "Learn more" */
  emptyHelp?: (kind: LibraryKind) => string | undefined;
  /** the library as the editor has it, and the fallback when there is no adapter */
  db: Db;
  /** how this host stores definitions; without one the Library is read-only */
  definitions?: DefinitionsAdapter;
  /** Read catalog ownership on a view-only host without exposing write operations. */
  readDefinitions?: Pick<DefinitionsAdapter, 'list'>;
  /** a read-only look on purpose (a phone): no "can't change" note and no "New" button */
  viewOnly?: boolean;
  /** the library changed — the host reloads its db and hands a new one down */
  /** the host has not answered with the catalog yet: the table shows skeleton rows, not "nothing here" */
  loading?: boolean;
  onDefinitionsChange?: (change: DefinitionChange) => void;
  /** the cutaway's renderer, injectable for tests */
  renderCutaway?: CrossSectionRenderer;
  /**
   * How this host stores artwork. Given one, a connector's or board's detail
   * grows an Artwork tab beside Definition (`ArtworkDetailPane`, moved in
   * from the editor's own top-level Artwork view). Without
   * one, only Definition shows: exactly today's behaviour.
   */
  artworkAdapter?: ArtworkAdapter;
  /** the shared asset library — "pick existing" beside an artwork upload */
  assets?: AssetsAdapter;
  /**
   * The host's 3D models. Given one, a record's detail
   * opens with a 2D / 3D / Photo view and Attach / Detach for its model.
   */
  models?: ModelsAdapter;
  /** Shared, persisted item cover supplied by the host; physical artwork stays independent. */
  recordPreview?: (record: { kind: LibraryKind; id: string; label: string }) => ReactNode;
  /** The same shared cover, as the 3D view's "Use this view as cover" stores it. */
  modelCover?: ModelCoverAdapter;
  /**
   * A host's compare view, when it has one: given this, a shell's or
   * board's detail gets a Compare action and the list a "Compare…" pick-two
   * mode. Item ids are `<kind>/<id>`.
   */
  onCompare?: (a: string, b?: string) => void;
  /** the kinds that get Compare actions; default: boards and mechanicals (what the compare view first served) */
  compareKinds?: readonly LibraryKind[];
  /**
   * The kind the list shows, when a host puts it in the URL (`/library/$kind`).
   * Uncontrolled (starts at `connectors`) when omitted — `CableEditor`'s own
   * Library tab still manages this itself.
   */
  kind?: LibraryKind;
  /** the host is told when the kind tab changes, so it can update the URL */
  onKindChange?: (kind: LibraryKind) => void;
  /**
   * The record selected, when a host puts it in the URL
   * (`/library/$kind/$id`). Uncontrolled (nothing selected) when omitted.
   */
  selectedId?: string;
  /** the host is told about every selection change — a click, a save, a
   * delete, closing the detail — so it can keep the URL in sync */
  onSelectId?: (id: string | undefined) => void;
  /** a design in the usage chip's popover was picked — opening it is the host's business */
  onOpenDesign?: (id: string) => void;
  /**
   * Open another record, possibly on another tab — a kit from a part's "In
   * kits", a part from a kit. A host that keeps selection in the URL
   * navigates once; without it the Library switches tab and selects itself.
   */
  onOpenRecord?: (kind: LibraryKind, id: string) => void;
  /**
   * How this host appends to the controlled lists and writes the tag side
   * table (data model v2 §5). Without one the pickers still pick from
   * `db.vocab`, but cannot add, and tag edits cannot be saved.
   */
  vocab?: VocabAdapter;
  /** a list grew, or tags were written — the host reloads its db */
  onVocabChange?: () => void;
  /**
   * The wire parts library and stock recipes. Given one, a wire
   * stock's detail is the builder (parts, lay, bonding), its spec sheet, and
   * "New wire stock" builds from parts; without one, the stock form as before.
   */
  wireLibrary?: WireLibraryAdapter;
  /**
   * The host's stored files (the shared asset store), for a wire stock's
   * vendor documents — linked in the builder, opened in-app from it and from
   * the spec sheet.
   */
  vendorDocuments?: VendorDocumentsAdapter;
  /**
   * Extra list actions beside "New …", per kind — the host's own tools for a
   * kind (the studio's "Import board" for boards).
   */
  listActions?: Partial<Record<DefinitionKind, ReactNode>>;
  /**
   * Panels a host adds to a stored record's detail (the studio's module
   * `library-detail` slot): called with the record's kind and id.
   */
  /** `readOnly`: a pack or importer record the viewer cannot change — no revision or note prompts */
  detailExtras?: (record: { kind: LibraryKind; id: string; readOnly?: boolean }) => ReactNode;
  /** a design's PN and saved revision, for Where used */
  designFacts?: (id: string) => DesignFacts | undefined;
  /** host-added module panels, shown after everything the Library itself shows for the record */
  moduleExtras?: (record: { kind: LibraryKind; id: string }) => ReactNode;
  /**
   * A small marker before a row's label — the studio's "someone else is
   * editing this" avatar (edit locks). `null` for none.
   */
  rowMarker?: (kind: LibraryKind, id: string) => ReactNode;
  /**
   * The board journey. Given one, a board's detail is
   * the steps a new PCB takes — Import, Pads, Connector, Builds, Guides —
   * with the build files read and saved through `builds`.
   */
  boardJourney?: BoardJourneyHost;
  /**
   * The owner's part-number scheme and register. Given
   * them, every part-number box gets a Suggest button (with the rule it
   * followed) and scheme warnings; without them, a plain box as before.
   */
  partNumbers?: PartNumberData;
  /**
   * Host tabs after the kind tabs — the studio's Proposals list (declined
   * board proposals). The host owns what they open.
   */
  extraTabs?: readonly { id: string; label: string; title?: string; onSelect: () => void }[];
  /**
   * Every design, for the tables' Used column — the
   * same `definitionUsage` the usage endpoint answers with. Without them the
   * column reads "—".
   */
  designs?: readonly CableDesign[];
  /** definition ids with drawn artwork (the Art flag) */
  art?: ReadonlySet<string>;
  /** definition ids with a photo (the Photo flag) */
  photos?: ReadonlySet<string>;
}

/** `tags` with one record's side-table entry replaced by what the host now holds. */
function withSavedTags(tags: SignalTags | undefined, saved: RecordTags, value: unknown): SignalTags {
  const base: SignalTags = tags ?? { src: '' };
  if (saved.kind === 'connectors') {
    return { ...base, connectors: { ...(base.connectors ?? {}), [saved.id]: value as NonNullable<SignalTags['connectors']>[string] } };
  }
  if (saved.kind === 'pcbas') {
    return { ...base, pcbas: { ...(base.pcbas ?? {}), [saved.id]: value as NonNullable<SignalTags['pcbas']>[string] } };
  }
  return { ...base, wires: { ...(base.wires ?? {}), [saved.id]: value as NonNullable<SignalTags['wires']>[string] } };
}

/** A tag save for a record being added sends only what was picked: a blank leaves the generator's proposal. */
function withoutBlanks(tags: RecordTags): RecordTags | undefined {
  const kept: [string, unknown][] = [];
  for (const [key, value] of Object.entries(tags.tags as Record<string, unknown>)) {
    if (value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value) && !('oneOf' in value)) {
      const picked = Object.entries(value as Record<string, unknown>).filter(([, field]) => field !== null);
      if (picked.length > 0) kept.push([key, Object.fromEntries(picked)]);
      continue;
    }
    kept.push([key, value]);
  }
  return kept.length === 0 ? undefined : ({ ...tags, tags: Object.fromEntries(kept) } as RecordTags);
}

type Mode = { kind: 'browse' } | { kind: 'edit'; id: string } | { kind: 'new' };
type DetailTab = 'definition' | 'artwork' | 'import' | 'pads' | 'connector' | 'builds';

/** Kinds a definition's detail grows an Artwork tab for — a wire stock or a
 * loose component has no picture of its own to anchor pins on. */
/** The housing a connector's body carries (shown read-only on the connector form). */
function bodyHousingOf(db: { bodies?: readonly { id: string; housing?: HousingSpec }[] }, bodyId: string): HousingSpec | undefined {
  return (db.bodies ?? []).find((b) => b.id === bodyId)?.housing;
}

function hasArtworkTab(kind: DefinitionKind): boolean {
  return kind === 'connectors' || kind === 'pcbas';
}

/**
 * The Artwork tab, mounted per selected definition (`key={defId}` at the call
 * site resets it on selection change). `ArtworkDetailPane` already takes just
 * a defId and an adapter (it was written for exactly this move) so
 * this is only the overlay bookkeeping `ArtworkPane` also does: pulling the
 * fresh manifest and bytes back after a write and keeping them around for as
 * long as this tab stays mounted.
 */
function LibraryArtworkTab(props: {
  defId: string;
  adapter: ArtworkAdapter;
  connector?: ConnectorDefinition;
  body?: NonNullable<Db['bodies']>[number];
  sharedBy?: string[];
  assets?: AssetsAdapter;
}): JSX.Element {
  const overlay = useRef<ArtworkOverlay>(EMPTY_OVERLAY);
  const onOverlay = useCallback(
    (id: string, detail: ArtworkDetail, assets: Record<string, DepictionArtwork>): void => {
      overlay.current = overlayWith(overlay.current, id, detail.meta, assets);
    },
    [],
  );
  return (
    <ArtworkDetailPane
      defId={props.defId}
      adapter={props.adapter}
      onOverlay={onOverlay}
      {...(props.connector === undefined ? {} : { connector: props.connector })}
      {...(props.body === undefined ? {} : { body: props.body })}
      {...(props.sharedBy === undefined ? {} : { sharedBy: props.sharedBy })}
      {...(props.assets === undefined ? {} : { assets: props.assets })}
    />
  );
}

/**
 * What the saved record still lacks or contradicts — its own `validateDb`
 * findings (no source yet, no family yet, a lay order that disagrees). Saving
 * keeps them (saving is not approval); this chip says so once, compactly,
 * with the sentences in its tooltip.
 */
function RecordFindings(props: { db: Db; kind: string; id: string | undefined; extra?: readonly Finding[] }): JSX.Element | null {
  const { db, kind, id, extra } = props;
  const findings = useMemo(() => {
    if (id === undefined) return extra ?? [];
    const at = `${kind}/${id}`;
    const own = issuesAsFindings(validateDb(db).filter((i) => i.where === at || (i.where ?? '').startsWith(`${at}/`)));
    // one list: a stock's live builder findings and the stored record's checks often say the same thing
    const seen = new Set(own.map((f) => f.message));
    return [...own, ...(extra ?? []).filter((f) => !seen.has(f.message))];
  }, [db, kind, id, extra]);
  return <FindingsChip findings={findings} testId="record-findings" />;
}

function Problem({ problem }: { problem: LifecycleProblem }): JSX.Element {
  return (
    <div className="cs-problem" role="alert">
      <strong>{problem.message}</strong>
      {problem.hint === undefined ? null : <p className="cs-problem-hint">{problem.hint}</p>}
      {problem.details.length === 0 ? null : (
        <ul className="cs-problem-list">
          {problem.details.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The library as the editor already has it — what the list shows with no host. */
function fromDb(db: Db, kind: DefinitionKind): DefinitionList {
  const records: DefinitionRecord[] =
    kind === 'connectors'
      ? db.connectors
      : kind === 'components'
        ? db.components
        : kind === 'wires'
          ? db.wires
          : kind === 'pcbas'
            ? db.pcbas
            : kind === 'mechanicals'
              ? (db.mechanicals ?? [])
              : kind === 'kits'
                ? (db.kits ?? [])
                : kind === 'bodies'
                  ? (db.bodies ?? [])
                  : (db.interfaces ?? []);
  return { kind, records };
}

/**
 * "In kits" on a part's page (data model v2 §7.1): every kit that ships it,
 * with add (pick a kit) and remove — each a save of the kit record. A part
 * may be in any number of kits.
 */
function InKits(props: {
  db: Db;
  kind: LibraryKind;
  id: string;
  definitions?: DefinitionsAdapter;
  readOnly: boolean;
  onChanged: (change: DefinitionChange) => void;
  onOpenKit?: (id: string) => void;
}): JSX.Element | null {
  const partKind = KIT_PART_KIND_OF[props.kind];
  const [kits, setKits] = useState<KitDefinition[]>(props.db.kits ?? []);
  const [problem, setProblem] = useState<LifecycleProblem | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => setKits(props.db.kits ?? []), [props.db.kits]);
  if (partKind === undefined) return null;
  const part = { kind: partKind, def: props.id };
  const inKits = kitsContaining({ kits }, part);
  const others = kits.filter((kit) => !inKits.includes(kit));
  const write = async (next: KitDefinition): Promise<void> => {
    if (props.definitions === undefined) return;
    setBusy(true);
    setProblem(undefined);
    const result = await saveDefinition(props.definitions, 'kits', next);
    setBusy(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setKits((current) => current.map((kit) => (kit.id === next.id ? next : kit)));
    props.onChanged(result.change);
  };
  const add =
    props.readOnly || others.length === 0 ? undefined : (
      <Pick
        ariaLabel="add to a kit"
        options={others.map((kit) => ({ value: kit.id, label: kit.label, hint: kit.sku }))}
        value=""
        placeholder="+ Add to kit"
        disabled={busy}
        onChange={(id) => {
          const kit = kits.find((k) => k.id === id);
          if (kit !== undefined) void write(kitWithPart(kit, part));
        }}
      />
    );
  return (
    <Section
      id="in-kits"
      title="In kits"
      className="cs-in-kits-section"
      summary={<span title="Kits are informational: a design BOM lists the parts, never the kit">{inKits.length === 0 ? 'none' : inKits.length}</span>}
      {...(add === undefined ? {} : { actions: add })}
    >
      {inKits.length === 0 && problem === undefined ? null : (
        <div className="cs-in-kits">
          {inKits.map((kit) => (
            <span key={kit.id} className="cs-chip cs-kit-chip">
              {props.onOpenKit === undefined ? (
                <span title={kit.label}>{kit.sku}</span>
              ) : (
                <button type="button" className="cs-link" title={kit.label} onClick={() => props.onOpenKit!(kit.id)}>
                  {kit.sku}
                </button>
              )}
              {props.readOnly ? null : (
                <button
                  type="button"
                  className="cs-chip-x"
                  aria-label={`remove from kit ${kit.sku}`}
                  disabled={busy}
                  onClick={() => void write(kitWithoutPart(kit, part))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {problem === undefined ? null : <Problem problem={problem} />}
        </div>
      )}
    </Section>
  );
}

/** The Library tab a kit line's part lives on. */
const TAB_OF_PART: Record<KitPartKind, LibraryKind> = {
  connector: 'connectors',
  pcba: 'pcbas',
  mechanical: 'mechanicals',
  component: 'components',
  wire: 'wires',
};

/** Pinouts no connector carries yet (the device): offered from the Connectors toolbar. */
function orphanPinouts(db: Db): { id: string; label: string; body: string }[] {
  const used = new Set(db.connectors.map((c) => `${c.body ?? ''}|${c.interface ?? ''}`));
  const out: { id: string; label: string; body: string }[] = [];
  for (const pinout of db.interfaces ?? []) {
    for (const body of pinout.bodies) {
      if (!db.connectors.some((c) => c.interface === pinout.id) && !used.has(`${body}|${pinout.id}`)) {
        out.push({ id: pinout.id, label: pinout.label, body });
        break;
      }
    }
  }
  return out;
}

/** Preview the same shared body artwork as the builder, or its built-in face diagram. */
function connectorPreviewProps(db: Db, connector: ConnectorDefinition): { builtIn2d?: JSX.Element; artworkFallbackIds: string[] } {
  const { body } = connectorArtProps(db, connector);
  const art = builtInConnectorArt(connector, body);
  return {
    artworkFallbackIds: [connector.body, body?.drawing].filter((id): id is string => id !== undefined),
    ...(art === undefined ? {} : { builtIn2d: <BuiltInConnectorArt def={connector} art={art} {...(body === undefined ? {} : { body })} /> }),
  };
}

/** The Artwork tab's view of a connector: its body, and every pinout that shares the drawing. */
function connectorArtProps(db: Db, connector: ConnectorDefinition): { connector: ConnectorDefinition; body?: NonNullable<Db['bodies']>[number]; sharedBy?: string[] } {
  const body = (db.bodies ?? []).find((b) => b.id === connector.body);
  if (body === undefined) return { connector };
  return { connector, body, sharedBy: interfacesOnBody(db, body.id).map((p) => p.label) };
}

/** Compare actions where a host gives no `compareKinds`: the two kinds the compare view first served. */
const DEFAULT_COMPARE_KINDS: readonly LibraryKind[] = ['pcbas', 'mechanicals'];

export function Library(props: LibraryProps): JSX.Element {
  const [uncontrolledKind, setUncontrolledKind] = useState<LibraryKind>('connectors');
  /** a new connector's starting pair — a pinout with no connector, or a variant */
  const [journeyStart, setJourneyStart] = useState<{ body?: string; interface?: string; variantOf?: ConnectorDefinition } | undefined>(undefined);
  /** rows shown / total, as the table reports them */
  const [tableCount, setTableCount] = useState<{ shown: number; total: number }>({ shown: 0, total: 0 });
  /** a selection waiting for its tab's list (uncontrolled hosts, "In kits" → kit) */
  const [pendingOpen, setPendingOpen] = useState<string | undefined>(undefined);
  /** bumped when the host's copy of the open record replaces the bundle's — the journey restarts from it */
  const [baselineVersion, setBaselineVersion] = useState(0);
  const kind = props.kind ?? uncontrolledKind;
  const [query, setQuery] = useState('');
  /** legacy / retired board revisions are hidden unless asked for */
  const [showOld, setShowOld] = useState(false);
  // the list's "Compare…" mode: the ids ticked, or `undefined` when off
  const [comparePick, setComparePick] = useState<string[] | undefined>(undefined);
  useEffect(() => setComparePick(undefined), [kind]);
  const [mode, setMode] = useState<Mode>({ kind: 'browse' });
  const [list, setList] = useState<DefinitionList>(() => fromDb(props.db, kind));
  const [draft, setDraft] = useState<DefinitionDraft | undefined>(undefined);
  /** the record as stored — the Revert target and the dirty baseline */
  const [baseline, setBaseline] = useState<DefinitionRecord | undefined>(undefined);
  const [usage, setUsage] = useState<DefinitionUsage | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LifecycleProblem | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [advanced, setAdvanced] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** the Fork to edit dialog: the source id and the id typed for the copy */
  const [forkAsk, setForkAsk] = useState<{ id: string; newId: string; label: string } | undefined>(undefined);
  const [detailTab, setDetailTab] = useState<DetailTab>('definition');
  const editSectionRef = useRef<HTMLElement>(null);
  /** the form is open: Edit was pressed (a new record always has it) */
  const [editing, setEditing] = useState(false);
  /** bumped by Edit: the form's Name field takes the caret once it is drawn */
  const [focusAsk, setFocusAsk] = useState(0);
  const [wireLib, setWireLib] = useState<WireLibrary | undefined>(undefined);
  const [wireNew, setWireNew] = useState<WireRecipe | undefined>(undefined);
  const [wireTab, setWireTab] = useState<WireDetailTab>('builder');
  // the wire builder's live findings, merged into the record head's one findings chip
  const [wireLines, setWireLines] = useState<string[]>([]);
  const wireFindings = useMemo(() => asFindings(wireLines), [wireLines]);

  const { definitions, db, onSelectId, onKindChange } = props;
  /** what the catalog already says, offered as suggestions in every form */
  const values = useMemo(() => catalogValues(db), [db]);
  const partNumbers = props.partNumbers;
  const pnScope = useMemo(() => (partNumbers === undefined ? undefined : partNumberScope(partNumbers, db)), [partNumbers, db]);

  /*
   * The lists and the tag table as the forms see them: the db's, plus what
   * this view has written since the db was handed down (an entry just added,
   * the tags just saved). A fresh db from the host replaces both overlays —
   * it already holds what they held.
   */
  const [listOverlay, setListOverlay] = useState<Record<string, VocabList>>({});
  const [tagOverlay, setTagOverlay] = useState<SignalTags | undefined>(undefined);
  useEffect(() => {
    setListOverlay({});
    setTagOverlay(undefined);
  }, [db]);
  const vocab = useMemo((): Vocab | undefined => {
    if (db.vocab === undefined && Object.keys(listOverlay).length === 0) return undefined;
    const merged: Vocab = { ...(db.vocab ?? {}) };
    for (const [id, list] of Object.entries(listOverlay)) {
      if ((merged[id]?.entries.length ?? 0) <= list.entries.length) merged[id] = list;
    }
    return merged;
  }, [db.vocab, listOverlay]);
  const tags = tagOverlay ?? db.tags;
  const vocabAdapter = props.vocab;
  const onVocabChange = props.onVocabChange;
  const vocabScope = useMemo((): VocabScope => {
    if (vocabAdapter === undefined) return { vocab };
    return {
      vocab,
      add: async (list, entry) => {
        const outcome = await vocabAdapter.append(list, entry);
        if (!outcome.ok) return outcome;
        setListOverlay((current) => ({ ...current, [list]: outcome.value.list }));
        onVocabChange?.();
        return { ok: true, value: outcome.value.entry };
      },
    };
  }, [vocab, vocabAdapter, onVocabChange]);

  /* the list pane: width and fold, remembered per viewer */
  const [pane, setPane] = useState<LibraryPaneState>(() => loadLibraryPane());
  const rootRef = useRef<HTMLDivElement>(null);
  const firstPane = useRef(true);
  useEffect(() => {
    if (firstPane.current) {
      firstPane.current = false;
      return;
    }
    const timer = setTimeout(() => saveLibraryPane(pane), 250);
    return () => clearTimeout(timer);
  }, [pane]);
  const toggleList = useCallback((): void => {
    setPane((current) => ({ ...current, collapsed: !current.collapsed }));
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'b') return;
      event.preventDefault();
      toggleList();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleList]);
  const shortcutHint = LIBRARY_PANE_SHORTCUT.replace('+', ' ');

  const wireAdapter = props.wireLibrary;
  useEffect(() => {
    if (wireAdapter === undefined || kind !== 'wires') return;
    let live = true;
    void wireAdapter.load().then((outcome) => {
      if (live && outcome.ok) setWireLib(outcome.value);
    });
    return () => {
      live = false;
    };
  }, [wireAdapter, kind]);

  const changeKind = (next: LibraryKind): void => {
    if (props.kind === undefined) setUncontrolledKind(next);
    onKindChange?.(next);
  };

  const refresh = useCallback(
    async (which: DefinitionKind): Promise<DefinitionList> => {
      const reader = definitions ?? props.readDefinitions;
      if (reader === undefined) {
        const local = fromDb(db, which);
        setList(local);
        return local;
      }
      const loaded = await reader.list(which);
      if (loaded.ok) {
        setList(loaded.value);
        return loaded.value;
      }
      // the editor already holds a copy of the library; showing it beats a
      // blank panel, and the message says why it may be out of date
      setProblem({ message: loaded.message, ...(loaded.hint === undefined ? {} : { hint: loaded.hint }), details: [] });
      const local = fromDb(db, which);
      setList(local);
      return local;
    },
    [definitions, props.readDefinitions, db],
  );

  useEffect(() => {
    void refresh(kind);
  }, [kind, refresh]);

  /* the table: every record of the kind as a row */
  const modelsAdapter = props.models;
  const [modelSet, setModelSet] = useState<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    if (modelsAdapter === undefined) return;
    let live = true;
    void modelsAdapter.list().then((outcome) => {
      if (live && outcome.ok) setModelSet(new Set(outcome.value.links.map((link) => link.record)));
    });
    return () => {
      live = false;
    };
  }, [modelsAdapter]);
  const tableContext = useMemo(
    (): LibraryTableContext => ({
      db,
      ...(props.designs === undefined ? {} : { designs: props.designs }),
      ...(modelSet === undefined ? {} : { models: modelSet }),
      ...(props.art === undefined ? {} : { art: props.art }),
      ...(props.photos === undefined ? {} : { photos: props.photos }),
      ...(list.kind !== kind || list.packs === undefined ? {} : { packs: list.packs }),
    }),
    [db, props.designs, modelSet, props.art, props.photos, list, kind],
  );
  // the tab can change a paint before the list for it arrives; reading last
  // tab's records as this tab's kind would summarise a connector as a wire
  const rows = useMemo(
    () => (list.kind !== kind ? [] : libraryRows(kind, list.records, list.generated ?? [], tableContext)),
    [list, kind, tableContext],
  );
  const columns = useMemo(() => libraryColumns(kind, list.kind === kind ? list.records : []), [kind, list]);
  const oldRevisions = rows.filter((row) => row.old).length;
  const tableRows = useMemo(() => (showOld ? rows : rows.filter((row) => !row.old)), [rows, showOld]);
  const openRow = rows.find((row) => mode.kind === 'edit' && row.id === mode.id);
  const onTableCount = useCallback((shown: number, total: number) => setTableCount({ shown, total }), []);

  const close = (opts: { keepUrl?: boolean } = {}): void => {
    setWireNew(undefined);
    setMode({ kind: 'browse' });
    setDraft(undefined);
    setBaseline(undefined);
    setUsage(undefined);
    setProblem(undefined);
    setConfirming(false);
    setDetailTab('definition');
    setEditing(false);
    if (opts.keepUrl !== true) onSelectId?.(undefined);
  };

  /** Open a record already in `list` — the click handler and the effect that
   * follows `props.selectedId` both funnel through this. */
  const openRecord = (id: string): void => {
    const record =
      list.records.find((candidate) => candidate.id === id) ??
      (list.generated ?? []).find((candidate) => candidate.id === id);
    if (record === undefined) return;
    setMode({ kind: 'edit', id });
    setDraft(draftOfRecord(kind, record, tags));
    setBaseline(record);
    setProblem(undefined);
    setStatus(undefined);
    setConfirming(false);
    setUsage(undefined);
    setDetailTab('definition');
    setEditing(false);
    if (definitions !== undefined) {
      void definitions.usage(kind, id).then((outcome) => {
        if (outcome.ok) setUsage(outcome.value);
      });
    }
  };

  /** A list click: opens the record and tells the host, so a host that keeps
   * selection in the URL (`/library/$kind/$id`) can follow along. */
  const selectRecord = (id: string): void => {
    openRecord(id);
    onSelectId?.(id);
  };

  // A host-driven selection (a deep link, or the URL changing under this
  // component) opens the record once its kind's list has actually loaded —
  // `list.kind !== kind` means the list for the *previous* tab is still what
  // is in state, and looking a new id up in it would just fail silently.
  useEffect(() => {
    if (props.selectedId === undefined) return;
    if (list.kind !== kind) return;
    if (mode.kind === 'edit' && mode.id === props.selectedId) return;
    openRecord(props.selectedId);
    // `openRecord` closes over `list`/`kind`/`definitions`, all covered by
    // this effect's own deps already; re-including it would re-run on every
    // unrelated render since it is a fresh function each time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId, list, kind]);

  useEffect(() => {
    if (pendingOpen === undefined || list.kind !== kind) return;
    const id = pendingOpen;
    setPendingOpen(undefined);
    selectRecord(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen, list, kind]);

  /** Open a record on any tab — through the host when it routes, else here. */
  const openRecordOf = (target: LibraryKind, id: string): void => {
    if (props.onOpenRecord !== undefined) {
      props.onOpenRecord(target, id);
      return;
    }
    if (target === kind) {
      selectRecord(id);
      return;
    }
    changeKind(target);
    close({ keepUrl: true });
    setPendingOpen(id);
  };

  const openNew = (start?: { body?: string; interface?: string; variantOf?: ConnectorDefinition }): void => {
    setJourneyStart(start);
    setWireNew(kind === 'wires' && wireAdapter !== undefined ? blankRecipe() : undefined);
    setWireTab('builder');
    setMode({ kind: 'new' });
    setDraft(blankDraftOf(kind));
    setBaseline(undefined);
    setUsage(undefined);
    setProblem(undefined);
    setStatus(undefined);
    setConfirming(false);
    setDetailTab('definition');
    // a not-yet-saved record has no id to put in the URL — `run()` follows
    // up with the real one the moment the host accepts the create
    if (props.selectedId !== undefined) onSelectId?.(undefined);
  };

  /** Duplicate: a new record starting as a copy of the open one (id `…-copy`). */
  const openDuplicate = (): void => {
    if (baseline === undefined) return;
    const taken = new Set([...list.records, ...(list.generated ?? [])].map((record) => record.id));
    let id = `${baseline.id}-copy`;
    for (let n = 2; taken.has(id); n += 1) id = `${baseline.id}-copy-${n}`;
    const copy = { ...baseline, id, label: `${baseline.label} (copy)` } as DefinitionRecord;
    setJourneyStart(undefined);
    setMode({ kind: 'new' });
    setDraft(draftOfRecord(kind, copy, tags));
    setBaseline(undefined);
    setUsage(undefined);
    setProblem(undefined);
    setStatus(undefined);
    setConfirming(false);
    setDetailTab('definition');
    onSelectId?.(undefined);
  };

  /** Edit: open the form (a board's Definition view) and put the caret in its Name. */
  const focusEditor = (): void => {
    setEditing(true);
    setDetailTab('definition');
    setFocusAsk((n) => n + 1);
  };
  useEffect(() => {
    if (focusAsk === 0) return;
    const section = rootRef.current?.querySelector<HTMLElement>('.cs-record-edit');
    section?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    const fields = [...(section?.querySelectorAll<HTMLElement>('input:not([disabled]):not([type=checkbox]), textarea:not([disabled])') ?? [])];
    const name = fields.find((field) => /name/i.test(field.getAttribute('aria-label') ?? field.closest('label')?.textContent ?? '')) ?? fields[0];
    name?.focus?.({ preventScroll: true });
  }, [focusAsk]);

  /** the tag table as a save just left it, for the draft rebuilt after it */
  const tagsAfterSave = useRef<SignalTags | undefined>(undefined);

  const run = async (operation: () => Promise<DefinitionResult>): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await operation();
      if (!result.ok) {
        // the form stays exactly as the user left it
        setProblem(result.problem);
        return;
      }
      setStatus(result.status);
      props.onDefinitionsChange?.(result.change);
      const refreshed = await refresh(kind);
      if (result.change.kind === 'definition-deleted') {
        close();
        setStatus(result.status);
        return;
      }
      const saved = result.change.record;
      const tagsNow = tagsAfterSave.current ?? tags;
      tagsAfterSave.current = undefined;
      setBaseline(saved);
      setMode({ kind: 'edit', id: saved.id });
      setDraft(draftOfRecord(kind, saved, tagsNow));
      // a create (no id in the URL yet) just got one — follow it, same as a
      // list click would
      if (props.selectedId !== saved.id) onSelectId?.(saved.id);
      if (definitions !== undefined && refreshed.records.some((r) => r.id === saved.id)) {
        const outcome = await definitions.usage(kind, saved.id);
        if (outcome.ok) setUsage(outcome.value);
      }
    } finally {
      setBusy(false);
    }
  };

  /** someone else holds this record's edit lock: shown, controls disabled */
  const editLocked = useEditLocked();
  /** the installed pack this record came from, when it did: read-only, fork to edit */
  const packOrigin = mode.kind === 'edit' && list.kind === kind ? list.packs?.[mode.id] : undefined;
  const generatedRecord = mode.kind === 'edit' && (list.generated ?? []).some((record) => record.id === mode.id);
  const readOnly = definitions === undefined || generatedRecord || packOrigin !== undefined;
  /**
   * An imported board is read-only, but its pad tags are not the record's:
   * they are corrections in the tag review file, which a re-import
   * keeps — so they stay editable.
   */
  const tagsOnly = generatedRecord && kind === 'pcbas' && definitions !== undefined && vocabAdapter !== undefined;
  /** a record the viewer cannot change: its facts, no form (Fork opens one) */
  const factsOnly = mode.kind === 'edit' && readOnly && !tagsOnly;

  /* the board journey: a board's detail as the steps a new PCB takes */
  const journey = useBoardJourney({
    enabled: kind === 'pcbas' && mode.kind === 'edit' && props.boardJourney !== undefined && props.artworkAdapter !== undefined,
    db,
    def: kind === 'pcbas' && mode.kind === 'edit' ? (baseline as PcbaDefinition | undefined) : undefined,
    host: props.boardJourney,
    ...(props.artworkAdapter === undefined ? {} : { artwork: props.artworkAdapter }),
    ...(vocabAdapter === undefined ? {} : { vocab: vocabAdapter }),
    ...(onVocabChange === undefined ? {} : { onVocabChange }),
    ...(packOrigin === undefined ? {} : { packOwner: packOrigin.pack }),
  });
  // a board opens on its first step still to do (once its art and build file are in)
  const autoStepFor = useRef<string | undefined>(undefined);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    if (journey === undefined || !journey.loaded || autoStepFor.current === journey.def.id) return;
    autoStepFor.current = journey.def.id;
    const first = journey.steps.find((step) => step.state === 'todo' || step.state === 'warn');
    const tab = (JOURNEY_STEPS.find((step) => step.id === first?.id)?.tab ?? 'pads') as DetailTab;
    // Edit pressed while the journey loaded: the form stays
    if (!editingRef.current) setDetailTab((current) => (current === 'definition' ? tab : current));
  }, [journey]);

  // the candidate is rebuilt from the draft on every keystroke, and the whole
  // library is re-validated against it — both memoised, because "every
  // keystroke" is exactly where a full `validateDb` pass would be felt
  const candidate = useMemo(
    () => (draft === undefined ? undefined : recordOfDraft(draft)),
    [draft],
  );
  // the stored record as the form would write it back unchanged: a record the
  // form reorders or normalises (an imported board's empty label, its key
  // order) is not a change, so merely opening it neither arms the unsaved
  // guard nor takes the edit lock
  const pristine = useMemo(() => {
    if (baseline === undefined || draft === undefined) return baseline;
    const unchanged = draftOfRecord(draft.kind, baseline, tags);
    return unchanged === undefined ? baseline : recordOfDraft(unchanged);
  }, [baseline, draft?.kind, tags]);
  const recordDirty =
    candidate !== undefined &&
    (baseline === undefined || JSON.stringify(candidate) !== JSON.stringify(pristine));
  /** the side-table tags this draft would change — pin signals, pad roles */
  const pendingTags = useMemo(
    () => (draft === undefined ? undefined : changedTags(draft, tags)),
    [draft, tags],
  );
  const dirty = recordDirty || (pendingTags !== undefined && vocabAdapter !== undefined);
  useUnsavedChangesGuard(dirty);

  /**
   * Save the record (when it changed), then its side-table tags (when they
   * did) — the record first, because a tag can only name a pin the stored
   * record has. A tag refusal after the record saved says so; the draft keeps
   * the tags, so Save again retries just them.
   */
  const saveAll = async (): Promise<DefinitionResult> => {
    const creating = mode.kind === 'new';
    let result: DefinitionResult;
    if (creating) result = await createDefinition(definitions!, kind, candidate!);
    else if (recordDirty || baseline === undefined) result = await saveDefinition(definitions!, kind, candidate!);
    else result = { ok: true, change: { kind: 'definition-saved', defKind: kind, record: baseline }, status: `Saved ${baseline.label}` };
    if (!result.ok || result.change.kind === 'definition-deleted' || vocabAdapter === undefined || pendingTags === undefined) return result;
    const send = creating ? withoutBlanks(pendingTags) : pendingTags;
    if (send === undefined) return result;
    const record = result.change.record;
    const outcome = await vocabAdapter.saveTags({ ...send, id: record.id } as RecordTags);
    if (!outcome.ok) {
      return {
        ok: false,
        problem: {
          message: `${record.label} was saved, but its tags were not: ${outcome.message}`,
          ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
          details: (outcome.issues ?? []).map((issue) => describeIssue(issue)),
        },
      };
    }
    const next = withSavedTags(tags, { ...send, id: record.id } as RecordTags, outcome.value.tags);
    tagsAfterSave.current = next;
    setTagOverlay(next);
    return { ...result, status: `${result.status} · tags` };
  };
  const fieldIssues = useMemo(
    () => (draft === undefined ? [] : draftFieldIssues(draft)),
    [draft],
  );
  const libraryIssues = useMemo(
    () => (candidate === undefined ? [] : draftIssues(db, kind, candidate)),
    [candidate, db, kind],
  );

  // The tag table can arrive after the record is open (the page paints from
  // the bundle, then the host's fresh db lands) or change under it (a save
  // rebuilt it). A draft nobody has touched follows the table; one with edits
  // in it is left alone.
  // Likewise the record: a deep link opens it from the list in hand (the
  // bundle's copy) before the host's list lands. When the host's copy
  // differs and nothing has been typed, the form switches to it — otherwise
  // a save would be built on the stale one.
  useEffect(() => {
    if (mode.kind !== 'edit' || baseline === undefined || draft === undefined || list.kind !== kind) return;
    const fresh = [...list.records, ...(list.generated ?? [])].find((record) => record.id === mode.id);
    if (fresh === undefined || JSON.stringify(fresh) === JSON.stringify(baseline)) return;
    const pristine = draftOfRecord(kind, baseline, tags);
    if (pristine === undefined || JSON.stringify(pristine) !== JSON.stringify(draft)) return;
    setBaseline(fresh);
    setBaselineVersion((n) => n + 1);
    setDraft(draftOfRecord(kind, fresh, tags));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const draftTags = useRef<SignalTags | undefined>(tags);
  useEffect(() => {
    const before = draftTags.current;
    draftTags.current = tags;
    if (before === tags || draft === undefined || baseline === undefined || mode.kind !== 'edit') return;
    const pristine = draftOfRecord(kind, baseline, before);
    if (pristine !== undefined && JSON.stringify(pristine) === JSON.stringify(draft)) {
      setDraft(draftOfRecord(kind, baseline, tags));
    }
    // only a change of table is a reason to look
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags]);
  const wireRecipe: WireRecipe | undefined =
    kind !== 'wires' || wireAdapter === undefined || wireLib === undefined
      ? undefined
      : mode.kind === 'edit'
        ? wireLib.recipes.find((recipe) => recipe.id === mode.id)
        : mode.kind === 'new'
          ? wireNew
          : undefined;
  const partKinds = new Set<DefinitionKind>(['connectors', 'components', 'wires', 'pcbas', 'mechanicals']);
  const takenIds = [
    ...db.connectors,
    ...db.components,
    ...db.wires,
    ...db.pcbas,
    ...(db.mechanicals ?? []),
  ].map((record) => record.id);
  const submitFork = (): void => {
    const ask = forkAsk;
    if (ask === undefined || ask.newId.trim() === '' || definitions?.fork === undefined) return;
    const fork = definitions.fork.bind(definitions);
    setForkAsk(undefined);
    void run(async () => {
      const outcome = await fork(kind, ask.id, ask.newId.trim(), ask.label.trim());
      if (!outcome.ok) return { ok: false, problem: { message: outcome.message, ...(outcome.hint === undefined ? {} : { hint: outcome.hint }), details: (outcome.issues ?? []).map((issue) => describeIssue(issue)) } };
      return { ok: true, change: { kind: 'definition-created', defKind: kind, record: outcome.value }, status: `Created ${outcome.value.label}` };
    });
  };
  /** a record a Where used row names: its name, PN and revision */
  const recordFacts = (refKind: string, id: string): { label: string; pn?: string; rev?: string } | undefined => {
    const lists: Record<string, readonly { id: string; label: string; partNumber?: string; revision?: string; sku?: string }[]> = {
      connectors: db.connectors,
      components: db.components,
      wires: db.wires,
      pcbas: db.pcbas,
      mechanicals: db.mechanicals ?? [],
      kits: db.kits ?? [],
      bodies: db.bodies ?? [],
      interfaces: db.interfaces ?? [],
    };
    const record = lists[refKind]?.find((r) => r.id === id);
    if (record === undefined) return undefined;
    const pn = record.partNumber ?? record.sku;
    return { label: record.label === '' ? id : record.label, ...(pn === undefined || pn === '' ? {} : { pn }), ...(record.revision === undefined || record.revision === '' ? {} : { rev: record.revision }) };
  };
  /** the record head's actions: Edit, New variant / Duplicate, Compare */
  const recordActions: RecordAction[] = [];
  if (mode.kind === 'edit') {
    if (!factsOnly && !editing) recordActions.push({ id: 'edit', label: 'Edit', disabled: editLocked, onClick: focusEditor });
    if (packOrigin !== undefined && definitions?.fork !== undefined) {
      const id = mode.id;
      recordActions.push({
        id: 'fork',
        label: 'Fork to edit',
        title: `Copy this record under a new id of your own (it remembers it came from ${packOrigin.pack} ${packOrigin.version})`,
        primary: true,
        disabled: busy,
        onClick: () => {
          setForkAsk({ id, newId: suggestDesignId(`${baseline?.label ?? 'Part'} copy`, takenIds), label: `${baseline?.label ?? 'Part'} (copy)` });
        },
      });
    } else if (kind === 'connectors' && baseline !== undefined && definitions !== undefined) {
      const source = baseline as ConnectorDefinition;
      recordActions.push({
        id: 'variant',
        label: 'New variant',
        title: 'Same pinout, a different construction (solder cup, PCB mount …) — a new connector with its own id and part number',
        onClick: () => openNew({ ...(source.body === undefined ? {} : { body: source.body }), ...(source.interface === undefined ? {} : { interface: source.interface }), variantOf: source }),
      });
    } else if ((kind === 'components' || kind === 'mechanicals' || kind === 'kits' || (kind === 'pcbas' && !readOnly)) && definitions !== undefined) {
      recordActions.push({ id: 'duplicate', label: 'Duplicate', title: 'A new record starting as a copy of this one', onClick: openDuplicate });
    }
    if (props.onCompare !== undefined && (props.compareKinds ?? DEFAULT_COMPARE_KINDS).includes(kind)) {
      const id = mode.id;
      recordActions.push({ id: 'compare', label: 'Compare', title: 'Open this part in the compare view', onClick: () => props.onCompare?.(`${kind}/${id}`) });
    }
  }
  const wireDetail =
    wireRecipe === undefined || wireLib === undefined || wireAdapter === undefined ? null : (
      <>
        <RecordHead
          {...(openRow === undefined || mode.kind !== 'edit' ? {} : { row: openRow })}
          title={mode.kind === 'new' ? (wireRecipe.label === '' ? 'New wire stock' : wireRecipe.label) : (baseline?.label ?? wireRecipe.label)}
          noun={DEFINITION_NOUNS[kind]}
          {...(mode.kind === 'edit' ? { id: mode.id } : {})}
          chips={<RecordFindings db={db} kind={kind} id={mode.kind === 'edit' ? mode.id : undefined} extra={wireFindings} />}
          actions={mode.kind !== 'edit' ? [] : recordActions}
        >
          {mode.kind !== 'edit' ? null : props.recordPreview?.({ kind, id: mode.id, label: baseline?.label ?? wireRecipe.label })}
        </RecordHead>
        <section className="cs-record-edit" aria-label="edit">
        <WireStockDetail
          key={mode.kind === 'edit' ? mode.id : `new:${wireRecipe.id}`}
          adapter={wireAdapter}
          recipe={wireRecipe}
          create={mode.kind === 'new'}
          readOnly={definitions === undefined || editLocked}
          takenIds={takenIds}
          tab={wireTab}
          onTab={setWireTab}
          library={wireLib}
          onLibrary={setWireLib}
          onFindings={setWireLines}
          properties={mode.kind === 'edit' && openRow !== undefined ? <PropertiesGrid row={openRow} columns={factColumns(columns, openRow)} {...(usage === undefined ? {} : { used: usage.count })} quiet={readOnly} /> : null}
          {...(props.vendorDocuments === undefined ? {} : { documents: props.vendorDocuments })}
          {...(props.modelCover === undefined ? {} : { cover: props.modelCover })}
          onClose={() => close()}
          onDuplicate={(recipe) => {
            const ids = new Set(takenIds);
            let id = `${recipe.id}-copy`;
            for (let n = 2; ids.has(id); n += 1) id = `${recipe.id}-copy-${n}`;
            setWireNew(duplicateRecipe(recipe, id, `${recipe.label} (copy)`));
            setWireTab('builder');
            setUsage(undefined);
            setMode({ kind: 'new' });
            onSelectId?.(undefined);
          }}
          onSaved={(recipe, wire, create) => {
            setWireLib((current) =>
              current === undefined
                ? current
                : {
                    ...current,
                    recipes: current.recipes.some((r) => r.id === recipe.id)
                      ? current.recipes.map((r) => (r.id === recipe.id ? recipe : r))
                      : [...current.recipes, recipe],
                  },
            );
            props.onDefinitionsChange?.({
              kind: create ? 'definition-created' : 'definition-saved',
              defKind: 'wires',
              record: wire,
            });
            setStatus(create ? `Added ${wire.label}.` : `Saved ${wire.label}.`);
            void refresh('wires');
            setWireNew(undefined);
            setBaseline(wire);
            setMode({ kind: 'edit', id: wire.id });
            if (props.selectedId !== wire.id) onSelectId?.(wire.id);
          }}
        />
        </section>
        {mode.kind === 'edit' && openRow !== undefined ? (
          <WhereUsed usage={usage} {...(props.onOpenDesign === undefined ? {} : { onOpenDesign: props.onOpenDesign })} onOpenRecord={openRecordOf} recordFacts={recordFacts} {...(props.designFacts === undefined ? {} : { designFacts: props.designFacts })} />
        ) : null}
        {mode.kind === 'edit' && baseline !== undefined ? <SourceBlock src={baseline.src} /> : null}
      </>
    );

  /* the list's actions besides New: in the toolbar while browsing, behind "⋯" beside a record */
  const moreActions = (
    <>
          {props.listActions?.[kind] ?? null}
          {props.onCompare !== undefined && (props.compareKinds ?? DEFAULT_COMPARE_KINDS).includes(kind) ? (
            comparePick === undefined ? (
              <button type="button" className="cs-small" title="Tick two parts to put them side by side" onClick={() => setComparePick([])}>
                Compare
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="cs-small cs-primary"
                  disabled={comparePick.length !== 2}
                  title={comparePick.length === 2 ? 'Open the two ticked parts in the compare view' : 'Tick two parts in the list'}
                  onClick={() => {
                    props.onCompare?.(`${kind}/${comparePick[0]!}`, `${kind}/${comparePick[1]!}`);
                    setComparePick(undefined);
                  }}
                >
                  Compare {comparePick.length}/2
                </button>
                <button type="button" className="cs-small" onClick={() => setComparePick(undefined)}>
                  Cancel
                </button>
              </>
            )
          ) : null}
          {oldRevisions > 0 ? (
            <button
              type="button"
              className="cs-small"
              aria-pressed={showOld}
              title={showOld ? 'Hide the legacy and retired revisions' : 'Show the legacy and retired revisions (kept for reference)'}
              onClick={() => setShowOld((v) => !v)}
            >
              Legacy {oldRevisions}
            </button>
          ) : null}
          {kind === 'connectors' && definitions !== undefined && orphanPinouts(db).length > 0 ? (
            <Popover.Root>
              <Popover.Trigger asChild>
                <button type="button" className="cs-small" title="Pinouts no connector carries yet — make one">
                  Unused pinouts {orphanPinouts(db).length}
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="cs-popover" sideOffset={6} align="start">
                  <ul className="cs-usage-list">
                    {orphanPinouts(db).map((pinout) => (
                      <li key={pinout.id}>
                        <button type="button" className="cs-link" onClick={() => openNew({ body: pinout.body, interface: pinout.id })}>
                          + connector: {pinout.label}
                        </button>
                        <span className="cs-def-id">{pinout.body}</span>
                      </li>
                    ))}
                  </ul>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ) : null}
    </>
  );
  /* search and the list's actions: the table's toolbar while browsing */
  const listTools = (
    <>
        <input
          className="cs-input"
          type="search"
          value={query}
          aria-label={`search ${DEFINITION_LABELS[kind]}`}
          placeholder={`Search ${DEFINITION_LABELS[kind].toLowerCase()}…`}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="cs-library-actions">
          {props.viewOnly === true ? null : (
          <button
            type="button"
            className="cs-primary"
            disabled={definitions === undefined || busy}
            title={
              definitions === undefined
                ? 'This hub cannot change the parts library'
                : `Add a ${DEFINITION_NOUNS[kind]}`
            }
            onClick={() => openNew()}
          >
            + New {DEFINITION_NOUNS[kind]}
          </button>
          )}
          {moreActions}
          <span className="cs-count">
            {tableCount.shown === tableCount.total ? countLabel(kind, tableCount.total) : `${tableCount.shown} of ${tableCount.total}`}
          </span>
          <button
            type="button"
            className="cs-icon-btn cs-library-fold"
            aria-label="Hide the list"
            title={`Hide the list — ${shortcutHint}`}
            onClick={toggleList}
          >
            <IconLayoutSidebarLeftCollapse size={16} stroke={1.75} />
          </button>
        </div>
    </>
  );
  /* beside a record the pane is narrow: search, New, "⋯" and the fold on one row */
  const compactTools = (
    <div className="cs-library-compact-bar">
        <input
          className="cs-input"
          type="search"
          value={query}
          aria-label={`search ${DEFINITION_LABELS[kind]}`}
          placeholder={`Search ${DEFINITION_LABELS[kind].toLowerCase()}…`}
          onChange={(event) => setQuery(event.target.value)}
        />
      {props.viewOnly === true ? null : (
        <button
          type="button"
          className="cs-icon-btn"
          aria-label={`New ${DEFINITION_NOUNS[kind]}`}
          title={`New ${DEFINITION_NOUNS[kind]}`}
          disabled={definitions === undefined || busy}
          onClick={() => openNew()}
        >
          <IconPlus size={16} stroke={1.75} />
        </button>
      )}
      <Popover.Root>
        <Popover.Trigger asChild>
          <button type="button" className="cs-icon-btn" aria-label="More list actions" title="Import, compare …">
            <IconDots size={16} stroke={1.75} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="cs-popover cs-library-more" sideOffset={6} align="start">
            {moreActions}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
          <button
            type="button"
            className="cs-icon-btn cs-library-fold"
            aria-label="Hide the list"
            title={`Hide the list — ${shortcutHint}`}
            onClick={toggleList}
          >
            <IconLayoutSidebarLeftCollapse size={16} stroke={1.75} />
          </button>
    </div>
  );

  return (
    // portrait phone widths: the list and the detail
    // pane cannot sit side by side at ~360-430px — `has-detail` (a record is
    // open) is what `editor.css`'s mobile rule reads to show one at a time.
    // Desktop's `320px 1fr` grid is unaffected either way.
    <div
      ref={rootRef}
      className={classes('cs-library', mode.kind !== 'browse' && 'has-detail', mode.kind === 'browse' && 'is-browsing', pane.collapsed && mode.kind !== 'browse' && 'is-list-collapsed')}
      style={{ '--cs-library-list': `${pane.width}px` } as CSSProperties}
    >
      {pane.collapsed ? (
        <div className="cs-library-rail">
          <button
            type="button"
            className="cs-icon-btn"
            aria-label="Show the list"
            title={`Show the list — ${shortcutHint}`}
            onClick={toggleList}
          >
            <IconLayoutSidebarLeftExpand size={16} stroke={1.75} />
          </button>
          <span className="cs-library-rail-kind">{DEFINITION_LABELS[kind]}</span>
        </div>
      ) : null}
      <div className="cs-library-list" hidden={pane.collapsed || undefined}>
        {mode.kind !== 'browse' ? (
          <Menu
            aria-label="parts library"
            align="start"
            trigger={
              <button type="button" className="cs-ui-tab cs-library-kind-menu" title="Switch the list">
                {DEFINITION_LABELS[kind]} <IconChevronDown size={12} stroke={1.75} aria-hidden="true" />
              </button>
            }
            items={[
              ...LIBRARY_KINDS.map((entry) => ({
                label: DEFINITION_LABELS[entry],
                onSelect: () => {
                  changeKind(entry);
                  close({ keepUrl: true });
                },
              })),
              ...(props.extraTabs ?? []).map((tab) => ({ label: tab.label, onSelect: tab.onSelect })),
            ]}
          />
        ) : (
        <Tabs
          value={kind}
          onValueChange={(next) => {
            changeKind(next as LibraryKind);
            // the kind switch is itself a "go to /library/$kind" — no
            // second, stale "and clear the id" navigation behind it
            close({ keepUrl: true });
          }}
        >
          <TabList aria-label="parts library" className="cs-library-tabs">
            {LIBRARY_KINDS.map((entry) => (
              <Tab key={entry} value={entry} title={DEFINITION_BLURBS[entry]} aria-controls={undefined}>
                {DEFINITION_LABELS[entry]}
              </Tab>
            ))}
            {(props.extraTabs ?? []).map((tab) => (
              // a tab of its own page (Vocabulary): still a tab, so the tab list holds only tabs
              <button key={tab.id} type="button" role="tab" aria-selected={false} className="cs-ui-tab" {...(tab.title === undefined ? {} : { title: tab.title })} onClick={tab.onSelect}>
                {tab.label}
              </button>
            ))}
          </TabList>
        </Tabs>
        )}
        {mode.kind === 'browse' ? null : compactTools}
        {mode.kind === 'browse' && props.viewOnly !== true && (definitions === undefined || status !== undefined || problem !== undefined) ? (
          <div className="cs-library-note">
            {definitions === undefined ? (
              <p className="cs-doc-note" title="Definition editing needs a host that stores the catalog files — WireHub’s own server does.">
                This hub can show the library but not change it.
              </p>
            ) : null}
            {status === undefined ? null : <p className="cs-doc-note">{status}</p>}
            {problem === undefined ? null : <Problem problem={problem} />}
          </div>
        ) : null}
          <LibraryTable
            kind={kind}
            loading={list.kind !== kind || props.loading === true}
            rows={list.kind !== kind ? [] : tableRows}
            columns={columns}
            query={query}
            {...(props.packFilter === undefined ? {} : { packFilter: props.packFilter })}
            {...(props.onPackFilterChange === undefined ? {} : { onPackFilterChange: props.onPackFilterChange })}
            compact={mode.kind !== 'browse'}
            {...(mode.kind === 'edit' ? { selectedId: mode.id } : {})}
            onSelect={selectRecord}
            {...(props.rowMarker === undefined ? {} : { rowMarker: (id: string) => props.rowMarker!(kind, id) })}
            {...(comparePick === undefined
              ? {}
              : {
                  pick: {
                    ids: comparePick,
                    toggle: (id: string) =>
                      setComparePick((current) =>
                        current === undefined ? current : current.includes(id) ? current.filter((x) => x !== id) : [...current.slice(-1), id],
                      ),
                  },
                })}
            empty={
              props.packFilter !== undefined
                ? `No ${DEFINITION_LABELS[kind].toLowerCase()} from ${props.packFilter} match this view. Try another category or choose All sources.`
                : rows.length === 0 ? (
                <span className="cs-lt-empty-line">
                  No {DEFINITION_LABELS[kind].toLowerCase()} yet.{' '}
                  <button type="button" className="cs-primary" disabled={definitions === undefined || busy} onClick={() => openNew()}>
                    + New {DEFINITION_NOUNS[kind]}
                  </button>
                  {props.emptyHelp?.(kind) === undefined ? null : (
                    <>
                      {' '}
                      <a href={props.emptyHelp?.(kind)} target="_blank" rel="noreferrer">
                        Learn more
                      </a>
                    </>
                  )}
                </span>
              ) : `Nothing here matches “${query}”. Clear the search or the filters to see all ${countLabel(kind, rows.length)}.`
            }
            onCount={onTableCount}
            {...(mode.kind === 'browse' ? { lead: listTools } : {})}
          />
      </div>
      {pane.collapsed ? (
        <span className="cs-library-split" aria-hidden="true" />
      ) : (
        <div className="cs-library-split">
          <Splitter
            axis="x"
            sign={1}
            size={pane.width}
            label="Drag to resize the list"
            onResize={(width) =>
              setPane((current) => ({
                ...current,
                width: clampListWidth(width, rootRef.current?.clientWidth),
              }))
            }
            onReset={() => setPane((current) => ({ ...current, width: LIBRARY_PANE_DEFAULT.width }))}
          />
        </div>
      )}

      <div className="cs-library-editor cs-scroll">
        <VocabContext.Provider value={vocabScope}>{wireDetail}</VocabContext.Provider>

        {wireDetail === null && mode.kind !== 'browse' && draft === undefined ? (
          <div className="cs-panel">
            <h2>{mode.kind === 'edit' ? baseline?.label ?? mode.id : `New ${DEFINITION_NOUNS[kind]}`}</h2>
            <p className="cs-doc-warning">
              <strong>The structured form cannot edit this stock.</strong> Its nested groups are
              preserved in the original definition. The cross-section and JSON below are read-only;
              nothing has been changed or flattened.
            </p>
            {mode.kind !== 'edit' ? null : props.recordPreview?.({ kind, id: mode.id, label: baseline?.label ?? mode.id })}
            {kind === 'wires' && mode.kind === 'edit' && baseline !== undefined ? <Cutaway wire={baseline as WireDefinition} {...(props.renderCutaway === undefined ? {} : { render: props.renderCutaway })} /> : null}
            <details className="cs-advanced" open>
              <summary>Advanced: the record as JSON</summary>
              <pre className="cs-json-view">
                {JSON.stringify(
                  list.records.find((record) => mode.kind === 'edit' && record.id === mode.id),
                  null,
                  2,
                )}
              </pre>
            </details>
            <button type="button" onClick={() => close()}>
              Back to the list
            </button>
          </div>
        ) : null}

        {draft === undefined || wireDetail !== null ? null : (
          <>
            <RecordHead
              {...(openRow === undefined || mode.kind !== 'edit' ? {} : { row: packOrigin === undefined ? openRow : { ...openRow, flags: openRow.flags.filter((flag) => flag !== 'Pack') } })}
              title={
                mode.kind === 'new'
                  ? journeyStart?.variantOf !== undefined && kind === 'connectors'
                    ? `New variant of ${journeyStart.variantOf.label}`
                    : `New ${DEFINITION_NOUNS[kind]}`
                  : (baseline?.label ?? (mode.kind === 'edit' ? mode.id : ''))
              }
              noun={DEFINITION_NOUNS[kind]}
              {...(mode.kind === 'edit' ? { id: mode.id } : {})}
              chips={
                <>
                  {packOrigin !== undefined ? (
                    <span
                      className="cs-chip"
                      title={`From the ${packOrigin.pack} pack ${packOrigin.version}: a pack update replaces it. Fork it to edit a copy of your own.`}
                    >
                      {packOrigin.pack} · read-only
                    </span>
                  ) : generatedRecord && definitions !== undefined ? (
                    <span
                      className="cs-chip"
                      title={
                        tagsOnly
                          ? 'This board comes from the importer: the record is rewritten by every import run, so it is read-only here. Pad roles and signals stay editable — they are kept as tag corrections the import keeps.'
                          : "This board comes from the importer — rewritten by `pnpm import-pcbas` from the production netlist every time that runs, so an edit here would not survive. Curate it by adding a hand-checked record with its own id."
                      }
                    >
                      {tagsOnly ? 'From the importer — tags editable' : 'From the importer — read-only'}
                    </span>
                  ) : null}
                  <RecordFindings db={db} kind={kind} id={mode.kind === 'edit' ? mode.id : undefined} />
                </>
              }
              actions={mode.kind !== 'edit' ? [] : recordActions}
            >
              {journey === undefined ? null : (
                <BoardJourneyStrip
                  journey={journey}
                  tab={detailTab}
                  onTab={(tab) => {
                    // a step the person picked is not moved again by the auto step
                    autoStepFor.current = journey.def.id;
                    if (tab === 'definition') setEditing(true);
                    setDetailTab(tab as DetailTab);
                  }}
                />
              )}
              {journey === undefined && mode.kind === 'edit' && hasArtworkTab(kind) && props.artworkAdapter !== undefined ? (
                <nav className="cs-tabs cs-def-tabs" aria-label="definition detail">
                  <button
                    type="button"
                    className={classes(detailTab === 'definition' && 'is-active')}
                    aria-pressed={detailTab === 'definition'}
                    onClick={() => setDetailTab('definition')}
                  >
                    Definition
                  </button>
                  <button
                    type="button"
                    className={classes(detailTab === 'artwork' && 'is-active')}
                    aria-pressed={detailTab === 'artwork'}
                    title="The picture this part draws as in the schematic, and its pin anchors"
                    onClick={() => setDetailTab('artwork')}
                  >
                    Artwork
                  </button>
                </nav>
              ) : null}
              {mode.kind !== 'edit' ? null : props.recordPreview?.({ kind, id: mode.id, label: baseline?.label ?? mode.id })}
            </RecordHead>

            {/* the record's facts first, then its views and the host's sections */}
            {mode.kind === 'edit' && openRow !== undefined ? <PropertiesGrid row={openRow} columns={factColumns(columns, openRow)} {...(usage === undefined ? {} : { used: usage.count })} quiet={readOnly} /> : null}
            {mode.kind === 'edit' && journey !== undefined ? (
              <BoardSourceRow
                journey={journey}
                onCheck={() => {
                  autoStepFor.current = journey.def.id;
                  setDetailTab('import');
                  // the check sits in the Import step, below the record's sections
                  requestAnimationFrame(() => editSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
                }}
              />
            ) : null}

            {mode.kind === 'edit' && props.models !== undefined && MODEL_KINDS.has(kind) ? (
              <ModelPanel
                key={`${kind}/${mode.id}`}
                kind={kind}
                id={mode.id}
                label={baseline?.label ?? 'Library item'}
                models={props.models}
                {...(props.artworkAdapter === undefined || !hasArtworkTab(kind) ? {} : { artwork: props.artworkAdapter })}
                {...(kind === 'connectors' && baseline !== undefined ? connectorPreviewProps(db, baseline as ConnectorDefinition) : {})}
                readOnly={definitions === undefined}
                {...(props.modelCover === undefined ? {} : { cover: props.modelCover })}
              />
            ) : null}
            {/* the record's own sections (parts, kits, use, reference), then the host's stack */}
            {mode.kind === 'edit' && kind === 'pcbas' && baseline !== undefined ? (
              <BoardComponentsSection
                key={`bc:${mode.id}`}
                db={db}
                board={(baseline as PcbaDefinition).partNumber}
                revision={(baseline as PcbaDefinition).revision}
                defId={mode.id}
                onOpenComponent={(id) => openRecordOf('components', id)}
              />
            ) : null}

            {mode.kind === 'edit' && KIT_PART_KIND_OF[kind] !== undefined && (db.kits ?? []).length > 0 ? (
              <InKits
                db={db}
                kind={kind}
                id={mode.id}
                readOnly={definitions === undefined || editLocked}
                {...(definitions === undefined ? {} : { definitions })}
                onChanged={(change) => props.onDefinitionsChange?.(change)}
                onOpenKit={(id) => openRecordOf('kits', id)}
              />
            ) : null}
            {mode.kind === 'edit' && openRow !== undefined ? (
              <WhereUsed
                usage={usage}
                {...(props.onOpenDesign === undefined ? {} : { onOpenDesign: props.onOpenDesign })}
                onOpenRecord={openRecordOf}
                recordFacts={recordFacts}
                {...(props.designFacts === undefined ? {} : { designFacts: props.designFacts })}
              />
            ) : null}
            {mode.kind === 'edit' && baseline !== undefined ? <SourceBlock src={baseline.src} /> : null}
            {mode.kind === 'edit' && props.detailExtras !== undefined ? (
              <div className="cs-extension-slot" data-slot="library-detail">
                {props.detailExtras({ kind, id: mode.id, readOnly: factsOnly })}
              </div>
            ) : null}

            <section className="cs-record-edit" aria-label="edit" ref={editSectionRef}>
            {journey !== undefined && isJourneyTab(detailTab) ? (
              <VocabContext.Provider value={vocabScope}>
                <fieldset className="cs-lock-fence" disabled={editLocked}>
                  <BoardJourneyStep journey={journey} tab={detailTab} />
                </fieldset>
              </VocabContext.Provider>
            ) : mode.kind === 'edit' &&
            detailTab === 'artwork' &&
            hasArtworkTab(kind) &&
            props.artworkAdapter !== undefined ? (
              <fieldset className="cs-lock-fence" disabled={editLocked}>
              <LibraryArtworkTab
                key={mode.id}
                defId={mode.id}
                adapter={props.artworkAdapter}
                {...(kind === 'connectors' && baseline !== undefined
                  ? connectorArtProps(db, baseline as ConnectorDefinition)
                  : {})}
                {...(props.assets === undefined ? {} : { assets: props.assets })}
              />
              </fieldset>
            ) : factsOnly || (mode.kind === 'edit' && !editing && !dirty && !(kind === 'connectors' && (baseline as ConnectorDefinition | undefined)?.body !== undefined)) ? null : kind === 'connectors' && ((mode.kind === 'edit' && (baseline as ConnectorDefinition | undefined)?.body !== undefined) || mode.kind === 'new') ? (
              <VocabContext.Provider value={vocabScope}>
                <ConnectorJourney
                  key={mode.kind === 'edit' ? `${mode.id}:${baselineVersion}` : `new:${journeyStart?.body ?? ''}:${journeyStart?.interface ?? ''}:${journeyStart?.variantOf?.id ?? ''}`}
                  db={db}
                  {...(definitions === undefined ? {} : { definitions })}
                  {...(mode.kind === 'edit' && baseline !== undefined ? { connector: baseline as ConnectorDefinition } : {})}
                  {...(mode.kind === 'new' && journeyStart !== undefined ? { start: journeyStart } : {})}
                  readOnly={definitions === undefined || editLocked}
                  takenIds={takenIds}
                  onSaved={(record, created, changes) => {
                    for (const change of changes) props.onDefinitionsChange?.(change);
                    setStatus(created ? `Added ${record.label}.` : `Saved ${record.label}.`);
                    setBaseline(record);
                    setDraft(draftOfRecord('connectors', record, tags));
                    setMode({ kind: 'edit', id: record.id });
                    if (props.selectedId !== record.id) onSelectId?.(record.id);
                    void refresh('connectors');
                    if (definitions !== undefined) {
                      void definitions.usage('connectors', record.id).then((outcome) => {
                        if (outcome.ok) setUsage(outcome.value);
                      });
                    }
                  }}
                  onClose={() => close()}
                  onDelete={() => setConfirming(true)}
                  onOpenConnector={(id) => selectRecord(id)}
                />
              </VocabContext.Provider>
            ) : (
            <form
              className={classes('cs-def-form', readOnly && 'is-readonly')}
              onSubmit={(event) => event.preventDefault()}
            >
              <fieldset disabled={(readOnly && !tagsOnly) || busy || editLocked}>
                <VocabContext.Provider value={vocabScope}>
                <CatalogValuesContext.Provider value={values}>
                <PartNumberContext.Provider value={pnScope}>
                {draft.kind === 'connectors' ? (
                  <ConnectorEditor
                    draft={draft.value}
                    idLocked={mode.kind === 'edit'}
                    {...(bodyHousingOf(props.db, draft.value.body) === undefined ? {} : { bodyHousing: bodyHousingOf(props.db, draft.value.body) as HousingSpec })}
                    onChange={(value) => setDraft((d) => ({ kind: 'connectors', value: mode.kind === 'new' && d?.kind === 'connectors' ? followNameId(d.value, value, takenIds) : value }))}
                  />
                ) : null}
                {draft.kind === 'components' ? (
                  <ComponentEditor
                    draft={draft.value}
                    idLocked={mode.kind === 'edit'}
                    onChange={(value) => setDraft((d) => ({ kind: 'components', value: mode.kind === 'new' && d?.kind === 'components' ? followNameId(d.value, value, takenIds) : value }))}
                  />
                ) : null}
                {draft.kind === 'wires' ? (
                  <WireStockEditor
                    draft={draft.value}
                    idLocked={mode.kind === 'edit'}
                    onChange={(value) => setDraft((d) => ({ kind: 'wires', value: mode.kind === 'new' && d?.kind === 'wires' ? followNameId(d.value, value, takenIds) : value }))}
                    {...(props.renderCutaway === undefined ? {} : { render: props.renderCutaway })}
                  />
                ) : null}
                {draft.kind === 'mechanicals' ? (
                  <MechanicalEditor
                    draft={draft.value}
                    tools={(props.db.mechanicals ?? []).filter((m) => m.kind === 'tool').map((m) => ({ id: m.id, label: m.label }))}
                    systems={[...new Set([...(props.db.mechanicals ?? []).flatMap((m) => m.termination?.systems ?? []), ...props.db.connectors.flatMap((c) => c.housing?.systems ?? []), ...(props.db.bodies ?? []).flatMap((b) => b.housing?.systems ?? [])])].sort()}
                    idLocked={mode.kind === 'edit'}
                    onChange={(value) => setDraft((d) => ({ kind: 'mechanicals', value: mode.kind === 'new' && d?.kind === 'mechanicals' ? followNameId(d.value, value, takenIds) : value }))}
                  />
                ) : null}
                {draft.kind === 'kits' ? (
                  <KitEditor
                    draft={draft.value}
                    idLocked={mode.kind === 'edit'}
                    db={db}
                    onOpenPart={(part, id) => openRecordOf(TAB_OF_PART[part], id)}
                    onChange={(value) => setDraft((d) => ({ kind: 'kits', value: mode.kind === 'new' && d?.kind === 'kits' ? followNameId(d.value, value, takenIds) : value }))}
                  />
                ) : null}
                {draft.kind === 'pcbas' ? (
                  <PcbaEditor
                    draft={draft.value}
                    idLocked={mode.kind === 'edit'}
                    locked={tagsOnly}
                    db={db}
                    onChange={(value) => setDraft((d) => ({ kind: 'pcbas', value: mode.kind === 'new' && d?.kind === 'pcbas' ? followNameId(d.value, value, takenIds) : value }))}
                  />
                ) : null}
                </PartNumberContext.Provider>
                </CatalogValuesContext.Provider>
                </VocabContext.Provider>
              </fieldset>

              {fieldIssues.length === 0 ? null : (
                <div className="cs-problem" role="status">
                  <strong>Fix these before saving</strong>
                  <ul className="cs-problem-list">
                    {fieldIssues.map((issue, index) => (
                      <li key={index}>
                        <span className="cs-issue-where">{issue.where}</span> {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {libraryIssues.length === 0 ? null : (
                <div className="cs-problem" role="status">
                  <strong>
                    Saves with {libraryIssues.length === 1 ? 'a finding' : `${libraryIssues.length} findings`} elsewhere in the library
                  </strong>
                  <ul className="cs-problem-list">
                    {libraryIssues.map((issue, index) => (
                      <li key={index}>{describeIssue(issue)}</li>
                    ))}
                  </ul>
                </div>
              )}

              {problem === undefined ? null : <Problem problem={problem} />}

              <div className="cs-def-actions">
                <button
                  type="button"
                  className="cs-primary"
                  disabled={(readOnly && !tagsOnly) || busy || !dirty || editLocked}
                  title={dirty ? 'Write this to the catalog' : 'Nothing has changed'}
                  onClick={() => void run(saveAll)}
                >
                  {busy ? 'Saving…' : mode.kind === 'new' ? `Add this ${DEFINITION_NOUNS[kind]}` : 'Save'}
                </button>
                {/* a new record has nothing to revert to */}
                {mode.kind === 'new' ? null : (
                  <button
                    type="button"
                    disabled={busy || !dirty || baseline === undefined}
                    onClick={() => {
                      if (baseline === undefined) return;
                      setDraft(draftOfRecord(kind, baseline, tags));
                      setProblem(undefined);
                    }}
                  >
                    Revert
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => close()}>
                  {mode.kind === 'new' ? 'Cancel' : 'Close'}
                </button>
                {mode.kind === 'edit' && !readOnly ? (
                  <button
                    type="button"
                    className="cs-danger-quiet"
                    disabled={busy || editLocked}
                    onClick={() => setConfirming(true)}
                  >
                    Delete…
                  </button>
                ) : null}
                {/* nothing is saved yet on a blank new record: no "saved" chip */}
                {mode.kind === 'new' && !dirty && status === undefined ? null : (
                  <span className={classes('cs-chip', dirty && 'is-dirty')}>
                    {dirty ? 'unsaved changes' : (status ?? 'saved')}
                  </span>
                )}
              </div>

              <details className="cs-advanced" open={advanced} onToggle={(event) => setAdvanced((event.target as HTMLDetailsElement).open)}>
                <summary title="Exactly what will be written. Nothing on this screen needs you to read it — it is here for when you want to check a value against a spec sheet.">
                  Advanced: the record as JSON
                </summary>
                <pre className="cs-json-view">{JSON.stringify(candidate, null, 2)}</pre>
              </details>
            </form>
            )}
            </section>
            {/* module panels come last: the definition first, then what installed modules add */}
            {mode.kind === 'edit' && props.moduleExtras !== undefined ? (
              <div className="cs-extension-slot" data-slot="library-detail">
                {props.moduleExtras({ kind, id: mode.id })}
              </div>
            ) : null}
          </>
        )}

        <Dialog
          open={forkAsk !== undefined}
          onOpenChange={(next) => { if (!next) setForkAsk(undefined); }}
          title="Fork to edit"
          size="sm"
          testId="fork-dialog"
          footer={
            <>
              <Button onClick={() => setForkAsk(undefined)}>Cancel</Button>
              <Button variant="primary" disabled={forkAsk === undefined || forkAsk.label.trim() === ''} onClick={submitFork} data-testid="fork-dialog-ok">Fork</Button>
            </>
          }
        >
          <Field label="Name for your copy">
            <Input
              value={forkAsk?.label ?? ''}
              onChange={(e) => setForkAsk((ask) => (ask === undefined ? ask : { ...ask, label: e.target.value, newId: suggestDesignId(e.target.value, takenIds) }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitFork(); } }}
            />
          </Field>
        </Dialog>

        {confirming && mode.kind === 'edit' ? (
          <div className="cs-modal" role="dialog" aria-modal="true" aria-label="Delete this definition">
            <div className="cs-modal-card">
              <h2>Delete this {DEFINITION_NOUNS[kind]}</h2>
              <p className="cs-modal-say">
                Delete <strong>{baseline?.label === undefined || baseline.label === '' ? mode.id : baseline.label}</strong>?
              </p>
              {usage !== undefined && usage.count > 0 ? (
                <p className="cs-modal-warn">
                  {usageSentence(usage)} The catalog will refuse this until nothing points at it any
                  more: {usageNames(usage).slice(0, 8).join('; ')}.
                </p>
              ) : (
                <p className="cs-modal-say">
                  Nothing in the catalog refers to it, so no design is affected. WireHub checks
                  again before it deletes anything.
                </p>
              )}
              {problem === undefined ? null : <Problem problem={problem} />}
              <div className="cs-modal-actions">
                <button
                  type="button"
                  className="cs-quiet"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    setProblem(undefined);
                  }}
                >
                  Keep it
                </button>
                <button
                  type="button"
                  className="cs-destructive"
                  disabled={busy}
                  onClick={() => {
                    const gone = baseline;
                    const adapter = definitions!;
                    const deletedKind = kind;
                    void run(async () => {
                      const result = await deleteDefinition(adapter, deletedKind, mode.id, mode.id);
                      // the row leaves the list now, not after the refresh
                      if (result.ok) setList((current) => (current.kind === deletedKind ? { ...current, records: current.records.filter((r) => r.id !== mode.id) } : current));
                      // the record, as it was, goes back when Undo is pressed within the window
                      if (result.ok && gone !== undefined) {
                        notify.undoable(`Deleted ${gone.label === '' ? gone.id : gone.label}`, () => {
                          void createDefinition(adapter, deletedKind, gone).then(async (back) => {
                            if (!back.ok) {
                              notify.error(`Could not restore ${gone.label === '' ? gone.id : gone.label}`, { description: back.problem.message });
                              return;
                            }
                            props.onDefinitionsChange?.(back.change);
                            await refresh(deletedKind);
                            notify.success(`Restored ${gone.label === '' ? gone.id : gone.label}`);
                          });
                        });
                      }
                      return result;
                    });
                  }}
                >
                  {busy ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
