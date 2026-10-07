/**
 * Runtime settings (`specs/runtime-settings.md`): how the hub behaves, changed
 * in Settings by an owner or an editor and applied live — no redeploy. A
 * redeploy is for install-level changes only (where the database is, the
 * secrets, ports, which services run); `docs/self-hosting.md` ("What lives
 * where") says which is which, variable by variable.
 *
 * Every runtime setting keeps its environment variable. **A variable that is
 * set wins**: the page shows the value as "set by the server", read-only, so a
 * deployment can still pin anything. Otherwise the value saved in Settings
 * applies, else the built-in default.
 *
 * - The values are catalog documents, one per group
 *   (`data/settings/<group>.json`), written through the unit of work like the
 *   other settings: If-Match, both backends, a change set in the history.
 * - Secrets (a webhook URL, a token, a password, a key) are never in those
 *   documents: they are kept encrypted in a store of their own
 *   (`settings-secrets.ts`), and the document records only when each was set.
 *
 * The server reads them through `RuntimeSettings.env()`: the process
 * environment with the saved values laid under it, under the same variable
 * names — so every reader parses a setting the way it always has, whether it
 * came from the environment or from Settings. `refresh()` re-reads the
 * documents and the secrets; the host calls it on every catalog change
 * notification (`follow`), so a save in one process reaches the others.
 */

import type { Env } from './env.ts';
import type { EventHub } from './events.ts';
import type { SecretStore, SettingsCipher } from './settings-secrets.ts';
import type { DocStore } from './storage/doc-store.ts';

export type SettingKind = 'text' | 'multiline' | 'url' | 'bool' | 'int' | 'list' | 'enum' | 'cron' | 'window';

export interface SettingDef {
  /** `<area>.<name>`: the key in the group's document, and a secret's name */
  key: string;
  /** the environment variable that sets it on the server (and wins) */
  env: string;
  label: string;
  help: string;
  kind: SettingKind;
  /** kept encrypted, write-only (`settings-secrets.ts`) */
  secret?: boolean;
  options?: readonly string[];
  min?: number;
  max?: number;
  placeholder?: string;
  /** shown as the value when nothing sets it */
  defaultText?: string;
}

export type SettingGroupId = 'notifications' | 'sign-in' | 'integrations' | 'jobs';

export interface SettingGroup {
  id: SettingGroupId;
  title: string;
  intro: string;
  /** who may change it: owner-only groups also hide their values from everyone else */
  role: 'owner' | 'editor';
  path: string;
  /** when a change takes effect */
  applies: string;
  fields: readonly SettingDef[];
}

const LIVE = 'Applies at once, in every process of this hub; no restart.';

export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: 'notifications',
    title: 'Notifications',
    intro: 'Alerts (a stale backup, a failing blob store, failed jobs, an API token created …) are logged, and also posted to a webhook when one is set.',
    role: 'owner',
    path: 'data/settings/notifications.json',
    applies: LIVE,
    fields: [
      { key: 'notify.url', env: 'WIREHUB_NOTIFY_URL', label: 'Webhook URL', help: 'The address alerts are POSTed to (an ntfy topic, a chat webhook, your own receiver). Kept encrypted: a webhook URL is often a credential.', kind: 'url', secret: true, placeholder: 'https://ntfy.example.com/wirehub' },
      { key: 'notify.format', env: 'WIREHUB_NOTIFY_FORMAT', label: 'Format', help: 'json: one JSON event per alert; ntfy: text with title, priority and tags headers; slack: { text } for Slack, Mattermost and most chat webhooks.', kind: 'enum', options: ['json', 'ntfy', 'slack'], defaultText: 'json' },
      { key: 'notify.token', env: 'WIREHUB_NOTIFY_TOKEN', label: 'Access token', help: 'Sent as "Authorization: Bearer …" with every alert, for a receiver that asks for one (an ntfy access token). Kept encrypted.', kind: 'text', secret: true },
    ],
  },
  {
    id: 'sign-in',
    title: 'Sign-in & accounts',
    intro: 'How people sign in. Whether sign-in is on at all (AUTH_ENABLED), the public address and the session secret are install settings and stay on the server.',
    role: 'owner',
    path: 'data/settings/sign-in.json',
    applies: 'The sign-in reloads in this process when it is saved (people already signed in stay signed in); no restart.',
    fields: [
      { key: 'auth.localAccounts', env: 'AUTH_LOCAL_ACCOUNTS', label: 'Email + password accounts', help: 'People invited from People make a password. Turn off only when everyone signs in through the identity provider below.', kind: 'bool', defaultText: 'on with the database backend' },
      { key: 'auth.allowedEmails', env: 'AUTH_ALLOWED_EMAILS', label: 'Allowed emails', help: 'Emails that may sign in without an invitation, with the editor role (comma-separated).', kind: 'list', placeholder: 'you@example.com' },
      { key: 'github.enabled', env: 'AUTH_GITHUB_ENABLED', label: 'GitHub sign-in', help: 'Enable after setting the client id and encrypted client secret. Register PUBLIC_URL followed by /api/auth/callback/github as the callback URL in GitHub.', kind: 'bool', defaultText: 'off' },
      { key: 'github.clientId', env: 'AUTH_GITHUB_CLIENT_ID', label: 'GitHub client id', help: 'From the OAuth application you registered with GitHub. Credentials alone do not enable sign-in.', kind: 'text' },
      { key: 'github.clientSecret', env: 'AUTH_GITHUB_CLIENT_SECRET', label: 'GitHub client secret', help: 'Kept encrypted; never shown again. Required when GitHub sign-in is on.', kind: 'text', secret: true },
      { key: 'google.enabled', env: 'AUTH_GOOGLE_ENABLED', label: 'Google sign-in', help: 'Enable after setting the client id and encrypted client secret. Register PUBLIC_URL followed by /api/auth/callback/google as the callback URL in Google.', kind: 'bool', defaultText: 'off' },
      { key: 'google.clientId', env: 'AUTH_GOOGLE_CLIENT_ID', label: 'Google client id', help: 'From the OAuth application you registered with Google. Credentials alone do not enable sign-in.', kind: 'text' },
      { key: 'google.clientSecret', env: 'AUTH_GOOGLE_CLIENT_SECRET', label: 'Google client secret', help: 'Kept encrypted; never shown again. Required when Google sign-in is on.', kind: 'text', secret: true },
      { key: 'oidc.issuer', env: 'AUTH_OIDC_ISSUER', label: 'OIDC issuer', help: 'Single sign-on with any OpenID Connect provider (Authentik, Keycloak, Google, Entra …). Register the redirect URI <public address>/api/auth/callback/<provider id>.', kind: 'url', placeholder: 'https://id.example.com' },
      { key: 'oidc.clientId', env: 'AUTH_OIDC_CLIENT_ID', label: 'OIDC client id', help: 'From the client you made in the identity provider.', kind: 'text' },
      { key: 'oidc.clientSecret', env: 'AUTH_OIDC_CLIENT_SECRET', label: 'OIDC client secret', help: 'Kept encrypted; never shown again.', kind: 'text', secret: true },
      { key: 'oidc.scopes', env: 'AUTH_OIDC_SCOPES', label: 'OIDC scopes', help: 'Space- or comma-separated.', kind: 'text', defaultText: 'openid email profile' },
      { key: 'oidc.emailClaim', env: 'AUTH_OIDC_EMAIL_CLAIM', label: 'Email claim', help: 'The ID-token or userinfo claim used as the person’s hub email; set your provider’s custom claim here if its standard email differs. Connecting a provider requires the same email as your current hub account.', kind: 'text', defaultText: 'email' },
      { key: 'oidc.providerId', env: 'AUTH_OIDC_PROVIDER_ID', label: 'Provider id', help: 'Lowercase letters, digits and hyphens; the last part of the redirect URI.', kind: 'text', defaultText: 'oidc' },
      { key: 'oidc.name', env: 'AUTH_OIDC_NAME', label: 'Button label', help: '"Sign in with …" on the sign-in page.', kind: 'text', defaultText: 'Single sign-on' },
      { key: 'smtp.host', env: 'AUTH_SMTP_HOST', label: 'SMTP server', help: 'Magic-link sign-in: a link by email, the way in when the identity provider is down.', kind: 'text', placeholder: 'smtp.example.com' },
      { key: 'smtp.port', env: 'AUTH_SMTP_PORT', label: 'SMTP port', help: '465 with TLS, 587 with STARTTLS.', kind: 'int', min: 1, max: 65535, defaultText: '465 with TLS, else 587' },
      { key: 'smtp.secure', env: 'AUTH_SMTP_SECURE', label: 'SMTP over TLS', help: 'On: TLS from the start (465). Off: STARTTLS (587).', kind: 'bool', defaultText: 'on' },
      { key: 'smtp.user', env: 'AUTH_SMTP_USER', label: 'SMTP user', help: 'The account the mail is sent with.', kind: 'text' },
      { key: 'smtp.pass', env: 'AUTH_SMTP_PASS', label: 'SMTP password', help: 'Kept encrypted; never shown again.', kind: 'text', secret: true },
      { key: 'smtp.from', env: 'AUTH_SMTP_FROM', label: 'From address', help: 'The sender of sign-in links; empty uses the SMTP user.', kind: 'text', placeholder: 'wirehub@example.com' },
      { key: 'limits.tokenReadsPerMinute', env: 'WIREHUB_TOKEN_READS_PER_MINUTE', label: 'API token reads per minute', help: 'Requests one personal API token may read with each minute.', kind: 'int', min: 10, max: 100000, defaultText: '600' },
      { key: 'limits.tokenWritesPerMinute', env: 'WIREHUB_TOKEN_WRITES_PER_MINUTE', label: 'API token writes per minute', help: 'Changes one token may make each minute.', kind: 'int', min: 1, max: 10000, defaultText: '60' },
      { key: 'limits.tokenWritesPerDay', env: 'WIREHUB_TOKEN_WRITES_PER_DAY', label: 'API token writes per day', help: 'Changes one token may make in a day.', kind: 'int', min: 1, max: 1000000, defaultText: '1000' },
    ],
  },
  {
    id: 'integrations',
    title: 'Integrations',
    intro: 'What the hub talks to: the catalog store, the browser PDF engine and the git mirror of the history.',
    role: 'owner',
    path: 'data/settings/integrations.json',
    applies: `${LIVE} The git mirror's schedule moves at the worker's next settings refresh.`,
    fields: [
      { key: 'store.hideUnreviewed', env: 'WIREHUB_STORE_HIDE_UNREVIEWED', label: 'Store: reviewed versions only', help: 'Browse store lists and installs only pack versions an index marks reviewed (or flagged).', kind: 'bool', defaultText: 'off: every version, with its status' },
      { key: 'store.allowUserSources', env: 'WIREHUB_STORE_ALLOW_USER_SOURCES', label: 'Store: owners and editors may add stores', help: 'Off locks the hub to the stores the server names (WIREHUB_STORE_INDEXES).', kind: 'bool', defaultText: 'on' },
      { key: 'pdf.url', env: 'WIREHUB_PDF_ENGINE_URL', label: 'PDF engine URL', help: 'The browser PDF engine (Gotenberg) the sheets are printed with; with the stack’s pdf profile, http://pdf:3000. Empty: the plain text-layout PDFs.', kind: 'url', placeholder: 'http://pdf:3000' },
      { key: 'pdf.timeoutMs', env: 'WIREHUB_PDF_ENGINE_TIMEOUT_MS', label: 'PDF engine timeout (ms)', help: 'How long one conversion may take before the plain PDF is sent instead.', kind: 'int', min: 1000, max: 600000, defaultText: '30000' },
      { key: 'mirror.url', env: 'WIREHUB_GIT_MIRROR_URL', label: 'Git mirror remote', help: 'Every change set as a commit, pushed here (ssh:// or https://; never a password in the URL). A repository mounted into the worker is WIREHUB_GIT_MIRROR_PATH, on the server.', kind: 'text', placeholder: 'ssh://git@git.example.com/workshop/catalog.git' },
      { key: 'mirror.branch', env: 'WIREHUB_GIT_MIRROR_BRANCH', label: 'Git mirror branch', help: 'The branch it commits to.', kind: 'text', defaultText: 'main' },
      { key: 'mirror.cron', env: 'WIREHUB_GIT_MIRROR_CRON', label: 'Git mirror schedule', help: 'How often it looks for new change sets (cron, container time).', kind: 'cron', defaultText: '*/5 * * * *' },
      { key: 'mirror.user', env: 'WIREHUB_GIT_MIRROR_USER', label: 'Git mirror user (HTTPS)', help: 'The account name the host expects with the token.', kind: 'text', defaultText: 'wirehub' },
      { key: 'mirror.token', env: 'WIREHUB_GIT_MIRROR_TOKEN', label: 'Git mirror token (HTTPS)', help: 'An access token that may push. Kept encrypted.', kind: 'text', secret: true },
      { key: 'mirror.sshKey', env: 'WIREHUB_GIT_MIRROR_SSH_KEY', label: 'Git mirror deploy key (SSH)', help: 'A private key with write access to the remote. Kept encrypted.', kind: 'multiline', secret: true },
      { key: 'mirror.knownHosts', env: 'WIREHUB_GIT_MIRROR_KNOWN_HOSTS', label: 'Git mirror known hosts (SSH)', help: 'The host’s key line(s) (ssh-keyscan); recommended, so the push talks only to that host.', kind: 'multiline' },
    ],
  },
  {
    id: 'jobs',
    title: 'Jobs & limits',
    intro: 'Background work and size limits.',
    role: 'editor',
    path: 'data/settings/jobs.json',
    applies: `${LIVE} The worker moves its schedule at its next settings refresh.`,
    fields: [
      { key: 'jobs.convertWindow', env: 'WIREHUB_CONVERT_WINDOW', label: 'Model build window', help: 'Build imported 3D models only in this window (HH:MM-HH:MM, container time); a person’s own upload always converts at once.', kind: 'window', placeholder: '01:00-06:00', defaultText: 'any time' },
      { key: 'jobs.importMaxMb', env: 'WIREHUB_IMPORT_MAX_MB', label: 'Largest import file (MB)', help: 'The largest file a module import takes.', kind: 'int', min: 1, max: 2048, defaultText: '100' },
      { key: 'jobs.backupMaxAgeHours', env: 'WIREHUB_BACKUP_MAX_AGE_HOURS', label: 'Backup alert after (hours)', help: 'The deep health check and the backup watch alert when the newest backup is older than this.', kind: 'int', min: 2, max: 24 * 30, defaultText: '30' },
    ],
  },
];

export const SETTING_FIELDS: readonly (SettingDef & { group: SettingGroupId })[] = SETTING_GROUPS.flatMap((g) => g.fields.map((f) => ({ ...f, group: g.id })));

export const groupById = (id: string): SettingGroup | undefined => SETTING_GROUPS.find((g) => g.id === id);
export const fieldByKey = (key: string): (SettingDef & { group: SettingGroupId }) | undefined => SETTING_FIELDS.find((f) => f.key === key);

/**
 * The settings documents only an owner may see: sign-in & accounts, notifications and
 * integrations (they name identity providers, mail servers, webhooks and remotes). They are
 * left out of the export for everyone else, never reach the git mirror, and their history
 * bodies are shown to owners only.
 */
export const OWNER_ONLY_SETTINGS_PATHS: readonly string[] = [
  ...SETTING_GROUPS.filter((g) => g.role === 'owner').map((g) => g.path),
  // the outbound webhook subscriptions (`webhooks/subscriptions.ts`): URLs of outside systems, owner-only like the groups
  'data/settings/webhooks.json',
];

/** Whether `path` (`data/settings/sign-in.json`, or the same without `data/`) is an owner-only settings document. */
export const isOwnerOnlySettingsPath = (path: string): boolean => OWNER_ONLY_SETTINGS_PATHS.some((p) => path === p || p === `data/${path}`);

/** Whether some text (a history subject or label) names an owner-only settings document. */
export const namesOwnerOnlySettings = (text: string): boolean => OWNER_ONLY_SETTINGS_PATHS.some((p) => text.includes(p) || text.includes(p.replace(/^data\//, '')));

export type SettingValue = string | number | boolean | string[];

/** `data/settings/<group>.json` */
export interface SettingsDoc {
  /** the values saved in Settings, by key; secrets are never here */
  values?: Record<string, SettingValue>;
  /** when each secret of the group was last set (the value is in the secret store) */
  secrets?: Record<string, string>;
  src: string;
}

export const SETTINGS_SRC = 'Hub settings (entered in the app)';

/** An environment value counts as set when it is not blank (an `.env` line left empty sets nothing). */
export const envIsSet = (env: Env, name: string): boolean => (env[name] ?? '').trim() !== '';

export function envText(def: SettingDef, value: SettingValue): string {
  if (Array.isArray(value)) return value.join(',');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * The environment the server reads: `base` (the process environment), with
 * what was saved in Settings filled in for every variable `base` leaves unset.
 */
export function overlayEnv(base: Env, docs: Partial<Record<SettingGroupId, SettingsDoc | undefined>>, secrets: Readonly<Record<string, string>>): Env {
  const out: Record<string, string | undefined> = { ...base };
  for (const field of SETTING_FIELDS) {
    if (envIsSet(base, field.env)) continue;
    const value = field.secret === true ? secrets[field.key] : docs[field.group]?.values?.[field.key];
    if (value === undefined || value === '') continue;
    out[field.env] = envText(field, value);
  }
  return out;
}

export async function readSettingsDoc(docs: DocStore | undefined, group: SettingGroup): Promise<SettingsDoc | undefined> {
  if (docs === undefined) return undefined;
  const value = (await docs.read(group.path)) as SettingsDoc | undefined;
  return value !== undefined && typeof value === 'object' && value !== null ? value : undefined;
}

export type SecretState = 'set' | 'unreadable';

export interface RuntimeSettingsOptions {
  /** the process environment, `*_FILE` already resolved */
  env: Env;
  /** the catalog documents (absent while a database hub is in first-run setup) */
  docs: () => DocStore | undefined;
  /** the secret store (absent while there is no organisation) */
  secrets: () => SecretStore | undefined;
  /** what the secrets are bound to: the organisation's id (pg), `files` on the file backend */
  org: () => string;
  /** absent: no install key (`WIREHUB_SETTINGS_KEY`), so no secret can be saved or read in Settings */
  cipher?: SettingsCipher;
  log?: (line: string) => void;
}

export interface RuntimeSettings {
  /** the process environment, as it was given */
  readonly base: Env;
  readonly cipher: SettingsCipher | undefined;
  /** the environment the server reads now: `base` with the saved settings under it */
  env(): Env;
  /** bumps whenever `env()` changes */
  version(): number;
  /** re-read the documents and the secrets; resolves once `env()` reflects them */
  refresh(): Promise<void>;
  /** called after a refresh that changed `env()` */
  onChange(listener: (env: Env) => void): () => void;
  /** refresh on every catalog change: a settings save is one (a secret's too: its document records when it was set) */
  follow(events: EventHub | undefined): () => void;
  /** which secrets are stored, and whether they decrypt */
  secretStates(): Readonly<Record<string, SecretState>>;
  /** what could not be applied, in words (a secret that does not decrypt, a sign-in that did not rebuild …) */
  problems(): readonly string[];
  /** add a reader's own problem (the live sign-in's) to `problems()` */
  reportFrom(source: () => string | undefined): void;
  /** a value built from `env()`, rebuilt only when it changed */
  memo<T>(build: (env: Env) => T): () => T;
  readonly options: RuntimeSettingsOptions;
}

export function createRuntimeSettings(options: RuntimeSettingsOptions): RuntimeSettings {
  const log = options.log ?? ((line: string) => console.warn(line));
  let current: Env = options.env;
  let version = 0;
  let states: Record<string, SecretState> = {};
  let problems: string[] = [];
  const listeners = new Set<(env: Env) => void>();
  const sources: (() => string | undefined)[] = [];
  let running: Promise<void> | undefined;
  let again = false;

  const load = async (): Promise<void> => {
    const docs = options.docs();
    const read: Partial<Record<SettingGroupId, SettingsDoc | undefined>> = {};
    const found: string[] = [];
    for (const group of SETTING_GROUPS) {
      try {
        read[group.id] = await readSettingsDoc(docs, group);
      } catch (error) {
        found.push(`${group.title}: the saved settings could not be read (${error instanceof Error ? error.message : String(error)}).`);
      }
    }
    const plain: Record<string, string> = {};
    const nextStates: Record<string, SecretState> = {};
    const store = options.secrets();
    if (store !== undefined) {
      let rows: Record<string, string> = {};
      try {
        rows = await store.all();
      } catch (error) {
        found.push(`The saved secrets could not be read (${error instanceof Error ? error.message : String(error)}).`);
      }
      for (const [name, ciphertext] of Object.entries(rows)) {
        const value = options.cipher?.decrypt(options.org(), name, ciphertext);
        if (value === undefined) {
          nextStates[name] = 'unreadable';
          const label = SETTING_FIELDS.find((f) => f.key === name)?.label ?? name;
          found.push(
            options.cipher === undefined
              ? `${label} is saved, but this server has no settings key (WIREHUB_SETTINGS_KEY) to read it with.`
              : `${label} is saved but does not decrypt with this server's settings key or its previous keys (WIREHUB_SETTINGS_KEY changed without WIREHUB_SETTINGS_KEY_PREVIOUS?); enter it again.`,
          );
        } else {
          nextStates[name] = 'set';
          plain[name] = value;
        }
      }
    }
    const next = overlayEnv(options.env, read, plain);
    states = nextStates;
    if (problems.join('\n') !== found.join('\n')) for (const line of found) log(`[settings] ${line}`);
    problems = found;
    if (!sameEnv(next, current)) {
      current = next;
      version += 1;
      for (const listener of [...listeners]) {
        try {
          listener(current);
        } catch (error) {
          log(`[settings] a listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };

  const refresh = (): Promise<void> => {
    if (running !== undefined) {
      // one more pass after the one in flight, so a change made during it is seen
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await load();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  return {
    base: options.env,
    cipher: options.cipher,
    options,
    env: () => current,
    version: () => version,
    refresh,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    follow(events) {
      if (events === undefined) return () => {};
      return events.subscribe((event) => {
        if (event.type === 'catalog') void refresh().catch((error: unknown) => log(`[settings] refresh failed: ${error instanceof Error ? error.message : String(error)}`));
      });
    },
    secretStates: () => states,
    problems: () => [...problems, ...sources.map((source) => source()).filter((line): line is string => line !== undefined)],
    reportFrom(source) {
      sources.push(source);
    },
    memo<T>(build: (env: Env) => T): () => T {
      let at = -1;
      let value: T;
      return () => {
        if (at !== version) {
          value = build(current);
          at = version;
        }
        return value;
      };
    },
  };
}

function sameEnv(a: Env, b: Env): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/** The environment a reader should use: the live settings when the host has them, else the process's. */
export function runtimeEnv(deps: { runtimeSettings?: RuntimeSettings }): Env {
  return deps.runtimeSettings?.env() ?? process.env;
}

/** A settings service over the environment alone (no documents, no secrets): what a host without Settings reads. */
export function staticRuntimeSettings(env: Env): RuntimeSettings {
  return createRuntimeSettings({ env, docs: () => undefined, secrets: () => undefined, org: () => 'none' });
}

/** A whole-number setting, or `fallback` when it is unset or not a positive whole number. */
export function intSetting(env: Env, name: string, fallback: number): number {
  const text = (env[name] ?? '').trim();
  const n = Number(text);
  return text !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** `WIREHUB_BACKUP_MAX_AGE_HOURS` (default 30): when the backup checks call the newest backup stale. */
export const backupMaxAgeHours = (env: Env): number => intSetting(env, 'WIREHUB_BACKUP_MAX_AGE_HOURS', 30);

/** The per-token request budgets (`WIREHUB_TOKEN_*`; defaults 600 reads a minute, 60 writes a minute, 1000 a day). */
export function tokenLimits(env: Env): { read: { count: number; ms: number }[]; write: { count: number; ms: number }[] } {
  return {
    read: [{ count: intSetting(env, 'WIREHUB_TOKEN_READS_PER_MINUTE', 600), ms: 60_000 }],
    write: [
      { count: intSetting(env, 'WIREHUB_TOKEN_WRITES_PER_MINUTE', 60), ms: 60_000 },
      { count: intSetting(env, 'WIREHUB_TOKEN_WRITES_PER_DAY', 1000), ms: 86_400_000 },
    ],
  };
}
