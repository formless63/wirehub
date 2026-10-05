/**
 * The pack lifecycle (`docs/catalog-store.md` §3): what is installed, update
 * with a diff, disable.
 *
 *   GET    /api/packs                  installed packs, with the version this build bundles
 *   GET    /api/packs/:id/update       the plan for installing this build's version: the
 *                                      record-level diff, conflicts, new errors, and the
 *                                      records it retires (dropped but still used: kept)
 *   POST   /api/packs/:id/update       apply it, as one change set: { acceptMajor?: true }
 *   GET    /api/packs/:id/references   what disabling would remove, and what outside the
 *                                      pack still uses it
 *   DELETE /api/packs/:id              disable: remove the pack's records, or refuse and
 *                                      list the references
 *   POST   /api/packs/install          install (or update) a pack from an upload or an https
 *                                      URL: { url } | { zip: <base64> } | { bundle }, then
 *                                      { apply: true, sha256?, acceptMajor? }; without apply
 *                                      it verifies and shows the diff, writing nothing
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

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyPackDisable,
  applyPackUpdate,
  catalogWithPacksSource,
  fsCatalogSource,
  installPack,
  installPackLayer,
  installedAcross,
  packFileProblems,
  packSourceProblems,
  planNewPack,
  setInstalledPackOrigin,
  setInstalledModuleTrust,
  ownedRecords,
  planPackDisable,
  planPackUpdate,
  readPackManifest,
  type CatalogSource,
  type InstalledPack,
  type PackDisablePlan,
  type PackInstallPreview,
  type PackUpdatePlan,
} from '@wirehub/catalog';
import { packCodecProblems } from '@wirehub/catalog/src/codec/tree.ts';
import type { CodeModuleManifest, ModuleRegistry } from '@wirehub/modules';

import type { ApiResponse } from './api.ts';
import type { CodeModuleHost } from './code-modules/host.ts';
import { codeModulesAllowedByEnv, readSettingsFile, updateSettingsFile } from './code-modules/state.ts';
import { codeGate, isOwner } from './code-modules/trust.ts';
import type { StudioUser } from './me.ts';
import { PackArchiveError, fetchPack, readPackBytes, sha256, writePackFiles } from './pack-archive.ts';
import { packDirOf, packsDirOf, type SetupDeps } from './setup.ts';

export const PACKS_ROUTES = [
  'GET    /api/packs',
  'GET    /api/packs/:id/update',
  'POST   /api/packs/:id/update',
  'GET    /api/packs/:id/references',
  'DELETE /api/packs/:id',
  'POST   /api/packs/install',
] as const;

/** Is this a packs route? */
export function isPacksPath(path: string): boolean {
  const p = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  return p === '/api/packs' || p.startsWith('/api/packs/');
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const refuse = (status: number, error: string, hint?: string, extra?: object): ApiResponse => json(status, { error, ...(hint === undefined ? {} : { hint }), ...extra });

/** The plan as the API shows it: without the file writes. */
function shown<T extends { writes: unknown }>(plan: T): Omit<T, 'writes' | 'retiredRecords' | 'assets'> {
  const { writes: _writes, retiredRecords: _retired, assets: _assets, ...rest } = plan as T & { retiredRecords?: unknown; assets?: unknown };
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
  const why = plan.conflicts.length > 0 ? 'it clashes with records outside the pack' : 'it would add errors to the library';
  const hint = plan.conflicts.length > 0 ? 'Rename or remove the clashing records, then update again.' : 'The errors are listed; fix what they name, or keep the installed version.';
  return refuse(409, `Pack '${plan.pack.id}' was not updated: ${why}. Nothing was changed.`, hint, { plan: shown(plan) });
}

/** What only the server passes to an install (never the request body): where the pack came from, recorded in `packs.json`. */
export interface InstallInternal {
  origin?: InstalledPack['origin'];
  /**
   * A store install: the publisher keys whose signature the store verified, or
   * `unsigned` when the index names no publisher (then a pack with code is refused).
   */
  store?: { index: string; keys: string[] } | { index: string; unsigned: true };
  /** the host that loads code modules (the trial load before an install is applied); absent: a pack with code is refused */
  code?: CodeModuleHost;
}

/**
 * `/api/packs…`. Writes change files directly (the file backend) or the
 * scratch copy (`deps.transact`, Postgres), so the caller runs them under the
 * write lock.
 */
export async function handlePacksRequest(
  request: { method: string; path: string; body?: unknown; user?: StudioUser },
  deps: SetupDeps | undefined,
  modules: ModuleRegistry | undefined,
  internal: InstallInternal = {},
): Promise<ApiResponse> {
  if (deps === undefined) return refuse(501, 'This host has no pack management.', 'Catalog packs are installed by the deployment here.');
  const method = request.method.toUpperCase();
  const write = method !== 'GET' && method !== 'HEAD';
  if (deps.transact !== undefined) {
    const { transact, ...rest } = deps;
    return transact((dataDir, packsDir) => handlePacksRequest(request, { ...rest, dataDir, packsDir }, modules, internal), write);
  }
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '').map((p) => decodeURIComponent(p));
  const id = parts[2];
  const action = parts[3];
  if (parts.length > 4) return refuse(404, 'There is no such address.', `Packs answer ${PACKS_ROUTES.join(', ')}.`);

  const packsDir = packsDirOf(deps);
  const installed = installedAcross(deps.dataDir, packsDir);
  const view = viewOf(deps);

  if (id === 'install' && action === undefined) {
    if (method !== 'POST') return refuse(405, `${method} is not something this address accepts.`, 'It answers POST.');
    return installFromSource(request.body, deps, view, installed.packs, installed.where, internal, request.user);
  }

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
          ...(pack.origin === undefined ? {} : { origin: pack.origin }),
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
    // a pack with code is the owners' to remove, like it was theirs to install
    if (pack.module !== undefined && !isOwner(request.user)) return refuse(403, `Only an owner can remove ${id}: it carries the code module '${pack.module.id}'.`, 'Ask an owner; turning the module off is Settings, Code modules.');
    const plan: PackDisablePlan = planPackDisable(view, installed.packs, id);
    if (!plan.ok) {
      return refuse(409, `Pack '${id}' was not disabled: ${plan.references.length} record${plan.references.length === 1 ? '' : 's'} outside it still use${plan.references.length === 1 ? 's' : ''} its records.`, 'Change what uses them first (the references are listed), then disable the pack.', { plan: shown(plan) });
    }
    applyPackDisable(deps.dataDir, packsDir === deps.dataDir ? undefined : packsDir, id, plan, where);
    if (pack.module !== undefined) {
      const moduleId = pack.module.id;
      updateSettingsFile(deps.dataDir, (s) => {
        delete s.modules[moduleId];
      });
    }
    if (deps.afterInstall !== undefined) await deps.afterInstall();
    return json(200, { disabled: id, removed: plan.records.length, plan: shown(plan), ...(pack.module === undefined ? {} : { module: { id: pack.module.id, removed: true } }) });
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
    return json(200, { updated: true, from: plan.pack.from, to: plan.pack.to, retired: plan.retired.length, plan: shown(plan) });
  }

  return refuse(404, 'There is no such address.', `Packs answer ${PACKS_ROUTES.join(', ')}.`);
}

/** The pack bytes a request names: a URL fetched here, a base64 zip, or a JSON bundle. */
async function packBytesOf(body: { url?: unknown; zip?: unknown; bundle?: unknown }, deps: SetupDeps): Promise<Uint8Array> {
  const given = [body.url, body.zip, body.bundle].filter((v) => v !== undefined).length;
  if (given !== 1) throw new PackArchiveError('Give exactly one of "url", "zip" (base64) or "bundle".');
  if (body.url !== undefined) {
    if (typeof body.url !== 'string') throw new PackArchiveError('"url" is the address, as text.');
    return fetchPack(body.url, deps.packFetch);
  }
  if (body.zip !== undefined) {
    if (typeof body.zip !== 'string') throw new PackArchiveError('"zip" is the file, base64 encoded.');
    return new Uint8Array(Buffer.from(body.zip, 'base64'));
  }
  return new TextEncoder().encode(JSON.stringify(body.bundle));
}

/**
 * Install a pack nobody bundled: verify it like `verify-pack.mjs` (manifest, `src` on
 * every record, the library validates with it, no clashes), show the record-level diff,
 * and with `apply` install it as one change set — a new layer, or an update when the
 * pack is installed already (so `/api/packs/:id` update and disable work on it).
 */
async function installFromSource(rawBody: unknown, deps: SetupDeps, view: CatalogSource, installed: readonly InstalledPack[], where: ReadonlyMap<string, 'layer' | 'merged'>, internal: InstallInternal, user: StudioUser | undefined): Promise<ApiResponse> {
  const body = (typeof rawBody === 'object' && rawBody !== null ? rawBody : {}) as { url?: unknown; zip?: unknown; bundle?: unknown; apply?: unknown; sha256?: unknown; acceptMajor?: unknown; trustKey?: unknown; consent?: unknown };
  const dir = mkdtempSync(join(tmpdir(), 'wirehub-pack-'));
  try {
    let bytes: Uint8Array;
    let format: 'zip' | 'bundle';
    let pinProblems: string[] = [];
    let signed = false;
    let read: ReturnType<typeof readPackBytes>;
    try {
      bytes = await packBytesOf(body, deps);
      const digest = sha256(bytes);
      if (body.apply === true && typeof body.sha256 === 'string' && body.sha256 !== digest) {
        return refuse(409, 'The pack changed since you looked at it.', 'Preview it again, check the diff, then install.');
      }
      read = readPackBytes(bytes);
      format = read.format;
      signed = read.signature !== undefined;
      // a manifest that pins its files by sha256 (a signed pack's does) must agree with them
      const manifestBytes = read.shipped.get('wirehub-pack.json');
      if (manifestBytes !== undefined) {
        try {
          pinProblems = packFileProblems(JSON.parse(new TextDecoder().decode(manifestBytes)) as { files?: unknown }, read.shipped);
        } catch {
          // an unreadable manifest is reported by packSourceProblems below
        }
      }
      writePackFiles(dir, read.files);
    } catch (error) {
      if (error instanceof PackArchiveError) return refuse(error.status, error.message, 'A pack is a zip of its directory, or a JSON bundle ({ "manifest", "files" }); see the catalog-pack skill.');
      throw error;
    }
    const digest = sha256(bytes);
    const problems = [...pinProblems, ...packSourceProblems(dir)];
    if (problems.length > 0) {
      return refuse(422, `That is not a usable pack: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}.`, 'Nothing was installed. The problems are listed.', { verified: false, problems });
    }
    const manifest = readPackManifest(dir);
    // a pack that carries code: owners only, signed by a trusted key, an API this hub runs, and consent to apply
    const settings = readSettingsFile(deps.dataDir);
    const gate = codeGate({
      manifest,
      ...(read.signature === undefined ? {} : { signature: read.signature }),
      shipped: read.shipped,
      ...(user === undefined ? {} : { user }),
      ...(internal.store === undefined ? {} : { store: internal.store }),
      trustKey: body.trustKey,
      consent: body.consent,
      apply: body.apply === true,
      settings,
      allowedByEnv: codeModulesAllowedByEnv(process.env),
      builtins: internal.code?.builtins ?? [],
    });
    if (gate.kind === 'refused') return gate.response;
    if (gate.kind === 'code' && internal.code === undefined) return refuse(501, 'This host does not run code modules.', 'Nothing was installed.');
    const existing = installed.find((p) => p.id === manifest.id);
    // a pack with code replaces another's only through its owners, and only with the same module
    if (existing?.module !== undefined && gate.kind === 'code' && existing.module.id !== gate.preview.module.id) {
      return refuse(409, `Pack '${manifest.id}' carries module '${existing.module.id}' here; this version carries '${gate.preview.module.id}'.`, 'Remove the installed pack first.');
    }
    if (existing?.module !== undefined && gate.kind === 'data' && !isOwner(user)) {
      return refuse(403, `Only an owner can update ${manifest.id}: the installed version carries the code module '${existing.module.id}'.`, 'Nothing was installed.');
    }
    const packsDir = packsDirOf(deps);
    const layered = packsDir !== deps.dataDir;
    let plan: PackUpdatePlan | PackInstallPreview;
    try {
      plan = existing === undefined ? planNewPack(view, installed, dir) : planPackUpdate(view, installed, dir);
    } catch (error) {
      return refuse(422, error instanceof Error ? error.message : String(error));
    }
    const kind = existing === undefined ? 'install' : 'update';
    const same = 'direction' in plan && plan.direction === 'same';
    const major = 'major' in plan && plan.major;
    // a numbering scheme the pack offers is never switched on by installing it: Settings offers it, an owner confirms
    const offers = manifest.partNumberScheme === undefined ? {} : { offers: { partNumberScheme: manifest.partNumberScheme } };
    // what the database catalog's codec would refuse once the pack is in: said now, so a pack that previews
    // as applicable also applies on Postgres, and `adopt` / `pg:import` take what this installed
    const codec = same ? [] : packCodecProblems(join(deps.dataDir, '..'), layered ? packsDir : undefined, dir);
    const preview = { kind, source: format, sha256: digest, size: bytes.length, verified: true, signed, problems: codec, plan: shown(plan), applicable: plan.ok && !same && codec.length === 0, ...offers, ...(gate.kind === 'code' ? { code: gate.preview } : {}) };
    if (body.apply !== true) return json(200, preview);
    if (same) return json(200, { ...preview, installed: false, reason: 'already at this version' });
    if (codec.length > 0) {
      return refuse(422, `Pack '${manifest.id}' was not installed: the catalog cannot hold it (${codec[0]}${codec.length > 1 ? `, and ${codec.length - 1} more` : ''}).`, 'Nothing was installed. The problems are listed; fix what they name and try again.', { ...preview });
    }
    if (!plan.ok) {
      const refusal = plan.conflicts.length > 0 ? 'it clashes with records outside the pack' : 'it would add errors to the library';
      return refuse(409, `Pack '${manifest.id}' was not installed: ${refusal}. Nothing was changed.`, 'The details are listed; fix what they name and try again.', { ...preview });
    }
    if (major && body.acceptMajor !== true) {
      return refuse(409, `Pack '${manifest.id}' goes from ${(plan as PackUpdatePlan).pack.from} to ${manifest.version}, a major version: designs built on the old one can break.`, 'Read the diff, then install again with { "acceptMajor": true }.', { ...preview });
    }
    // the module is loaded once before anything is written: one that throws or clashes is never installed
    if (gate.kind === 'code' && internal.code !== undefined) {
      const server = read.files.get(`code/${gate.preview.module.id}/server.mjs`);
      const problems = server === undefined ? ['its server entry is missing'] : await internal.code.trial(manifest.module as unknown as CodeModuleManifest, server, sha256(server));
      if (problems.length > 0) return refuse(409, `${gate.preview.module.id} ${gate.preview.module.version} was not installed: it does not load (${problems.join('; ')}).`, 'Nothing was installed. Tell its publisher.', { ...preview, problems });
    }
    if (existing === undefined) {
      if (layered) installPackLayer(deps.dataDir, packsDir, dir);
      else installPack(deps.dataDir, dir);
    } else {
      applyPackUpdate(deps.dataDir, layered ? packsDir : undefined, dir, plan as PackUpdatePlan, where.get(manifest.id) ?? 'merged');
    }
    // where it came from: a store install records its index and signers; anything else leaves no origin
    const recordedIn = existing === undefined ? (layered ? packsDir : deps.dataDir) : (where.get(manifest.id) ?? 'merged') === 'layer' ? packsDir : deps.dataDir;
    setInstalledPackOrigin(recordedIn, manifest.id, internal.origin);
    if (gate.kind === 'code') {
      // how it was trusted, and the owner's consent as the module's enabled state (and the key they pinned)
      setInstalledModuleTrust(recordedIn, manifest.id, gate.trust);
      const now = new Date().toISOString();
      const by = user?.name ?? 'someone';
      const moduleId = gate.preview.module.id;
      const pin = gate.pin;
      updateSettingsFile(deps.dataDir, (s) => {
        s.modules[moduleId] = { enabled: true, by, on: now };
        if (pin !== undefined) s.keys.push({ key: pin, ...(manifest.publisher?.name === undefined ? {} : { label: manifest.publisher.name }), by, on: now });
      });
    }
    if (deps.afterInstall !== undefined) await deps.afterInstall();
    return json(200, { ...preview, installed: true, id: manifest.id, version: manifest.version });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
