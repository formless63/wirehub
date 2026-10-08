/**
 * The code-module and system routes (`specs/runtime-modules.md`):
 *
 *   GET    /api/code-modules                 the installed code modules and their state, the kill switch, pinned keys
 *   GET    /api/code-modules/browser         the browser entries the page should load (content-addressed, with integrity)
 *   GET    /api/code-modules/files/<sha>.mjs|.css   a loaded module's browser file (immutable)
 *   POST   /api/code-modules/<id>/enable     owner: trial-load, then enable (live, or at the next start)
 *   POST   /api/code-modules/<id>/disable    owner
 *   PUT    /api/code-modules/settings        owner: { allow }
 *   POST   /api/code-modules/keys            owner: pin a publisher key { key, label? }
 *   DELETE /api/code-modules/keys/<keyId>    owner
 *   GET    /api/system/boot                  { bootId, startedAt, restarting, supervised }
 *   POST   /api/system/restart               owner: 202 at once, then drain and exit with the restart code. The answer is
 *                                            { restarting, bootId, supervised, poll }: `bootId` is the process being replaced.
 *                                            Draining and the exit come after the answer, so a client polls `poll`
 *                                            (`GET /api/system/boot`) until `bootId` differs from this one and `restarting` is false
 *
 * Installing and updating a code module is installing a pack (`packs.ts`,
 * `store.ts`, with `trust.ts`'s gate); removing it is disabling the pack.
 * Writes go through the same path as a pack's: the catalog directory on files,
 * one change set on Postgres (`SetupDeps.transact`).
 */

import { normalStoreKey } from '@wirehub/catalog';
import { MODULE_API_VERSION } from '@wirehub/modules';

import { publishCatalog, type ApiResponse, type WorkbenchDeps } from '../api.ts';
import type { StudioUser } from '../me.ts';
import { codeModulesAllowedByEnv, isPinned, readSettingsFile, settingsOf, updateSettingsFile, CODE_MODULES_DOC, type CodeModuleSettings } from './state.ts';
import { isOwner, keyFacts } from './trust.ts';

export const CODE_MODULE_ROUTES = [
  'GET    /api/code-modules',
  'GET    /api/code-modules/browser',
  'GET    /api/code-modules/files/:file',
  'POST   /api/code-modules/:id/enable',
  'POST   /api/code-modules/:id/disable',
  'PUT    /api/code-modules/settings',
  'POST   /api/code-modules/keys',
  'DELETE /api/code-modules/keys/:keyId',
  'GET    /api/system/boot',
  'POST   /api/system/restart',
] as const;

export function isCodeModulesPath(path: string): boolean {
  const p = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  return p === '/api/code-modules' || p.startsWith('/api/code-modules/') || p === '/api/system' || p.startsWith('/api/system/');
}

const json = (status: number, body: unknown, headers?: Record<string, string>): ApiResponse => ({ status, body, ...(headers === undefined ? {} : { headers }) });
const refuse = (status: number, error: string, hint?: string, extra?: object): ApiResponse => json(status, { error, ...(hint === undefined ? {} : { hint }), ...extra });
const notOwner = (what: string): ApiResponse => refuse(403, `Only an owner can ${what}.`, 'Code modules run in the hub itself; an owner decides, in a signed-in session (never with an API token).');

/** Change the owners' document: on the catalog directory (files) or in one change set (Postgres). */
async function writeSettings(deps: WorkbenchDeps, change: (settings: CodeModuleSettings) => void): Promise<ApiResponse | undefined> {
  const setup = deps.setup;
  if (setup === undefined) return refuse(501, 'This host keeps no code-module settings.');
  if (setup.transact !== undefined) {
    const answer = await setup.transact(async (dataDir) => {
      updateSettingsFile(dataDir, change);
      return json(200, {});
    }, true);
    return answer.status >= 400 ? answer : undefined;
  }
  updateSettingsFile(setup.dataDir, change);
  await publishCatalog(deps);
  return undefined;
}

async function currentSettings(deps: WorkbenchDeps): Promise<CodeModuleSettings> {
  // the catalog directory on files (where the writes go), the catalog's documents on Postgres
  if (deps.setup !== undefined && deps.setup.transact === undefined && deps.setup.dataDir !== '') return readSettingsFile(deps.setup.dataDir);
  return settingsOf(await deps.docs?.read(CODE_MODULES_DOC));
}

/** `/api/code-modules…` and `/api/system…`; writes run under the write lock (the caller takes it). */
export async function handleCodeModulesRequest(request: { method: string; path: string; body?: unknown; user?: StudioUser }, deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '').map((p) => decodeURIComponent(p));
  const user = request.user ?? deps.localUser;
  const now = new Date().toISOString();
  const by = user?.name ?? 'someone';

  if (parts[1] === 'system') {
    const system = deps.system;
    if (parts[2] === 'boot' && parts.length === 3) {
      if (method !== 'GET') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET.');
      if (system === undefined) return json(200, { bootId: 'unknown', restarting: false, supervised: false });
      return json(200, { bootId: system.bootId, startedAt: system.startedAt, restarting: system.restarting(), supervised: system.supervised });
    }
    if (parts[2] === 'restart' && parts.length === 3) {
      if (method !== 'POST') return refuse(405, `${method} is not something this address accepts.`, 'It answers POST.');
      if (!isOwner(user)) return notOwner('restart WireHub');
      if (system === undefined) return refuse(501, 'This host cannot restart itself.', 'Restart the process the way it was started.');
      system.restart(by);
      return json(202, {
        restarting: true,
        // the process being replaced: the restart is done when `GET /api/system/boot` answers another id
        bootId: system.bootId,
        supervised: system.supervised,
        poll: '/api/system/boot',
        ...(system.supervised ? {} : { hint: 'No supervisor is declared: the process exits, and comes back only if something restarts it.' }),
      });
    }
    return refuse(404, 'There is no such address.', `This answers ${CODE_MODULE_ROUTES.join(', ')}.`);
  }

  const host = deps.codeModules;
  if (host === undefined) return refuse(501, 'This host does not run code modules.', 'The standalone server and the worker do.');
  const action = parts[2];

  if (action === undefined) {
    if (method !== 'GET') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET.');
    await host.sync();
    const settings = await currentSettings(deps);
    const env = codeModulesAllowedByEnv(process.env);
    return json(200, {
      apiVersion: MODULE_API_VERSION,
      allowed: { env, settings: settings.allow !== false, effective: env && settings.allow !== false },
      builtins: host.builtins,
      supervised: deps.system?.supervised ?? false,
      generation: host.generation,
      modules: host.status(),
      keys: settings.keys.flatMap((k) => {
        try {
          return [{ ...keyFacts(k.key), ...(k.label === undefined ? {} : { label: k.label }), ...(k.by === undefined ? {} : { by: k.by }), ...(k.on === undefined ? {} : { on: k.on }) }];
        } catch {
          return [];
        }
      }),
    });
  }

  if (action === 'browser' && parts.length === 3) {
    if (method !== 'GET') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET.');
    return json(200, await host.browser());
  }

  if (action === 'files' && parts.length === 4) {
    if (method !== 'GET') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const match = /^([0-9a-f]{64})\.(mjs|css)$/.exec(parts[3] ?? '');
    if (match === null) return refuse(404, 'There is no such file.');
    const found = await host.file(match[1] as string);
    if (found === undefined || found.mediaType.includes('css') !== (match[2] === 'css')) return refuse(404, 'No loaded module serves that file.', 'GET /api/code-modules/browser lists what the page may load.');
    return { status: 200, body: null, bytes: found.bytes, contentType: found.mediaType, headers: { ETag: `"${match[1] as string}"`, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } };
  }

  if (action === 'settings' && parts.length === 3) {
    if (method !== 'PUT') return refuse(405, `${method} is not something this address accepts.`, 'It answers PUT { "allow": true | false }.');
    if (!isOwner(user)) return notOwner('turn code modules on or off');
    const allow = (request.body as { allow?: unknown } | undefined)?.allow;
    if (typeof allow !== 'boolean') return refuse(400, '"allow" is true or false.');
    const failed = await writeSettings(deps, (s) => {
      s.allow = allow;
    });
    if (failed !== undefined) return failed;
    await host.sync();
    return json(200, { allow, modules: host.status() });
  }

  if (action === 'keys') {
    if (!isOwner(user)) return notOwner('change the trusted publisher keys');
    if (parts.length === 3 && method === 'POST') {
      const body = (request.body ?? {}) as { key?: unknown; label?: unknown };
      if (typeof body.key !== 'string') return refuse(400, '"key" is the publisher\'s public key (RW…).');
      let key: string;
      try {
        key = normalStoreKey(body.key);
      } catch {
        return refuse(400, 'That is not a minisign public key (RW…).');
      }
      if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 120)) return refuse(400, '"label" is a short text.');
      const settings = await currentSettings(deps);
      if (isPinned(settings, key)) return json(200, { pinned: keyFacts(key), already: true });
      const failed = await writeSettings(deps, (s) => {
        s.keys.push({ key, ...(typeof body.label === 'string' && body.label.trim() !== '' ? { label: body.label.trim() } : {}), by, on: now });
      });
      if (failed !== undefined) return failed;
      return json(201, { pinned: keyFacts(key) });
    }
    if (parts.length === 4 && method === 'DELETE') {
      const keyId = (parts[3] ?? '').toUpperCase();
      const settings = await currentSettings(deps);
      const kept = settings.keys.filter((k) => {
        try {
          return keyFacts(k.key).keyId.toUpperCase() !== keyId;
        } catch {
          return true;
        }
      });
      if (kept.length === settings.keys.length) return refuse(404, `No pinned key has the id ${keyId}.`);
      const failed = await writeSettings(deps, (s) => {
        s.keys = kept;
      });
      if (failed !== undefined) return failed;
      return json(200, { removed: keyId, note: 'Modules installed with that key keep running; it is no longer trusted for new uploads.' });
    }
    return refuse(405, `${method} is not something this address accepts.`, 'Keys answer POST /api/code-modules/keys and DELETE /api/code-modules/keys/<keyId>.');
  }

  const id = action;
  const verb = parts[3];
  if (parts.length === 4 && (verb === 'enable' || verb === 'disable')) {
    if (method !== 'POST') return refuse(405, `${method} is not something this address accepts.`, 'It answers POST.');
    if (!isOwner(user)) return notOwner(`${verb} a code module`);
    await host.sync();
    const status = host.status().find((s) => s.id === id);
    if (status === undefined) return refuse(404, `No code module '${id}' is installed.`, 'GET /api/code-modules lists them; install one as a pack.');
    if (verb === 'enable') {
      const allowed = await host.allowed();
      if (!allowed.env) return refuse(403, 'Code modules are turned off on this hub by the server (WIREHUB_ALLOW_CODE_MODULES=false).');
      if (!allowed.settings) return refuse(403, 'Code modules are turned off in Settings (Code modules, Allow code modules).', 'Turn them on first.');
      if (status.enabled && status.state === 'loaded') return json(200, { module: status, apply: status.apply, changed: false });
      // the module is loaded once before it is recorded as enabled: a module that throws is never left enabled by a click
      const problems = await host.trialInstalled(id);
      if (problems.length > 0) return refuse(409, `${id} ${status.version} was not enabled: ${problems.join('; ')}.`, 'Nothing was changed. Install a version that loads, or tell its publisher.', { problems });
    }
    const failed = await writeSettings(deps, (s) => {
      s.modules[id] = { enabled: verb === 'enable', by, on: now };
    });
    if (failed !== undefined) return failed;
    await host.sync();
    const after = host.status().find((s) => s.id === id);
    return json(200, { module: after, apply: status.apply, changed: true });
  }

  return refuse(404, 'There is no such address.', `This answers ${CODE_MODULE_ROUTES.join(', ')}.`);
}
