/**
 * Runtime code modules (`specs/runtime-modules.md`): what a host needs to load
 * a module that was installed while it runs, rather than bundled with it.
 *
 * - the API version a module is built against, and the compatibility rule;
 * - the extension points and permissions a module object uses, so a bundle's
 *   manifest can declare them and a host can check the declaration;
 * - which points apply live and which need a restart;
 * - a **live registry**: a `ModuleRegistry` whose contents can be swapped, so
 *   every holder of the registry sees modules come and go;
 * - composing the image's built-in modules with runtime ones, built-ins first.
 *
 * Pure and framework-free like the rest of this package.
 */

import { createRegistry, manifestProblems, type ModuleRegistry, type WireHubModule } from './index.ts';

/* ------------------------------------------------------------------ *
 * The API version
 * ------------------------------------------------------------------ */

/**
 * The `@wirehub/modules` API a module is built against, `<major>.<minor>`.
 * `1.0` was the build-time-only contract; `1.1` adds runtime loading (nothing a
 * 1.0 module relies on changed); `1.2` adds `revisionSources`; `1.3` module SQL migrations; `1.4` `PanelProps.onChange`;
 * `1.5` declared module settings (`WireHubModule.settings`, read through `request.settings` /
 * `context.settings`). A minor bump adds; a major bump breaks.
 */
export const MODULE_API_VERSION = '1.5';

const API_VERSION = /^(\d+)\.(\d+)$/;

/** Can a module built against `declared` run on a host at `host`? Same major, and a minor no newer than the host's. */
export function apiCompatibility(declared: unknown, host: string = MODULE_API_VERSION): { ok: true } | { ok: false; reason: string } {
  const want = typeof declared === 'string' ? API_VERSION.exec(declared) : null;
  const have = API_VERSION.exec(host);
  if (want === null || have === null) return { ok: false, reason: `its apiVersion '${String(declared)}' is not <major>.<minor>` };
  if (Number(want[1]) !== Number(have[1])) return { ok: false, reason: `it was built for module API ${declared as string}, and this hub runs ${host} (a different major version)` };
  if (Number(want[2]) > Number(have[2])) return { ok: false, reason: `it needs module API ${declared as string}, newer than this hub's ${host}; update WireHub` };
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Extension points and permissions
 * ------------------------------------------------------------------ */

export const EXTENSION_POINTS = [
  'setup',
  'catalogPacks',
  'importers',
  'exporters',
  'partNumberScheme',
  'validationRules',
  'integrations',
  'queues',
  'panels',
  'compareViews',
  'revisionSources',
  'routes',
  'authProviders',
  'commitHook',
  'documents',
  'derived',
  'art',
  'bench',
  'migrations',
  'settings',
] as const;

export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

/** Points whose change needs a fresh process; all supported runtime points currently apply live. */
export const RESTART_POINTS: readonly ExtensionPoint[] = [];

/** Reserved for extension points unavailable to runtime modules. SQL is handled by the separate owner migration command. */
export const RUNTIME_REFUSED_POINTS: readonly ExtensionPoint[] = [];

/** Points the host ignores in a runtime module: the pack that carries the module is its data. */
export const RUNTIME_IGNORED_POINTS: readonly ExtensionPoint[] = ['setup', 'catalogPacks'];

const some = (list: readonly unknown[] | undefined): boolean => (list ?? []).length > 0;

/** The extension points a module object contributes to, in `EXTENSION_POINTS` order. */
export function extensionPointsOf(m: WireHubModule): ExtensionPoint[] {
  const used: Record<ExtensionPoint, boolean> = {
    setup: m.setup !== undefined,
    catalogPacks: some(m.catalogPacks),
    importers: some(m.importers),
    exporters: some(m.exporters),
    partNumberScheme: m.partNumberScheme !== undefined,
    validationRules: some(m.validationRules),
    integrations: some(m.integrations),
    queues: (m.integrations ?? []).some((i) => some(i.queues)),
    panels: some(m.panels),
    compareViews: some(m.compareViews),
    revisionSources: some(m.revisionSources),
    routes: some(m.routes),
    authProviders: some(m.authProviders),
    commitHook: m.commitHook !== undefined,
    documents: some(m.documents),
    derived: some(m.derived),
    art: m.art !== undefined && (some(m.art.connectors) || some(m.art.bodyLayouts) || m.art.drawing !== undefined),
    bench: m.bench !== undefined,
    migrations: m.migrations !== undefined,
    settings: some(m.settings),
  };
  return EXTENSION_POINTS.filter((p) => used[p]);
}

/** `'restart'` when any of `points` needs a fresh process to change, else `'live'`. */
export function applyModeOf(points: readonly string[]): 'live' | 'restart' {
  return points.some((p) => (RESTART_POINTS as readonly string[]).includes(p)) ? 'restart' : 'live';
}

/**
 * What a module may do, in words a person can consent to. Declared in the
 * bundle's manifest and checked against the module object at load; not a
 * sandbox (a module is trusted code), but a module never does more than it said.
 *
 * - `server-code` — runs on the server (every runtime module)
 * - `browser-code` — runs in people's browsers
 * - `routes` — answers HTTP requests under `/api/modules/<id>/`
 * - `writes` — has a route that changes catalog data (takes the write lock)
 * - `jobs` — runs background jobs (its own queues)
 * - `sign-in` — adds a sign-in method
 * - `env:<NAME>` — reads the server environment variable NAME (also a declared
 *   setting's `env` override, which the host reads on the module's behalf)
 */
export const PERMISSIONS = ['server-code', 'browser-code', 'routes', 'writes', 'jobs', 'sign-in', 'database-schema'] as const;

export type ModulePermission = (typeof PERMISSIONS)[number] | `env:${string}`;

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** The permissions a module object needs (`browser`: it ships a browser entry). */
export function permissionsOf(m: WireHubModule, options: { browser?: boolean } = {}): ModulePermission[] {
  const out = new Set<ModulePermission>(['server-code']);
  if (m.migrations !== undefined) out.add('database-schema');
  if (options.browser === true) out.add('browser-code');
  for (const integration of m.integrations ?? []) {
    if (some(integration.routes)) out.add('routes');
    if ((integration.routes ?? []).some((r) => r.writes === true)) out.add('writes');
    if (some(integration.queues)) out.add('jobs');
    for (const name of integration.env ?? []) out.add(`env:${name}`);
  }
  for (const setting of m.settings ?? []) if (setting.env !== undefined) out.add(`env:${setting.env}`);
  for (const provider of m.authProviders ?? []) {
    out.add('sign-in');
    for (const [key, value] of Object.entries(provider.config ?? {})) {
      if (key.endsWith('Env') && typeof value === 'string') out.add(`env:${value}`);
    }
  }
  const order = (p: string): number => {
    const i = (PERMISSIONS as readonly string[]).indexOf(p);
    return i === -1 ? PERMISSIONS.length : i;
  };
  return [...out].sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/* ------------------------------------------------------------------ *
 * The bundle's manifest (`wirehub-pack.json` → `module`)
 * ------------------------------------------------------------------ */

/** The `module` block of a pack manifest: the code module the pack carries. */
export interface CodeModuleManifest {
  /** the `WireHubModule` id: kebab, unique in the hub */
  id: string;
  /** the module's semver */
  version: string;
  label: string;
  /** `MODULE_API_VERSION` it was built against */
  apiVersion: string;
  /** `code/<id>/server.mjs` */
  server: string;
  /** `code/<id>/browser.mjs`, when it has UI */
  browser?: string;
  /** `code/<id>/browser.css` */
  css?: string;
  /** Signed SQL paths and checksums; applied by the owner migration CLI before code loads. */
  migrations?: { path: string; sha256: string }[];
  extensionPoints: string[];
  permissions: string[];
  description?: string;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The path of a code file of module `id`: `code/<id>/server.mjs`, `…/browser.mjs`, `…/browser.css`. */
export function codeFilePath(id: string, file: 'server.mjs' | 'browser.mjs' | 'browser.css'): string {
  return `code/${id}/${file}`;
}

/** Is `path` a code file a pack may carry (`code/<kebab>/(server|browser).mjs | browser.css`)? */
export function isCodeFilePath(path: string): boolean {
  return /^code\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:server\.mjs|browser\.mjs|browser\.css|migrations\/\d{4}_[a-z0-9_]+\.sql)$/.test(path);
}

/** What is wrong with a `module` block, one sentence each; empty when it is usable. */
export function codeModuleManifestProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['the manifest\'s "module" is not an object'];
  const m = value as Record<string, unknown>;
  const problems: string[] = [];
  const id = typeof m['id'] === 'string' ? m['id'] : '';
  if (!KEBAB.test(id)) problems.push('the module id must be kebab-case');
  if (typeof m['version'] !== 'string' || !SEMVER.test(m['version'])) problems.push('the module version must be semver');
  if (typeof m['label'] !== 'string' || m['label'].trim() === '') problems.push('the module needs a label');
  if (typeof m['apiVersion'] !== 'string') problems.push('the module names the apiVersion it was built against');
  if (m['server'] !== codeFilePath(id, 'server.mjs')) problems.push(`the module's server entry must be ${codeFilePath(id || '<id>', 'server.mjs')}`);
  if (m['browser'] !== undefined && m['browser'] !== codeFilePath(id, 'browser.mjs')) problems.push(`the module's browser entry must be ${codeFilePath(id || '<id>', 'browser.mjs')}`);
  if (m['css'] !== undefined && m['css'] !== codeFilePath(id, 'browser.css')) problems.push(`the module's styles must be ${codeFilePath(id || '<id>', 'browser.css')}`);
  if (m['css'] !== undefined && m['browser'] === undefined) problems.push('the module has styles but no browser entry');
  const points = m['extensionPoints'];
  if (!Array.isArray(points) || !points.every((p) => typeof p === 'string')) problems.push('the module lists its extensionPoints');
  else {
    for (const p of points) if (!(EXTENSION_POINTS as readonly string[]).includes(p)) problems.push(`'${p}' is not an extension point`);
    for (const p of RUNTIME_REFUSED_POINTS) if (points.includes(p)) problems.push(`a module installed at runtime cannot use '${p}'`);
  }
  if (Array.isArray(points) && points.includes('settings') && (typeof m['apiVersion'] !== 'string' || !/^1\.(?:[5-9]|[1-9]\d+)$/.test(m['apiVersion']))) problems.push('declared module settings require module API 1.5 or newer');
  const migrations = m['migrations'];
  if (Array.isArray(points) && points.includes('migrations')) {
    if (typeof m['apiVersion'] !== 'string' || !/^1\.(?:[3-9]|[1-9]\d+)$/.test(m['apiVersion'])) problems.push('SQL migrations require module API 1.3 or newer');
    if (!Array.isArray(migrations) || migrations.length === 0 || migrations.length > 100) problems.push('the module names 1–100 signed SQL migrations');
    else migrations.forEach((raw: unknown, index: number) => {
      const file = raw as { path?: unknown; sha256?: unknown } | null;
      const prefix = `code/${id}/migrations/${String(index + 1).padStart(4, '0')}_${id.replace(/-/g, '_')}_`;
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || !file.path.startsWith(prefix) || !isCodeFilePath(file.path) || !file.path.endsWith('.sql') || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) problems.push(`migration ${index + 1} needs a sequential module SQL path and sha256`);
    });
    if (!Array.isArray(m['permissions']) || !m['permissions'].includes('database-schema')) problems.push("SQL migrations declare the permission 'database-schema'");
  } else if (migrations !== undefined) problems.push('SQL files need the migrations extension point');
  const perms = m['permissions'];
  if (!Array.isArray(perms) || !perms.every((p) => typeof p === 'string')) problems.push('the module lists its permissions');
  else {
    for (const p of perms) {
      if (!(PERMISSIONS as readonly string[]).includes(p) && !(p.startsWith('env:') && ENV_NAME.test(p.slice(4)))) problems.push(`'${p}' is not a permission`);
    }
    if (!perms.includes('server-code')) problems.push("every runtime module declares 'server-code'");
    if (m['browser'] !== undefined && !perms.includes('browser-code')) problems.push("a module with a browser entry declares 'browser-code'");
  }
  return problems;
}

/** The module export of an imported entry: the default export, else the one named export whose `id` is `id`. */
export function pickModuleExport(namespace: Readonly<Record<string, unknown>>, id: string): WireHubModule | undefined {
  const isModule = (v: unknown): v is WireHubModule =>
    typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string' && typeof (v as { version?: unknown }).version === 'string' && typeof (v as { label?: unknown }).label === 'string';
  const fallback = namespace['default'];
  if (isModule(fallback) && fallback.id === id) return fallback;
  const named = Object.entries(namespace).filter(([key, v]) => key !== 'default' && isModule(v) && v.id === id);
  return named.length === 1 ? (named[0]![1] as WireHubModule) : undefined;
}

/** A module as a host registers it at runtime: without `setup` and `catalogPacks` (its pack is installed already). */
export function forRuntime(m: WireHubModule): WireHubModule {
  const { setup: _setup, catalogPacks: _packs, migrations: _migrations, ...rest } = m;
  return rest;
}

/**
 * Why a loaded module may not run as the manifest describes it, one sentence
 * each: its id or version differ, it uses a point or a permission it did not
 * declare, or a point no runtime module may use.
 */
export function runtimeModuleProblems(m: WireHubModule, manifest: CodeModuleManifest): string[] {
  const problems: string[] = [];
  if (m.id !== manifest.id) problems.push(`the code exports module '${m.id}', but the manifest says '${manifest.id}'`);
  if (m.version !== manifest.version) problems.push(`the code is version ${m.version}, but the manifest says ${manifest.version}`);
  const used = extensionPointsOf(m).filter((p) => !(RUNTIME_IGNORED_POINTS as readonly string[]).includes(p));
  for (const p of used) {
    if ((RUNTIME_REFUSED_POINTS as readonly string[]).includes(p)) problems.push(`a module installed at runtime cannot use '${p}'`);
    else if (!manifest.extensionPoints.includes(p)) problems.push(`it uses '${p}', which its manifest does not declare`);
  }
  for (const p of permissionsOf(m, { browser: manifest.browser !== undefined })) {
    if (!manifest.permissions.includes(p)) problems.push(`it needs the permission '${p}', which its manifest does not declare`);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * The live registry
 * ------------------------------------------------------------------ */

/** A registry whose contents can be swapped: every call goes to the registry it holds now. */
export interface LiveModuleRegistry extends ModuleRegistry {
  /** the registry it holds now (immutable: hold on to it for one consistent view) */
  current(): ModuleRegistry;
  /** hold `next` from now on, and tell the subscribers */
  replace(next: ModuleRegistry): void;
  /** called after every `replace`; returns the unsubscribe */
  subscribe(listener: () => void): () => void;
  /** bumped by every `replace` */
  readonly generation: number;
}

/** Is this registry a live one? */
export function isLiveRegistry(registry: ModuleRegistry | undefined): registry is LiveModuleRegistry {
  return registry !== undefined && typeof (registry as Partial<LiveModuleRegistry>).replace === 'function' && typeof (registry as Partial<LiveModuleRegistry>).current === 'function';
}

export function createLiveRegistry(initial: ModuleRegistry): LiveModuleRegistry {
  let inner = initial;
  let generation = 0;
  const listeners = new Set<() => void>();
  const own: Pick<LiveModuleRegistry, 'current' | 'replace' | 'subscribe'> = {
    current: () => inner,
    replace(next) {
      inner = next;
      generation += 1;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // one listener never stops the others
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  // every other member is the held registry's, looked up at each call: a point the registry
  // gains later is delegated without being listed here
  return new Proxy({} as LiveModuleRegistry, {
    get(_target, key) {
      if (key === 'generation') return generation;
      if (typeof key === 'string' && key in own) return own[key as keyof typeof own];
      return (inner as unknown as Record<PropertyKey, unknown>)[key];
    },
    has: (_target, key) => key === 'generation' || key in own || key in inner,
  });
}

/* ------------------------------------------------------------------ *
 * Built-ins plus runtime modules
 * ------------------------------------------------------------------ */

export interface ComposedRegistry {
  registry: ModuleRegistry;
  /** the runtime modules registered, in order */
  accepted: string[];
  /** the runtime modules left out, with why */
  refused: { id: string; problems: string[] }[];
}

/**
 * The image's built-in modules, then the runtime ones in id order, each kept
 * only when the registry with it is still sound (`manifestProblems`). A
 * runtime module whose id a built-in has is refused: the built-in wins. The
 * built-ins themselves must be sound (`createRegistry` throws otherwise, as at
 * start).
 */
export function composeRegistry(builtins: readonly WireHubModule[], runtime: readonly WireHubModule[]): ComposedRegistry {
  const list = [...builtins];
  const accepted: string[] = [];
  const refused: { id: string; problems: string[] }[] = [];
  const before = new Set(manifestProblems(list));
  for (const candidate of [...runtime].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (builtins.some((m) => m.id === candidate.id)) {
      refused.push({ id: candidate.id, problems: [`this hub's image has a built-in module '${candidate.id}', which wins`] });
      continue;
    }
    const problems = manifestProblems([...list, candidate]).filter((p) => !before.has(p));
    if (problems.length > 0) {
      refused.push({ id: candidate.id, problems });
      continue;
    }
    list.push(candidate);
    accepted.push(candidate.id);
  }
  return { registry: createRegistry(list), accepted, refused };
}
