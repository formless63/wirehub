# Self-hosting WireHub

```
git clone https://github.com/formless63/wirehub && cd wirehub
bash scripts/setup-env.sh        # writes .env with generated secrets
docker compose up -d             # open http://localhost:5183
```

`scripts/setup-env.sh` copies `.env.example` to `.env` and generates every
secret (S3 keys, the Garage RPC secret and admin token, the Postgres
password, the sign-in secret). Every variable is documented in
`.env.example`. The login is **off** until `AUTH_ENABLED=true`: turn it on
before the hub is reachable by anyone but you, and put a TLS-terminating
reverse proxy (Caddy, Traefik, nginx) in front.

## The default stack (`compose.yaml`)

| Service | Image | What it does | Used by the app today? |
| --- | --- | --- | --- |
| `wirehub` | `ghcr.io/formless63/wirehub` (or built locally) | the app: UI and API, the only published port | — |
| `garage` | `dxflrs/garage:v2.4.1` | S3-compatible object store, single node | **yes**: uploaded file bytes (photos, datasheets, 3D models) |
| `garage-init` | the app image | one-shot: Garage layout, access keys, bucket | yes, at start |
| `postgres` | `postgres:18.6-bookworm` | PostgreSQL 18 | **not yet** — provisioned for the database backend |

**Be clear about what holds your data today.** WireHub is still file-backed:
the catalog, the designs, drawings and saved versions are JSON files in the
`catalog` volume (seeded from the image's starter catalog on first start);
sign-in state and the save audit log are in the `auth` volume. What already
goes through the storage seam to object storage is the **bytes of uploaded
files**: their records stay in the catalog (`assets/index.json`), their
content goes to the bucket (`STUDIO_BLOBS=s3`, `apps/studio/server/blobs.ts`).

PostgreSQL runs so an install made today already has its database, its
credentials and its backups in place when the database backend lands
(`specs/postgres-backend.md`, phases A–D, which move the catalog and designs
into it and keep the blob store). Until then it holds nothing; start without
it with `docker compose up -d wirehub` (Compose starts only the app and its
dependencies).

Networking: Garage and Postgres sit on an internal network with no
published ports. The app's port binds to `127.0.0.1` unless `WIREHUB_BIND`
says otherwise.

### Why Garage

The two candidates were **Garage** and **RustFS**. (MinIO, the usual third
option, was left out: its vendor has scaled back the open-source edition.)

- **Garage** (Deuxfleurs, AGPL-3.0) is mature — releases since 2022, a 2.x
  line with a stable admin API — and designed for exactly this: small,
  self-hosted, geo-distributable storage that runs in a few tens of MB of
  RAM. It is also the owner's existing choice, so it is the one we test.
  Its cost is setup: a fresh node needs a cluster layout, keys and a bucket,
  which `garage-init` (`docker/garage/init.mjs`, idempotent, over Garage's
  admin API) does on every start.
- **RustFS** (Apache-2.0) is simpler to start (keys from environment
  variables, MinIO-compatible console) but young — 1.0 release candidates as
  of 2026 — and a hub's uploads are not where to try a new storage engine.

WireHub speaks plain S3 (path-style `PUT`/`GET`/`HEAD`/`DELETE`, SigV4), so
any S3-compatible service works instead: point `S3_ENDPOINT`, `S3_REGION`,
`S3_BUCKET` and the keys at it and drop the `garage` services (AWS S3,
RustFS, MinIO, Ceph RGW, Backblaze B2, Cloudflare R2).

### Fallback without object storage

Set `STUDIO_BLOBS=fs:/data/blobs` in `.env` and start only the app:

```
docker compose up -d --no-deps wirehub
```

Uploaded bytes then live in the `blobs` volume. This is a fallback for
machines that cannot run Garage, not the recommended setup: the database
backend's blob GC and backups are designed around object storage.

## Backups (`compose.backup.yaml`) — recommended

```
docker compose -f compose.yaml -f compose.backup.yaml up -d
# open http://localhost:9898 (Backrest)
```

**Recommendation: restic, driven by Backrest, to a repository on another
machine or provider.** restic gives deduplicated, encrypted, verifiable
snapshots to almost any backend (a restic REST server on a NAS, S3, B2, R2,
SFTP); Backrest adds a web UI for repositories, plans, retention, restores
and notifications, so nobody has to write cron jobs. The add-on stages
everything into one tree that Backrest snapshots:

| Service | What it stages |
| --- | --- |
| `backup-dump` | `pg_dump -Fc` of the database into the `backups` volume, at start and daily at `BACKUP_DUMP_AT` (keeps `BACKUP_KEEP_DUMPS`) |
| `backup-mirror` | an rclone mirror of the bucket, with the **read-only** backup key, every `BACKUP_MIRROR_INTERVAL` seconds |
| `backrest` | restic + web UI; reads `/sources/backups` (dump + mirror), `/sources/catalog` and `/sources/auth` read-only |

Set up in the Backrest UI:

1. **Repository**: your restic repository (e.g. `rest:https://user:pass@nas.example:8000/wirehub`
   or `s3:https://s3.example/bucket/wirehub`), with a strong password kept
   somewhere other than this machine.
2. **Plan**: paths `/sources`; schedule daily at 03:00 (after the 02:30
   dump); retention 7 daily, 4 weekly, 12 monthly; a weekly `check`.
3. **Notifications** (optional): Backrest posts to ntfy, Gotify, Discord,
   Slack and others on failure.

The `catalog` volume is in the snapshot because, today, it *is* the data.
Derived caches (`cache` volume: converted 3D models) are left out; they are
rebuilt on demand.

The `rest-server` profile (`--profile rest-server`) runs a restic REST server
in the same stack for trying the flow; a real repository lives elsewhere —
run `restic/rest-server` on another host, or use a cloud bucket.

**Restore**, in short: stop the stack; restore the snapshot's `catalog/` and
`auth/` into the volumes; `pg_restore` the dump into a fresh `postgres`
volume; copy `backups/blobs/` back into the bucket (`rclone copy` with the
app key); start. Try it once on another machine before you rely on it.

**Alternative for Postgres only: Databasus.** If you already run Databasus
(a self-hosted web UI for scheduled PostgreSQL dumps to local disk, S3 and
other storage, with notifications), point it at the `postgres` service for
the database and keep restic/Backrest — or any file backup — for the
`catalog` and `auth` volumes and the bucket. Databasus alone does not cover
WireHub today, because today's data is not in Postgres.

## Upgrades

Pull or build the new image and `docker compose up -d`. Take a backup first.
Pin `WIREHUB_IMAGE` to a version tag (`ghcr.io/formless63/wirehub:0.1.0`)
for production; `edge` follows `main`.

## Running a development copy beside production

Use another project name and port: `docker compose -p wirehub-dev` with
`WIREHUB_PORT` changed in that checkout's `.env`. Volumes are per project, so
the copies never share data.
