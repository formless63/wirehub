# Self-hosting WireHub

WireHub runs from **one file**, `compose.yaml`. You do not need to clone the
repository, write a `.env` or generate a secret: the stack does that itself
on first start.

> **The first release (v0.1.0) is not tagged yet.** The image
> `ghcr.io/formless63/wirehub:0.1.0` that `compose.yaml` names is published
> when it is. Until then, build the image yourself ("Development" below).

## Install

### With a terminal

```
mkdir wirehub && cd wirehub
curl -fsSLO https://raw.githubusercontent.com/formless63/wirehub/main/compose.yaml
docker compose up -d
docker compose logs wirehub        # the first-run setup code
```

Open <http://localhost:5183/setup>, enter the setup code, name your
organisation, create your admin account (email and password), choose the
starter catalog or an empty one, pick the domain modules you need, and you
are signed in.

### With a Docker UI (Portainer, Komodo, Dockhand …)

1. Create a stack and paste the contents of
   [`compose.yaml`](https://raw.githubusercontent.com/formless63/wirehub/main/compose.yaml).
2. Leave the environment empty — or paste the lines you want from
   [`.env.example`](https://raw.githubusercontent.com/formless63/wirehub/main/.env.example)
   (the public URL, a port, `COMPOSE_PROFILES=backup` …).
3. Deploy.
4. Open the **logs of the `wirehub` container**. Once it has started it prints
   a box like this:

   ```
   ==============================================================
     WireHub first-run setup

     Open http://localhost:5183/setup and enter the setup code:

         ABCD-EFGH-JKMN

     It is asked once, until setup is finished.
   ==============================================================
   ```

5. Open that address, enter the code, and fill in the organisation and your
   admin account.

The app's port binds to `127.0.0.1` by default. On a server you reach over the
network, set `WIREHUB_BIND=0.0.0.0` (or, better, publish it through your
reverse proxy) and `WIREHUB_PUBLIC_URL` to the address people open.

### The config generator

**<https://formless63.github.io/wirehub/generator/>** writes a `compose.yaml` and a
`.env` from a few choices: the public URL and ports, your own PostgreSQL or
S3 instead of the bundled ones, backups, the image tag, and the
domain modules to suggest at setup. It runs entirely in your browser — the
page makes no network request at all, and the same result is possible
without it (download the files and let the stack generate its secrets, or
use the terminal script below). Its default output is this repository's
`compose.yaml`, byte for byte.

### First-run setup

On a new hub, `/setup` (and nothing else — every other address waits until
it is done) asks for:

1. the **setup code** from the log;
2. the **organisation**: its name and a short name;
3. the **admin**: your name, email and a password (12 characters or more).
   Single sign-on is usually added afterwards, under Settings > Sign-in &
   accounts. A hub that must never have a password from the start sets
   `AUTH_LOCAL_ACCOUNTS=false` and a configured GitHub, Google or OIDC
   provider on the server for its first start (in a `compose.override.yaml`);
   setup records the owner email the provider knows you by, then asks you
   to sign in through that provider;
4. the **catalog**: the starter catalog (example cables and the parts they
   use) or an empty one (the base vocabulary only);
5. the **domain modules** (below).

Finishing creates all of it in the database. Password setup signs you in
and opens the studio; provider-only setup finishes through provider sign-in. Invite the others from **People** (the people icon in the left rail;
`/settings/people`): each invitation is a link you send, valid for 7 days,
with the role you chose — **owner** (manages people), **editor** (changes the
catalog) or **viewer** (reads).

`/setup` lists every bundled domain module — **PC & serial**, **Networking**,
**Pro audio**, **AV / video**, **Automotive** — with what it adds. None is
ticked unless the deployment suggested it (`WIREHUB_SUGGESTED_MODULES`, which
the generator writes); you decide. More can be enabled later from the
command palette. A module's catalog pack is installed into the `packs`
volume on the file backend; on the database backend its records join the
catalog like any other.

The setup code is asked only while setup has not been finished, so a hub
exposed by mistake cannot be set up by a stranger. It is generated once and
kept in the `secrets` volume; set `WIREHUB_SETUP_CODE` to choose your own.

## What runs

| Service | Image | What it does |
| --- | --- | --- |
| `bootstrap` | the app image | one-shot, first: fills the `secrets` volume (below) and writes Garage's config |
| `postgres` | `postgres:18.6-bookworm` | PostgreSQL 18, internal network only |
| `migrate` | the app image | one-shot: WireHub's database roles (`studio_owner`, `studio_app`, `studio_ro`), every pending migration, and once a catalog kept in files before the database moved in ("Upgrades") |
| `garage` | `dxflrs/garage:v2.4.1` | S3-compatible object store for uploaded files (photos, datasheets, 3D models), single node, internal only |
| `garage-init` | the app image | one-shot: Garage's layout, the bucket, and the app's and the backup's keys — **created by Garage** and written to the `secrets` volume |
| `wirehub` | `ghcr.io/formless63/wirehub` | the app: UI and API, the only published port |
| `worker` | the app image | background jobs ("Jobs" below): module imports, converting a STEP upload to a 3D model, building imported models, and housekeeping |
| `pdf` (profile `pdf`) | `gotenberg/gotenberg:8.37.0-chromium` | optional: the browser PDF engine that prints the HTML sheets to PDF ("Printed PDFs" below), internal only |

Every service waits for the ones it needs (`depends_on` with
`service_completed_successfully` / `service_healthy`), so one `up` brings the
whole stack up in order.

**What holds your data.** PostgreSQL (`pg_data`) holds the catalog, designs,
drawings, saved versions, the accounts, people and API tokens, and the
history of every save (who changed what, when). Uploaded file bytes are in
Garage. The `catalog`, `packs` and `auth` volumes hold a hub's files from
before the database (`WIREHUB_BACKEND=files`, still available for a small
single-user hub — see "Settings"); a new hub leaves them as they came.

**Memory.** Each service has a cap (`mem_limit`): the app 768 MiB, the worker
1.5 GiB, PostgreSQL 512 MiB, Garage 256 MiB, the one-shots less. The worker's
cap is sized for one STEP conversion at a time (they peak at about 1.1 GB);
a STEP that would need more than `WIREHUB_STEP_RSS_LIMIT_MB` (1280) is refused
with a sentence rather than taking the worker down. The whole stack fits a
machine with 2 GB of memory; 4 GB leaves room.

### Jobs: the `worker` service

Work that takes longer than a page load runs in the `worker` (the same image,
`server/worker.ts`): the app records a job in the database and the worker
picks it up (pg-boss, in the database's `pgboss` schema). Nothing to set up;
it waits while the hub is in first-run setup.

| Job | When | What it does |
| --- | --- | --- |
| `convert` | a person uploads a STEP model in the Library | converts it to GLB in a memory-capped child process; the upload waits for it and answers as before |
| `import` | a module import sent with `job: true` (`POST /api/modules/<module>/_import/<importer>`) | runs the importer over the catalog and keeps its **plan** — every record it would add, and the files that would change; `POST /api/jobs/<id>/publish` saves the plan as one change, or answers 409 when the catalog changed since the run |
| `model-cache` | at start, after a save that links an imported model, on request (`POST /api/jobs`) | builds every imported 3D model that is not built yet, from its source files (`WIREHUB_MODEL_SOURCES`, a folder you mount read-only, or a board's `.kicad_pcb` uploaded in the Library); a board's KiCad library models are fetched from kicad-packages3D at a pinned commit into the model cache (`WIREHUB_KICAD_LIBRARY_DIR` moves that copy; `WIREHUB_KICAD_LIBRARY_FETCH=0` keeps the worker offline, and a model it does not have is left off the board); a model whose source files are not mounted is reported as `unavailable` in the job result with a note, not as a failure, and raises no alert (an alert is for a model that could not be built from sources it has) |
| `derive` | at start and daily | recomputes derived records (the tag tables) only if something bypassed a save |
| `blob-gc` | daily at 04:30 | removes uploaded files nothing uses any more — only after 30 days, and only once a backup taken after that holds them — and rebuildable models no record shows |
| `backup` | hourly | looks at the backups (profile `backup`): marks what they hold and alerts when the newest dump is older than 30 hours (Settings > Jobs & limits) |
| `git-mirror` | only when configured (Settings > Integrations): at start and every 5 minutes, or its own schedule | writes each new change set as a git commit and pushes it (below, "History and the git mirror"); with `WIREHUB_WORKER=off` the studio runs it on a timer of its own, and a scheduled run that committed nothing leaves no row in the Jobs list |

`GET /api/jobs` lists recent jobs and the worker's last heartbeat (it beats
every minute; the container's health check reads it). One conversion runs at
a time; a model build window (Settings > Jobs & limits, for example
`01:00-06:00`) keeps the model builds (not a person's upload) to the night on
a small machine. Alerts (a stale backup, models that could not be built, a GC
error) go to the log, and to the webhook when one is set (Settings >
Notifications). That alert webhook is for the operator; to tell another system what happened in
WireHub (a version released, a number assigned), use **event webhooks** (Settings > Webhooks,
`docs/webhooks.md`), whose deliveries are jobs of kind `webhook` run by the worker with retries.

Without a worker, set `WIREHUB_WORKER=off` on the app and remove the
`worker` service: the app then runs the jobs itself, one at a time, and
converts STEP uploads in its own process (raise its `mem_limit` to 1.5 GiB).
The file backend (`WIREHUB_BACKEND=files`) always runs its jobs in the app.

### Secrets: the `secrets` volume

On first start, `bootstrap` generates every secret the stack needs and keeps
it in the `secrets` volume (mounted at `/run/wirehub`):

| File | What |
| --- | --- |
| `postgres_password` | the bundled Postgres's superuser (`POSTGRES_PASSWORD_FILE`) |
| `wirehub_owner_password`, `wirehub_app_password`, `wirehub_ro_password` | the database roles |
| `database_admin_url`, `database_owner_url`, `database_url`, `database_ro_url` | the connections, derived from the passwords on every start |
| `better_auth_secret` | the sign-in session secret |
| `settings_key` | encrypts the secrets entered in Settings (`WIREHUB_SETTINGS_KEY_FILE`); generated on the first start after an upgrade too |
| `settings_key_previous` | retired settings keys, only while a rotation is under way ("Rotating the settings key" under Settings) |
| `garage_rpc_secret`, `garage_admin_token` | Garage's |
| `s3_access_key_id`, `s3_secret_access_key`, `s3_backup_*` | the S3 keys Garage created (`garage-init`) |
| `setup_code` | the first-run setup code |
| `restic_password` | the backup repository's password (profile `backup`) |

The rules:

- **Generated once, never regenerated.** A restart, an upgrade or a re-deploy
  changes nothing.
- **An explicit value wins.** Set `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`,
  `WIREHUB_SETUP_CODE`, `DATABASE_ADMIN_URL`, the S3 keys … (or their `_FILE`
  forms, for Docker secrets) and it is used — and written to the volume, so
  the volume always holds what is in use.
- **Services read files, not values.** The app reads `NAME_FILE` for any
  variable (`S3_SECRET_ACCESS_KEY_FILE`, `DATABASE_URL_FILE` …), Postgres reads
  `POSTGRES_PASSWORD_FILE`, Garage its config. Nothing secret is written into
  `compose.yaml`.

To see a secret: `docker compose exec wirehub cat /run/wirehub/setup_code`
(or the container's console in your UI). The files are readable inside the
stack's containers only (mode 0644 inside the volume, because the services
run as different users).

**The terminal alternative.** If you would rather keep the secrets in a file
you control (a password manager, a re-deploy onto fresh volumes),
`scripts/setup-env.sh` writes a `.env` from `.env.example` with all of them
filled in:

```
curl -fsSLO https://raw.githubusercontent.com/formless63/wirehub/main/.env.example
curl -fsSLO https://raw.githubusercontent.com/formless63/wirehub/main/scripts/setup-env.sh
bash setup-env.sh
```

### Settings

**Most settings are in the app.** How the hub behaves — sign-in methods,
allowed emails, alerts, the git mirror, the PDF engine, job and size limits —
is changed under **Settings** by an owner (Jobs & limits also by an editor)
and applies at once, in every process of the hub, with no restart and no
redeploy. A redeploy is only for the install itself: where the database and
the files are, the secrets, ports, the public address, which services run.
The design is `specs/runtime-settings.md`.

Every runtime setting still has its variable, and **a variable that is set
wins**: Settings shows it read-only, "set by the server (`NAME`)". So a
deployment can still pin anything, and an owner who locks themselves out with
a sign-in setting recovers by setting the variable (for example
`AUTH_LOCAL_ACCOUNTS=true`). The default `compose.yaml` passes only the
install-level variables; to pin a runtime one, add it under the service's
`environment:` in a `compose.override.yaml` (the app's for sign-in, store and
PDF settings; the app's **and** the worker's for alerts, the git mirror and
job settings).

**Secrets entered in Settings** (the SMTP password, the OAuth/OIDC client secrets,
the webhook URL and token, the git mirror's token or key) are write-only:
the page shows "set" or "not set", never the value. They are kept encrypted
(AES-256-GCM) with the install's `settings_key` from the `secrets` volume,
apart from the catalog: never in the export, the git mirror or the change
history, which record only when one was set. Keep a copy of `settings_key`
with your backup password, or re-enter those secrets after a restore onto
fresh volumes.

**Rotating the settings key.** To replace `settings_key` (a suspected leak,
a routine change) without downtime or losing a secret: the app reads with a
key ring, the current key plus the previous ones
(`WIREHUB_SETTINGS_KEY_PREVIOUS`, comma separated, or the volume's
`settings_key_previous`, one per line), and always writes with the current one.

1. Make the new key. In the compose stack the bootstrap does it and retires the
   old one into `settings_key_previous`:

   ```
   docker compose run --rm -e WIREHUB_ROTATE_SETTINGS_KEY=1 bootstrap
   docker compose up -d
   ```

   (The second command restarts the app and the worker with both keys; every
   secret still reads, and a secret saved from now on is under the new key.)
   If you set `WIREHUB_SETTINGS_KEY` yourself in `.env`, put the new value there
   and `up -d`: the bootstrap retires the file's old key on its own. Outside
   compose, make a key with `pnpm --filter studio settings-key generate`, set it
   as `WIREHUB_SETTINGS_KEY` and the old one as `WIREHUB_SETTINGS_KEY_PREVIOUS`.
2. Re-encrypt what is stored, as an owner: **Settings > Rotate key** (it shows
   how many secrets are still under a previous key), or from the server's
   shell. Both swap each secret from its old ciphertext to the new in one step,
   so a hub in use keeps working, and a secret saved meanwhile is kept:

   ```
   docker compose exec wirehub node --experimental-strip-types --no-warnings \
     --import ./server/boot-env.ts server/settings-key-cli.ts rotate
   ```

   `settings-key-cli.ts status` counts the secrets under each key. Running it
   again does nothing. A secret no key reads is left as it is and named; enter
   it again in Settings.
3. When none is left under a previous key, drop the old key:
   `docker compose run --rm -e WIREHUB_DROP_PREVIOUS_SETTINGS_KEYS=1 bootstrap`
   then `docker compose up -d` (outside compose, remove
   `WIREHUB_SETTINGS_KEY_PREVIOUS`). Keep a copy of the new `settings_key`
   with your backup password.

Backups made before the rotation hold secrets under the old key; keep that key
as long as you might restore one.

**Who sees the sign-in, notification and integration settings.** Those three
documents (`data/settings/sign-in.json`, `notifications.json`,
`integrations.json`) name identity providers, mail servers, webhooks and
remotes, so they are owner-only everywhere: `GET /api/export` leaves them out
for editors and viewers (an owner's export includes them, listed under
`owner_only`), the git mirror and the file backend's git export never commit
them, and the history shows an editor that one changed but not what it held.
The webhook subscriptions (`data/settings/webhooks.json`, Settings > Webhooks) are owner-only in the
same way, and each one's signing secret is kept encrypted like the others above.

**Module settings.** A module may declare the settings it needs, mostly credentials (a
supplier's API key). Each installed one gets a section under **Settings > Module settings**,
for owners only: its secrets are set, replaced or cleared there and kept encrypted like the
others above (never shown again; *configured*, *set by the server* or *missing*), per
organisation; its other values are in the owner-only `data/settings/modules.json`. A variable a
module names (for example `WIREHUB_SUPPLIERS_MOUSER_KEY`) still wins when the app and the worker
have it, and the field shows it locked; unset it to manage the value in Settings.

The variables most people set in `.env` (every one is explained in `.env.example`):

| Variable | Default | |
| --- | --- | --- |
| `WIREHUB_PUBLIC_URL` | `http://localhost:<port>` | the address people open (sign-in links, the setup banner) |
| `WIREHUB_BIND`, `WIREHUB_PORT` | `127.0.0.1`, `5183` | where the app is published |
| `COMPOSE_PROFILES` | — | optional parts: `backup`, `pdf` (comma separated) |
| `WIREHUB_IMAGE` | the release `compose.yaml` came from | another tag, or a locally built image |
| `WIREHUB_TRUST_PROXY` | — | `1` behind a reverse proxy you trust |
| `TZ` | `UTC` | log timestamps, backup and job schedules |

#### What lives where

**(a) Install-level: stays in the environment.** Needed before the app can
read its database, wiring the stack together, or tied to a mount, a memory
cap or another container.

| Variable | Why it stays in the environment |
| --- | --- |
| `WIREHUB_IMAGE`, `COMPOSE_PROFILES` | choose the image and the services: Docker reads them, not the app |
| `WIREHUB_BIND`, `WIREHUB_PORT` (`HOST`, `PORT` inside the container) | the published socket, bound before anything is read |
| `WIREHUB_PUBLIC_URL` (`BETTER_AUTH_URL`) | the sign-in's base URL and cookie origin, fixed when the sign-in starts; the setup banner prints it before there is a database |
| `TZ` | the container clock every schedule runs on |
| `WIREHUB_ENV`, `WIREHUB_PROD_MARKERS` | the environment guard refuses to start a misconfigured instance before it touches a database |
| `WIREHUB_ALLOW_FILES_IN_PROD` | part of the same guard |
| `WIREHUB_BACKEND` | which store holds the settings themselves |
| `WIREHUB_ORG` | which organisation's settings to read |
| `WIREHUB_TRUST_PROXY` | decides who a client is (rate limits, origins) for every request, sign-in included; a security boundary of the network around the app |
| `AUTH_ENABLED` | whether anyone may edit without signing in; turning it off from inside the app would be an escalation |
| `AUTH_DATA_DIR` | a path in a volume |
| `BETTER_AUTH_SECRET` | signs every session; generated into the `secrets` volume |
| `WIREHUB_SETTINGS_KEY` | encrypts the secrets entered in Settings; it cannot live beside them |
| `WIREHUB_SETTINGS_KEY_PREVIOUS` | the old key(s) while rotating it (comma separated) |
| `WIREHUB_SETUP_CODE`, `WIREHUB_SETUP_PROMPT` | first-run setup, before there is an organisation (or a Settings page) |
| `WIREHUB_SUGGESTED_MODULES` | read only at first-run setup, before there is a Settings page; `/setup` itself lets you choose |
| `WIREHUB_LOCAL_USER` | who a hub with sign-in off names; sign-in off is itself an install choice |
| `DATABASE_ADMIN_URL`, `DATABASE_OWNER_URL`, `DATABASE_URL`, `DATABASE_RO_URL` | where the database is: needed to read anything |
| `POSTGRES_PASSWORD`, `WIREHUB_OWNER_PASSWORD`, `WIREHUB_APP_PASSWORD`, `WIREHUB_RO_PASSWORD`, `WIREHUB_DB_NAME` | the database's roles, created by `bootstrap` and `migrate` |
| `WIREHUB_BLOBS`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | where uploaded files are: needed to serve anything |
| `S3_BACKUP_ACCESS_KEY_ID`, `S3_BACKUP_SECRET_ACCESS_KEY` | the backup mirror's key, read by the `backup-mirror` container |
| `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_CAPACITY` | the bundled Garage's own configuration |
| `WIREHUB_WORKER` | whether the `worker` service exists |
| `WIREHUB_ALLOW_CODE_MODULES` | the server's kill switch for runtime code modules (default true; `false` wins over Settings > Code modules): what code an install may run is the operator's decision |
| `WIREHUB_RESTART_SUPERVISED` | declares that something restarts the app when it exits (compose: `restart: unless-stopped`), so Settings > Restart WireHub is offered as safe |
| `WIREHUB_MODULE_CACHE_DIR` | where the app and the worker write the code modules they import (default the system temp directory; a cache, rebuilt from the catalog at every start) |
| `WIREHUB_STEP_RSS_LIMIT_MB` | sized to the worker's `mem_limit` |
| `WIREHUB_MODEL_SOURCES`, `WIREHUB_MODEL_CACHE_DIR`, `WIREHUB_PACKS_DIR`, `WIREHUB_KICAD_LIBRARY_DIR` | paths of mounts and volumes |
| `WIREHUB_MODEL_PROFILE` | explicit profile for new Library model uploads and board-file imports: `exporter` (default), `occurrence` (source RGB), or `appearance` (source RGB and opacity); existing links retain their keyed profile |
| `WIREHUB_OCCT_STYLES_DIR`, `WIREHUB_OCCT_APPEARANCE_DIR` | separately mounted, verified optional reader artifacts on app and worker; build and licensing instructions in [occurrence reader](../apps/studio/occt/README.md) and [appearance reader](../apps/studio/occt-appearance/README.md); missing or invalid artifacts refuse the affected new CAD imports |
| `WIREHUB_KICAD_LIBRARY_FETCH` | whether the worker may reach the internet at all: an air-gap decision of the install |
| `WIREHUB_GIT_MIRROR_PATH`, `WIREHUB_GIT_MIRROR_DIR` | a repository mounted into the worker, its working clone's path |
| `WIREHUB_BACKUP_MARKER`, `WIREHUB_BACKUP_DIR` | paths of the backup volumes |
| `BACKUP_REPOSITORY`, `BACKUP_REPOSITORY_PASSWORD`, `BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY`, `BACKUP_SCHEDULE` | read by `backup-init` on first start; afterwards Backrest's own UI is where they change |
| `BACKUP_DUMP_AT`, `BACKUP_KEEP_DUMPS`, `BACKUP_CHECK_DAY`, `BACKUP_MIRROR_INTERVAL` | read by the `backup-dump` and `backup-mirror` containers, which have no database of settings |
| `BACKREST_BIND`, `BACKREST_PORT` | Backrest's published port |
| `WIREHUB_GIT_AUTOCOMMIT`, `WIREHUB_GIT_DIR`, `WIREHUB_GIT_REMOTE`, `WIREHUB_GIT_BRANCH` (and their old `STUDIO_*` names) | the file backend's git export, which pulls before the server starts |
| `WIREHUB_SECRETS_DIR` | where the stack's one-shots write the secrets |
| `WIREHUB_VERSION`, `WIREHUB_REVISION`, `WIREHUB_BLOB_VERIFY`, `WIREHUB_WORKER_BEAT_FILE`, `WIREHUB_DERIVE_CRON`, `WIREHUB_GC_CRON`, `WIREHUB_BACKUP_WATCH_CRON` | set by the image, or internal tuning for development and tests |
| `WIREHUB_API_URL`, `WIREHUB_API_TOKEN`, `WIREHUB_API_ENV`, `WIREHUB_PACK_SIGNING_KEY`, `WIREHUB_STORE_SIGNING_KEY` | read by the command-line tools on your machine, not by the server |

**(b) Runtime: set in Settings.** The variable still works and wins (a lock),
but is no longer in the default `compose.yaml`.

| Settings group | Variables | Why it is a runtime setting |
| --- | --- | --- |
| Notifications (owner) | `WIREHUB_NOTIFY_URL`\*, `WIREHUB_NOTIFY_FORMAT`, `WIREHUB_NOTIFY_TOKEN`\* | where alerts go is the owner's choice and changes with their tools |
| Sign-in & accounts (owner) | `AUTH_LOCAL_ACCOUNTS`, `AUTH_ALLOWED_EMAILS` | who may sign in is people management, like invitations |
| | `AUTH_GITHUB_ENABLED`, `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`\*, `AUTH_GOOGLE_ENABLED`, `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`\* | built-in GitHub and Google sign-in; disabled by default, configured by an owner without redeploying |
| | `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`\*, `AUTH_OIDC_SCOPES`, `AUTH_OIDC_EMAIL_CLAIM`, `AUTH_OIDC_PROVIDER_ID`, `AUTH_OIDC_NAME` | an identity provider is added or rotated without touching the stack; the sign-in rebuilds in-process, sessions stay |
| | `AUTH_SMTP_HOST`, `AUTH_SMTP_PORT`, `AUTH_SMTP_SECURE`, `AUTH_SMTP_USER`, `AUTH_SMTP_PASS`\*, `AUTH_SMTP_FROM` | the magic link's mail server, the same |
| | `WIREHUB_TOKEN_READS_PER_MINUTE`, `WIREHUB_TOKEN_WRITES_PER_MINUTE`, `WIREHUB_TOKEN_WRITES_PER_DAY` | API token budgets, tuned to how the hub's scripts work (new; were fixed) |
| Integrations (owner) | `WIREHUB_STORE_HIDE_UNREVIEWED`, `WIREHUB_STORE_ALLOW_USER_SOURCES` | the hub's trust policy for the catalog store, read at each request |
| | `WIREHUB_PDF_ENGINE_TIMEOUT_MS` | a tuning of the engine, read at each print |
| | `WIREHUB_GIT_MIRROR_URL`, `WIREHUB_GIT_MIRROR_BRANCH`, `WIREHUB_GIT_MIRROR_CRON`, `WIREHUB_GIT_MIRROR_USER`, `WIREHUB_GIT_MIRROR_TOKEN`\*, `WIREHUB_GIT_MIRROR_SSH_KEY`\*, `WIREHUB_GIT_MIRROR_KNOWN_HOSTS` | a remote and its credentials need no mount; the worker re-schedules when they change |
| Jobs & limits (editor) | `WIREHUB_CONVERT_WINDOW` | when the night's model builds run; the worker re-schedules |
| | `WIREHUB_IMPORT_MAX_MB` | the largest import file, read at each upload |
| | `WIREHUB_BACKUP_MAX_AGE_HOURS` | when a backup counts as stale for the health check and the backup watch (new; was fixed at 30) |
| | `WIREHUB_WEBHOOK_BACKOFF` | seconds to wait before each retry of a failed event webhook, comma-separated, at most five (default `30,120,600,3600,21600`; `docs/webhooks.md`); an environment variable only, there is no Settings field for it |

| Module settings (owner) | each installed module's declared settings, for example the optional suppliers module's `WIREHUB_SUPPLIERS_PROVIDERS`, `WIREHUB_SUPPLIERS_MOUSER_KEY`\*, `WIREHUB_SUPPLIERS_DIGIKEY_CLIENT_ID`\*, `WIREHUB_SUPPLIERS_DIGIKEY_CLIENT_SECRET`\*, `WIREHUB_SUPPLIERS_DIGIKEY_ACCOUNT_ID`\*, `WIREHUB_SUPPLIERS_LCSC_KEY`\*, `WIREHUB_SUPPLIERS_LCSC_SECRET`\* | a module's API keys and switches are the owner's account details, entered per organisation and changed without a redeploy; the module reads them at its next lookup, in the app and the worker (`docs/modules.md`, "Module settings") |

\* a secret: write-only and encrypted in Settings. In the environment each
can also be given as a file (`NAME_FILE`).

**(c) Both, by design.**

| Variable | How the two meet |
| --- | --- |
| `WIREHUB_PDF_ENGINE_URL` | wires the stack's `pdf` profile, so `compose.yaml` still passes it and the config generator writes it with the profile; without it, Settings > Integrations names an engine |
| `WIREHUB_STORE_INDEXES` | the stores the server trusts, shown read-only beside the ones added under Settings > Store sources (the server's win on the same URL) |
| `WIREHUB_TEST_DEFAULTS` | continuity test parameters as JSON. Like every runtime setting, a parameter it sets wins and shows read-only as "set by the server" under Settings > Testing; the parameters it leaves out are set there (changed in v0.2.0: it used to be a fallback Settings overrode) |

**Sign-in** is on: first-run setup makes the admin's account, and the admin
invites everyone else. GitHub, Google, single sign-on (OIDC), magic links over SMTP and the
allowed emails (who may sign in without an invitation, as editors) are set
under Settings > Sign-in & accounts; nobody can claim a new hub before you,
because `/setup` asks for the setup code. Before the hub is reachable from
anywhere but this machine, put a TLS-terminating reverse proxy (Caddy,
Traefik, nginx) in front, set `WIREHUB_PUBLIC_URL` to the address people open
and `WIREHUB_TRUST_PROXY=1` (so rate limits count real clients). Opened by its
LAN address without a proxy, sign-in still works: the studio trusts the
address a request was made to.

**Scripts and agents** use the same API with a personal API token (the key
icon in the rail; `/account/tokens`): a token acts as the person who made it,
with the scopes they chose, for 1 to 90 days, and is shown once.

**Health and alerts.** `/healthz` is the container's liveness probe. `/healthz?deep=1`
also checks the database, that every migration is applied, the blob store (a
canary object) and, with the backup profile, that a backup finished in the last
30 hours (Settings > Jobs & limits changes it; the file Backrest's post-snapshot hook touches, `WIREHUB_BACKUP_MARKER`;
a day's grace after the first start), that no more than two background jobs failed
in the last day (`jobs`), and that the worker beat its heartbeat in the last five
minutes; it answers `503`
with the failing check's name when one fails, so an uptime monitor can poll it.
With a webhook set (Settings > Notifications, or `WIREHUB_NOTIFY_URL`), the studio also POSTs an event to it
(`{event, severity, title, message, at, env, version, data}`) for a failing
blob store, a stale backup, a stale worker heartbeat, failing jobs, models a sweep could not
build, a GC error, a failed backup or restore check (urgent), a catalog write that
bypassed the application, a created API token and repeated refused tokens;
every event is logged either way, and no token ever appears in one.

**Catalog store.** Library → Browse store lists the packs of the store indexes in
`WIREHUB_STORE_INDEXES`, and owners and editors install or update them with the same
diff and single change set as any pack (viewers see the list only). Each entry is an
index URL and the minisign public key (`RW…`) its publisher gives you:

```
WIREHUB_STORE_INDEXES=https://packs.example.com/store/index.json RW<their public key>,https://other.example/index.json RW<theirs>
```

The server fetches `<url>` and `<url>.minisig`, refuses an index whose signature does
not match the key you configured, and refuses a download whose size or sha256 differs
from the index. Fetches are https only, to public addresses, within 8 MB and 15 s. Unset,
the hub trusts WireHub's official index once this release carries its key (the word
`official` names it in a list); empty or `none` turns the store off. Packs are published
by their authors, who are responsible for their content and licensing; the licence shown
is information, not checked. An air-gapped hub leaves this off and installs pack files
(Modules → Install pack…). To publish your own index, see `docs/catalog-store.md` §4.

**Store sources (Settings).** Owners and editors can add more stores under Settings > Store
sources: a URL and the store's public key (the `RW…` line, or "fetch key from the store's
`wirehub-store.pub`"). The hub fetches the index and its signature, verifies them, and shows the
store's name, publishers, pack count and the key's fingerprint before saving; the person adding
it confirms the fingerprint (a key fetched from the store itself is trust on first use). Added
stores are kept in the catalog (`data/settings/stores.json`, with the other hub settings, on both
backends) and Browse store then lists their packs next to the others, grouped by store. They can be
renamed, disabled, re-checked and removed. The stores in `WIREHUB_STORE_INDEXES` are shown there
read-only ("set by the server") and win when the same URL is also added. The same https, size and
time limits and private-address refusal apply as for a pack URL. An installed pack remembers the
store it came from and is only offered updates by that store. To lock a hub to the stores the
server names, turn off "owners and editors may add stores" under Settings > Integrations
(or set `WIREHUB_STORE_ALLOW_USER_SOURCES=false`).

When an index lists a pack's **publisher**, the hub also checks the publisher's signature
over the pack's manifest (`wirehub-pack.sig`) and every file the manifest pins, and
refuses the pack otherwise. The index publisher can mark a version **reviewed** or
**flagged** (shown beside it, as information), **yank** a version (Browse store warns,
never offers it, and only an owner can install it anyway; an installed yanked version gets
a warning badge in the Packs panel with the version to update to), and **revoke** a key (a
pack signed only by that key is refused, and flagged where installed).
"Reviewed versions only" (Settings > Integrations, or `WIREHUB_STORE_HIDE_UNREVIEWED=true`) makes the
hub list and install only versions the index marks reviewed or flagged; by default every version is shown, with its status.

**Code modules.** Besides data packs, an **owner** can install modules that run code in the hub
(an ERP link, a house rule, a panel): from a store whose index lists the module's publisher, or as
a signed file with the publisher's public key, which the hub then pins. The install shows what the
module may do and asks for the owner's consent; the module runs at once, without a restart, and is
turned on or off under Settings > Code modules. The hub's image does not change, and nothing
outside the app is involved. To forbid code modules on an install, set
`WIREHUB_ALLOW_CODE_MODULES=false` on the app and the worker (the built-in modules still run);
owners can also turn them off in Settings. Design: `specs/runtime-modules.md`, `docs/modules.md`.

**Restart WireHub.** Settings > Code modules > Restart WireHub (owners) finishes a change only a
fresh process applies (a code module's job queues). The app stops taking requests, lets the ones
in flight finish, closes cleanly and exits with code **75** — logged as `[restart] requested by
<name>: exiting with code 75 (restart requested, not a crash)`, so it is told apart from a crash
(exit 1) — and the worker, told through the database, does the same. Compose's
`restart: unless-stopped` (on the app, the worker and every long-running service) starts both
again; the page shows "Restarting WireHub…" and reconnects by itself. Under another supervisor,
keep a restart policy that restarts on a non-zero exit (`on-failure` or `always`) and set
`WIREHUB_RESTART_SUPERVISED=true`. Proof on a real stack: `bash scripts/restart-smoke.sh <image>`.

### Your own PostgreSQL or S3

The bundled services sit between marker comments in `compose.yaml`
(`# >>> bundled-postgres` … `# <<< bundled-postgres`, the same for
`bundled-s3`). Delete those blocks — the config generator does it for you —
and set:

- **PostgreSQL:** `DATABASE_ADMIN_URL`, a connection as a role that may create
  roles and the database. `migrate` creates WireHub's roles with it, and their
  connections are derived from it (same host, port, database and options). On
  a managed database without such a role, create the roles yourself and give
  `DATABASE_OWNER_URL` and `DATABASE_URL` instead.
- **S3:** `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, and optionally a read-only `S3_BACKUP_*` pair for the
  backup mirror. WireHub speaks plain S3 (path-style, SigV4): AWS S3, RustFS,
  MinIO, Ceph RGW, Backblaze B2, Cloudflare R2 all work.

**Without object storage:** `WIREHUB_BLOBS=fs:/data/blobs` keeps uploaded
bytes in the `blobs` volume instead (delete the `bundled-s3` blocks too). A
fallback for machines that cannot run Garage, not the recommended setup.

### Why Garage

The two candidates were **Garage** and **RustFS**; MinIO was left out because
its vendor has scaled back the open-source edition.

- **Garage** (Deuxfleurs, AGPL-3.0) is mature — releases since 2022, a 2.x
  line with a stable admin API — and designed for small, self-hosted storage
  that runs in a few tens of MB of RAM. Its cost is setup (a cluster layout,
  keys, a bucket), which `garage-init` does on every start, idempotently.
- **RustFS** (Apache-2.0) is simpler to start but young — 1.0 release
  candidates as of 2026 — and a hub's uploads are not where to try a new
  storage engine.

### Board textures and existing imported model keys

New conversions recognize a board body named `Board~<exporter-id>` (1–64 alphanumeric
characters, optionally a numbered `#` suffix), as well as `board` and the `_PCB`
convention. The painter still needs suitable top/bottom geometry and both recorded
Gerber SVG views; a name alone does not fabricate a board or artwork.

Paired-art source keys include a separate board-texture revision. Geometry-only
keys and the global converter revision remain unchanged. Existing signed pack
links and cached GLBs keep their original keys: a missing legacy entry rebuilds
with the legacy detector, so newer paint is never stored under its old identity.
An importer must explicitly reimport/relink a model using the current `sourceKey`
to opt into the new painting profile. That new key builds from the hash-verified
geometry and current stored SVG bytes; importing art may sanitize those bytes, so
verify the active link's key rather than an earlier source-pack key. Neither a
startup nor a metadata-only anchor edit silently upgrades a legacy painting key.

## History and the git mirror

**History.** Every save is a change set in the database: who made it, when,
its message, and every record it changed with its state before and after.
The studio shows it — **History** in the rail lists the hub's changes
(filter by person, date and kind), and the History button of a cable (beside
its revision chip) or a library record lists that record's changes, opens
each to a field-by-field diff, and **restores** an earlier state. A restore is
a new change set by the person who asked, checked like any edit (the record's
edit lock, its validation, and the version they were looking at): history is
never rewritten, and a restore can itself be restored. The same is under
`GET /api/history` (`apps/studio/README.md`). Changes saved before this
version recorded earlier states (migration 0017) show what they changed but
may lack their "before".

What each backend keeps:

| Backend | History | Diffs | Restore |
| --- | --- | --- | --- |
| `pg` (the default) | every change set, with its person | every change since 0017; older ones where neighbouring saves recorded the states | yes |
| `files`, catalog in a git repository | the git log of the catalog: every save while the git export is on (`WIREHUB_GIT_AUTOCOMMIT=true`), plus any hand commits | yes (from the commits) | yes, as a new save |
| `files`, no git | nothing — the History page says so | — | — |

**The git mirror** (optional, the database backend). For a trail outside the
database — on your git host, diffable, readable without WireHub — the worker
can write each change set as a commit: the catalog's files as the export
writes them (binary files named by content address in `.wirehub-blobs.json`,
not copied), authored by the person who saved, at the time they saved, with
the change set's message and the trailers `WireHub-Change-Set` and
`WireHub-Catalog-Version`. Its first run commits the catalog as it finds it.
It never forces: if someone else pushed to its branch while it had commits of
its own to push, the job fails, alerts (Settings > Notifications) and waits for
you; files outside `data/` and `depictions/` (a README) are left alone. The
owner-only settings documents (sign-in, notifications, integrations) are not
mirrored; a mirror kept before v0.2.0 drops them at its next commit, but they
stay in its older commits (see "Older history of the git mirror" below). The
mirror is a copy, not the backup — keep the backups below.

Set it up under **Settings > Integrations**: the remote (`ssh://…` or
`https://…`, never with a password in it), the branch, the schedule, and its
credential — an SSH deploy key with write access (and, recommended, the host's
key line from `ssh-keyscan`), or an HTTPS access token with the user name the
host expects. The key and the token are kept encrypted and never shown again.
The worker picks the change up within a minute and schedules (or stops) the
mirror; no restart.

To pin it on the server instead, each setting has its variable, which wins
over Settings (add them to the worker's `environment:` in a
`compose.override.yaml`):

| Variable | Default | |
| --- | --- | --- |
| `WIREHUB_GIT_MIRROR_URL` | — | a remote (`ssh://…`, `https://…`) to push to; never with a password in it |
| `WIREHUB_GIT_MIRROR_PATH` | — | instead: a repository (or an empty folder) mounted into the worker, committed to directly (environment only: it is a mount) |
| `WIREHUB_GIT_MIRROR_BRANCH` | `main` | the branch it writes |
| `WIREHUB_GIT_MIRROR_CRON` | `*/5 * * * *` | how often it looks for new change sets (without a worker, only the period counts: every N minutes, hourly, or every H hours) |
| `WIREHUB_GIT_MIRROR_SSH_KEY_FILE` | — | an SSH private key (a deploy key with write access) |
| `WIREHUB_GIT_MIRROR_KNOWN_HOSTS_FILE` | — | the host's key; without it the first key seen is trusted |
| `WIREHUB_GIT_MIRROR_TOKEN_FILE` | — | instead of a key: an HTTPS access token, handed to git by `GIT_ASKPASS` |
| `WIREHUB_GIT_MIRROR_USER` | `wirehub` | the user name sent with the token |
| `WIREHUB_GIT_MIRROR_DIR` | a folder under `/tmp` | the working clone (re-cloned when lost) |

Each secret is read from its file at start (any variable works as `NAME_FILE`).
The job appears in the Jobs list (`GET /api/jobs`) with what it committed and
pushed. A change set saved before the database kept what a replay needs (an
upload's details, before 0017), or whose uploaded bytes are gone, is not
replayed one by one: the mirror then commits the catalog as it is now and
says so in the commit message.

### Older history of the git mirror

The current mirror, and the file backend's git export, never commit the three
owner-only settings documents. Earlier ones did, and **git keeps what it once
committed**: a mirror repository made before v0.2.0, and a file-backend export
repository that ran with the git export on before that, hold them in older
commits until their history is rewritten, even though today's commits no longer
have them. Everyone who can read that repository (your git host's members, its
forks and clones) can read them.

**What is exposed.** The files are `data/settings/sign-in.json`,
`data/settings/notifications.json` and `data/settings/integrations.json` (a
repository rooted at the catalog's `data/` folder has them as `settings/…`).
They hold the settings that are not secrets: the allowed emails, whether local
accounts are on, the identity provider's address and client id, the SMTP host,
port, user and sender, the webhook's format, the git mirror's remote address,
branch and schedule, the PDF engine's address and the token limits, and the
time each secret was last set. They never hold a secret value: the SMTP
password, the OIDC client secret, the webhook URL and token and the mirror's
token and key live in an encrypted store of their own (see "Settings" above).
So the exposure is who your people and your services are, not their
credentials; a repository that was public, or shared wider than your hub's
owners, should be treated as having disclosed those, and anything you ever put
in a settings field that was not a secret field (an address with a password in
it, which the form refuses today) as compromised, so change it.

**Option 1, a fresh mirror repository (simplest).** Create a new empty
repository, point **Settings > Integrations > Git mirror** at it (or
`WIREHUB_GIT_MIRROR_URL`), and archive or delete the old one on your host. The
mirror's first run commits the catalog as it is now, with no settings
documents; the per-change-set trail restarts from there, and the old
repository keeps the earlier trail if you keep it (private). The hub's own
History is in the database and is not affected.

**Option 2, rewrite the old repository's history** and keep its trail. Work on
a clone you made for this, never the hub's live working clone, with a terminal
where git and Node are installed:

```
git clone --mirror <your-mirror-url> mirror-copy      # a full copy: every branch and tag
pnpm --filter studio mirror:purge ../mirror-copy --dry-run
pnpm --filter studio mirror:purge ../mirror-copy      # shows the dry run again, then asks you to type the folder name
```

The tool takes **only a local folder** (a URL is refused), always prints a dry
run first (how many commits hold the files, how many would vanish because they
changed nothing else, which branches and tags move, which refs it deletes), and
rewrites only after you type the folder's name (`--confirm <name>` where there
is no terminal). It rebuilds the commits with plain git: every commit keeps its
message, author, committer and dates, loses the three files, and gets a new id;
commits that only touched those files are dropped; signatures on rewritten
commits cannot survive. Local branches and tags move to the new commits,
remote-tracking refs and the reflog are removed and the old objects collected.
`--path <file>` (repeatable) names other files to drop instead. It never
pushes and never changes a remote's configuration.

Publishing is yours: the remote's history now differs, so push the new history
to a **fresh empty repository** (recommended: `git push --mirror <new-url>`)
and point the hub's mirror at it, or force-push over the old one if you accept
that every clone must be re-cloned. Then stop the old copy being readable:
clones and forks made earlier, and your host's own caches (pull request refs,
a forge's "view all commits" by id), may still serve the old commits, so
delete the old repository where you can, and treat what the files held as
seen. The mirror continues from the rewritten branch: its newest commit still
says which catalog version it holds, and it never forces, so if you push the
rewritten history to the same remote, set the hub's working clone aside
(`WIREHUB_GIT_MIRROR_DIR`, re-cloned when lost) first.

## Printed PDFs (`COMPOSE_PROFILES=pdf`)

By default the PDF of the build sheet, the BOM, the continuity spec and a wire
stock's spec sheet is a plain text layout of the sheet (tables and notes, no
figures), and the drawing sheet's is a rasterised page, because laying out
HTML takes a browser engine and the WireHub image does not carry one. The
`pdf` profile adds one beside the app, so `?format=pdf` (and the `render`
command) gives the sheet exactly as a browser prints it — page size and
margins, figures, the UNRELEASED / UNAPPROVED mark, the branding:

```
COMPOSE_PROFILES=pdf
WIREHUB_PDF_ENGINE_URL=http://pdf:3000
```

(With backups too: `COMPOSE_PROFILES=backup,pdf`. The config generator sets
both lines; the engine's address can instead be named under Settings >
Integrations, which also has the timeout.) The service is **Gotenberg** (Apache-2.0), an HTTP API around
headless Chromium, in its Chromium-only image. It is on the internal network
only, publishes no port, and runs with JavaScript off and every outbound
address refused: WireHub posts the sheet as one self-contained HTML file
(images and fonts inline) and gets the PDF back, so a sheet can fetch
nothing. Its memory cap is 1 GiB (it idles near 170 MiB; it converts two
sheets at a time and restarts Chromium every 50); a conversion has 30 s
(Settings > Integrations, and Gotenberg's own `--api-timeout`).

When no engine is named, or the engine is down, slow or refuses a sheet,
the app still answers with the headless PDF and says why in the
`X-WireHub-PDF-Fallback` response header (the `render` command prints it as
a note; the app's log has a line too). `X-WireHub-PDF-Renderer` names what
made every PDF: `browser`, `text-layout`, `raster` or `vector`. The
schematic, the label sheet and the formboard keep their own PDFs either way
(`docs/exports.md`). An engine elsewhere works too: any Gotenberg 8 the app
can reach, at its base URL.

## Backups — recommended (`COMPOSE_PROFILES=backup`)

Add `COMPOSE_PROFILES=backup` to the environment and deploy again. Backups
then run with nothing set up by hand: **restic**, driven by **Backrest** (a web
UI on port 9898, `127.0.0.1` unless `BACKREST_BIND` says otherwise).

| Service | What it does |
| --- | --- |
| `backup-init` | one-shot: stages the scripts below from the image, keeps the repository password (`restic_password`), and on first start configures Backrest: one repository and one plan |
| `backup-dump` | `pg_dump -Fc` of the database into the `backups` volume as the read-only role `studio_ro`, at start and daily at `BACKUP_DUMP_AT` (keeps `BACKUP_KEEP_DUMPS`), each with a row-count file; once a week (`BACKUP_CHECK_DAY`) it restores the newest dump into a scratch database and compares the counts |
| `backup-mirror` | an rclone mirror of the bucket with the **read-only** key, every `BACKUP_MIRROR_INTERVAL` seconds |
| `backrest` | snapshots `/sources` — the dump and mirror, and the `catalog`, `auth` and `packs` volumes — on `BACKUP_SCHEDULE` (daily at 03:00), keeping 7 daily, 4 weekly and 12 monthly, with a weekly prune and check |

**Where the snapshots go.** `BACKUP_REPOSITORY` (read on first start; change
it in Backrest's UI afterwards):

- unset — a repository in the `restic_repo` volume **on this machine**. It
  protects against mistakes (a deleted record, a bad upgrade), not against
  losing the disk; the log says so.
- `rest:https://user:pass@nas.example:8000/wirehub` — a restic REST server on
  another machine;
- `s3:https://s3.example.com/bucket/wirehub` with `BACKUP_AWS_ACCESS_KEY_ID`
  and `BACKUP_AWS_SECRET_ACCESS_KEY` (S3, B2, R2 …);
- `sftp:user@host:/srv/wirehub` (add the SSH key in Backrest's UI).

A new repository is created on first use with a generated password
(`restic_password` in the `secrets` volume) — **copy it somewhere else**: a
backup cannot be restored without it. To use an existing repository, give its
password as `BACKUP_REPOSITORY_PASSWORD`.

Backrest asks the first visitor of its UI to create a login. Notifications
(ntfy, Gotify, Discord, Slack …) on failure are set up there too.

**Restore.** Try it once on another machine before you rely on it.

1. On the machine you restore to, start the stack once (`docker compose up
   -d`, with `COMPOSE_PROFILES=backup`): it creates the database roles. Do
   not finish `/setup`.
2. Put the snapshot's `backups/` back into the `backups` volume — in
   Backrest's UI, restore the snapshot's `/sources/backups` to
   `/sources/backups` (or copy `postgres/` and `blobs/` there yourself).
3. Restore the database and the uploaded files, then start the app:

   ```
   docker compose stop wirehub
   docker compose run --rm --entrypoint bash backup-dump /run/wirehub/backup/pg-restore.sh
   docker compose run --rm --entrypoint sh backup-mirror /run/wirehub/backup/blob-restore.sh
   docker compose start wirehub
   ```

   `pg-restore.sh` replaces the database with the newest dump (or the one you
   name) and checks every table's row count against the count taken with it;
   `blob-restore.sh` copies the bucket mirror back with the app's key.
4. Sign in with the accounts of the restored hub.

After a restore the worker rebuilds the imported 3D models on its next start
(they are never in a backup: they are rebuilt from their sources).

**Blob clean-up and backups.** The worker deletes an uploaded file nothing uses
any more only after a backup that holds it has completed: it reads that from
the `backups` volume (mounted read-only), from the file a finished snapshot
touches — `WIREHUB_BACKUP_MARKER` (as for the deep health check; the compose
stack's default is `/backup-marker/.last-snapshot`, a small volume only Backrest
may write). `backup-init` sets that hook up in the plan it creates; a Backrest
configuration made before that (or by hand) needs a post-snapshot command hook,
`touch /marker/.last-snapshot` on the condition "snapshot success" (the volume is
mounted at `/marker` in Backrest). Until the marker exists — no backup profile,
or no hook — such files are kept.

The weekly restore check runs the same restore into a scratch database; to
run it now: `docker compose run --rm --entrypoint bash backup-dump
/run/wirehub/backup/pg-restore-check.sh`.

**Alternative for Postgres only: Databasus.** If you already run it, point it
at the `postgres` service for the database and keep restic (or any file
backup) for the volumes and the bucket.

## Upgrades

Take a backup, then set a newer `WIREHUB_IMAGE` tag (or download the newer
release's `compose.yaml`, which pins it) and deploy again: `migrate` brings
the database up to date before the app starts.

**From a hub that kept its catalog in files** (before v0.1.0, or with
`WIREHUB_BACKEND=files`): deploy the new `compose.yaml` over the same volumes.
On its first start `migrate` imports the `catalog` volume, with the packs in
`packs` merged in, into the database as one organisation (it does this only
while the database holds none, and only for a catalog that was in use — a
fresh install goes to `/setup`). With sign-in on, `/setup` then asks for the
setup code and makes the first admin; nothing else answers until then. The
file volumes stay as they were; a JSON export of the database catalog is
`GET /api/export`.

**PostgreSQL major versions** (18 → 19): take a dump (`backup-dump`), stop
the stack, move `pg_data` aside, change the `postgres` image tag, start (the
roles are recreated), then restore the dump as above. Try it on a copy first. Releases are listed at
<https://github.com/formless63/wirehub/releases>; the image is tagged `X.Y.Z`,
`X.Y`, `X` (from 1.0) and `latest`. Pin a full version in production.

### GitHub and Google sign-in

Set `WIREHUB_PUBLIC_URL` to the final browser-facing HTTPS address **before**
registering either provider. In **Settings > Sign-in & accounts**, enter the
provider's client ID and client secret, enable it, then save. Both providers
are off by default. Secrets are encrypted and write-only; configuring one
does not grant access to everyone with a provider account. Invitations,
organisation membership and the existing allowed-email rules still apply.

**Adding a provider to an existing password account:** sign in with the
password first, click your avatar to open the sign-in/account page, then
choose **Connect GitHub**, **Connect Google**, or **Connect** followed by your
configured OIDC provider's name. Use the same verified email
as the existing WireHub account. A successful provider login does not
silently link an unverified local email; connecting while authenticated
proves control of both accounts. Test provider sign-in before disabling
password accounts.

For OIDC, **Email claim** in the sign-in settings selects which claim contains
the hub account's email (default: `email`; server override:
`AUTH_OIDC_EMAIL_CLAIM`). The provider must supply it in the ID token or userinfo.

| Provider | Register | Exact callback URL (example public address) |
| --- | --- | --- |
| GitHub | A GitHub **OAuth app** | `https://studio.example.com/api/auth/callback/github` |
| Google | A Google OAuth client of type **Web application** | `https://studio.example.com/api/auth/callback/google` |

For GitHub, create the OAuth app under **Settings > Developer settings >
OAuth apps**, use the hub's public address as its homepage, and enter the
callback above. Copy its client ID and generate a client secret. The sign-in
uses a verified email from GitHub, including a private email; the address
must match the owner's or invited person's address. See GitHub's
[OAuth app registration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
and [email API](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user).

For Google, configure the project's OAuth consent audience, then create a
**Web application** client with the callback above in **Authorized redirect
URIs**. If the consent app is in testing, add the people who will test it to
its test users. WireHub requires a verified Google email matching the person
in the hub. See Google's
[web-server client setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)
and [OpenID Connect email claims](https://developers.google.com/identity/openid-connect/openid-connect#obtainuserinfo).

The callback's scheme, hostname, port and path must match the hub's public
URL; do not register the container or localhost address for a public hub.
A reverse proxy must forward the callback to WireHub
without replacing it with another sign-in flow. Set `WIREHUB_TRUST_PROXY=1`
only behind a trusted proxy. GitHub and Google use their own built-in
provider IDs; generic OIDC remains a separate sign-in method.

**Optional server initialization.** The standard Compose and config generator
leave these runtime settings to the owner in the app. Uncommenting values
in `.env` alone does not pass them to the app. To configure a provider before
first setup, add explicit entries to `compose.override.yaml`:

```yaml
services:
  wirehub:
    environment:
      AUTH_GITHUB_ENABLED: ${AUTH_GITHUB_ENABLED:-false}
      AUTH_GITHUB_CLIENT_ID: ${AUTH_GITHUB_CLIENT_ID:-}
      AUTH_GITHUB_CLIENT_SECRET: ${AUTH_GITHUB_CLIENT_SECRET:-}
      # For a hub that starts with provider sign-in only:
      AUTH_LOCAL_ACCOUNTS: "false"
```

Google uses the corresponding `AUTH_GOOGLE_*` names. For a secret file,
mount it read-only and set `AUTH_GITHUB_CLIENT_SECRET_FILE` or
`AUTH_GOOGLE_CLIENT_SECRET_FILE` instead of the plain secret. Explicit
server values lock those Settings fields. To make the provider editable
later, use **Adopt the server's values**, then remove the provider variables
from the override and redeploy; saved secrets stay encrypted.

For provider-only first setup, enable and fully configure at least one
provider, enter the setup code, and record the owner's exact verified
provider email. Completing setup alone does not establish a provider session:
finish with **Sign in with GitHub** or **Sign in with Google**. Afterward,
invite other people as usual. Keep a working owner sign-in method while
changing providers; the owner-password recovery command below remains
available if access is lost.

### Upgrading to v0.2.0: settings moved into the app

Read this before you upgrade a hub that sets sign-in, alerts or the git mirror
in its `.env`. The default `compose.yaml` no longer passes the runtime
variables to the app (list in "What lives where"): `AUTH_ALLOWED_EMAILS`,
`AUTH_LOCAL_ACCOUNTS`, `AUTH_OIDC_*`, `AUTH_SMTP_*`, `WIREHUB_NOTIFY_*`,
`WIREHUB_STORE_HIDE_UNREVIEWED`, `WIREHUB_STORE_ALLOW_USER_SOURCES`,
`WIREHUB_PDF_ENGINE_TIMEOUT_MS`, `WIREHUB_CONVERT_WINDOW`, the git mirror's
remote settings and the token budgets. Nothing is lost, and no click is
needed to keep a hub running, but a variable that no longer reaches the app
stops applying, so choose one of these **before** deploying:

1. **Keep them as they are** (safest): put the variables you use under the
   service's `environment:` in a `compose.override.yaml` next to
   `compose.yaml`. A variable that reaches the app is honoured exactly as
   before and wins over Settings (the page shows it "set by the server"). A
   value pulled from `.env` needs its own line, because compose passes only
   what `environment:` names:

   ```yaml
   # compose.override.yaml: the app for sign-in, store and PDF settings;
   # add the same lines under `worker:` for alerts, the git mirror and job settings
   services:
     wirehub:
       environment:
         AUTH_OIDC_ISSUER: ${AUTH_OIDC_ISSUER:-}
         AUTH_OIDC_CLIENT_ID: ${AUTH_OIDC_CLIENT_ID:-}
         AUTH_OIDC_CLIENT_SECRET: ${AUTH_OIDC_CLIENT_SECRET:-}
         AUTH_ALLOWED_EMAILS: ${AUTH_ALLOWED_EMAILS:-}
         AUTH_SMTP_HOST: ${AUTH_SMTP_HOST:-}
         AUTH_SMTP_FROM: ${AUTH_SMTP_FROM:-}
         AUTH_SMTP_USER: ${AUTH_SMTP_USER:-}
         AUTH_SMTP_PASS: ${AUTH_SMTP_PASS:-}
     worker:
       environment:
         WIREHUB_NOTIFY_URL: ${WIREHUB_NOTIFY_URL:-}
         WIREHUB_GIT_MIRROR_URL: ${WIREHUB_GIT_MIRROR_URL:-}
   ```

   (An empty value counts as not set. A secret given as a file works too:
   mount it and set `AUTH_OIDC_CLIENT_SECRET_FILE`.)
2. **Move them into the app**: with the override in place, sign in as an owner,
   open **Settings** and press **Adopt the server's values**. Every setting the
   server still sets is copied into Settings, secrets (the OIDC client secret,
   the SMTP password, the webhook URL and token, the mirror's token and key)
   into the encrypted store; `WIREHUB_TEST_DEFAULTS` is copied too. Then delete
   the variables and the override and redeploy: nothing changes. (It needs the
   install's `settings_key`; the stack generates one, and an existing install
   gains it on its next start.)

**If you already deployed without doing either.** Sign-in is not lost, but a
hub that signed in **only** through OIDC or magic links now has email +
password accounts as its only method, and nobody there has a password. The
sign-in page then says so ("There is no way to sign in to this hub right now")
instead of showing a form that cannot work. Two ways back, neither touches
your data:

- put the variables back in a `compose.override.yaml` as above and
  `docker compose up -d`; or
- set an owner's password from the server's shell (it asks twice, hidden, or
  reads one line from standard input; at least 12 characters), then sign in
  with it and fill in Settings:

  ```
  docker compose exec wirehub node --experimental-strip-types --no-warnings \
    --import ./server/boot-env.ts server/pg/cli.ts owner-password --email you@example.com
  ```

  `--email` may be left out when the hub has one owner. It makes the owner's
  email + password login when there is none, or replaces the password (ending
  that person's sessions). The same command recovers an owner who turned
  **Email + password accounts** off in Settings and lost the identity provider;
  also set `AUTH_LOCAL_ACCOUNTS=true` in the override then, since a variable
  that is set wins.

**`WIREHUB_TEST_DEFAULTS` changed.** It used to be a fallback that Settings >
Testing overrode. It now follows the rule every runtime setting follows: a
parameter the variable sets **wins** and shows read-only as "set by the
server", and Settings supplies the parameters it leaves out. If you set it and
also saved a different value for one of its parameters in Settings, the
variable's value is now the one in force (so the value saved there is kept but
not used). Adopt the server's values to copy the variable into Settings, or
unset the variable to go back to the Settings value.

**Who sees what.** The sign-in, notification and integration settings are now
left out of `/api/export` for editors and viewers, never committed to the git
mirror, and hidden from non-owners in the history ("Settings", above).

## Development

Building and running from source (Node 24+, pnpm 10 — `corepack enable`):

```
git clone https://github.com/formless63/wirehub && cd wirehub
pnpm install
pnpm --filter studio dev           # the app, no containers; open the printed URL
```

Saves land in `packages/catalog/data`; modules enabled at setup install their
packs into the gitignored `data/packs/`, so domain records never end up in a
commit to the base.

The stack with a locally built image:

```
docker build -f docker/app.Dockerfile -t wirehub:dev .
WIREHUB_IMAGE=wirehub:dev docker compose up -d
```

`bash scripts/stack-smoke.sh --pdf --backup wirehub:dev` is the deploy test CI runs:
an empty directory with only `compose.yaml`, no `.env`, the default stack, the
`pdf` profile (the engine answers from the app's container and a build sheet
prints with `X-WireHub-PDF-Renderer: browser`) and then the backup profile, every check a person would make, and everything
removed afterwards. `node site/check-variants.mjs` validates the config
generator's variants with `docker compose config`.

**A second copy beside production:** another project name and port —
`docker compose -p wirehub-dev` with `WIREHUB_PORT` changed and
`WIREHUB_ENV=dev`. Volumes are per project, so the copies never share data;
the copy shows a DEV badge, refuses API tokens made on production, and with
`WIREHUB_PROD_MARKERS` (pieces of production's database host or name and
bucket) refuses to start if it is pointed at production. To refresh it from
production, restore production's latest dump into it ("Restore").

**Releases** are cut by release-please: conventional commits on `main` keep a
release pull request open with the next version, the changelog and the image
tag pinned in `compose.yaml`; merging it tags `vX.Y.Z`, publishes the GitHub
Release and the multi-arch image. Nothing is published on an ordinary push; a
manual run of the Image workflow builds an `edge` image for testing.
