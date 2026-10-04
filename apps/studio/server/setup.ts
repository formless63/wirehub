/**
 * First-run setup: which domain modules this hub uses.
 *
 *   GET  /api/setup    the domain modules the build offers, which are enabled,
 *                      and whether setup still has to run
 *   POST /api/setup    { modules: string[] } — enable those modules: install
 *                      their catalog packs into the catalog, record the choice
 *
 * The WireHub base is generic; what a shop works on (video, automotive,
 * fieldbus …) arrives as **domain modules** (`docs/modules.md`), each with
 * a catalog pack. The build decides which domain modules are *available*
 * (`modules.config.ts`); a person decides which are *enabled*, here, with
 * sensible suggestions shown and nothing forced. Enabling one installs its
 * packs (`installPack`, `@wirehub/catalog`) — after that its records are
 * ordinary catalog data — and adds it to `setup.json` in the catalog
 * directory, the stored selection. Enabling is additive: a module is never
 * uninstalled from here.
 *
 * Setup "has to run" when the catalog has no `setup.json` and the host asked
 * for the prompt (`WIREHUB_SETUP_PROMPT=1`, set in the container image), so a
 * development checkout and the test suites never get bounced to /setup.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installPack, readInstalledPacks, readPackManifest } from '@wirehub/catalog';
import type { ModuleRegistry, WireHubModule } from '@wirehub/modules';

import { writeFileAtomic } from './atomic-write.ts';
import type { ApiResponse } from './api.ts';

export interface SetupDeps {
  /** the catalog directory packs are installed into and `setup.json` lives in */
  dataDir: string;
  /** whether an unfinished setup should send the browser to /setup */
  prompt: boolean;
  /** now, ISO 8601 (injected by tests) */
  now: () => string;
}

/** `setup.json`: the stored selection. */
export interface SetupState {
  src: string;
  completed: boolean;
  completedAt?: string;
  completedBy?: string;
  /** enabled domain modules, in the order they were enabled */
  modules: string[];
}

/** A domain the setup page mentions that this build has no module for yet. */
export interface DomainSuggestion {
  label: string;
  description: string;
}

/**
 * Domains shown beside the bundled modules, so a person sees where WireHub
 * is going. Not installable: a domain moves from here to a real module once
 * one exists.
 */
export const DOMAIN_SUGGESTIONS: readonly DomainSuggestion[] = [
  { label: 'Fieldbus', description: 'PROFIBUS, CAN, Modbus, M8/M12 codings: planned (docs/catalog-store.md).' },
];

const SETUP_FILE = 'setup.json';
const SRC = 'the domain modules this hub uses, chosen at first-run setup (apps/studio/server/setup.ts)';

export function readSetup(dataDir: string): SetupState | undefined {
  const path = join(dataDir, SETUP_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SetupState) : undefined;
}

function writeSetup(dataDir: string, state: SetupState): void {
  writeFileAtomic(join(dataDir, SETUP_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** A pack contribution's directory: a `file:` URL or an absolute path. */
export function packDirOf(root: string | undefined): string | undefined {
  if (root === undefined) return undefined;
  if (root.startsWith('file:')) return fileURLToPath(root);
  return isAbsolute(root) ? root : undefined;
}

function domainView(module: WireHubModule, enabled: readonly string[], installed: ReadonlySet<string>): unknown {
  return {
    id: module.id,
    label: module.label,
    version: module.version,
    ...(module.license === undefined ? {} : { license: module.license }),
    description: module.setup?.description ?? '',
    suggested: module.setup?.suggested === true,
    enabled: enabled.includes(module.id),
    packs: (module.catalogPacks ?? []).map((pack) => ({
      id: pack.id,
      label: pack.label,
      version: pack.version,
      ...(pack.license === undefined ? {} : { license: pack.license }),
      installed: installed.has(pack.id),
    })),
  };
}

function view(deps: SetupDeps, modules: ModuleRegistry | undefined): unknown {
  const state = readSetup(deps.dataDir);
  const enabled = state?.modules ?? [];
  const installed = new Set(readInstalledPacks(deps.dataDir).packs.map((p) => p.id));
  return {
    needed: deps.prompt && state?.completed !== true,
    completed: state?.completed === true,
    domains: (modules?.domains() ?? []).map((m) => domainView(m, enabled, installed)),
    suggestions: DOMAIN_SUGGESTIONS,
  };
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const refuse = (status: number, error: string, hint?: string): ApiResponse => json(status, { error, ...(hint === undefined ? {} : { hint }) });

/** Is this a setup route? */
export function isSetupPath(path: string): boolean {
  return (path.split('?')[0] ?? '').replace(/\/+$/, '') === '/api/setup';
}

/**
 * `/api/setup`. The POST writes files directly (pack installs are journaled
 * by the installer), so the caller runs it under the write lock.
 */
export async function handleSetupRequest(
  request: { method: string; body?: unknown; user?: { name: string } },
  deps: SetupDeps | undefined,
  modules: ModuleRegistry | undefined,
): Promise<ApiResponse> {
  if (deps === undefined) return refuse(501, 'This host has no first-run setup.', 'Domain modules are installed by the deployment here.');
  const method = request.method.toUpperCase();
  if (method === 'GET') return json(200, view(deps, modules));
  if (method !== 'POST') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET and POST.');

  const body = request.body as { modules?: unknown } | undefined;
  const asked = body?.modules;
  if (!Array.isArray(asked) || !asked.every((id): id is string => typeof id === 'string')) {
    return refuse(400, 'Say which domain modules to enable.', 'Send { "modules": ["av-video", …] } — an empty list is fine.');
  }
  const domains = modules?.domains() ?? [];
  const unknown = asked.filter((id) => !domains.some((m) => m.id === id));
  if (unknown.length > 0) {
    return refuse(400, `Not a domain module of this build: ${unknown.join(', ')}.`, `This build offers ${domains.map((m) => m.id).join(', ') || 'none'}.`);
  }

  // check every pack before installing any, so a conflict leaves nothing half-done
  const chosen = domains.filter((m) => asked.includes(m.id));
  const plans: { module: string; pack: string; dir: string }[] = [];
  for (const module of chosen) {
    for (const pack of module.catalogPacks ?? []) {
      const dir = packDirOf(pack.root);
      if (dir === undefined) return refuse(500, `Module '${module.id}' names no directory for pack '${pack.id}'.`);
      try {
        readPackManifest(dir);
      } catch (error) {
        return refuse(500, error instanceof Error ? error.message : String(error));
      }
      plans.push({ module: module.id, pack: pack.id, dir });
    }
  }
  const installed: { module: string; pack: string; added: number; alreadyInstalled: boolean }[] = [];
  for (const plan of plans) {
    try {
      const result = installPack(deps.dataDir, plan.dir);
      installed.push({
        module: plan.module,
        pack: plan.pack,
        added: Object.values(result.added).reduce((n, ids) => n + Math.max(1, ids.length), 0),
        alreadyInstalled: result.alreadyInstalled,
      });
    } catch (error) {
      return refuse(409, error instanceof Error ? error.message : String(error), 'Rename or remove the clashing record in the catalog, then run setup again.');
    }
  }

  const before = readSetup(deps.dataDir);
  const modulesNow = [...(before?.modules ?? [])];
  for (const id of asked) if (!modulesNow.includes(id)) modulesNow.push(id);
  writeSetup(deps.dataDir, {
    src: SRC,
    completed: true,
    completedAt: before?.completedAt ?? deps.now(),
    ...(before?.completedBy !== undefined ? { completedBy: before.completedBy } : request.user === undefined ? {} : { completedBy: request.user.name }),
    modules: modulesNow,
  });
  return json(200, { ...(view(deps, modules) as object), installed });
}
