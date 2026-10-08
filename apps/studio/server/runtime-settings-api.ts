/**
 * The runtime settings in the API (`runtime-settings.ts`, `specs/runtime-settings.md` §5):
 *
 *   GET    /api/settings/runtime             every group: its fields, where each value comes from
 *                                             (the server, Settings, or the default), a secret as set
 *                                             or not set, and the group's ETag
 *   PUT    /api/settings/runtime/<group>     replace the group's values (If-Match: the group's ETag)
 *   PUT    /api/settings/secrets/<key>       set a secret: { "value": "…" } — write-only
 *   DELETE /api/settings/secrets/<key>       clear it
 *   POST   /api/settings/adopt               copy the server's values (the environment's) into Settings
 *   POST   /api/settings/rotate-key          re-encrypt every stored secret under the current settings key (owner, signed in)
 *
 * Owner-only groups (sign-in, notifications, integrations) refuse everyone else, and API
 * tokens: they are changed in a signed-in session. Their values are not shown to editors or
 * viewers either. A setting the server's environment sets is read-only here ("set by the
 * server"); saving one is refused.
 *
 * A save is checked the way the server reads it — the same parsers, on the environment as it
 * would be — so a value the server would refuse is refused here, with the field's name.
 */

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import type { Env } from './env.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { parseWindow } from './jobs/model-cache.ts';
import type { StudioUser } from './me.ts';
import { notifierFromEnv } from './notify.ts';
import { pdfEngineFromEnv } from './render/browser-pdf.ts';
import {
  SETTINGS_SRC,
  SETTING_FIELDS,
  SETTING_GROUPS,
  envIsSet,
  envText,
  fieldByKey,
  groupById,
  readSettingsDoc,
  type RuntimeSettings,
  type SettingDef,
  type SettingGroup,
  type SettingValue,
  type SettingsDoc,
} from './runtime-settings.ts';
import { moduleSettingsView } from './module-settings.ts';
import { rotateSecrets, rotationStatus } from './settings-secrets.ts';
import { ENGINEERING_PATH, readEngineering } from './settings.ts';
import { UnitOfWork } from './storage/unit-of-work.ts';

export const RUNTIME_SETTINGS_ROUTES = [
  'GET    /api/settings/runtime',
  'PUT    /api/settings/runtime/:group',
  'PUT    /api/settings/secrets/:key',
  'DELETE /api/settings/secrets/:key',
  'POST   /api/settings/adopt',
  'POST   /api/settings/rotate-key',
] as const;

const MAX_TEXT = 500;
const MAX_MULTILINE = 16_384;

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });

const isOwner = (user: StudioUser | undefined): boolean => user === undefined || user.role === undefined || user.role === 'owner';
const mayRead = (group: SettingGroup, user: StudioUser | undefined): boolean => group.role === 'editor' || isOwner(user);

function mayWrite(group: SettingGroup, user: StudioUser | undefined): ApiResponse | undefined {
  if (user?.role === 'viewer') return fail(403, 'Your role can view these settings but not change them.', 'Ask an owner for the editor role.');
  if (group.role === 'owner' && !isOwner(user)) return fail(403, `${group.title} is changed by an owner.`, 'Ask an owner of this hub.');
  if (group.role === 'owner' && user?.apiTokenId !== undefined) return fail(403, `${group.title} is changed in a signed-in session, not with an API token.`);
  return undefined;
}

/** Variable names in a parser's sentence, replaced by the field labels a person sees. */
function inWords(message: string): string {
  let out = message;
  for (const field of [...SETTING_FIELDS].sort((a, b) => b.env.length - a.env.length)) {
    out = out.replace(new RegExp(`\\b${field.env}(_FILE)?\\b`, 'g'), `“${field.label}”`);
  }
  return out.replace(/^Auth is enabled \(AUTH_ENABLED=true\) but /, '');
}

/** One value from a request, checked against its field; `{ value: undefined }` = unset. */
function readValue(field: SettingDef, raw: unknown): { value?: SettingValue; error?: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  const bad = (why: string): { error: string } => ({ error: `${field.label}: ${why}` });
  switch (field.kind) {
    case 'bool':
      return typeof raw === 'boolean' ? { value: raw } : bad('is on or off (true or false).');
    case 'int': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : raw;
      if (typeof n !== 'number' || !Number.isInteger(n)) return bad('is a whole number.');
      if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) return bad(`is a whole number from ${field.min} to ${field.max}.`);
      return { value: n };
    }
    case 'list': {
      const items = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : undefined)?.map((v) => (typeof v === 'string' ? v.trim() : v));
      if (items === undefined || items.some((v) => typeof v !== 'string')) return bad('is a list of text.');
      const list = [...new Set((items as string[]).filter((v) => v !== ''))];
      if (list.join(',').length > MAX_MULTILINE) return bad('is too long.');
      return list.length === 0 ? {} : { value: list };
    }
    default: {
      if (typeof raw !== 'string') return bad('is text.');
      const text = field.kind === 'multiline' ? raw.replace(/\r\n/g, '\n').trim() : raw.trim();
      if (text === '') return {};
      // eslint-disable-next-line no-control-regex
      if ((field.kind === 'multiline' ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(text)) return bad('cannot contain control characters.');
      if (text.length > (field.kind === 'multiline' ? MAX_MULTILINE : MAX_TEXT)) return bad('is too long.');
      if (field.kind === 'enum' && !(field.options ?? []).includes(text)) return bad(`is one of ${(field.options ?? []).join(', ')}.`);
      if (field.kind === 'url') {
        try {
          const url = new URL(text);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return bad('is an http(s) URL.');
        } catch {
          return bad('is an http(s) URL.');
        }
      }
      if (field.kind === 'cron') {
        const parts = text.split(/\s+/);
        if (parts.length !== 5 || !parts.every((part) => /^[\d*/,-]+$/.test(part))) return bad('is a cron expression of five fields (minute hour day month weekday).');
      }
      if (field.kind === 'window' && parseWindow(text) === undefined) return bad('is a window HH:MM-HH:MM, for example 01:00-06:00.');
      return { value: field.kind === 'cron' ? text.replace(/\s+/g, ' ') : text };
    }
  }
}

/**
 * The group's whole configuration, checked the way the server reads it, on `env` (the
 * environment as it would be after the save). `undefined` when it holds.
 */
async function groupProblem(group: SettingGroup, env: Env, deps: WorkbenchDeps): Promise<string | undefined> {
  try {
    if (group.id === 'notifications') notifierFromEnv(env);
    // Auth defaults off when AUTH_ENABLED is unset; avoid initializing its filesystem
    // defaults then. Explicit flags still go through the parser, including invalid flags.
    // The sign-in's and the mirror's parsers resolve the server's own paths.
    const { authRequested, readAuthConfig } = group.id === 'sign-in' && envIsSet(env, 'AUTH_ENABLED') ? await import('./auth/config.ts') : { authRequested: () => false, readAuthConfig: () => undefined };
    if (group.id === 'sign-in' && authRequested(env)) {
      readAuthConfig(
        {
          ...env,
          // the install's own values are not this page's to judge: stand-ins when a test host has none
          ...(envIsSet(env, 'BETTER_AUTH_SECRET') ? {} : { BETTER_AUTH_SECRET: 'x'.repeat(32) }),
          ...(envIsSet(env, 'BETTER_AUTH_URL') ? {} : { BETTER_AUTH_URL: 'http://localhost' }),
        },
        { moduleProviders: deps.modules?.authProviders?.().length ?? 0 },
      );
    }
    if (group.id === 'integrations') {
      pdfEngineFromEnv(env);
      (await import('./history/mirror.ts')).gitMirrorConfigFromEnv(env);
    }
  } catch (error) {
    return inWords(error instanceof Error ? error.message : String(error));
  }
  return undefined;
}

/** `env` with the group's values (or one secret) replaced, for `groupProblem`. */
function candidateEnv(current: Env, base: Env, group: SettingGroup, values: Record<string, SettingValue> | undefined, secret?: { key: string; value: string | undefined }): Env {
  const out: Record<string, string | undefined> = { ...current };
  for (const field of group.fields) {
    if (envIsSet(base, field.env)) continue;
    if (field.secret === true) {
      if (secret?.key === field.key) {
        if (secret.value === undefined) delete out[field.env];
        else out[field.env] = secret.value;
      }
      continue;
    }
    if (values === undefined) continue;
    const value = values[field.key];
    if (value === undefined) delete out[field.env];
    else out[field.env] = envText(field, value);
  }
  return out;
}

function fieldView(field: SettingDef, doc: SettingsDoc | undefined, settings: RuntimeSettings, restricted: boolean): Record<string, unknown> {
  const base = settings.base;
  const locked = envIsSet(base, field.env);
  const view: Record<string, unknown> = {
    key: field.key,
    env: field.env,
    label: field.label,
    help: field.help,
    kind: field.kind,
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
    ...(field.defaultText === undefined ? {} : { defaultText: field.defaultText }),
    ...(field.secret === true ? { secret: true } : {}),
  };
  if (field.secret === true) {
    const state = settings.secretStates()[field.key];
    view['source'] = locked ? 'server' : state !== undefined ? 'settings' : 'default';
    if (restricted) return view;
    view['set'] = locked || state !== undefined;
    if (state === 'unreadable' && !locked) view['unreadable'] = true;
    const at = doc?.secrets?.[field.key];
    if (at !== undefined && !locked) view['setAt'] = at;
    return view;
  }
  const saved = doc?.values?.[field.key];
  view['source'] = locked ? 'server' : saved !== undefined ? 'settings' : 'default';
  if (restricted) return view;
  if (locked) view['value'] = shownEnvValue(field, base[field.env] as string);
  else if (saved !== undefined) view['value'] = saved;
  // a value saved here that the server's variable overrides: kept, and used again if the variable goes
  if (locked && saved !== undefined) view['saved'] = saved;
  return view;
}

/** The server's value as the page shows it (a list as a list, a flag as a flag). */
function shownEnvValue(field: SettingDef, raw: string): SettingValue {
  const text = raw.trim();
  if (field.kind === 'bool') return /^(1|true|yes|on)$/i.test(text);
  if (field.kind === 'list') return text.split(/[\s,]+/).filter((v) => v !== '');
  if (field.kind === 'int' && /^\d+$/.test(text)) return Number(text);
  return text;
}

async function groupsView(deps: WorkbenchDeps, settings: RuntimeSettings, user: StudioUser | undefined): Promise<Record<string, unknown>> {
  const groups = [];
  for (const group of SETTING_GROUPS) {
    const doc = await readSettingsDoc(deps.docs, group);
    const restricted = !mayRead(group, user);
    groups.push({
      id: group.id,
      title: group.title,
      intro: group.intro,
      applies: group.applies,
      role: group.role,
      editable: mayWrite(group, user) === undefined,
      ...(restricted ? { restricted: true } : {}),
      etag: contentETag(doc ?? null),
      fields: group.fields.map((f) => fieldView(f, doc, settings, restricted)),
    });
  }
  return {
    groups,
    // the settings installed modules declare (module-settings.ts): one section per module
    modules: await moduleSettingsView(deps, settings, user),
    secrets: settings.cipher === undefined
      ? { available: false, note: 'This server has no settings key (WIREHUB_SETTINGS_KEY), so secrets cannot be saved here; set them on the server instead. The compose stack generates the key.' }
      : { available: true, ...(await keyRingView(settings, user)) },
    ...(isOwner(user) && user?.apiTokenId === undefined ? { adoptable: await adoptable(deps, settings) } : {}),
    problems: settings.problems(),
    src: SETTINGS_SRC,
  };
}

/** For an owner: how the key ring stands (previous keys still read with, secrets not yet under the current key). */
async function keyRingView(settings: RuntimeSettings, user: StudioUser | undefined): Promise<{ keyRing?: { previousKeys: number; stale: number; unreadable: number } }> {
  const store = settings.options.secrets();
  const cipher = settings.cipher;
  if (!isOwner(user) || user?.apiTokenId !== undefined || store === undefined || cipher === undefined) return {};
  return { keyRing: { previousKeys: cipher.previousKeys, ...(await rotationStatus(store, cipher, settings.options.org())) } };
}

/** The settings the server's environment sets that Settings does not yet hold the same value for (labels, for the page). */
async function adoptable(deps: WorkbenchDeps, settings: RuntimeSettings): Promise<{ key: string; env: string; label: string }[]> {
  const out: { key: string; env: string; label: string }[] = [];
  const states = settings.secretStates();
  for (const group of SETTING_GROUPS) {
    const doc = await readSettingsDoc(deps.docs, group);
    for (const field of group.fields) {
      if (!envIsSet(settings.base, field.env)) continue;
      const held = field.secret === true ? states[field.key] === 'set' : JSON.stringify(doc?.values?.[field.key]) === JSON.stringify(shownEnvValue(field, settings.base[field.env] as string));
      // a secret already stored is not compared (it is write-only): it counts as held
      if (!held) out.push({ key: field.key, env: field.env, label: field.label });
    }
  }
  const fromServer = deps.testDefaults;
  if (fromServer !== undefined) {
    const saved = (await readEngineering(deps.docs))?.testDefaults as Record<string, number> | undefined;
    if (Object.entries(fromServer).some(([k, v]) => saved?.[k] !== v)) out.push({ key: 'testDefaults', env: 'WIREHUB_TEST_DEFAULTS', label: 'Continuity test defaults' });
  }
  return out;
}

const noSettings = (): ApiResponse => fail(501, 'This studio keeps no runtime settings.', 'They are set on the server, in its environment.');

/** `GET /api/settings/runtime`, `PUT /api/settings/runtime/<group>`: in the unit of work, like the other settings. */
export async function handleRuntimeSettingsRequest(method: string, parts: string[], body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined, user: StudioUser | undefined): Promise<ApiResponse | undefined> {
  if (parts[0] !== 'api' || parts[1] !== 'settings' || parts[2] !== 'runtime') return undefined;
  const settings = deps.runtimeSettings;
  if (settings === undefined || deps.docs === undefined) return noSettings();
  if (parts.length === 3) return method === 'GET' ? { status: 200, body: await groupsView(deps, settings, user) } : fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
  if (parts.length !== 4) return undefined;
  const group = groupById(parts[3] as string);
  if (group === undefined) return fail(404, `There is no settings group '${parts[3]}'.`, `The groups: ${SETTING_GROUPS.map((g) => g.id).join(', ')}.`);
  const current = await readSettingsDoc(deps.docs, group);
  const etag = contentETag(current ?? null);
  if (method === 'GET') {
    if (!mayRead(group, user)) return fail(403, `${group.title} is shown to owners.`);
    return { status: 200, body: { ...(current ?? { src: SETTINGS_SRC }) }, headers: { ETag: etag } };
  }
  if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
  const refused = mayWrite(group, user);
  if (refused !== undefined) return refused;
  const guard = checkIfMatch(ifMatch, etag, 'settings', group.id);
  if (guard !== undefined) return guard;
  const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { values?: unknown }).values : undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'Send { "values": { "<key>": value, … } }; a key left out is unset.', 'Secrets are set one by one: PUT /api/settings/secrets/<key>.');
  const given = input as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    const field = group.fields.find((f) => f.key === key);
    if (field === undefined) return fail(400, `'${key}' is not a setting of ${group.title}.`, `Its settings: ${group.fields.filter((f) => f.secret !== true).map((f) => f.key).join(', ')}.`);
    if (field.secret === true) return fail(400, `${field.label} is a secret: it is set on its own (PUT /api/settings/secrets/${field.key}) and never sent back.`);
  }
  const values: Record<string, SettingValue> = {};
  for (const field of group.fields) {
    if (field.secret === true) continue;
    const locked = envIsSet(settings.base, field.env);
    if (locked && !(field.key in given)) {
      // the server's variable wins; what was saved here is kept for when it goes
      const kept = current?.values?.[field.key];
      if (kept !== undefined) values[field.key] = kept;
      continue;
    }
    const got = readValue(field, given[field.key]);
    if (got.error !== undefined) return fail(400, got.error);
    if (got.value === undefined) continue;
    if (locked && JSON.stringify(got.value) !== JSON.stringify(current?.values?.[field.key])) {
      return fail(409, `${field.label} is set by the server (${field.env}); it cannot be changed here.`, 'Leave it out, or ask whoever runs the server to unset the variable.');
    }
    values[field.key] = got.value;
  }
  const problem = await groupProblem(group, candidateEnv(settings.env(), settings.base, group, values), deps);
  if (problem !== undefined) return fail(400, problem, 'Nothing was saved.');
  const next: SettingsDoc = { ...(Object.keys(values).length === 0 ? {} : { values: sortKeys(values) }), ...(current?.secrets === undefined || Object.keys(current.secrets).length === 0 ? {} : { secrets: current.secrets }), src: SETTINGS_SRC };
  const empty = next.values === undefined && next.secrets === undefined;
  if (empty) await deps.docs.remove(group.path);
  else await deps.docs.write(group.path, next);
  const saved = empty ? undefined : next;
  return { status: 200, body: { ...(saved ?? { src: SETTINGS_SRC }) }, headers: { ETag: contentETag(saved ?? null) } };
}

const sortKeys = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** `PUT`/`DELETE /api/settings/secrets/<key>` */
export function isSettingsSecretPath(path: string): boolean {
  return /^\/api\/settings\/secrets\/[^/?]+\/?$/.test(path.split('?')[0] ?? '');
}

/**
 * Set or clear one secret, outside the router: the value goes to the encrypted store, and
 * the group's document records when it was set — as its own change set, whose request
 * body (the secret) is never handed to the commit, so no history, message or export
 * carries it. Runs under the write lock.
 */
export async function handleSettingsSecret(
  request: { method: string; path: string; body?: unknown; user?: StudioUser },
  deps: WorkbenchDeps,
  commit: (uow: UnitOfWork, request: { method: string; path: string; user?: StudioUser }, response: ApiResponse) => Promise<ApiResponse>,
  now: () => string = () => new Date().toISOString(),
): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const key = decodeURIComponent((request.path.split('?')[0] ?? '').replace(/\/+$/, '').split('/').pop() ?? '');
  const settings = deps.runtimeSettings;
  if (settings === undefined || deps.docs === undefined) return noSettings();
  const field = fieldByKey(key);
  if (field === undefined || field.secret !== true) return fail(404, `'${key}' is not a secret setting.`, `The secrets: ${SETTING_FIELDS.filter((f) => f.secret === true).map((f) => f.key).join(', ')}.`);
  const group = groupById(field.group) as SettingGroup;
  if (method !== 'PUT' && method !== 'DELETE') return fail(405, `${method} is not something this address accepts.`, 'It answers PUT (set) and DELETE (clear); a secret is never read back.');
  const refused = mayWrite(group, request.user);
  if (refused !== undefined) return refused;
  if (envIsSet(settings.base, field.env)) return fail(409, `${field.label} is set by the server (${field.env}); it cannot be changed here.`);
  const store = settings.options.secrets();
  if (store === undefined) return fail(503, 'This hub has no secret store yet.', 'Finish first-run setup first.');
  const cipher = settings.cipher;
  if (method === 'PUT' && cipher === undefined) return fail(409, 'This server has no settings key (WIREHUB_SETTINGS_KEY), so it cannot keep a secret entered here.', `Set ${field.env} on the server instead, or give the server a settings key (the compose stack generates one).`);

  let value: string | undefined;
  if (method === 'PUT') {
    const raw = typeof request.body === 'object' && request.body !== null ? (request.body as { value?: unknown }).value : undefined;
    if (typeof raw !== 'string' || raw.trim() === '') return fail(400, 'Send { "value": "…" }. To clear the secret, DELETE it.');
    const got = readValue(field, raw);
    if (got.error !== undefined) return fail(400, got.error);
    value = String(got.value);
    if (field.key === 'mirror.sshKey' && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return fail(400, `${field.label}: paste the private key, from -----BEGIN … PRIVATE KEY----- to its END line.`);
  }
  const problem = await groupProblem(group, candidateEnv(settings.env(), settings.base, group, undefined, { key: field.key, value }), deps);
  if (problem !== undefined) return fail(400, problem, 'Nothing was saved.');

  const before = (await store.all())[field.key];
  if (value === undefined && before === undefined) return { status: 200, body: { key: field.key, set: false } };
  // the secret first; the document's marker is committed after, and a failed commit puts the secret back
  if (value === undefined) await store.remove(field.key);
  else await store.put(field.key, (cipher as NonNullable<typeof cipher>).encrypt(settings.options.org(), field.key, value));
  const uow = new UnitOfWork(deps);
  const doc = (await readSettingsDoc(uow.deps.docs, group)) ?? { src: SETTINGS_SRC };
  const secrets = { ...(doc.secrets ?? {}) };
  if (value === undefined) delete secrets[field.key];
  else secrets[field.key] = now();
  const next: SettingsDoc = { ...(doc.values === undefined ? {} : { values: doc.values }), ...(Object.keys(secrets).length === 0 ? {} : { secrets: sortKeys(secrets) }), src: SETTINGS_SRC };
  if (next.values === undefined && next.secrets === undefined) await uow.deps.docs!.remove(group.path);
  else await uow.deps.docs!.write(group.path, next);
  const answer: ApiResponse = { status: 200, body: { key: field.key, set: value !== undefined } };
  // never the body: it is the secret
  const committed = await commit(uow, { method, path: `/api/settings/secrets/${field.key}`, ...(request.user === undefined ? {} : { user: request.user }) }, answer);
  if (committed.status >= 400) {
    if (before === undefined) await store.remove(field.key);
    else await store.put(field.key, before);
  }
  await settings.refresh();
  return committed;
}

/** `POST /api/settings/rotate-key` */
export const isSettingsRotatePath = (path: string): boolean => (path.split('?')[0] ?? '').replace(/\/+$/, '') === '/api/settings/rotate-key';

/**
 * "Rotate key": re-encrypt every stored secret under the server's current settings key
 * (`WIREHUB_SETTINGS_KEY`), reading the old ones with the previous keys the server was given
 * (`WIREHUB_SETTINGS_KEY_PREVIOUS`, `docs/self-hosting.md` "Rotating the settings key"). Reads and
 * saves carry on while it runs. Owner only, in a signed-in session. The answer names how many
 * moved and which could not be read, never a value.
 */
export async function handleSettingsRotate(request: { method: string; path: string; user?: StudioUser }, deps: WorkbenchDeps): Promise<ApiResponse> {
  if (request.method.toUpperCase() !== 'POST') return fail(405, `${request.method} is not something this address accepts.`, 'It answers POST.');
  const settings = deps.runtimeSettings;
  if (settings === undefined) return noSettings();
  const user = request.user;
  if (user?.role === 'viewer' || !isOwner(user)) return fail(403, 'Rotating the settings key is done by an owner.', 'Ask an owner of this hub.');
  if (user?.apiTokenId !== undefined) return fail(403, 'Rotating the settings key is done in a signed-in session, not with an API token.');
  const cipher = settings.cipher;
  if (cipher === undefined) return fail(409, 'This server has no settings key (WIREHUB_SETTINGS_KEY), so there is nothing to rotate.', 'Give the server a settings key first.');
  const store = settings.options.secrets();
  if (store === undefined) return fail(503, 'This hub has no secret store yet.', 'Finish first-run setup first.');
  const report = await rotateSecrets(store, cipher, settings.options.org());
  await settings.refresh();
  return { status: 200, body: { ...report, previousKeys: cipher.previousKeys } };
}

/** `POST /api/settings/adopt` */
export const isSettingsAdoptPath = (path: string): boolean => (path.split('?')[0] ?? '').replace(/\/+$/, '') === '/api/settings/adopt';

/**
 * "Adopt the server's values": for an upgraded hub whose runtime settings are still given by
 * the environment. Every setting the environment sets is copied into Settings — plain values
 * into their group's document, secrets (encrypted) into the secret store — in one change set,
 * so the variables can then be dropped from the deployment and nothing changes. The variables
 * keep winning while they are set. Owner only, in a signed-in session. The response names
 * what was copied, never a value; the secrets are never handed to the commit.
 */
export async function handleSettingsAdopt(
  request: { method: string; path: string; user?: StudioUser },
  deps: WorkbenchDeps,
  commit: (uow: UnitOfWork, request: { method: string; path: string; user?: StudioUser }, response: ApiResponse) => Promise<ApiResponse>,
  now: () => string = () => new Date().toISOString(),
): Promise<ApiResponse> {
  if (request.method.toUpperCase() !== 'POST') return fail(405, `${request.method} is not something this address accepts.`, 'It answers POST.');
  const settings = deps.runtimeSettings;
  if (settings === undefined || deps.docs === undefined) return noSettings();
  const user = request.user;
  if (user?.role === 'viewer' || !isOwner(user)) return fail(403, 'Adopting the server’s values is done by an owner.', 'Ask an owner of this hub.');
  if (user?.apiTokenId !== undefined) return fail(403, 'Adopting the server’s values is done in a signed-in session, not with an API token.');
  const store = settings.options.secrets();
  const cipher = settings.cipher;
  const uow = new UnitOfWork(deps);
  const adopted: string[] = [];
  const skipped: { key: string; label: string; why: string }[] = [];
  const restore: (() => Promise<void>)[] = [];
  const secretsNeeded = SETTING_FIELDS.some((f) => f.secret === true && envIsSet(settings.base, f.env));
  if (secretsNeeded && store === undefined) return fail(503, 'This hub has no secret store yet.', 'Finish first-run setup first.');
  if (secretsNeeded && cipher === undefined) return fail(409, 'This server has no settings key (WIREHUB_SETTINGS_KEY), so it cannot keep the secrets entered here.', 'Give the server a settings key (the compose stack generates one), then adopt again.');
  const before = store === undefined ? {} : await store.all();
  try {
    for (const group of SETTING_GROUPS) {
      const doc = (await readSettingsDoc(uow.deps.docs, group)) ?? { src: SETTINGS_SRC };
      const values: Record<string, SettingValue> = { ...(doc.values ?? {}) };
      const secrets: Record<string, string> = { ...(doc.secrets ?? {}) };
      let changed = false;
      for (const field of group.fields) {
        if (!envIsSet(settings.base, field.env)) continue;
        const raw = settings.base[field.env] as string;
        if (field.secret === true) {
          const got = readValue(field, raw);
          if (got.error !== undefined || got.value === undefined) {
            skipped.push({ key: field.key, label: field.label, why: got.error ?? 'is empty' });
            continue;
          }
          const name = field.key;
          await (store as NonNullable<typeof store>).put(name, (cipher as NonNullable<typeof cipher>).encrypt(settings.options.org(), name, String(got.value)));
          restore.push(async () => {
            if (before[name] === undefined) await (store as NonNullable<typeof store>).remove(name);
            else await (store as NonNullable<typeof store>).put(name, before[name] as string);
          });
          secrets[name] = now();
          adopted.push(name);
          changed = true;
        } else {
          const got = readValue(field, shownEnvValue(field, raw));
          if (got.error !== undefined || got.value === undefined) {
            skipped.push({ key: field.key, label: field.label, why: got.error ?? 'is empty' });
            continue;
          }
          if (JSON.stringify(values[field.key]) === JSON.stringify(got.value)) continue;
          values[field.key] = got.value;
          adopted.push(field.key);
          changed = true;
        }
      }
      if (!changed) continue;
      const next: SettingsDoc = { ...(Object.keys(values).length === 0 ? {} : { values: sortKeys(values) }), ...(Object.keys(secrets).length === 0 ? {} : { secrets: sortKeys(secrets) }), src: SETTINGS_SRC };
      await uow.deps.docs!.write(group.path, next);
    }
  } catch (error) {
    for (const undo of restore) await undo().catch(() => {});
    throw error;
  }
  // WIREHUB_TEST_DEFAULTS: the parameters it sets, into the engineering settings' test defaults
  if (deps.testDefaults !== undefined) {
    const eng = await readEngineering(uow.deps.docs);
    const saved = (eng?.testDefaults ?? {}) as Record<string, number>;
    const merged = { ...saved, ...deps.testDefaults } as Record<string, number>;
    if (JSON.stringify(Object.entries(merged).sort()) !== JSON.stringify(Object.entries(saved).sort())) {
      await uow.deps.docs!.write(ENGINEERING_PATH, { ...(eng ?? { src: SETTINGS_SRC }), testDefaults: merged });
      adopted.push('testDefaults');
    }
  }
  const answer: ApiResponse = { status: 200, body: { adopted: adopted.sort(), skipped } };
  if (adopted.length === 0) return answer;
  // the secrets' values are not in the answer or the change set; only the keys and the time they were set
  const committed = await commit(uow, { method: 'POST', path: '/api/settings/adopt', ...(user === undefined ? {} : { user }) }, answer);
  if (committed.status >= 400) for (const undo of restore) await undo().catch(() => {});
  await settings.refresh();
  return committed;
}
