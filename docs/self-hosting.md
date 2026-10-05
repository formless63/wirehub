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

**<https://formless63.github.io/wirehub/>** writes a `compose.yaml` and a
`.env` from a few choices: the public URL and ports, your own PostgreSQL or
S3 instead of the bundled ones, backups, OIDC sign-in, the image tag, and the
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
3. the **admin**: your name, email and a password (12 characters or more) —
   with sign-in through an identity provider only (`AUTH_LOCAL_ACCOUNTS=false`
   and `AUTH_OIDC_*`), just the email it knows you by;
4. the **catalog**: the starter catalog (example cables and the parts they
   use) or an empty one (the base vocabulary only);
5. the **domain modules** (below).

Finishing creates all of it in the database, signs you in, and opens the
studio. Invite the others from **People** (the people icon in the left rail;
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
| `model-cache` | at start, after a save that links an imported model, on request (`POST /api/jobs`) | builds every imported 3D model that is not built yet, from its source files (`WIREHUB_MODEL_SOURCES`, a folder you mount read-only) |
| `derive` | at start and daily | recomputes derived records (the tag tables) only if something bypassed a save |
| `blob-gc` | daily at 04:30 | removes uploaded files nothing uses any more — only after 30 days, and only once a backup taken after that holds them — and rebuildable models no record shows |
| `backup` | hourly | looks at the backups (profile `backup`): marks what they hold and alerts when the newest dump is older than 30 hours |
| `git-mirror` | only when configured: at start and every 5 minutes (`WIREHUB_GIT_MIRROR_CRON`) | writes each new change set as a git commit and pushes it (below, "History and the git mirror") |

`GET /api/jobs` lists recent jobs and the worker's last heartbeat (it beats
every minute; the container's health check reads it). One conversion runs at
a time; `WIREHUB_CONVERT_WINDOW=01:00-06:00` keeps the model builds (not a
person's upload) to a night window on a small machine. Alerts (a stale
backup, models that could not be built, a GC error) go to the log, and to
`WIREHUB_NOTIFY_URL` when you set one (below).

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

Every variable is optional and explained in `.env.example`. The ones most
people set:

| Variable | Default | |
| --- | --- | --- |
| `WIREHUB_PUBLIC_URL` | `http://localhost:<port>` | the address people open (sign-in links, the setup banner) |
| `WIREHUB_BIND`, `WIREHUB_PORT` | `127.0.0.1`, `5183` | where the app is published |
| `COMPOSE_PROFILES` | — | optional parts: `backup` |
| `WIREHUB_IMAGE` | the release `compose.yaml` came from | another tag, or a locally built image |
| `WIREHUB_SUGGESTED_MODULES` | — | modules pre-ticked at `/setup` |
| `WIREHUB_TEST_DEFAULTS` | — | fallback JSON of default continuity test parameters, e.g. `{"isolationVolts":250}`; the Settings page's Testing section overrides it (`docs/exports.md`) |
| `AUTH_ENABLED` | `true` | sign-in; `false` lets anyone who reaches the port edit |
| `AUTH_LOCAL_ACCOUNTS`, `AUTH_OIDC_*`, `AUTH_ALLOWED_EMAILS` | email + password on | sign-in methods (`apps/studio/README.md`) |
| `WIREHUB_TRUST_PROXY` | — | `1` behind a reverse proxy you trust |
| `WIREHUB_ENV`, `WIREHUB_PROD_MARKERS` | `prod` | a development copy beside production ("Development") |
| `WIREHUB_BACKEND` | `pg` | `files` keeps the catalog as JSON files (with `WIREHUB_ALLOW_FILES_IN_PROD=1`) |
| `WIREHUB_NOTIFY_URL`, `WIREHUB_NOTIFY_FORMAT` | — | alerts to a webhook (`json`, `ntfy` or `slack` body; below) |
| `WIREHUB_STORE_INDEXES` | the official index, once its key is published | catalog store indexes to trust (Library → Browse store): `<https url> <public key>`, comma separated; `none` for no store (below) |
| `WIREHUB_CONVERT_WINDOW` | — | `HH:MM-HH:MM`: build imported models only then |
| `WIREHUB_MODEL_SOURCES` | — | the folder (mounted into `worker`) imported models are built from |
| `WIREHUB_WORKER` | on | `off`: the app runs the jobs itself (no `worker` service) |
| `WIREHUB_GIT_MIRROR_URL` or `…_PATH` | — | the optional git mirror of every change set (below); its credentials as `…_SSH_KEY_FILE` / `…_TOKEN_FILE` |
| `TZ` | `UTC` | log timestamps, backup and job schedules |

**Sign-in** is on: first-run setup makes the admin's account, and the admin
invites everyone else. `AUTH_ALLOWED_EMAILS` lets the emails it lists sign in
without an invitation (as editors); nobody can claim a new hub before you,
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
30 hours (the file Backrest's post-snapshot hook touches, `WIREHUB_BACKUP_MARKER`;
a day's grace after the first start), that no more than two background jobs failed
in the last day (`jobs`), and that the worker beat its heartbeat in the last five
minutes; it answers `503`
with the failing check's name when one fails, so an uptime monitor can poll it.
With `WIREHUB_NOTIFY_URL` set, the studio also POSTs an event to that URL
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
its own to push, the job fails, alerts (`WIREHUB_NOTIFY_URL`) and waits for
you; files outside `data/` and `depictions/` (a README) are left alone. The
mirror is a copy, not the backup — keep the backups below.

```bash
# .env — a remote over SSH, with a deploy key that may write
WIREHUB_GIT_MIRROR_URL=ssh://git@git.example.com/workshop/catalog.git
WIREHUB_GIT_MIRROR_SSH_KEY_FILE=/run/secrets/git-mirror-key
WIREHUB_GIT_MIRROR_KNOWN_HOSTS_FILE=/run/secrets/git-mirror-known-hosts
```

```yaml
# compose.override.yaml — the key and the host's key, mounted into the worker
services:
  worker:
    volumes:
      - ./git-mirror-key:/run/secrets/git-mirror-key:ro
      - ./git-mirror-known-hosts:/run/secrets/git-mirror-known-hosts:ro
```

| Variable | Default | |
| --- | --- | --- |
| `WIREHUB_GIT_MIRROR_URL` | — | a remote (`ssh://…`, `https://…`) to push to; never with a password in it |
| `WIREHUB_GIT_MIRROR_PATH` | — | instead: a repository (or an empty folder) mounted into the worker, committed to directly |
| `WIREHUB_GIT_MIRROR_BRANCH` | `main` | the branch it writes |
| `WIREHUB_GIT_MIRROR_CRON` | `*/5 * * * *` | how often it looks for new change sets |
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

**Renamed variables.** WireHub's own settings are named `WIREHUB_*`. An `.env`
from before the rename that still says `STUDIO_*` keeps working, with one
warning at startup naming each one to rename (`apps/studio/server/env.ts`).

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

`bash scripts/stack-smoke.sh --backup wirehub:dev` is the deploy test CI runs:
an empty directory with only `compose.yaml`, no `.env`, the default stack and
then the backup profile, every check a person would make, and everything
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
