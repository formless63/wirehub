/**
 * @wirehub/modules — the build-time module registry.
 *
 * A **module** is a plain object (`WireHubModule`) that contributes to a
 * fixed set of extension points: catalog packs, importers, exporters /
 * document types, a part-number scheme, validation rules, integrations
 * (server routes), UI panels and routes, and auth providers. A deployment
 * lists the modules it wants in its **manifest** (`apps/studio/modules.config.ts`)
 * and the registry built from that list is what every host reads.
 *
 * There is **no runtime plugin loading**: a module is an npm workspace
 * package (or a git dependency) imported by the manifest and bundled with
 * the app. See `docs/modules.md` for the design and how a private module
 * lives in its own repository.
 *
 * Everything here is pure and framework-free: UI contributions are carried as
 * opaque component references the host renders (`unknown` here, so this
 * package needs no React).
 */

import type { CableDesign, Db, Issue, PartNumberScheme } from '@wirehub/model';

/* ------------------------------------------------------------------ *
 * Extension points
 * ------------------------------------------------------------------ */

/**
 * A catalog pack: definitions (and optionally example designs) a module
 * ships as data. `root` is a directory laid out like `packages/catalog/data`
 * (`connectors.json`, `wires.json`, `vocab/…`); the host merges packs into
 * the deployment's catalog at install time (`docs/catalog-store.md`).
 */
export interface CatalogPackContribution {
  /** kebab id, unique across the deployment: `pro-audio` */
  id: string;
  label: string;
  /** semver of the pack's data */
  version: string;
  /**
   * the pack's data directory (server only): an absolute path, or a `file:`
   * URL — `new URL('../pack/', import.meta.url).href` keeps the module
   * importable in the browser bundle, where `node:url` is not
   */
  root?: string;
  /** SPDX licence expression of the pack's data as a whole; records may carry their own */
  license?: string;
}

/** What an importer reads and what it produces. */
export interface ImportInput {
  fileName: string;
  bytes: Uint8Array;
}

export interface ImportResult {
  /** definitions proposed for the catalog — never written until a person accepts them */
  definitions?: Partial<Pick<Db, 'connectors' | 'wires' | 'components' | 'pcbas' | 'mechanicals'>>;
  /** designs proposed for the catalog */
  designs?: CableDesign[];
  /** what a person should check, in words */
  notes: string[];
}

export interface ImporterContribution {
  id: string;
  label: string;
  /** file extensions it accepts, lower case with the dot: `.kicad_pcb` */
  accepts: readonly string[];
  import(input: ImportInput, db: Db): ImportResult | Promise<ImportResult>;
}

/** A rendered document or export payload. */
export interface ExportOutput {
  mimeType: string;
  fileName: string;
  body: string | Uint8Array;
}

export interface ExporterContribution {
  id: string;
  label: string;
  /** one sentence for the Documents view */
  description?: string;
  render(design: CableDesign, db: Db, options?: Readonly<Record<string, unknown>>): ExportOutput | Promise<ExportOutput>;
}

/** An extra design rule: issues it adds to `validateDesign`'s. Must be pure. */
export interface ValidationRuleContribution {
  /** issue codes it may emit are prefixed with the module id: `acme/…` */
  id: string;
  label: string;
  check(design: CableDesign, db: Db): Issue[];
}

/** A server route an integration adds under `/api/modules/<module id>/…`. */
export interface ServerRouteContribution {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** path below the module's prefix: `push`, `status` */
  path: string;
  /** whether the route writes catalog data (takes the write lock) */
  writes?: boolean;
  handle(request: {
    body?: unknown;
    query: URLSearchParams;
    user?: { name: string; email?: string };
    /** this module's job queues (absent where the studio runs no jobs) */
    jobs?: ModuleJobs;
  }): Promise<{ status: number; body: unknown }>;
}

/** What a queue's `run` is given for one job. */
export interface JobQueueContext {
  /** the module id and the queue's id */
  module: string;
  queue: string;
  /** what the job was enqueued with (`jobs.enqueue(queue, request)`); `{ reason: 'schedule' }` for a scheduled run, `{ reason: 'requested' }` by hand; plain JSON */
  request: Readonly<Record<string, unknown>>;
  /** report progress: shown on the job, in order */
  step(text: string): Promise<void>;
  /** the catalog as it is when the job starts (read only: catalog writes go through the module's routes and importers) */
  db(): Promise<Db>;
}

/**
 * A job queue a module registers through an integration (`docs/modules.md`,
 * "Job queues"): work that takes longer than a request, or runs on a schedule,
 * run by the worker process on the Postgres backend and in the studio process
 * on files, one job at a time per queue, recorded like the base's own
 * (`GET /api/jobs`, kind `<module id>:<queue id>`). Nothing is retried: a
 * `run` that throws fails the job with its message.
 */
export interface JobQueueContribution {
  /** kebab id, unique within the module; the job kind is `<module id>:<id>` */
  id: string;
  label: string;
  /** a five-field cron expression (container time): a job is enqueued on it by the worker (Postgres only) */
  schedule?: string;
  /** do the work; the returned object (plain JSON) is the job's result */
  run(context: JobQueueContext): Promise<Record<string, unknown> | void>;
}

/** What a route's `request.jobs` offers: enqueue and read this module's own queues. */
export interface ModuleJobs {
  /** queue a job on one of this module's queues; resolves once it is recorded, not when it has run */
  enqueue(queue: string, request?: Record<string, unknown>): Promise<{ id: string; kind: string; status: string }>;
  /** a job of this module's queues (`undefined` for any other job): its status, steps, result and error */
  get(id: string): Promise<{ id: string; kind: string; status: string; steps: { at: string; text: string }[]; result?: Record<string, unknown>; error?: string } | undefined>;
}

export interface IntegrationContribution {
  id: string;
  label: string;
  /** environment variables it reads, for the setup page and `docs/` */
  env?: readonly string[];
  routes?: readonly ServerRouteContribution[];
  /** job queues of this module (run by the worker; see `JobQueueContribution`) */
  queues?: readonly JobQueueContribution[];
}

export type PanelSlot = 'cable-inspector' | 'cable-documents' | 'library-detail' | 'settings';

/** A UI panel the host mounts in a named slot. The component is the host framework's (React in apps/studio). */
export interface PanelContribution {
  id: string;
  label: string;
  slot: PanelSlot;
  /** a React component taking `PanelProps` (`unknown` here, so this package needs no React) */
  component: unknown;
}

/**
 * A call to the module's own server routes (`/api/modules/<module>/<path>`),
 * as the host hands it to a panel or a route. Resolves with the HTTP status and
 * the parsed JSON body; never throws on a 4xx/5xx.
 */
export type ModuleApi = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

/**
 * The props every panel component receives. `design` is the cable on screen
 * (the live, possibly unsaved one) in the cable slots; `record` names the
 * Library definition in `library-detail`. Panels are read-mostly: write through
 * `api` to the module's own routes, or through the module's data under
 * `design.extensions[module]` by the commit hook.
 */
export interface PanelProps {
  slot: PanelSlot;
  /** the module that contributed the panel */
  module: string;
  db: Db;
  design?: CableDesign;
  record?: { kind: string; id: string };
  /** a read-only view (a saved revision, someone else's edit lock): no writes */
  readOnly: boolean;
  api: ModuleApi;
}

/**
 * A compare view for Library records: two records of one kind side by side (a board's artwork
 * and 3D model revisions, two shells' dimensions …). The base ships a generic field diff
 * (`RecordCompare`); a module that registers a view for a kind replaces it for that kind.
 */
export interface CompareViewContribution {
  id: string;
  label: string;
  /** the Library kinds it compares (`pcbas`, `mechanicals`, …); absent = every kind */
  kinds?: readonly string[];
  /** a React component taking `CompareProps` (`unknown` here, so this package needs no React) */
  component: unknown;
}

/** What the Library hands a compare view: the record(s) by kind and id, the library, and a way back. */
export interface CompareProps {
  /** the module that contributed the view */
  module: string;
  db: Db;
  /** the record the Compare action was pressed on, or the first one ticked */
  a: { kind: string; id: string };
  /** the second record, once chosen; absent: the view asks for it */
  b?: { kind: string; id: string };
  api: ModuleApi;
  /** close the compare view and go back to the Library */
  onClose: () => void;
}

export interface UiRouteContribution {
  /** path below `/m/<module id>/`: `status`, or `reports/summary` (static segments only) */
  path: string;
  label: string;
  /** shown in the rail when set: a Tabler icon name (`IconPlug`) from the host's small set; unknown names fall back to a puzzle piece */
  icon?: string;
  /** a React component taking `RouteProps` */
  component: unknown;
}

/** The props a UI route's component receives. */
export interface RouteProps {
  module: string;
  /** the route's path below `/m/<module>/` */
  path: string;
  db: Db;
  api: ModuleApi;
}

/** A sign-in method the auth layer offers (e.g. OIDC against a deployment's identity provider). */
export interface AuthProviderContribution {
  id: string;
  label: string;
  kind: 'oidc' | 'oauth2' | 'other';
  /** the provider's config, as the auth layer takes it (server only) */
  config: Readonly<Record<string, unknown>>;
}

/**
 * How first-run setup (`/setup`) offers a module. A **domain** module —
 * the vocabulary and catalog packs of one field (video, automotive,
 * fieldbus …) — is optional: a person picks it, and its packs are installed
 * as layers under the catalog then. Every domain module starts unticked: a
 * deployment pre-ticks some with `WIREHUB_SUGGESTED_MODULES`. `suggested`
 * pre-ticks this one only where that variable is unset (a private build's own
 * default); nothing is forced either way. The bundled modules leave it unset.
 */
export interface SetupContribution {
  kind: 'domain';
  /** one sentence: what enabling it adds */
  description: string;
  suggested?: boolean;
}

/** The commit hook a module may install in the editor (`setCommitHook`). */
export type CommitHookContribution = (before: CableDesign, proposed: CableDesign, description: string) => CableDesign;

/**
 * Catalog documents a module owns (`data/<prefix>…`): what an importer or a
 * script writes through `PUT /api/docs/*path` (`imported`, `report`). Truth
 * files keep their own routes; derived files are never written by hand.
 */
export interface DocumentContribution {
  /** a path prefix under `data/`, ending in `/` (`data/acme/`), or one exact file (`data/acme/register.json`) */
  path: string;
  class: 'imported' | 'report';
}

/**
 * SQL migrations for a module's own relational state (Postgres backend only;
 * `docs/modules.md`, "Module tables"). `dir` holds forward-only
 * `NNNN_<module_id>_<name>.sql` files (`NNNN` ascending from 0001, the module id
 * with `-` written as `_`), applied after the base's migrations into the schema
 * `mod_<module_id>`. A path or a `file:` URL, like a pack's `root`.
 */
export interface ModuleMigrationsContribution {
  dir: string | URL;
}

/**
 * Derived records a module keeps beside the catalog: files recomputed from
 * the designs and definitions whenever a save changes one of them, so they are
 * never stale and travel with the change that moved them (the git export on
 * files, the `derived_doc` table on Postgres). They live at
 * `data/derived/<module id>/<file>`; nobody writes them by hand.
 *
 * `derive` must be pure and deterministic (no clock, no network): the same
 * inputs give the same bytes on both backends. Return one entry per declared
 * file: JSON-able data for a `.json` file, a string for a `.md` file.
 */
export interface DerivedContribution {
  id: string;
  label: string;
  /** the files it keeps, by name: `summary.json`, `report.md` (lowercase, `.json` or `.md`) */
  files: readonly string[];
  derive(input: { designs: readonly CableDesign[]; db: Db }): Record<string, unknown>;
}

/**
 * Drawings a module carries for the shapes its catalog pack adds
 * (`docs/modules.md`, "Art"; `specs/drawing-language.md` §7). Every entry is
 * plain data, the parsed contents of files in the pack's `art/` directory;
 * the host validates and registers them at start (`registerConnectorArt`,
 * `registerBodyLayouts`, `registerDrawingArt`), so the types stay out of this
 * contract package — they are `@wirehub/catalog`'s `ConnectorArtRecord`,
 * `BodyLayoutRecord` and `@wirehub/docs`'s `DrawingArt`.
 *
 * Art is keyed by body, drawing name or family and is inert in a catalog that
 * has none of them, so it applies to the whole deployment — the base alone
 * (no module) draws exactly what it always did.
 */
export interface ArtContribution {
  /** connector drawings: the mating face as painted shapes with a handle per pin */
  connectors?: readonly unknown[];
  /** the standard position layouts a family offers for a new body */
  bodyLayouts?: readonly unknown[];
  /** drawing-sheet art: traced faces and plugs, cutaways per stock, the title block's logo and text */
  drawing?: unknown;
}

/* ------------------------------------------------------------------ *
 * The module
 * ------------------------------------------------------------------ */

export interface WireHubModule {
  /** kebab id, unique in the deployment; also the key of the module's data under `CableDesign.extensions` */
  id: string;
  label: string;
  /** semver */
  version: string;
  /** SPDX licence expression of the module's code */
  license?: string;
  /** set for an optional (domain) module that first-run setup offers; absent = always part of the deployment */
  setup?: SetupContribution;
  catalogPacks?: readonly CatalogPackContribution[];
  importers?: readonly ImporterContribution[];
  exporters?: readonly ExporterContribution[];
  /** at most one module in a deployment may set this */
  partNumberScheme?: PartNumberScheme;
  validationRules?: readonly ValidationRuleContribution[];
  integrations?: readonly IntegrationContribution[];
  panels?: readonly PanelContribution[];
  /** compare views for Library records (the base's generic field diff stands in where none is registered) */
  compareViews?: readonly CompareViewContribution[];
  routes?: readonly UiRouteContribution[];
  authProviders?: readonly AuthProviderContribution[];
  /** at most one module in a deployment may set this */
  commitHook?: CommitHookContribution;
  documents?: readonly DocumentContribution[];
  derived?: readonly DerivedContribution[];
  /** drawings for the shapes the module's pack adds */
  art?: ArtContribution;
  /** SQL for the module's own tables on the Postgres backend */
  migrations?: ModuleMigrationsContribution;
}

/** Identity helper so a module file type-checks its own literal. */
export function defineModule<M extends WireHubModule>(module: M): M {
  return module;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

export interface ModuleRegistry {
  readonly modules: readonly WireHubModule[];
  module(id: string): WireHubModule | undefined;
  /** the scheme a module registered, or `undefined` (the host then uses the catalog's configured default) */
  partNumberScheme(): PartNumberScheme | undefined;
  commitHook(): CommitHookContribution | undefined;
  catalogPacks(): readonly (CatalogPackContribution & { module: string })[];
  /** the optional (domain) modules first-run setup offers, in manifest order */
  domains(): readonly WireHubModule[];
  importers(): readonly (ImporterContribution & { module: string })[];
  derived(): readonly (DerivedContribution & { module: string })[];
  /** every module's art contribution, in manifest order */
  art(): readonly (ArtContribution & { module: string })[];
  /**
   * The catalog directories (relative to `data/`, `''` = the top level) holding
   * files modules own — their documents and derived records — so the file
   * backend's catalog version covers them.
   */
  catalogDirs(): readonly string[];
  /** the module document a catalog path belongs to, if any (`PUT /api/docs/*path`) */
  documentFor(path: string): (DocumentContribution & { module: string }) | undefined;
  /** one importer, by module and id */
  importer(module: string, id: string): (ImporterContribution & { module: string }) | undefined;
  /** one exporter, by module and id */
  exporter(module: string, id: string): (ExporterContribution & { module: string }) | undefined;
  /** the importers that take `fileName`, by extension */
  importersFor(fileName: string): readonly (ImporterContribution & { module: string })[];
  exporters(): readonly (ExporterContribution & { module: string })[];
  panels(slot: PanelContribution['slot']): readonly (PanelContribution & { module: string })[];
  /** every module's compare view, in manifest order */
  compareViews(): readonly (CompareViewContribution & { module: string })[];
  /** the first compare view that takes Library `kind`, or `undefined` (the host then uses the generic field diff) */
  compareViewFor(kind: string): (CompareViewContribution & { module: string }) | undefined;
  routes(): readonly (UiRouteContribution & { module: string })[];
  integrations(): readonly (IntegrationContribution & { module: string })[];
  /** every module's job queues, with the job kind each runs as (`<module>:<queue>`) */
  queues(): readonly (JobQueueContribution & { module: string; kind: string })[];
  authProviders(): readonly (AuthProviderContribution & { module: string })[];
  /** every registered rule's issues for `design`, codes prefixed `<module>/` when the rule did not */
  validate(design: CableDesign, db: Db): Issue[];
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DERIVED_FILE = /^[a-z0-9][a-z0-9-]*\.(json|md)$/;
const CRON_FIELD = /^[0-9*,/\-A-Za-z]+$/;
const ROUTE_PATH = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

/** Why a manifest is unusable — thrown by `createRegistry`, one sentence per problem. */
export class ModuleManifestError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`module manifest: ${problems.join('; ')}`);
    this.name = 'ModuleManifestError';
    this.problems = problems;
  }
}

function tag<T extends object>(module: WireHubModule, items: readonly T[] | undefined): (T & { module: string })[] {
  return (items ?? []).map((item) => ({ ...item, module: module.id }));
}

/** Check a manifest's problems without throwing: empty when it is usable. */
export function manifestProblems(modules: readonly WireHubModule[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const m of modules) {
    if (!KEBAB.test(m.id)) problems.push(`'${m.id}' is not a kebab-case module id`);
    if (ids.has(m.id)) problems.push(`module '${m.id}' is listed twice`);
    ids.add(m.id);
    if (!/^\d+\.\d+\.\d+/.test(m.version)) problems.push(`module '${m.id}' version '${m.version}' is not semver`);
    if (m.setup !== undefined && (m.catalogPacks ?? []).length === 0) problems.push(`domain module '${m.id}' ships no catalog pack for setup to install`);
  }
  for (const m of modules) {
    const kept = new Set<string>();
    for (const d of m.derived ?? []) {
      if (!KEBAB.test(d.id)) problems.push(`module '${m.id}' derived record '${d.id}' is not a kebab-case id`);
      for (const file of d.files) {
        if (!DERIVED_FILE.test(file)) problems.push(`module '${m.id}' derived file '${file}' must be a lowercase name ending .json or .md`);
        if (kept.has(file)) problems.push(`module '${m.id}' declares derived file '${file}' twice`);
        kept.add(file);
      }
    }
    for (const doc of m.documents ?? []) {
      if (doc.path.startsWith('data/derived/')) problems.push(`module '${m.id}' document '${doc.path}' is under data/derived/, which the host keeps for derived records`);
    }
    for (const integration of m.integrations ?? []) {
      for (const route of integration.routes ?? []) {
        if (route.path.startsWith('_')) problems.push(`module '${m.id}' route '${route.path}' starts with '_', which the host reserves for importers and exporters`);
      }
    }
    const queues = new Set<string>();
    for (const integration of m.integrations ?? []) {
      for (const queue of integration.queues ?? []) {
        if (!KEBAB.test(queue.id)) problems.push(`module '${m.id}' queue '${queue.id}' is not a kebab-case id`);
        if (queues.has(queue.id)) problems.push(`module '${m.id}' has two queues with id '${queue.id}'`);
        queues.add(queue.id);
        if (queue.schedule !== undefined) {
          const fields = queue.schedule.trim().split(/\s+/);
          if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) problems.push(`module '${m.id}' queue '${queue.id}' schedule must be a five-field cron expression`);
        }
      }
    }
    const paths = new Set<string>();
    for (const route of m.routes ?? []) {
      if (!ROUTE_PATH.test(route.path)) problems.push(`module '${m.id}' UI route '${route.path}' must be lowercase kebab segments joined by '/'`);
      if (paths.has(route.path)) problems.push(`module '${m.id}' has two UI routes at '${route.path}'`);
      paths.add(route.path);
    }
    const compares = new Set<string>();
    for (const view of m.compareViews ?? []) {
      if (compares.has(view.id)) problems.push(`module '${m.id}' has two compare views with id '${view.id}'`);
      compares.add(view.id);
    }
    const panels = new Set<string>();
    for (const panel of m.panels ?? []) {
      if (panels.has(panel.id)) problems.push(`module '${m.id}' has two panels with id '${panel.id}'`);
      panels.add(panel.id);
    }
  }
  const schemes = modules.filter((m) => m.partNumberScheme !== undefined).map((m) => m.id);
  if (schemes.length > 1) problems.push(`more than one module sets a part-number scheme (${schemes.join(', ')})`);
  const hooks = modules.filter((m) => m.commitHook !== undefined).map((m) => m.id);
  if (hooks.length > 1) problems.push(`more than one module sets a commit hook (${hooks.join(', ')})`);
  const unique = (what: string, list: { id: string; module: string }[]): void => {
    const seen = new Map<string, string>();
    for (const item of list) {
      const other = seen.get(item.id);
      if (other !== undefined) problems.push(`${what} '${item.id}' is contributed by both ${other} and ${item.module}`);
      seen.set(item.id, item.module);
    }
  };
  const artIds = (what: string, pick: (a: ArtContribution) => readonly unknown[] | undefined): void => {
    const rows: { id: string; module: string }[] = [];
    for (const m of modules) {
      for (const item of pick(m.art ?? {}) ?? []) {
        const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
        if (typeof id !== 'string' || !KEBAB.test(id)) problems.push(`module '${m.id}' has ${what} without a kebab-case id`);
        else rows.push({ id, module: m.id });
      }
    }
    unique(what, rows);
  };
  artIds('connector drawing', (a) => a.connectors);
  artIds('body layout', (a) => a.bodyLayouts);
  unique('catalog pack', modules.flatMap((m) => tag(m, m.catalogPacks)));
  unique('importer', modules.flatMap((m) => tag(m, m.importers)));
  unique('exporter', modules.flatMap((m) => tag(m, m.exporters)));
  unique('auth provider', modules.flatMap((m) => tag(m, m.authProviders)));
  return problems;
}

/** Build the registry from a manifest. Throws `ModuleManifestError` when the manifest is unusable. */
export function createRegistry(modules: readonly WireHubModule[]): ModuleRegistry {
  const problems = manifestProblems(modules);
  if (problems.length > 0) throw new ModuleManifestError(problems);
  const list = [...modules];
  return {
    modules: list,
    module: (id) => list.find((m) => m.id === id),
    partNumberScheme: () => list.find((m) => m.partNumberScheme !== undefined)?.partNumberScheme,
    commitHook: () => list.find((m) => m.commitHook !== undefined)?.commitHook,
    catalogPacks: () => list.flatMap((m) => tag(m, m.catalogPacks)),
    domains: () => list.filter((m) => m.setup?.kind === 'domain'),
    importers: () => list.flatMap((m) => tag(m, m.importers)),
    derived: () => list.flatMap((m) => tag(m, m.derived)),
    art: () => list.flatMap((m) => (m.art === undefined ? [] : [{ ...m.art, module: m.id }])),
    catalogDirs: () => {
      const dirs = new Set<string>();
      for (const m of list) {
        for (const doc of m.documents ?? []) {
          const rel = doc.path.replace(/^data\//, '');
          const slash = rel.lastIndexOf('/');
          dirs.add(doc.path.endsWith('/') ? rel.replace(/\/$/, '') : slash === -1 ? '' : rel.slice(0, slash));
        }
        if ((m.derived ?? []).length > 0) dirs.add(`derived/${m.id}`);
      }
      return [...dirs].sort();
    },
    importer: (module, id) => list.flatMap((m) => tag(m, m.importers)).find((i) => i.module === module && i.id === id),
    exporter: (module, id) => list.flatMap((m) => tag(m, m.exporters)).find((e) => e.module === module && e.id === id),
    documentFor: (path) =>
      list.flatMap((m) => tag(m, m.documents)).find((d) => (d.path.endsWith('/') ? path.startsWith(d.path) : path === d.path) && !path.includes('..')),
    importersFor: (fileName) => {
      const lower = fileName.toLowerCase();
      return list.flatMap((m) => tag(m, m.importers)).filter((i) => i.accepts.some((ext) => lower.endsWith(ext)));
    },
    exporters: () => list.flatMap((m) => tag(m, m.exporters)),
    panels: (slot) => list.flatMap((m) => tag(m, m.panels)).filter((p) => p.slot === slot),
    compareViews: () => list.flatMap((m) => tag(m, m.compareViews)),
    compareViewFor: (kind) => list.flatMap((m) => tag(m, m.compareViews)).find((v) => v.kinds === undefined || v.kinds.includes(kind)),
    routes: () => list.flatMap((m) => tag(m, m.routes)),
    integrations: () => list.flatMap((m) => tag(m, m.integrations)),
    queues: () => list.flatMap((m) => (m.integrations ?? []).flatMap((i) => (i.queues ?? []).map((q) => ({ ...q, module: m.id, kind: `${m.id}:${q.id}` })))),
    authProviders: () => list.flatMap((m) => tag(m, m.authProviders)),
    validate: (design, db) =>
      list.flatMap((m) =>
        (m.validationRules ?? []).flatMap((rule) =>
          rule.check(design, db).map((issue) => (issue.code.startsWith(`${m.id}/`) ? issue : { ...issue, code: `${m.id}/${issue.code}` })),
        ),
      ),
  };
}

/** The registry of a deployment with no modules. */
export const EMPTY_REGISTRY: ModuleRegistry = createRegistry([]);
