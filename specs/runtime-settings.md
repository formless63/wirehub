# Spec — Runtime settings: what lives in the environment, what lives in Settings

Status: **built** (cs-gm8, 2026-10-05). Owner direction: *"Really most settings — redeploying
a stack should only be needed when fundamental install level changes are being made."*

## 1. The rule

A variable stays in the environment when the server needs it **before it can read its own
database**, or when it **wires the stack together**: where the database and the blob store are
and their credentials, the install's secrets, ports and bind address, the public address,
`WIREHUB_ENV`, the backend, which services and profiles run, mounts and paths. Everything else is
how the hub *behaves*, and is changed by its owner (or an editor) in **Settings**, applied at once,
with no restart and no redeploy.

`docs/self-hosting.md` ("What lives where") classifies every variable, with a reason each.

## 2. Precedence

Every runtime setting keeps its environment variable. For each one:

1. the **environment**, when the variable is set to something other than blank — it wins, and
   the page shows the value read-only as *set by the server (`NAME`)*. A deployment can still pin
   anything, and an owner locked out by a bad sign-in setting recovers by setting the variable;
2. else the value **saved in Settings**;
3. else the built-in default.

A value saved in Settings while the variable is set is kept (shown as *saved*) and applies again if
the variable goes. `WIREHUB_TEST_DEFAULTS` follows the same rule (v0.2.0, cs-26a), parameter by
parameter: a parameter the variable sets wins and the Testing section shows it read-only as *set by
the server (`WIREHUB_TEST_DEFAULTS`)*; the parameters it leaves out come from Settings, then the
built-in defaults. Changing a parameter the variable sets is refused (409); echoing the server's own
value is allowed (that is how it is adopted). This reverses the older "fallback Settings overrides".

### 2.1 Upgrading: the environment is honoured, and can be adopted

An upgraded hub whose runtime variables still reach the app (a `compose.override.yaml`) behaves
exactly as before: precedence rule 1 needs no click. `compose.yaml` itself no longer passes them
(cs-gm8), so the release notes (`docs/self-hosting.md`, "Upgrading to v0.2.0") carry the override
recipe, and three safety nets exist for a hub that upgrades without it:

- **Adopt the server's values** (`POST /api/settings/adopt`, a button in Settings, owners only, a signed-in
  session): every setting whose variable is set is copied into its group document, secrets into the
  encrypted store, `WIREHUB_TEST_DEFAULTS` into the engineering document's test defaults; one change set,
  the response names keys (never values) and any value the parsers would refuse (`skipped`). The variables
  keep winning while set; once dropped, nothing changes. `GET /api/settings/runtime` carries `adoptable`
  (owners): what the button would copy. Without `WIREHUB_SETTINGS_KEY` it refuses (409) rather than skip secrets.
- **The sign-in page says so when nobody can sign in**: no OIDC, no SMTP, no module provider, and email +
  password accounts that no live person has a password for (`PeopleStore.hasPasswordLogin`). It then
  names the way back (the override, the command below) instead of an unusable form.
- **`cli.ts owner-password [--email] [--org]`** (`server/pg/owner-password.ts`): sets an owner's email +
  password login from the server's shell (password on stdin or a hidden prompt, at least 12 characters;
  creates the Better Auth account or replaces the password and ends that person's sessions).

## 2.2 Owner-only documents stay with owners

The sign-in, notifications and integrations documents (`OWNER_ONLY_SETTINGS_PATHS`):

- `GET /api/export` omits them unless the caller is an owner, whose export lists them under `owner_only`;
- the git mirror (pg) never writes them (its tree is filtered; their change rows are not replayed) and the file
  backend's git export never stages them;
- history entries show a non-owner that the document changed (its name) but its before/after states are
  `{ known: false }` and not restorable. (Secrets are in no document, so none of this changes for them.)

## 3. Where the values are

The server reads every runtime setting through `RuntimeSettings.env()`
(`apps/studio/server/runtime-settings.ts`): the process environment with the saved values laid
under it, **under the same variable names**. Every reader therefore parses a setting the way it
always has (`notifierFromEnv`, `readAuthConfig`, `pdfEngineFromEnv`, `gitMirrorConfigFromEnv` …),
whatever its source, and a save is validated by the very same parsers on the environment as it
would be after the save.

Non-secret values are **catalog documents**, one per group:

| Group | Document | Who changes it |
| --- | --- | --- |
| Notifications | `data/settings/notifications.json` | owner |
| Sign-in & accounts | `data/settings/sign-in.json` | owner |
| Integrations (store options, PDF engine, git mirror) | `data/settings/integrations.json` | owner |
| Jobs & limits | `data/settings/jobs.json` | owner or editor |

`{ values: { "<area>.<name>": value }, secrets?: { "<key>": "<ISO time set>" }, src }`. They are
written through the unit of work like every other setting: `If-Match` on the group's ETag, both
backends, one change set in the history, in the export. The owner-only ones are not in anyone else's
export or in the git mirror (§2.2); Jobs & limits is in both. Owner-only groups refuse
editors, viewers and personal API tokens (security-sensitive settings are changed in a signed-in
session), and their values are not shown to anyone but an owner.

## 4. Secrets entered in Settings

The webhook URL (often a credential in itself), the webhook's bearer token, the OIDC client secret,
the SMTP password, and the git mirror's HTTPS token and SSH deploy key.

- **Never a catalog document.** The catalog is exported, git-mirrored and kept in the change
  history; none of those may carry a secret. A secret lives in a store of its own:
  `studio.settings_secret` on Postgres (migration 0019, org-scoped under RLS, no audit trigger),
  a JSON file of mode 0600 beside the sign-in data (`AUTH_DATA_DIR/settings-secrets.json`, outside
  the catalog directory) on files.
- **Encrypted at rest.** AES-256-GCM, with a key derived (HKDF-SHA256) from the install's
  `WIREHUB_SETTINGS_KEY` — generated by the stack's `bootstrap` into the `secrets` volume as
  `settings_key` (an existing install gains it on its next start). The organisation's id and the
  secret's name are the additional data: a value copied to another row or organisation does not
  decrypt. Stored form `v1.<iv>.<ciphertext>.<tag>` (base64url).
- **Write-only in the API.** `PUT /api/settings/secrets/<key>` `{ value }` sets it, `DELETE` clears
  it; nothing reads it back. `GET /api/settings/runtime` answers *set* or *not set* (and when).
- **Recorded, never revealed.** A set or clear also writes the group document's
  `secrets.<key>` (the time) as its own change set, so the history says *when* a secret changed and
  every process hears of it through the catalog notification. The secret goes to its store first;
  the request body is never handed to the commit, so no change, message or history entry carries
  it; a commit that fails puts the previous ciphertext back.
- **Without a key** (a hub run from source with no `WIREHUB_SETTINGS_KEY`), secrets cannot be
  saved in Settings — the page says so — and the environment still sets them. A stored secret that
  no longer decrypts (the key changed) is ignored and named in the page's problems; enter it again.
- **Rotation (cs-za5).** The cipher holds a key ring: `WIREHUB_SETTINGS_KEY` (current, the only key it
  writes with) and previous keys (`WIREHUB_SETTINGS_KEY_PREVIOUS`, comma separated, plus the secrets
  volume's `settings_key_previous`, one per line), tried in order when reading, so a hub started with
  the new key still reads everything. `rotateSecrets` re-encrypts each stored secret the current key does
  not open, by compare-and-swap on its old ciphertext (`SecretStore.swap`; a secret saved meanwhile is
  kept), with no downtime and no migration; a secret no key opens is left and named. Triggers: the
  owner-only, signed-in-session `POST /api/settings/rotate-key` (the Settings page's "Rotate key"; the
  page shows `secrets.keyRing` to owners: previous keys held, secrets still under one) and
  `server/settings-key-cli.ts rotate|status|generate`. The stack's `bootstrap` makes the new key
  (`WIREHUB_ROTATE_SETTINGS_KEY=1`, the old one retired into `settings_key_previous`) and drops the
  retired ones (`WIREHUB_DROP_PREVIOUS_SETTINGS_KEYS=1`). The operator's procedure is in
  `docs/self-hosting.md`, "Rotating the settings key".
- Backups: the ciphertext is in the database dump; the key is in the `secrets` volume. Keep a
  copy of `settings_key` with the restic password, or re-enter the secrets after a restore.

## 5. API

```
GET    /api/settings/runtime            groups, fields (source: server | settings | default), ETags, problems
PUT    /api/settings/runtime/<group>    { values } — a key left out is unset (If-Match)
PUT    /api/settings/secrets/<key>      { value } — write-only
DELETE /api/settings/secrets/<key>
POST   /api/settings/adopt              copy the server's values into Settings (owner, signed in) → { adopted, skipped }
POST   /api/settings/rotate-key         re-encrypt every stored secret under the current key (owner, signed in) → { total, rotated, current, skipped, unreadable, previousKeys }
```

## 6. Live apply

`RuntimeSettings.refresh()` re-reads the documents and the secrets. Every process follows the
catalog change notification (`follow(events)`: on Postgres the `LISTEN studio_catalog` of every
studio and of the worker; on files the in-process event hub), refreshes once a minute as a
fallback, and a save refreshes its own process before it answers. Then:

| What | How it applies |
| --- | --- |
| Notifications | `liveNotifier` rebuilds the webhook client when its URL, format or token change; the health monitor checks while one is set |
| Sign-in methods, allowed emails | `liveStudioAuth` rebuilds Better Auth in-process on the same database connection: signed-in sessions stay; a configuration that does not hold leaves the last working sign-in in place and says why. `AUTH_ENABLED`, `BETTER_AUTH_SECRET` and the public address stay install settings |
| API token budgets | read by the gate at each request |
| Store options | read at each request |
| PDF engine | `pdfEngineOf` / `livePdfEngine`, rebuilt when it changes |
| Git mirror | read at each run; the worker re-schedules (or unschedules) its cron, the in-process timer (`WIREHUB_WORKER=off`) checks each minute |
| Model build window | read at each run; the worker re-schedules the nightly sweep |
| Import size limit | read at each upload |
| Backup alert age | read by the deep health check and the backup watch at each run |
