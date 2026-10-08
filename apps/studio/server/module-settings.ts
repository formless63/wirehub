/**
 * Settings modules declare (`WireHubModule.settings`, module API 1.5; `specs/runtime-modules.md`
 * §8, `docs/modules.md` "Module settings"): mostly credentials — a supplier's API key, a client
 * secret — that an owner enters in Settings → Module settings instead of the deployment's
 * environment, so a key change needs no redeploy.
 *
 * They follow the runtime settings (`runtime-settings.ts`, `specs/runtime-settings.md`) exactly:
 *
 * - **Where.** A secret is a row of the settings secret store (`studio.settings_secret` on
 *   Postgres, `settings-secrets.json` on files) named `module.<module>.<key>`: AES-256-GCM under
 *   the install's `WIREHUB_SETTINGS_KEY`, the organisation and the name as additional data,
 *   rotated with every other secret. A non-secret value (which providers are on) is kept in
 *   the owner-only document `data/settings/modules.json` under `<module>.<key>`, which also
 *   records when each module secret was set — so the change history says *when*, never *what*.
 * - **Scope.** Per organisation, as every setting is: the catalog documents and the secret
 *   store are the organisation's (one on the file backend).
 * - **Precedence.** A declared `env` variable set on the server wins and is shown locked
 *   ("set by the server"); else the value saved here; else nothing.
 * - **Who.** Owners, in a signed-in session (no API token), as the owner-only groups; other
 *   people see only that the section exists. No value of a secret ever leaves the server.
 * - **Reading.** Module server code reads through `moduleSettingsFor` (`request.settings`,
 *   `context.settings`), never `process.env`: the next `get` after a save sees the new value,
 *   in every process (the document's change is a catalog notification).
 */

import type { ModuleRegistry, ModuleSettingContribution, ModuleSettings, WireHubModule } from '@wirehub/modules';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import type { Env } from './env.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import type { StudioUser } from './me.ts';
import { MODULE_SETTINGS_PATH, SETTINGS_SRC, envIsSet, type RuntimeSettings, type SettingValue, type SettingsDoc } from './runtime-settings.ts';
import { UnitOfWork } from './storage/unit-of-work.ts';

export { MODULE_SETTINGS_PATH };

export const MODULE_SETTINGS_ROUTES = [
  'PUT    /api/settings/modules/:module',
  'PUT    /api/settings/modules/:module/secrets/:key',
  'DELETE /api/settings/modules/:module/secrets/:key',
] as const;

const MAX_TEXT = 500;
const MAX_SECRET = 16_384;

/** The secret store's name of a module secret: `module.<module>.<key>`. */
export const moduleSecretName = (module: string, key: string): string => `module.${module}.${key}`;
/** The document's key of a module setting (its value, or when its secret was set): `<module>.<key>`. */
export const moduleDocKey = (module: string, key: string): string => `${module}.${key}`;
export const isSecretSetting = (setting: ModuleSettingContribution): boolean => (setting.kind ?? 'secret') === 'secret';

/** The modules that declare settings, in registry order. */
export function modulesWithSettings(registry: ModuleRegistry | undefined): WireHubModule[] {
  return (registry?.modules ?? []).filter((m) => (m.settings ?? []).length > 0);
}

export interface ResolvedModuleSetting {
  /** the value in effect, as text (a list comma-separated, a flag `true`/`false`) */
  value?: string;
  source: 'server' | 'settings' | 'default';
  /** a secret saved here that this server cannot decrypt */
  unreadable?: boolean;
}

const textOf = (value: SettingValue): string => (Array.isArray(value) ? value.join(',') : typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));

/** One declared setting as it stands: the server's variable, else what was saved here, else nothing. */
export function resolveModuleSetting(settings: RuntimeSettings | undefined, module: string, setting: ModuleSettingContribution, base: Env = settings?.base ?? process.env): ResolvedModuleSetting {
  if (setting.env !== undefined && envIsSet(base, setting.env)) return { value: (base[setting.env] as string).trim(), source: 'server' };
  if (isSecretSetting(setting)) {
    const name = moduleSecretName(module, setting.key);
    const value = settings?.secret(name);
    if (value !== undefined) return { value, source: 'settings' };
    return settings?.secretStates()[name] === 'unreadable' ? { source: 'default', unreadable: true } : { source: 'default' };
  }
  const saved = settings?.moduleDoc()?.values?.[moduleDocKey(module, setting.key)];
  return saved === undefined ? { source: 'default' } : { value: textOf(saved), source: 'settings' };
}

/**
 * What a module's server code is given (`request.settings`, `context.settings`): its own
 * declared settings, resolved at each call against the live registry and the live settings.
 * An undeclared key answers `undefined`; another module's settings are out of reach.
 */
export function moduleSettingsFor(module: string, registry: () => ModuleRegistry | undefined, settings: () => RuntimeSettings | undefined): ModuleSettings {
  return {
    async get(key) {
      const setting = registry()?.module(module)?.settings?.find((s) => s.key === key);
      return setting === undefined ? undefined : resolveModuleSetting(settings(), module, setting).value;
    },
  };
}

/* ------------------------------------------------------------------ *
 * The API
 * ------------------------------------------------------------------ */

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });
const isOwner = (user: StudioUser | undefined): boolean => user === undefined || user.role === undefined || user.role === 'owner';

function mayWrite(user: StudioUser | undefined): ApiResponse | undefined {
  if (user?.role === 'viewer') return fail(403, 'Your role can view these settings but not change them.', 'Ask an owner for the editor role.');
  if (!isOwner(user)) return fail(403, 'Module settings are changed by an owner.', 'Ask an owner of this hub.');
  if (user?.apiTokenId !== undefined) return fail(403, 'Module settings are changed in a signed-in session, not with an API token.');
  return undefined;
}

async function readModulesDoc(deps: Pick<WorkbenchDeps, 'docs'>): Promise<SettingsDoc | undefined> {
  const raw = await deps.docs?.read(MODULE_SETTINGS_PATH);
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as SettingsDoc) : undefined;
}

const sortKeys = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

const docOf = (values: Record<string, SettingValue>, secrets: Record<string, string>): SettingsDoc | undefined =>
  Object.keys(values).length === 0 && Object.keys(secrets).length === 0
    ? undefined
    : { ...(Object.keys(values).length === 0 ? {} : { values: sortKeys(values) }), ...(Object.keys(secrets).length === 0 ? {} : { secrets: sortKeys(secrets) }), src: SETTINGS_SRC };

/** One value from a request, checked against its declaration; `{}` = unset. */
export function readModuleValue(setting: ModuleSettingContribution, raw: unknown): { value?: SettingValue; error?: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  const bad = (why: string): { error: string } => ({ error: `${setting.label}: ${why}` });
  switch (setting.kind ?? 'secret') {
    case 'bool':
      return typeof raw === 'boolean' ? { value: raw } : bad('is on or off (true or false).');
    case 'list': {
      const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : undefined;
      if (items === undefined || items.some((v) => typeof v !== 'string')) return bad('is a list of words.');
      const list = [...new Set((items as string[]).map((v) => v.trim()).filter((v) => v !== ''))];
      const options = setting.options;
      const unknown = options === undefined ? list.filter((v) => !/^[A-Za-z0-9._-]{1,100}$/.test(v)) : list.filter((v) => !options.includes(v));
      if (unknown.length > 0) return bad(options === undefined ? 'takes words of letters, digits, dots, dashes and underscores.' : `takes ${options.join(', ')} (not ${unknown.join(', ')}).`);
      if (list.join(',').length > MAX_TEXT) return bad('is too long.');
      return list.length === 0 ? {} : { value: list };
    }
    default: {
      if (typeof raw !== 'string') return bad('is text.');
      const multiline = isSecretSetting(setting) && setting.multiline === true;
      const text = multiline ? raw.replace(/\r\n/g, '\n').trim() : raw.trim();
      if (text === '') return {};
      // eslint-disable-next-line no-control-regex
      if ((multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(text)) return bad('cannot contain control characters.');
      if (text.length > (isSecretSetting(setting) ? MAX_SECRET : MAX_TEXT)) return bad('is too long.');
      return { value: text };
    }
  }
}

/** The server's value as the page shows it (a list as a list, a flag as a flag); never a secret's. */
function shownEnvValue(setting: ModuleSettingContribution, raw: string): SettingValue {
  const text = raw.trim();
  if (setting.kind === 'bool') return /^(1|true|yes|on)$/i.test(text);
  if (setting.kind === 'list') return text.split(/[\s,]+/).filter((v) => v !== '');
  return text;
}

/**
 * The Module settings section of `GET /api/settings/runtime`: one entry per module that
 * declares settings, each field with where its value comes from. A secret answers only
 * whether it is set (and when); an owner sees non-secret values; everyone else sees the
 * declarations and that the section is the owner's.
 */
export async function moduleSettingsView(deps: WorkbenchDeps, settings: RuntimeSettings, user: StudioUser | undefined): Promise<Record<string, unknown>[]> {
  const modules = modulesWithSettings(deps.modules);
  if (modules.length === 0) return [];
  const doc = await readModulesDoc(deps);
  const restricted = !isOwner(user);
  const editable = mayWrite(user) === undefined;
  const etag = contentETag(doc ?? null);
  return modules.map((m) => ({
    module: m.id,
    title: m.label,
    editable,
    ...(restricted ? { restricted: true } : {}),
    etag,
    fields: (m.settings ?? []).map((setting) => {
      const secret = isSecretSetting(setting);
      const resolved = resolveModuleSetting(settings, m.id, setting);
      const view: Record<string, unknown> = {
        key: setting.key,
        label: setting.label,
        help: setting.help ?? '',
        kind: setting.kind ?? 'secret',
        ...(secret ? { secret: true } : {}),
        ...(setting.multiline === true ? { multiline: true } : {}),
        ...(setting.options === undefined ? {} : { options: setting.options }),
        ...(setting.required === true ? { required: true } : {}),
        ...(setting.gates === undefined ? {} : { gates: setting.gates }),
        ...(setting.env === undefined ? {} : { env: setting.env }),
        source: resolved.source,
      };
      if (restricted) return view;
      const docKey = moduleDocKey(m.id, setting.key);
      // configured / from the server (locked) / missing
      view['status'] = resolved.source === 'server' ? 'server' : resolved.value !== undefined ? 'configured' : setting.required === true ? 'missing' : 'unset';
      if (secret) {
        view['set'] = resolved.value !== undefined;
        if (resolved.unreadable === true) view['unreadable'] = true;
        const at = doc?.secrets?.[docKey];
        if (at !== undefined && resolved.source !== 'server') view['setAt'] = at;
        return view;
      }
      const saved = doc?.values?.[docKey];
      if (resolved.source === 'server') view['value'] = shownEnvValue(setting, settings.base[setting.env as string] as string);
      else if (saved !== undefined) view['value'] = saved;
      if (resolved.source === 'server' && saved !== undefined) view['saved'] = saved;
      return view;
    }),
  }));
}

/** `/api/settings/modules/<module>` or `/api/settings/modules/<module>/secrets/<key>` */
function modulePath(path: string): { module: string; key?: string } | undefined {
  const parts = (path.split('?')[0] ?? '').replace(/\/+$/, '').split('/').filter((p) => p !== '');
  if (parts[0] !== 'api' || parts[1] !== 'settings' || parts[2] !== 'modules' || parts[3] === undefined) return undefined;
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (parts.length === 4) return { module: decode(parts[3]) };
  if (parts.length === 6 && parts[4] === 'secrets') return { module: decode(parts[3]), key: decode(parts[5] as string) };
  return undefined;
}

export const isModuleSecretPath = (path: string): boolean => modulePath(path)?.key !== undefined;

const noSettings = (): ApiResponse => fail(501, 'This studio keeps no runtime settings.', 'They are set on the server, in its environment.');

/**
 * `PUT /api/settings/modules/<module>` `{ values }` (If-Match: the section's ETag): the
 * module's non-secret settings, replaced (a key left out is unset; one the server's
 * environment sets keeps what was saved). Runs in the router's unit of work.
 */
export async function handleModuleSettingsRequest(method: string, path: string, body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined, user: StudioUser | undefined): Promise<ApiResponse | undefined> {
  const target = modulePath(path);
  if (target === undefined || target.key !== undefined) return undefined;
  const settings = deps.runtimeSettings;
  if (settings === undefined || deps.docs === undefined) return noSettings();
  const module = modulesWithSettings(deps.modules).find((m) => m.id === target.module);
  if (module === undefined) return fail(404, `No installed module '${target.module}' declares settings.`);
  if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers PUT; GET /api/settings/runtime lists the module settings.');
  const refused = mayWrite(user);
  if (refused !== undefined) return refused;
  const current = await readModulesDoc(deps);
  const guard = checkIfMatch(ifMatch, contentETag(current ?? null), 'settings', 'modules');
  if (guard !== undefined) return guard;
  const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { values?: unknown }).values : undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'Send { "values": { "<key>": value, … } }; a key left out is unset.', `Secrets are set one by one: PUT /api/settings/modules/${module.id}/secrets/<key>.`);
  const given = input as Record<string, unknown>;
  const declared = module.settings ?? [];
  for (const key of Object.keys(given)) {
    const setting = declared.find((s) => s.key === key);
    if (setting === undefined) return fail(400, `'${key}' is not a setting of ${module.label}.`, `Its settings: ${declared.filter((s) => !isSecretSetting(s)).map((s) => s.key).join(', ') || 'secrets only'}.`);
    if (isSecretSetting(setting)) return fail(400, `${setting.label} is a secret: it is set on its own (PUT /api/settings/modules/${module.id}/secrets/${key}) and never sent back.`);
  }
  const values: Record<string, SettingValue> = Object.fromEntries(Object.entries(current?.values ?? {}).filter(([k]) => !k.startsWith(`${module.id}.`)));
  for (const setting of declared) {
    if (isSecretSetting(setting)) continue;
    const docKey = moduleDocKey(module.id, setting.key);
    const locked = setting.env !== undefined && envIsSet(settings.base, setting.env);
    const kept = current?.values?.[docKey];
    if (locked && !(setting.key in given)) {
      if (kept !== undefined) values[docKey] = kept;
      continue;
    }
    const got = readModuleValue(setting, given[setting.key]);
    if (got.error !== undefined) return fail(400, got.error);
    if (got.value === undefined) continue;
    if (locked && JSON.stringify(got.value) !== JSON.stringify(kept)) return fail(409, `${setting.label} is set by the server (${setting.env}); it cannot be changed here.`, 'Leave it out, or ask whoever runs the server to unset the variable.');
    values[docKey] = got.value;
  }
  const next = docOf(values, { ...(current?.secrets ?? {}) });
  if (next === undefined) await deps.docs.remove(MODULE_SETTINGS_PATH);
  else await deps.docs.write(MODULE_SETTINGS_PATH, next);
  const own = Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith(`${module.id}.`)).map(([k, v]) => [k.slice(module.id.length + 1), v]));
  return { status: 200, body: { module: module.id, values: own }, headers: { ETag: contentETag(next ?? null) } };
}

/**
 * `PUT` / `DELETE /api/settings/modules/<module>/secrets/<key>`: set or clear one module
 * secret, outside the router, as the runtime settings' secrets are
 * (`runtime-settings-api.ts`, `handleSettingsSecret`): the value goes to the encrypted store
 * first, then the document records when it was set as its own change set, whose request body
 * (the secret) is never handed to the commit; a commit that fails puts the old ciphertext back.
 * Runs under the write lock.
 */
export async function handleModuleSecret(
  request: { method: string; path: string; body?: unknown; user?: StudioUser },
  deps: WorkbenchDeps,
  commit: (uow: UnitOfWork, request: { method: string; path: string; user?: StudioUser }, response: ApiResponse) => Promise<ApiResponse>,
  now: () => string = () => new Date().toISOString(),
): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const target = modulePath(request.path);
  const settings = deps.runtimeSettings;
  if (settings === undefined || deps.docs === undefined) return noSettings();
  const module = modulesWithSettings(deps.modules).find((m) => m.id === target?.module);
  const setting = module?.settings?.find((s) => s.key === target?.key);
  if (module === undefined || setting === undefined || !isSecretSetting(setting)) {
    const secrets = (module?.settings ?? []).filter(isSecretSetting).map((s) => s.key);
    return fail(404, `'${target?.key ?? ''}' is not a secret setting of ${module?.label ?? `a module '${target?.module ?? ''}'`}.`, module === undefined ? undefined : `Its secrets: ${secrets.join(', ') || 'none'}.`);
  }
  if (method !== 'PUT' && method !== 'DELETE') return fail(405, `${method} is not something this address accepts.`, 'It answers PUT (set) and DELETE (clear); a secret is never read back.');
  const refused = mayWrite(request.user);
  if (refused !== undefined) return refused;
  if (setting.env !== undefined && envIsSet(settings.base, setting.env)) return fail(409, `${setting.label} is set by the server (${setting.env}); it cannot be changed here.`, 'Ask whoever runs the server to unset the variable first.');
  const store = settings.options.secrets();
  if (store === undefined) return fail(503, 'This hub has no secret store yet.', 'Finish first-run setup first.');
  const cipher = settings.cipher;
  if (method === 'PUT' && cipher === undefined) {
    return fail(409, 'This server has no settings key (WIREHUB_SETTINGS_KEY), so it cannot keep a secret entered here.', setting.env === undefined ? 'Give the server a settings key (the compose stack generates one).' : `Set ${setting.env} on the server instead, or give the server a settings key (the compose stack generates one).`);
  }
  let value: string | undefined;
  if (method === 'PUT') {
    const raw = typeof request.body === 'object' && request.body !== null ? (request.body as { value?: unknown }).value : undefined;
    if (typeof raw !== 'string' || raw.trim() === '') return fail(400, 'Send { "value": "…" }. To clear the secret, DELETE it.');
    const got = readModuleValue(setting, raw);
    if (got.error !== undefined) return fail(400, got.error);
    value = String(got.value);
  }
  const name = moduleSecretName(module.id, setting.key);
  const docKey = moduleDocKey(module.id, setting.key);
  const before = (await store.all())[name];
  if (value === undefined && before === undefined) return { status: 200, body: { module: module.id, key: setting.key, set: false } };
  if (value === undefined) await store.remove(name);
  else await store.put(name, (cipher as NonNullable<typeof cipher>).encrypt(settings.options.org(), name, value));
  const uow = new UnitOfWork(deps);
  const doc = await readModulesDoc(uow.deps);
  const secrets = { ...(doc?.secrets ?? {}) };
  if (value === undefined) delete secrets[docKey];
  else secrets[docKey] = now();
  const next = docOf({ ...(doc?.values ?? {}) }, secrets);
  if (next === undefined) await uow.deps.docs!.remove(MODULE_SETTINGS_PATH);
  else await uow.deps.docs!.write(MODULE_SETTINGS_PATH, next);
  const answer: ApiResponse = { status: 200, body: { module: module.id, key: setting.key, set: value !== undefined } };
  // never the body: it is the secret
  const committed = await commit(uow, { method, path: `/api/settings/modules/${module.id}/secrets/${setting.key}`, ...(request.user === undefined ? {} : { user: request.user }) }, answer);
  if (committed.status >= 400) {
    if (before === undefined) await store.remove(name);
    else await store.put(name, before);
  }
  await settings.refresh();
  return committed;
}
