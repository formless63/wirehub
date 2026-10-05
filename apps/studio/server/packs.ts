/**
 * The pack lifecycle (`docs/catalog-store.md` §3): what is installed, update
 * with a diff, disable.
 *
 *   GET    /api/packs                  installed packs, with the version this build bundles
 *   GET    /api/packs/:id/update       the plan for installing this build's version: the
 *                                      record-level diff, conflicts, references, new errors
 *   POST   /api/packs/:id/update       apply it, as one change set: { acceptMajor?: true }
 *   GET    /api/packs/:id/references   what disabling would remove, and what outside the
 *                                      pack still uses it
 *   DELETE /api/packs/:id              disable: remove the pack's records, or refuse and
 *                                      list the references
 *
 * Both backends run this one handler. It works on a catalog **directory** (and
 * the packs directory beside it): the file backend's own, or, on Postgres, the
 * scratch copy `pgSetupDeps` makes and commits as one change set, exactly as
 * first-run setup does. Planning is `@wirehub/catalog`'s `planPackUpdate` /
 * `planPackDisable`; this file is the routes, the words and the apply step.
 *
 * Writes run under the write lock, and no API token may call them (they are
 * deployment administration, like `/api/setup`).
 */

import { existsSync } from 'node:fs';

import {
  applyPackDisable,
  applyPackUpdate,
  catalogWithPacksSource,
  fsCatalogSource,
  installedAcross,
  ownedRecords,
  planPackDisable,
  planPackUpdate,
  readPackManifest,
  type CatalogSource,
  type PackDisablePlan,
  type PackUpdatePlan,
} from '@wirehub/catalog';
import type { ModuleRegistry } from '@wirehub/modules';

import type { ApiResponse } from './api.ts';
import { packDirOf, packsDirOf, type SetupDeps } from './setup.ts';

export const PACKS_ROUTES = [
  'GET    /api/packs',
  'GET    /api/packs/:id/update',
  'POST   /api/packs/:id/update',
  'GET    /api/packs/:id/references',
  'DELETE /api/packs/:id',
] as const;

/** Is this a packs route? */
export function isPacksPath(path: string): boolean {
  const p = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  return p === '/api/packs' || p.startsWith('/api/packs/');
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const refuse = (status: number, error: string, hint?: string, extra?: object): ApiResponse => json(status, { error, ...(hint === undefined ? {} : { hint }), ...extra });

/** The plan as the API shows it: without the file writes. */
function shown<T extends { writes: unknown }>(plan: T): Omit<T, 'writes'> {
  const { writes: _writes, ...rest } = plan;
  return rest;
}

/** The directory of the version of pack `id` this build bundles (a module's `catalogPacks`), if any. */
function bundledPack(modules: ModuleRegistry | undefined, id: string): { dir: string; module: string; version: string } | undefined {
  for (const module of modules?.domains() ?? []) {
    for (const pack of module.catalogPacks ?? []) {
      if (pack.id !== id) continue;
      const dir = packDirOf(pack.root);
      if (dir !== undefined && existsSync(dir)) return { dir, module: module.id, version: pack.version };
    }
  }
  return undefined;
}

function viewOf(deps: SetupDeps): CatalogSource {
  const packsDir = packsDirOf(deps);
  return packsDir === deps.dataDir ? fsCatalogSource(deps.dataDir) : catalogWithPacksSource(deps.dataDir, packsDir);
}

const notInstalled = (id: string): ApiResponse => refuse(404, `Pack '${id}' is not installed.`, 'GET /api/packs lists the installed packs.');

function updateRefusal(plan: PackUpdatePlan): ApiResponse {
  const why = plan.conflicts.length > 0 ? 'it clashes with records outside the pack' : plan.references.length > 0 ? 'it drops records something outside the pack still uses' : 'it would add errors to the library';
  const hint =
    plan.conflicts.length > 0
      ? 'Rename or remove the clashing records, then update again.'
      : plan.references.length > 0
        ? 'Move the records that use them to something else first (the references are listed), then update again.'
        : 'The errors are listed; fix what they name, or keep the installed version.';
  return refuse(409, `Pack '${plan.pack.id}' was not updated: ${why}. Nothing was changed.`, hint, { plan: shown(plan) });
}

/**
 * `/api/packs…`. Writes change files directly (the file backend) or the
 * scratch copy (`deps.transact`, Postgres), so the caller runs them under the
 * write lock.
 */
export async function handlePacksRequest(
  request: { method: string; path: string; body?: unknown },
  deps: SetupDeps | undefined,
  modules: ModuleRegistry | undefined,
): Promise<ApiResponse> {
  if (deps === undefined) return refuse(501, 'This host has no pack management.', 'Catalog packs are installed by the deployment here.');
  const method = request.method.toUpperCase();
  const write = method !== 'GET' && method !== 'HEAD';
  if (deps.transact !== undefined) {
    const { transact, ...rest } = deps;
    return transact((dataDir, packsDir) => handlePacksRequest(request, { ...rest, dataDir, packsDir }, modules), write);
  }
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '').map((p) => decodeURIComponent(p));
  const id = parts[2];
  const action = parts[3];
  if (parts.length > 4) return refuse(404, 'There is no such address.', `Packs answer ${PACKS_ROUTES.join(', ')}.`);

  const packsDir = packsDirOf(deps);
  const installed = installedAcross(deps.dataDir, packsDir);
  const view = viewOf(deps);

  if (id === undefined) {
    if (method !== 'GET') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET.');
    return json(200, {
      packs: installed.packs.map((pack) => {
        const bundled = bundledPack(modules, pack.id);
        const bundledVersion = bundled?.version;
        return {
          id: pack.id,
          version: pack.version,
          license: pack.license,
          records: ownedRecords(view, pack).size,
          ...(bundled === undefined ? {} : { module: bundled.module }),
          ...(bundledVersion === undefined || bundledVersion === pack.version ? {} : { available: bundledVersion }),
        };
      }),
    });
  }

  const pack = installed.packs.find((p) => p.id === id);
  if (pack === undefined) return notInstalled(id);
  const where = installed.where.get(id) ?? 'merged';

  if (action === undefined) {
    if (method !== 'DELETE') return refuse(405, `${method} is not something this address accepts.`, 'It answers DELETE (disable the pack).');
    const plan: PackDisablePlan = planPackDisable(view, installed.packs, id);
    if (!plan.ok) {
      return refuse(409, `Pack '${id}' was not disabled: ${plan.references.length} record${plan.references.length === 1 ? '' : 's'} outside it still use${plan.references.length === 1 ? 's' : ''} its records.`, 'Change what uses them first (the references are listed), then disable the pack.', { plan: shown(plan) });
    }
    applyPackDisable(deps.dataDir, packsDir === deps.dataDir ? undefined : packsDir, id, plan, where);
    if (deps.afterInstall !== undefined) await deps.afterInstall();
    return json(200, { disabled: id, removed: plan.records.length, plan: shown(plan) });
  }

  if (action === 'references') {
    if (method !== 'GET') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET.');
    return json(200, shown(planPackDisable(view, installed.packs, id)));
  }

  if (action === 'update') {
    if (method !== 'GET' && method !== 'POST') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET (the plan) and POST (apply it).');
    const bundled = bundledPack(modules, id);
    if (bundled === undefined) {
      return refuse(404, `This build has no other version of pack '${id}'.`, 'A pack is updated from the version its module bundles; install a newer image of WireHub to get one.');
    }
    try {
      readPackManifest(bundled.dir);
    } catch (error) {
      return refuse(500, error instanceof Error ? error.message : String(error));
    }
    const plan = planPackUpdate(view, installed.packs, bundled.dir);
    if (method === 'GET') return json(200, { ...shown(plan), applicable: plan.ok && plan.direction !== 'same' });
    if (plan.direction === 'same') return json(200, { updated: false, reason: 'already at this version', plan: shown(plan) });
    if (!plan.ok) return updateRefusal(plan);
    const accept = (request.body as { acceptMajor?: unknown } | undefined)?.acceptMajor === true;
    if (plan.major && !accept) {
      return refuse(409, `Pack '${id}' goes from ${plan.pack.from} to ${plan.pack.to}, a major version: designs built on the old one can break.`, 'Read the diff, then update again with { "acceptMajor": true }.', { plan: shown(plan) });
    }
    applyPackUpdate(deps.dataDir, packsDir === deps.dataDir ? undefined : packsDir, bundled.dir, plan, where);
    if (deps.afterInstall !== undefined) await deps.afterInstall();
    return json(200, { updated: true, from: plan.pack.from, to: plan.pack.to, plan: shown(plan) });
  }

  return refuse(404, 'There is no such address.', `Packs answer ${PACKS_ROUTES.join(', ')}.`);
}
