# Self-hosting WireHub

WireHub runs from **one file**, `compose.yaml`. You do not need to clone the
repository, write a `.env` or generate a secret: the stack does that itself
on first start.

> **The first release (v0.1.0) is not out yet.** It ships once the Postgres
> backend's write path lands, and the image `ghcr.io/formless63/wirehub:0.1.0`
> that `compose.yaml` names is published with it. Until then, build the image
> yourself ("Development" below).

## Install

### With a terminal

```
mkdir wirehub && cd wirehub
curl -fsSLO https://raw.githubusercontent.com/formless63/wirehub/main/compose.yaml
docker compose up -d
docker compose logs wirehub        # the first-run setup code
```

Open <http://localhost:5183/setup>, enter the setup code, pick the domain
modules you need, and you are in.

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

5. Open that address and enter the code.

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

`/setup` lists every bundled domain module — **PC & serial**, **Networking**,
**Pro audio**, **AV / video**, **Automotive** — with what it adds. None is
ticked unless the deployment suggested it (`WIREHUB_SUGGESTED_MODULES`, which
the generator writes); you decide. More can be enabled later from the
command palette. A module's catalog pack is installed into the `packs`
volume, layered under the catalog, never into the starter catalog.

The setup code is asked only while setup has not been finished, so a hub
exposed by mistake cannot be set up by a stranger. It is generated once and
kept in the `secrets` volume; set `WIREHUB_SETUP_CODE` to choose your own.

## What runs

| Service | Image | What it does |
| --- | --- | --- |
| `bootstrap` | the app image | one-shot, first: fills the `secrets` volume (below) and writes Garage's config |
| `postgres` | `postgres:18.6-bookworm` | PostgreSQL 18, internal network only |
| `migrate` | the app image | one-shot: WireHub's database roles (`studio_owner`, `studio_app`, `studio_ro`) and every pending migration |
| `garage` | `dxflrs/garage:v2.4.1` | S3-compatible object store for uploaded files (photos, datasheets, 3D models), single node, internal only |
| `garage-init` | the app image | one-shot: Garage's layout, the bucket, and the app's and the backup's keys — **created by Garage** and written to the `secrets` volume |
| `wirehub` | `ghcr.io/formless63/wirehub` | the app: UI and API, the only published port |

Every service waits for the ones it needs (`depends_on` with
`service_completed_successfully` / `service_healthy`), so one `up` brings the
whole stack up in order.

**What holds your data today.** The catalog, designs, drawings and saved
versions are JSON files in the `catalog` volume (seeded from the image's
starter catalog on first start). Installed packs and the setup record are in
`packs`; sign-in state and the save audit log in `auth`; uploaded file bytes
in Garage. PostgreSQL is migrated and ready, and the first release moves the
catalog into it (`specs/postgres-backend.md`); until the write path lands the
app runs with `WIREHUB_BACKEND=files`.

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
| `AUTH_ENABLED`, `AUTH_OIDC_*`, `AUTH_ALLOWED_EMAILS` | off | sign-in (`apps/studio/README.md`) |
| `TZ` | `UTC` | log timestamps, backup schedule |

Sign-in is **off** until `AUTH_ENABLED=true`: turn it on before the hub is
reachable by anyone but you, and put a TLS-terminating reverse proxy (Caddy,
Traefik, nginx) in front.

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
| `backup-dump` | `pg_dump -Fc` of the database into the `backups` volume, at start and daily at `BACKUP_DUMP_AT` (keeps `BACKUP_KEEP_DUMPS`) |
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

**Restore**, in short: stop the stack; restore the snapshot's `catalog/`,
`auth/` and `packs/` into the volumes; `pg_restore` the dump into a fresh
`postgres` volume; copy `backups/blobs/` back into the bucket (`rclone copy`
with the app key); start. Try it once on another machine before you rely on
it.

**Alternative for Postgres only: Databasus.** If you already run it, point it
at the `postgres` service for the database and keep restic (or any file
backup) for the volumes and the bucket.

## Upgrades

Take a backup, then set a newer `WIREHUB_IMAGE` tag (or download the newer
release's `compose.yaml`, which pins it) and deploy again: `migrate` brings
the database up to date before the app starts. Releases are listed at
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
`docker compose -p wirehub-dev` with `WIREHUB_PORT` changed. Volumes are per
project, so the copies never share data.

**Releases** are cut by release-please: conventional commits on `main` keep a
release pull request open with the next version, the changelog and the image
tag pinned in `compose.yaml`; merging it tags `vX.Y.Z`, publishes the GitHub
Release and the multi-arch image. Nothing is published on an ordinary push; a
manual run of the Image workflow builds an `edge` image for testing.
