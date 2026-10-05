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
| `import` | a module importer is started (`POST /api/modules/<module>/importers/<importer>`) | runs the importer over the catalog and keeps its **plan** — every record it would add or change, and the files that would change; `POST /api/jobs/<id>/publish` saves the plan as one change, or answers 409 when a record changed since the run |
| `model-cache` | at start, after a save that links an imported model, on request (`POST /api/jobs`) | builds every imported 3D model that is not built yet, from its source files (`WIREHUB_MODEL_SOURCES`, a folder you mount read-only) |
| `derive` | at start and daily | recomputes derived records (the tag tables) only if something bypassed a save |
| `blob-gc` | daily at 04:30 | removes uploaded files nothing uses any more — only after 30 days, and only once a backup taken after that holds them — and rebuildable models no record shows |
| `backup` | hourly | looks at the backups (profile `backup`): marks what they hold and alerts when the newest dump is older than 30 hours |

`GET /api/jobs` lists recent jobs and the worker's last heartbeat (it beats
every minute; the container's health check reads it). One conversion runs at
a time; `WIREHUB_CONVERT_WINDOW=01:00-06:00` keeps the model builds (not a
person's upload) to a night window on a small machine. Alerts (a stale
backup, models that could not be built, a GC error) go to the log, and as
JSON to `WIREHUB_NOTIFY_URL` when you set one (ntfy, Gotify, or a webhook
adapter).

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
| `AUTH_ENABLED` | `true` | sign-in; `false` lets anyone who reaches the port edit |
| `AUTH_LOCAL_ACCOUNTS`, `AUTH_OIDC_*`, `AUTH_ALLOWED_EMAILS` | email + password on | sign-in methods (`apps/studio/README.md`) |
| `WIREHUB_TRUST_PROXY` | — | `1` behind a reverse proxy you trust |
| `WIREHUB_ENV`, `WIREHUB_PROD_MARKERS` | `prod` | a development copy beside production ("Development") |
| `WIREHUB_BACKEND` | `pg` | `files` keeps the catalog as JSON files (with `WIREHUB_ALLOW_FILES_IN_PROD=1`) |
| `WIREHUB_NOTIFY_URL` | — | alerts as a JSON POST (ntfy, Gotify, a webhook adapter) |
| `WIREHUB_CONVERT_WINDOW` | — | `HH:MM-HH:MM`: build imported models only then |
| `WIREHUB_MODEL_SOURCES` | — | the folder (mounted into `worker`) imported models are built from |
| `WIREHUB_WORKER` | on | `off`: the app runs the jobs itself (no `worker` service) |
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
the `backups` volume (mounted read-only), where Backrest marks a finished
snapshot in `.last-snapshot`. Until that marker exists — no backup profile, or
a Backrest plan without the hook — such files are kept.

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
