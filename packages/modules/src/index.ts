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
  handle(request: { body?: unknown; query: URLSearchParams; user?: { name: string; email?: string } }): Promise<{ status: number; body: unknown }>;
}

export interface IntegrationContribution {
  id: string;
  label: string;
  /** environment variables it reads, for the setup page and `docs/` */
  env?: readonly string[];
  routes?: readonly ServerRouteContribution[];
}

/** A UI panel the host mounts in a named slot. The component is the host framework's (React in apps/studio). */
export interface PanelContribution {
  id: string;
  label: string;
  slot: 'cable-inspector' | 'cable-documents' | 'library-detail' | 'settings';
  component: unknown;
}

export interface UiRouteContribution {
  /** path below `/m/<module id>/` */
  path: string;
  label: string;
  /** shown in the rail when set */
  icon?: string;
  component: unknown;
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
  routes?: readonly UiRouteContribution[];
  authProviders?: readonly AuthProviderContribution[];
  /** at most one module in a deployment may set this */
  commitHook?: CommitHookContribution;
  documents?: readonly DocumentContribution[];
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
  /** the module document a catalog path belongs to, if any (`PUT /api/docs/*path`) */
  documentFor(path: string): (DocumentContribution & { module: string }) | undefined;
  /** the importers that take `fileName`, by extension */
  importersFor(fileName: string): readonly (ImporterContribution & { module: string })[];
  exporters(): readonly (ExporterContribution & { module: string })[];
  panels(slot: PanelContribution['slot']): readonly (PanelContribution & { module: string })[];
  routes(): readonly (UiRouteContribution & { module: string })[];
  integrations(): readonly (IntegrationContribution & { module: string })[];
  authProviders(): readonly (AuthProviderContribution & { module: string })[];
  /** every registered rule's issues for `design`, codes prefixed `<module>/` when the rule did not */
  validate(design: CableDesign, db: Db): Issue[];
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    documentFor: (path) =>
      list.flatMap((m) => tag(m, m.documents)).find((d) => (d.path.endsWith('/') ? path.startsWith(d.path) : path === d.path) && !path.includes('..')),
    importersFor: (fileName) => {
      const lower = fileName.toLowerCase();
      return list.flatMap((m) => tag(m, m.importers)).filter((i) => i.accepts.some((ext) => lower.endsWith(ext)));
    },
    exporters: () => list.flatMap((m) => tag(m, m.exporters)),
    panels: (slot) => list.flatMap((m) => tag(m, m.panels)).filter((p) => p.slot === slot),
    routes: () => list.flatMap((m) => tag(m, m.routes)),
    integrations: () => list.flatMap((m) => tag(m, m.integrations)),
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
