/**
 * The catalog loaders, bound to a `CatalogSource` (storage seams).
 *
 * `createCatalog(source)` returns every loader `@wirehub/catalog`
 * exports — `loadDb`, `loadDesign`, … — reading through `source` instead of
 * `node:fs`. The package's top-level functions are this, bound to the live
 * `data/` directory (the starter catalog); `fixtureCatalog` is this, bound
 * to the frozen fixture catalog under `fixtures/v1/`.
 *
 * Only `connectors.json`, `wires.json` and `components.json` are required;
 * every other file is optional and reads as empty when absent, so a new
 * deployment can start from an almost empty catalog.
 *
 * Every call re-reads: a source over a directory the studio writes into must
 * never answer from a stale memo. Each call returns fresh objects, so callers
 * can never mutate a shared singleton.
 */

import { DEFAULT_PART_NUMBER_SCHEME, boardPartsWithBuilds, composeConnectors, composePcbas, schemeFromConfig, withPcbaPads, type BoardPartsEntry, type PcbaStatusEntry } from '@wirehub/model';
import type {
  BoardBuilds,
  CableDesign,
  ComponentDefinition,
  ConnectorBody,
  ConnectorDefinition,
  ConnectorRecord,
  DbRules,
  ValidationRule,
  BenchStepRule,
  DrawingArtData,
  CostingRules,
  ElectricalRules,
  Db,
  DesignVersionFile,
  Interface,
  KitDefinition,
  MechanicalDefinition,
  PartNumberScheme,
  PcbaDefinition,
  PcbaPadTable,
  SignalTags,
  StripPractice,
  Vocab,
  VocabList,
  WireDefinition,
  WireLibrary,
  WirePart,
  WireRecipe,
} from '@wirehub/model';

import type { CatalogSource } from './source.ts';

/**
 * A design id. Kebab-case, and the file's own name under `data/designs/`.
 *
 * Deliberately `string` and not a union of the ids that happened to exist when
 * this file was written: the workbench writes new designs at runtime, and a
 * union would make every one of them a type error until someone edited this
 * module. The *file* is the record; validation, not the type system, is what
 * keeps a design honest.
 */
export type DesignId = string;

/**
 * A design id is a kebab-case slug — lowercase letters and digits in
 * hyphen-separated groups. It is also a file name, so nothing else is allowed
 * near it: no dots, no slashes, no `..`.
 */
export function isDesignId(value: unknown): value is DesignId {
  return typeof value === 'string' && value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** The directory a design's saved versions live in (relative to `data/`). */
export function designVersionsDir(id: DesignId): string {
  if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
  return `designs/_versions/${id}`;
}

const EMPTY_SIGNAL_TAGS: SignalTags = { src: 'none: the catalog has no tags file' };

const jsonNames = (names: string[]): string[] => names.filter((name) => name.endsWith('.json')).sort();

/** Every loader, reading through `source`. */
export function createCatalog(source: CatalogSource) {
  function readJson<T>(relative: string): T {
    const text = source.read(relative);
    if (text === undefined) throw new Error(`${source.name} has no ${relative}`);
    return JSON.parse(text) as T;
  }
  function readOptional<T>(relative: string): T | undefined {
    const text = source.read(relative);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  /* -------------------------------- designs -------------------------------- */

  /**
   * Every design in `designs/`, sorted by id. Read per call, never memoised:
   * the studio writes this directory while it runs.
   */
  function listDesignIds(): DesignId[] {
    return jsonNames(source.list('designs'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter(isDesignId)
      .sort();
  }
  /** One design, by id. Throws for an id no file backs. */
  function loadDesign(id: DesignId): CableDesign {
    if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
    return readJson<CableDesign>(`designs/${id}.json`);
  }
  function listDesignSummaries(): { id: DesignId; label: string }[] {
    return listDesignIds().map((id) => ({ id, label: loadDesign(id).label }));
  }
  function designExists(id: string): boolean {
    return isDesignId(id) && listDesignIds().includes(id);
  }
  function loadDesigns(): CableDesign[] {
    return listDesignIds().map((id) => loadDesign(id));
  }

  /** The revision numbers saved for `id`, ascending; `[]` when none. */
  function listDesignRevisions(id: DesignId): number[] {
    return source
      .list(designVersionsDir(id))
      .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
      .filter((rev): rev is string => rev !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }
  function loadDesignVersion(id: DesignId, rev: number): DesignVersionFile | undefined {
    if (!Number.isInteger(rev) || rev < 0) return undefined;
    if (!listDesignRevisions(id).includes(rev)) return undefined;
    return readJson<DesignVersionFile>(`${designVersionsDir(id)}/${rev}.json`);
  }
  function loadLatestDesignVersion(id: DesignId): DesignVersionFile | undefined {
    const revs = listDesignRevisions(id);
    const last = revs[revs.length - 1];
    return last === undefined ? undefined : loadDesignVersion(id, last);
  }

  /* ------------------------------ definitions ------------------------------ */

  const loadConnectorRecords = (): ConnectorRecord[] => readJson<ConnectorRecord[]>('connectors.json');
  const loadBodies = (): ConnectorBody[] => readOptional<ConnectorBody[]>('bodies.json') ?? [];
  const loadInterfaces = (): Interface[] => readOptional<Interface[]>('interfaces.json') ?? [];
  const loadWires = (): WireDefinition[] => readJson<WireDefinition[]>('wires.json');
  const loadComponents = (): ComponentDefinition[] => readJson<ComponentDefinition[]>('components.json');
  const loadKits = (): KitDefinition[] => readOptional<KitDefinition[]>('kits.json') ?? [];
  const loadMechanicals = (): MechanicalDefinition[] => readOptional<MechanicalDefinition[]>('mechanicals.json') ?? [];
  /** board definitions (PCBAs as black boxes) — optional file */
  const loadCuratedPcbas = (): PcbaDefinition[] => readOptional<PcbaDefinition[]>('pcbas.json') ?? [];
  const loadPcbaStatus = (): PcbaStatusEntry[] => readOptional<{ status: PcbaStatusEntry[] }>('pcba-status.json')?.status ?? [];
  const loadWireParts = (): WirePart[] => readOptional<WirePart[]>('wire-parts.json') ?? [];
  const loadWireRecipes = (): WireRecipe[] => readOptional<WireRecipe[]>('wire-recipes.json') ?? [];
  /** the bench's strip steps per construction — optional file */
  const loadStripPractice = (): StripPractice[] => readOptional<StripPractice[]>('strip-practice.json') ?? [];
  const loadWireLibrary = (): WireLibrary => ({ parts: loadWireParts(), recipes: loadWireRecipes() });
  const loadPcbaPads = (): PcbaPadTable => readOptional<PcbaPadTable>('pcba-pads.json') ?? { boards: {} };

  function listVocabIds(): string[] {
    return jsonNames(source.list('vocab')).map((name) => name.slice(0, -'.json'.length));
  }
  function loadVocabList(id: string): VocabList {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`'${id}' is not a usable vocab list id`);
    return readJson<VocabList>(`vocab/${id}.json`);
  }
  const loadVocab = (): Vocab => Object.fromEntries(listVocabIds().map((id) => [id, loadVocabList(id)]));
  const loadSignalTags = (): SignalTags => readOptional<SignalTags>('tags/signal-tags.json') ?? EMPTY_SIGNAL_TAGS;

  function loadConnectors(): ConnectorDefinition[] {
    return composeConnectors(loadConnectorRecords(), { bodies: loadBodies(), interfaces: loadInterfaces(), vocab: loadVocab() });
  }
  function loadPcbas(): PcbaDefinition[] {
    return composePcbas({ curated: loadCuratedPcbas(), generated: [], kicad: [], status: loadPcbaStatus() });
  }
  /** `board-parts.json` — optional file; the builds' population is laid over it here, at load */
  const loadBoardPartsFile = (): BoardPartsEntry[] | undefined => readOptional<{ boards: BoardPartsEntry[] }>('board-parts.json')?.boards;
  /** the organisation's rule thresholds, kept in the hub's engineering settings (`settings/engineering.json`) */
  const loadRules = (): DbRules | undefined => {
    const settings = readOptional<{ electrical?: ElectricalRules; costing?: CostingRules }>('settings/engineering.json');
    const electrical = settings?.electrical;
    const costing = settings?.costing;
    return electrical === undefined && costing === undefined ? undefined : { ...(electrical === undefined ? {} : { electrical }), ...(costing === undefined ? {} : { costing }) };
  };
  function loadDb(): Db {
    const pcbas = loadPcbas();
    const boardParts = loadBoardPartsFile();
    const rules = loadRules();
    // the declarative validation rules (`validation-rules.json`, an array of rule records; a pack may ship them)
    const validationRules = readOptional<ValidationRule[]>('validation-rules.json');
    // the shop's work instructions as data (`bench-rules.json`, an array of rule records; a pack may ship them)
    const benchRules = readOptional<BenchStepRule[]>('bench-rules.json');
    // drawing art as data (`drawing-art.json`: faces, plugs and cutaways by definition id; a pack may ship it)
    const drawingArt = readOptional<DrawingArtData>('drawing-art.json');
    return {
      ...(rules === undefined ? {} : { rules }),
      ...(Array.isArray(validationRules) && validationRules.length > 0 ? { validationRules } : {}),
      ...(Array.isArray(benchRules) && benchRules.length > 0 ? { benchRules } : {}),
      ...(typeof drawingArt === 'object' && drawingArt !== null && !Array.isArray(drawingArt) && (drawingArt.faces !== undefined || drawingArt.plugs !== undefined || drawingArt.cutaways !== undefined) ? { drawingArt } : {}),
      connectors: loadConnectors(),
      wires: loadWires(),
      components: loadComponents(),
      ...(boardParts === undefined ? {} : { boardParts: boardPartsWithBuilds(boardParts, loadBoardBuilds(), pcbas) }),
      pcbas: withPcbaPads(pcbas, loadPcbaPads()),
      mechanicals: loadMechanicals(),
      vocab: loadVocab(),
      tags: loadSignalTags(),
      bodies: loadBodies(),
      interfaces: loadInterfaces(),
      kits: loadKits(),
    };
  }

  /* ------------------------------ part numbers ----------------------------- */

  /**
   * The deployment's numbering scheme: the built-in prefix scheme configured
   * by `part-numbers.json`, or its defaults when the file is absent. A module
   * that brings its own scheme replaces this at registration
   * (`docs/modules.md`).
   */
  function loadPartNumberScheme(): PartNumberScheme {
    const json = readOptional<unknown>('part-numbers.json');
    return json === undefined ? DEFAULT_PART_NUMBER_SCHEME : schemeFromConfig(json);
  }

  /** Every board's build file (`builds/*.json`), in file-name order — optional directory. */
  const loadBoardBuilds = (): BoardBuilds[] => jsonNames(source.list('builds')).map((name) => readJson<BoardBuilds>(`builds/${name}`));

  return {
    source,
    /** A data file, parsed; `undefined` when it is not there. */
    readJsonFile: readOptional,
    listDesignIds,
    listDesignSummaries,
    designExists,
    loadDesign,
    loadDesigns,
    listDesignRevisions,
    loadDesignVersion,
    loadLatestDesignVersion,
    loadCatalog: (): { db: Db; designs: CableDesign[] } => ({ db: loadDb(), designs: loadDesigns() }),
    loadConnectors,
    loadConnectorRecords,
    loadBodies,
    loadInterfaces,
    loadWires,
    loadComponents,
    loadKits,
    loadMechanicals,
    loadCuratedPcbas,
    loadPcbaStatus,
    loadPcbas,
    loadWireParts,
    loadWireRecipes,
    loadWireLibrary,
    loadStripPractice,
    loadPcbaPads,
    listVocabIds,
    loadVocabList,
    loadVocab,
    loadSignalTags,
    loadPartNumberScheme,
    loadDb,
    loadBoardBuilds,
  };
}

/** Every loader over one catalog — what `createCatalog` returns. */
export type Catalog = ReturnType<typeof createCatalog>;
