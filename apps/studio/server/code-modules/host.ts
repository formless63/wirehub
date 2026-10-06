/**
 * The code-module host (`specs/runtime-modules.md` §3): loads the runtime code
 * modules this hub has installed and enabled into the live registry, next to the
 * image's built-in modules, and keeps them in step with the catalog.
 *
 * `sync()` reads what is installed (`packs.json`) and what the owners chose
 * (`data/settings/code-modules.json`, the kill switch), imports every enabled
 * module's server entry that is not loaded yet — its bytes checked against the
 * sha256 recorded at install, written to the module cache as `<id>-<sha>.mjs`
 * and imported with a generation query, so an update or a re-enable is a fresh
 * instance — and swaps the registry once. A module that fails to load is
 * quarantined (left out, its error kept) and never takes the hub down.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';

import type { InstalledModule, InstalledPack } from '@wirehub/catalog';
import {
  MODULE_API_VERSION,
  apiCompatibility,
  applyModeOf,
  codeFilePath,
  composeRegistry,
  forRuntime,
  pickModuleExport,
  runtimeModuleProblems,
  RESTART_POINTS,
  type CodeModuleManifest,
  type LiveModuleRegistry,
  type WireHubModule,
} from '@wirehub/modules';

import { codeModulesAllowedByEnv, type CodeModuleSettings } from './state.ts';

/** Where the host reads installed modules from: the packs record, the owners' settings, and the files. */
export interface CodeModuleSource {
  state(): Promise<{ packs: readonly InstalledPack[]; settings: CodeModuleSettings }>;
  /** the bytes of `relative` (`code/<id>/server.mjs`) of an installed pack, whose sha256 should be `sha` */
  migrations?: (id: string, files: readonly { path: string; sha256: string }[]) => Promise<string[]>;
  bytes(pack: InstalledPack, relative: string, sha: string): Promise<Uint8Array | undefined>;
}

export type CodeModuleState = 'loaded' | 'disabled' | 'off' | 'failed' | 'refused' | 'pending';

export interface CodeModuleStatus {
  id: string;
  version: string;
  label: string;
  pack: { id: string; version: string };
  apiVersion: string;
  extensionPoints: string[];
  permissions: string[];
  trust?: InstalledModule['trust'];
  enabled: boolean;
  enabledBy?: string;
  enabledOn?: string;
  state: CodeModuleState;
  /** why it is not loaded */
  error?: string;
  /** live: every change applies at once; restart: the points in `restartPoints` apply on the next start (the rest at once) */
  apply: 'live' | 'restart';
  /** its extension points that need a fresh process (currently none) */
  restartPoints: string[];
  /** it changed since this process started in a way only a restart completes (`restartPoints`) */
  restartPending: boolean;
  /** the browser entry and styles it ships (sha256), served while it is loaded */
  browser?: { js: string; css?: string };
}

export interface BrowserModuleEntry {
  id: string;
  version: string;
  js: { url: string; integrity: string };
  css?: { url: string; integrity: string };
  /** it sets the editor's commit hook (a refresh is needed to drop an old one) */
  commitHook: boolean;
}

export interface CodeModuleHost {
  /** read the state, load what should run, swap the registry when the set changed */
  sync(): Promise<void>;
  /** every installed code module and what became of it in this process */
  status(): readonly CodeModuleStatus[];
  /** the modules the browser should load (the loaded ones that ship a browser entry) */
  browser(): Promise<{ generation: number; modules: BrowserModuleEntry[] }>;
  /** a served file of a loaded module, by sha256 */
  file(sha: string): Promise<{ bytes: Uint8Array; mediaType: string } | undefined>;
  /**
   * Load a module that is not enabled yet without registering it (an install's
   * or an enable's trial): the problems, empty when it would run. A success is
   * kept, so the sync that follows reuses the instance.
   */
  trial(manifest: CodeModuleManifest, serverBytes: Uint8Array, serverSha: string): Promise<string[]>;
  /** the installed module `id` as the trial needs it, from the current state */
  trialInstalled(id: string): Promise<string[]>;
  /** is code allowed (environment, settings)? */
  allowed(): Promise<{ env: boolean; settings: boolean }>;
  /** after the boot sync: from now on a restart-only change waits for the next start */
  markBooted(): void;
  /** the image's built-in module ids */
  readonly builtins: readonly string[];
  /** bumped by every registry swap */
  readonly generation: number;
}

export interface CodeModuleHostOptions {
  builtins: readonly WireHubModule[];
  live: LiveModuleRegistry;
  source: CodeModuleSource;
  /** the server's own environment (the kill switch); default `process.env` */
  env?: () => Readonly<Record<string, string | undefined>>;
  /** default `WIREHUB_MODULE_CACHE_DIR`, else `<tmp>/wirehub-code-modules` */
  cacheDir?: string;
  log?: (line: string) => void;
  /** how a written entry is imported (default: `import()` of its file URL with a fresh query); tests in a browser-like environment stand in */
  importModule?: (url: string, bytes: Uint8Array) => Promise<Record<string, unknown>>;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const integrityOf = (hex: string): string => `sha256-${Buffer.from(hex, 'hex').toString('base64')}`;

/** React for the modules' code: they reach the host's copy, never a second one (`wirehub-module build`'s shim). */
export function installSharedModules(): void {
  const g = globalThis as { __wirehub?: { shared?: Record<string, unknown> } };
  g.__wirehub ??= {};
  g.__wirehub.shared = { ...(g.__wirehub.shared ?? {}), react: React, 'react/jsx-runtime': JsxRuntime };
}

/** The manifest a loaded module is checked against, rebuilt from the install record. */
export function manifestOfInstalled(m: InstalledModule): CodeModuleManifest {
  return {
    id: m.id,
    version: m.version,
    label: m.label,
    apiVersion: m.apiVersion,
    server: codeFilePath(m.id, 'server.mjs'),
    ...(m.files.browser === undefined ? {} : { browser: codeFilePath(m.id, 'browser.mjs') }),
    ...(m.files.css === undefined ? {} : { css: codeFilePath(m.id, 'browser.css') }),
    ...(m.files.migrations === undefined ? {} : { migrations: m.files.migrations }),
    extensionPoints: [...m.extensionPoints],
    permissions: [...m.permissions],
  };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every import in this process gets its own query, so a module is never served from the ESM cache of an earlier load. */
let imports = 0;

export function createCodeModuleHost(options: CodeModuleHostOptions): CodeModuleHost {
  const env = options.env ?? (() => process.env);
  const log = options.log ?? ((line: string) => console.log(`[modules] ${line}`));
  const cacheDir = options.cacheDir ?? (process.env.WIREHUB_MODULE_CACHE_DIR?.trim() || join(tmpdir(), 'wirehub-code-modules'));
  const builtins = [...options.builtins];
  installSharedModules();

  /** loaded instances, by `<id>@<server sha>` */
  const instances = new Map<string, WireHubModule>();
  /** modules that failed to load, by the same key, with why */
  const quarantine = new Map<string, string>();
  /** what was loaded at the boot sync, by module id: a later change to a module with restart points is pending until the next start */
  let bootKeys: Map<string, string> | undefined;
  let statuses: CodeModuleStatus[] = [];
  let registered = '';
  let chain: Promise<void> = Promise.resolve();
  const fileCache = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  let lastPacks: readonly InstalledPack[] = [];

  const importBytes = async (id: string, sha: string, bytes: Uint8Array): Promise<Record<string, unknown>> => {
    mkdirSync(cacheDir, { recursive: true });
    const file = join(cacheDir, `${id}-${sha.slice(0, 16)}.mjs`);
    if (!existsSync(file)) writeFileSync(file, bytes);
    imports += 1;
    const url = `${pathToFileURL(file).href}?g=${imports}`;
    if (options.importModule !== undefined) return options.importModule(url, bytes);
    return (await import(url)) as Record<string, unknown>;
  };

  /** import, pick, check: the module, or throws with the sentence a person reads */
  const instantiate = async (manifest: CodeModuleManifest, sha: string, bytes: Uint8Array): Promise<WireHubModule> => {
    if (sha256(bytes) !== sha) throw new Error('its server entry does not match the sha256 recorded when it was installed');
    let namespace: Record<string, unknown>;
    try {
      namespace = await importBytes(manifest.id, sha, bytes);
    } catch (error) {
      throw new Error(`it threw while loading: ${message(error)}`);
    }
    const module = pickModuleExport(namespace, manifest.id);
    if (module === undefined) throw new Error(`its server entry exports no module with id '${manifest.id}'`);
    const problems = runtimeModuleProblems(module, manifest);
    if (problems.length > 0) throw new Error(problems.join('; '));
    return forRuntime(module);
  };

  const statusOf = (pack: InstalledPack, m: InstalledModule, settings: CodeModuleSettings): CodeModuleStatus => {
    const choice = settings.modules[m.id];
    return {
      id: m.id,
      version: m.version,
      label: m.label,
      pack: { id: pack.id, version: pack.version },
      apiVersion: m.apiVersion,
      extensionPoints: [...m.extensionPoints],
      permissions: [...m.permissions],
      ...(m.trust === undefined ? {} : { trust: m.trust }),
      enabled: choice?.enabled === true,
      ...(choice?.by === undefined ? {} : { enabledBy: choice.by }),
      ...(choice?.on === undefined ? {} : { enabledOn: choice.on }),
      state: 'disabled',
      apply: applyModeOf(m.extensionPoints),
      restartPoints: m.extensionPoints.filter((p) => (RESTART_POINTS as readonly string[]).includes(p)),
      restartPending: false,
      ...(m.files.browser === undefined ? {} : { browser: { js: m.files.browser, ...(m.files.css === undefined ? {} : { css: m.files.css }) } }),
    };
  };

  const syncNow = async (): Promise<void> => {
    let state: Awaited<ReturnType<CodeModuleSource['state']>>;
    try {
      state = await options.source.state();
    } catch (error) {
      log(`the installed modules could not be read (${message(error)}); the loaded set stays`);
      return;
    }
    lastPacks = state.packs;
    const allowEnv = codeModulesAllowedByEnv(env());
    const allowSettings = state.settings.allow !== false;
    const next: CodeModuleStatus[] = [];
    const want: { key: string; status: CodeModuleStatus; module: WireHubModule }[] = [];
    for (const pack of state.packs) {
      const m = pack.module;
      if (m === undefined) continue;
      const status = statusOf(pack, m, state.settings);
      next.push(status);
      const key = `${m.id}@${m.files.server}`;
      if (!status.enabled) continue;
      if (!allowEnv || !allowSettings) {
        status.state = 'off';
        status.error = allowEnv ? 'code modules are turned off in Settings' : 'code modules are turned off by the server (WIREHUB_ALLOW_CODE_MODULES=false)';
        continue;
      }
      const api = apiCompatibility(m.apiVersion);
      if (!api.ok) {
        status.state = 'refused';
        status.error = api.reason;
        continue;
      }
      if (m.extensionPoints.includes('migrations')) {
        try {
          if (options.source.migrations === undefined || m.files.migrations === undefined) throw new Error('This module needs database migrations and requires the Postgres backend.');
          const pending = await options.source.migrations(m.id, m.files.migrations);
          for (const file of m.files.migrations) {
            const bytes = await options.source.bytes(pack, file.path, file.sha256);
            if (bytes === undefined || sha256(bytes) !== file.sha256) throw new Error(`SQL file ${file.path} is missing or changed.`);
          }
          if (pending.length > 0) {
            status.state = 'pending';
            status.error = 'Database changes are waiting. An administrator must run the migration command with the publisher public key before this module can run.';
            continue;
          }
        } catch (error) { status.state = 'refused'; status.error = message(error); continue; }
      }
      const failed = quarantine.get(key);
      if (failed !== undefined) {
        status.state = 'failed';
        status.error = failed;
        continue;
      }
      // A future extension point may require a fresh process rather than live reconciliation.
      if (bootKeys !== undefined && status.restartPoints.length > 0 && bootKeys.get(m.id) !== key) status.restartPending = true;
      let module = instances.get(key);
      if (module === undefined) {
        try {
          const bytes = await options.source.bytes(pack, codeFilePath(m.id, 'server.mjs'), m.files.server);
          if (bytes === undefined) throw new Error('its server entry is missing from the hub\'s store');
          module = await instantiate(manifestOfInstalled(m), m.files.server, bytes);
          instances.set(key, module);
        } catch (error) {
          status.state = 'failed';
          status.error = message(error);
          quarantine.set(key, status.error);
          log(`${m.id} ${m.version} was disabled automatically: ${status.error}`);
          continue;
        }
      }
      want.push({ key, status, module });
    }
    let composed: ReturnType<typeof composeRegistry>;
    try {
      composed = composeRegistry(builtins, want.map((w) => w.module));
    } catch (error) {
      log(`the module set could not be composed (${message(error)}); the loaded set stays`);
      statuses = next;
      return;
    }
    for (const w of want) {
      const refusal = composed.refused.find((r) => r.id === w.module.id);
      if (refusal !== undefined) {
        w.status.state = 'refused';
        w.status.error = refusal.problems.join('; ');
      } else w.status.state = 'loaded';
    }
    const accepted = want.filter((w) => composed.accepted.includes(w.module.id));
    // instances nothing wants any more are forgotten: enabling again imports afresh
    const keep = new Set(accepted.map((w) => w.key));
    for (const key of [...instances.keys()]) if (!keep.has(key)) instances.delete(key);
    // Preserve restart status when a future extension point cannot be removed live.
    for (const status of next) if (bootKeys?.has(status.id) === true && status.restartPoints.length > 0 && status.state !== 'loaded') status.restartPending = true;
    const fingerprint = accepted.map((w) => w.key).join(',');
    if (fingerprint !== registered) {
      options.live.replace(composed.registry);
      registered = fingerprint;
      log(`modules now: ${[...builtins.map((b) => b.id), ...accepted.map((w) => `${w.module.id} ${w.module.version} (runtime)`)].join(', ')}`);
    }
    statuses = next;
  };

  const host: CodeModuleHost = {
    builtins: builtins.map((b) => b.id),
    get generation() {
      return options.live.generation;
    },
    sync() {
      chain = chain.then(syncNow, syncNow);
      return chain;
    },
    status: () => statuses,
    markBooted() {
      if (bootKeys !== undefined) return;
      bootKeys = new Map();
      for (const status of statuses) {
        if (status.state !== 'loaded') continue;
        const pack = lastPacks.find((p) => p.module?.id === status.id);
        if (pack?.module !== undefined) bootKeys.set(status.id, `${status.id}@${pack.module.files.server}`);
      }
    },
    async allowed() {
      const state = await options.source.state();
      return { env: codeModulesAllowedByEnv(env()), settings: state.settings.allow !== false };
    },
    async trial(manifest, serverBytes, serverSha) {
      if (manifest.extensionPoints.includes('migrations')) {
        if (options.source.migrations === undefined || manifest.migrations === undefined) return ['This module needs SQL migrations and requires the Postgres backend.'];
        try { if ((await options.source.migrations(manifest.id, manifest.migrations)).length > 0) return []; }
        catch (error) { return [message(error)]; }
      }
      const key = `${manifest.id}@${serverSha}`;
      quarantine.delete(key);
      let module: WireHubModule;
      try {
        module = await instantiate(manifest, serverSha, serverBytes);
      } catch (error) {
        return [message(error)];
      }
      const others = statuses.filter((s) => s.state === 'loaded' && s.id !== manifest.id).map((s) => options.live.module(s.id)).filter((m): m is WireHubModule => m !== undefined);
      const composed = composeRegistry(builtins, [...others, module]);
      const refusal = composed.refused.find((r) => r.id === manifest.id);
      if (refusal !== undefined) return refusal.problems;
      instances.set(key, module);
      return [];
    },
    async trialInstalled(id) {
      const state = await options.source.state();
      const pack = state.packs.find((p) => p.module?.id === id);
      const m = pack?.module;
      if (pack === undefined || m === undefined) return [`no code module '${id}' is installed`];
      const api = apiCompatibility(m.apiVersion);
      if (!api.ok) return [api.reason];
      const bytes = await options.source.bytes(pack, codeFilePath(m.id, 'server.mjs'), m.files.server);
      if (bytes === undefined) return ['its server entry is missing from the hub\'s store'];
      return host.trial(manifestOfInstalled(m), bytes, m.files.server);
    },
    async browser() {
      await host.sync();
      const modules: BrowserModuleEntry[] = [];
      for (const status of statuses) {
        if (status.state !== 'loaded' || status.browser === undefined) continue;
        const loaded = options.live.module(status.id);
        modules.push({
          id: status.id,
          version: status.version,
          js: { url: `/api/code-modules/files/${status.browser.js}.mjs`, integrity: integrityOf(status.browser.js) },
          ...(status.browser.css === undefined ? {} : { css: { url: `/api/code-modules/files/${status.browser.css}.css`, integrity: integrityOf(status.browser.css) } }),
          commitHook: loaded?.commitHook !== undefined,
        });
      }
      return { generation: options.live.generation, modules };
    },
    async file(sha) {
      const cached = fileCache.get(sha);
      if (cached !== undefined) return cached;
      for (const status of statuses) {
        if (status.state !== 'loaded' || status.browser === undefined) continue;
        const which = status.browser.js === sha ? 'browser.mjs' : status.browser.css === sha ? 'browser.css' : undefined;
        if (which === undefined) continue;
        const pack = lastPacks.find((p) => p.module?.id === status.id);
        if (pack === undefined) continue;
        const bytes = await options.source.bytes(pack, codeFilePath(status.id, which), sha);
        if (bytes === undefined || sha256(bytes) !== sha) return undefined;
        const found = { bytes, mediaType: which.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' };
        fileCache.set(sha, found);
        return found;
      }
      return undefined;
    },
  };
  return host;
}

export { MODULE_API_VERSION };
