# Spec — Storage seam: async stores, unit of work, change sets

Read `../SPEC.md` and `../AGENTS.md` first. This is the seam a database-first backend
(Postgres + an object store, `postgres-backend.md`) plugs into, **in the same app** — not
a fork. Today the only backend is files under `packages/catalog/data/`.

## 1. The shape of a request

```
host adapter (hono-adapter.ts / plugin.ts)        request guards: size, cross-site, content type, auth, locks
  └─ handleWorkbenchRequest(request, deps)        api.ts — the thin adapter; mutating requests take withWriteLock
       └─ new UnitOfWork(deps)                    storage/unit-of-work.ts
            ├─ uow.deps.loadDb()                  catalog snapshot, cached by deps.catalogVersion()
            ├─ routeWorkbenchRequest(req, uow.deps)   the router + handlers: pure model logic over staged stores
            └─ uow.commit(context)                if the answer is < 400 and anything was staged:
                 └─ commitChangeSet(deps, set)    preconditions → apply in order → derived records
```

- Handlers are `async` and `await` every store call. They never write: a store write
  inside a request *stages* a change and later reads in the same request see it
  (read-your-writes).
- A handler that refuses (4xx) writes nothing, by construction.
- Request guards (the lock store's 423, auth) go in `handleWorkbenchRequest` in front of
  the router, or in the host adapter — the signature `(request, deps) =>
  Promise<ApiResponse>` is the only thing hosts call.
- Module integration routes (`/api/modules/<module>/…`, `docs/modules.md`) answer for
  themselves in front of the router; a route that declares `writes: true` runs under the
  write lock.

## 2. Store interfaces

Every store in `apps/studio/server/*` returns `Awaitable<T>` (`T | Promise<T>`,
`storage/change-set.ts`): `DesignStore`, `DefinitionStore`, `DrawingStore`, `AssetStore`,
`VocabStore`, `TagStore`, `WireLibraryStore`, `BuildsStore`, `VersionStore`,
`DepictionStore`, `ModelLinkStore` and `ModelCache`. `LockStore` (`locks/lock-store.ts`) is
fully async and takes `now` from the caller. Callers always `await`. A database backend
returns promises; the file stores and the in-memory test stores answer at once, which is
why the type allows both. `WorkbenchDeps.loadDb` / `loadPartNumberFiles` are awaitable too.

The unit of work stages (read-your-writes, `expect`) designs, definitions, drawings,
assets, vocab, tags, the wire library, builds and versions. **Not staged, and so written
outside the change set:** `modelLinks` (the Library's attach, upload and detach write
`models.json` directly) and `DepictionStore` (§6).

Two optional deps complete the seam:

| dep | file backend | purpose |
| --- | --- | --- |
| `catalogVersion()` | `storage/catalog-version.ts`: a hash of the name, inode, size and mtime of the JSON files `loadDb()` reads | the unit of work loads the db once per version, one structured copy per request |
| `derived` | `derived.ts`: a `DerivedStore` | recompute module-owned derived records at commit (none in the base) |

## 3. The change set

`storage/change-set.ts`. No paths, no tables:

```ts
interface RecordChange {
  kind: RecordKind;            // 'design' | 'drawing' | 'drawing-photo' | 'definitions' | 'vocab' | 'tag-review'
                               // | 'wire-library' | 'wire' | 'builds' | 'design-version' | 'version-working'
                               // | 'version-draft' | 'version-artwork' | 'design-versions' | 'asset'
  key: string;                 // the record's natural id: design id, `<design>/<rev>`, definition kind, list id, sha256…
  op: 'put' | 'delete' | 'move';
  value?: unknown;             // the JSON document (put)
  bytes?: Uint8Array;          // binary payload (asset, photo, artwork blob)
  to?: string;                 // move: the new key (a design rename carries its drawing and versions)
  expect?: string | null;      // optimistic concurrency: content ETag when this request read it; null = must not exist
}
interface ChangeSet { changes: RecordChange[]; context: { method; path; user? } }
interface CommitResult { applied: number; derived: DerivedKind[] }   // 'tags' | 'module'
```

The Postgres plan adds these kinds (`postgres-backend.md` §3.3), each landing on the file
backend first: `model-link` (key `<kind>/<id>`), `depiction-meta`, `depiction-asset`, and
`doc` (a `data/…` path, for import publishes). Derived caches (the converted-model cache)
are deliberately **not** change-set kinds: a cache is not catalog state.

`expect` is filled in by the unit of work from its read set, not by handlers: the first
read of a record records its version; a write to it is conditional on that version. A
commit whose precondition fails throws `StaleRecordError` before anything is written, and
the request answers **409** ("changed since you opened it").

## 4. Commit — the file backend

`commitChangeSet(deps, set)` applies a set through `deps`' own stores:

- **If-Match** — handlers check it against what they read; the write lock makes
  check-then-write atomic within the process, and `expect` catches anything outside it (a
  hand edit, a `git pull`, another process).
- **Atomic temp + rename** per file (`atomic-write.ts`).
- **Write journal + optional git export** — the host wraps the whole request (commit
  included) in `collectWritesAsync` inside the backup queue's `withSave`, so the git commit
  holds exactly the files the save wrote, attributed to the person; never `add -A`, never
  force-push (`apps/studio/README.md`, "Optional git export of saves").
- **Serial writers** — `storage/write-lock.ts`: mutating requests run one at a time.

Not atomic *across* files: a crash mid-commit can leave the first files of a multi-record
save written. The Postgres backend closes that gap. The write journal and the git export
are the file backend's durability; on Postgres the transaction is the durability, the
`change_set`/`change` rows are the journal, and database + blob backups are the backup
(`postgres-backend.md` §8.6).

### Derived records

`derivedFor(changes)` names what a set makes stale; the commit recomputes it after the
primary changes, in the same journal and git commit:

| derived | inputs | written by |
| --- | --- | --- |
| `tags` — `tags/signal-tags.json`, `instance-slots.json`, `report.md` | definitions, vocab, tag review, wires, designs | `TagStore.regenerate()` |
| `module` — whatever a module's `DerivedStore` keeps | designs, drawings, definitions, wires, vocab, builds | `DerivedStore.regenerate()` |

A tag PUT answers with the table it will derive via `TagStore.preview(review)`.

## 5. A Postgres backend

`postgres-backend.md` designs it in full. In brief:

- `STUDIO_BACKEND=files|pg` picks the stores in `default-deps.ts`. The handlers, the model
  and the browser are unchanged. The switch is one line in `handleWorkbenchRequest`:
  `deps.commit?.(set) ?? commitChangeSet(deps, set)`.
- `catalogVersion()` is `catalog_head.version`. The snapshot is the same loaders fed the
  same file text (a codec renders the rows as files), so the `Db` is identical by
  construction.
- One READ COMMITTED transaction per commit, serialised by a per-org head row taken
  `FOR UPDATE` — today's write lock, made global across processes. The preconditions
  compare a generated `etag` column with `expect`.
- Documents are `body json`, because key order is data: it decides the ETag and the
  exported bytes. A generated `jsonb` column beside it serves queries.
- Bytes go to the blob store (local filesystem or any S3-compatible service) under
  content-addressed keys, uploaded before the transaction (HEAD, then PUT, then a re-read
  that must hash to the key — no conditional PUT or bucket versioning needed when a key is
  its content's sha256). The derived caches become derived blobs, rebuilt by worker jobs.
- `move` keeps identity: a rename is an `UPDATE` of the entity's slug.
- Derived records are recomputed inside the same transaction.

## 6. Not yet in the change set

- **Artwork** (`/api/depictions/*`, `DepictionStore`) — serialized under the write lock,
  but it still writes directly. Staging it is kinds `depiction-meta` / `depiction-asset`
  with `bytes` (Postgres plan task B7).
- **3D model links** (`/api/models/*`, `ModelLinkStore`) — attach, upload and detach
  rewrite `data/models.json` directly (the upload's bytes do go through the staged asset
  store). Kind `model-link` fixes this (plan task B0, on the file backend first).
- **Importers** — module importers (`docs/modules.md`) propose records; accepting them is
  an ordinary request. On Postgres, long-running imports become worker jobs that publish
  one change set; command-line tools become **API clients** with a personal token
  (`postgres-backend.md` §4.5).
- **Derived caches** (`data/.model-cache/`) — never catalog state and never in a change
  set, by design.
- **The catalog loaders** read through `CatalogSource` (`packages/catalog/src/source.ts`:
  a directory or an in-memory map); a pg backend gives `loadDb` its own reader.

## 7. Schema version

Stored designs are at one `CURRENT_SCHEMA_VERSION` (4). `model/src/migrate-schema.ts`
(`upgradeDesignSchema`) is the only reader of versions 1–3; the API upgrades an older body
on the way in. Saved versions and the frozen fixture catalog keep the version they were
saved at. Fields added without a version bump are optional (`extensions` is one).

## 8. Environments

The seam is the same in every environment; what changes is which stores
`default-deps.ts` builds, from the environment:

| Env var | development | production | tests |
| --- | --- | --- | --- |
| `STUDIO_ENV` | `dev` | `prod` | unset (`test`) |
| `STUDIO_BACKEND` | `files` or `pg` | `pg` (or `files` for a small single-user install) | `files` / memory / pg (contract suite) |
| `STUDIO_BLOBS` | `fs:<dir>` or `s3` | `s3` or `fs:<dir>` | `fs:<dir>` |

The git export (§4) is a file-backend piece only. The environment guard
(`postgres-backend.md` §8.7) refuses a process whose stores, buckets or database do not
match its `STUDIO_ENV`.

## 9. API clients: one request, one unit of work

Scripts and agents use the same HTTP API as the GUI, with a personal API token instead of
a session (`postgres-backend.md` §4.5). The seam needs no new concept for it:

- A token request is an ordinary request: the auth gate maps the token to its person, and
  the handler, the `UnitOfWork`, the If-Match checks and the edit-lock gate are the GUI's.
  The `ChangeSet`'s context carries the person (and, on pg, the token's id for audit).
- **`POST /api/batch`** runs several requests through the same router and handlers inside
  **one** `UnitOfWork`, so they commit as one `ChangeSet` (one git commit on files, one
  transaction on pg), or not at all. A later request reads an earlier one's staged writes.
- **Dry run** (`?dryRun=1`, or `dryRun` in a batch) runs the request to the point of
  commit and then discards the unit of work; the answer is the staged `RecordChange`s and
  the derived kinds the commit would recompute.
- Both work on the file backend as well as on pg, so the contract suite runs them on every
  backend.
