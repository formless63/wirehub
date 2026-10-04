# Execution handoff — Postgres backend and the self-hosted install

**For:** an agent session (the *executor*) implementing `specs/postgres-backend.md` (rev 6)
in this repository, phase by phase (A, B, C, S; D only when asked).

**From:** the orchestrating session, which reviews each phase and merges it into the main
branch.

This document is meant to be enough on its own. When it and the plan disagree, the plan
wins on design and this document wins on process. When the plan and `SPEC.md` disagree,
`SPEC.md` wins: flag the conflict, never pick silently.

---

## 1. Read first, in this order

1. `AGENTS.md` (`CLAUDE.md` is a symlink to it): the conventions and the git rules.
2. `SPEC.md`: the domain model. You will not change it; skim it.
3. `specs/storage-seam.md`: the seam you plug into (stores, the unit of work, change sets,
   `CatalogSource`).
4. `specs/postgres-backend.md`, all of it — especially §3.2 / §3.3 (every file and every
   record kind, with its table), §4.5 (API clients), §5 (blobs), §8–§9 (deployment and
   clean install) and §11 (your task list, the order and the gates).
5. `docs/modules.md`: module tables (§3.13 of the plan) and module routes must keep
   working.

---

## 2. Repo facts

| Fact | Detail |
| --- | --- |
| Layout | pnpm TypeScript monorepo: `packages/{model,catalog,modules,layout,render-svg,docs,editor-react}`, `apps/studio` (Hono server under `apps/studio/server/`, a React SPA under `apps/studio/src/`) |
| Language | TypeScript **strict**, ESM. Packages export TS source; `build` = `tsc --noEmit`. The server runs TS directly (`node --experimental-strip-types`): no parameter properties, enums or namespaces in server code |
| Install / build | `pnpm install` · `pnpm -r build` |
| One test file | `pnpm --filter studio test -- test/<file>.test.ts` |
| A package's tests | `pnpm --filter <pkg> test -- --maxWorkers=2` |
| Full run | `pnpm test` (each workspace in turn), with `--maxWorkers=2` on a shared machine, once per batch of commits |
| Zero-dep rule | `@wirehub/model`, `@wirehub/catalog` and `@wirehub/modules` have **zero runtime dependencies** (`node:` built-ins are fine). `pg`, Kysely, `@aws-sdk/client-s3` and pg-boss go in `apps/studio` only |
| The model owns truth | Domain logic stays in `model`; Postgres is storage, not logic: validation, usage and derivation stay pure functions over the snapshot |
| Deterministic library code | No `Date.now()`, randomness or network in `model`/`catalog` `src`. The server and the worker may use them |
| Citations | Every catalog data record carries `"src"` |
| Canonical JSON | Catalog JSON is `JSON.stringify(v, null, 2) + '\n'`; A0 adds a guard test |
| Privacy check | `bash scripts/privacy-check.sh --tree` must stay clean (`CONTRIBUTING.md`); the git hooks run it on every commit |

### Shared machines

- Check free memory before a full run or a heavy build; never run two full runs at once;
  keep `--maxWorkers=2`.
- Cap every container you start (`--memory 256m` for a scratch Postgres or MinIO) and
  remove scratch containers on exit (`trap … EXIT`).
- Use `docker-compose.test.yml` (A8 creates it) with a project name of your own
  (`-p cs-pg-test`), random localhost ports and no `container_name`, or throwaway
  `docker run` containers. Never bring up a compose file that binds a port or a container
  name another running service uses.
- The STEP → GLB conversion runs in a memory-capped child (`models/convert-worker.ts`).
  Keep it capped, and run one at a time.

### Secrets

Credentials live only in `.env` (gitignored). Never write them into compose files, specs,
tests, logs or commit messages. The clean install generates its own (plan §9.1).

---

## 3. Where you work

In your own git worktree, which the orchestrator creates for you. Never in the main
checkout itself.

---

## 4. Branch strategy

- **One branch per phase:** `pg/A-read-path`, `pg/B-write-path`, `pg/C-worker`,
  `pg/S-self-hosted`, `pg/D-migration`. Each is cut from the main branch after the previous
  phase is merged. A large phase may use sub-branches.
- **Never push** unless `AGENTS.md` says your branch may be pushed. Never force-push,
  never rebase a branch someone else has.
- **Merge the main branch in regularly** and before asking for a review; resolve conflicts
  on your branch; re-run the gates of §6 after each merge.
- **The orchestrator merges each phase** after reviewing it and running the full suite.
- **Commits:** small, one task (or part of one) each; the message says what and why, names
  the task (`B4`) and its bead, and ends with the tests you ran and their counts, then the
  attribution trailers your harness gives you. Never `git add -A` blindly; never commit
  `.env`, dumps, blobs or caches.
- **Beads (`bd`)** is the only task tracker. Create an epic "Postgres backend: execution
  (plan rev 6)", one bead per phase and one per task with `--parent`; claim before you
  start, append findings as notes, close on acceptance, file new work as new beads.

---

## 5. Phase gates

The task tables, with sizes and dependencies, are in the plan §11. Each phase must prove
its go/no-go there before the orchestrator merges it. In the report for each phase:

- what was built, task by task, with commits;
- the gate's numbers (byte identity, parity diffs, latency percentiles, memory peaks);
- any plan edit you made (with its changelog line);
- open questions (§8).

---

## 6. What changes on the main branch while you work

New catalog files, new optional record fields, new routes, new direct writers and module
work keep landing. After every merge of the main branch into your branch, re-run:

1. the canonical-JSON guard (after A0);
2. **the importer gate** (`pnpm --filter studio pg:gate`, from Phase A on) on the
   starter catalog and the fixture catalog. The coverage rule fails loudly on a new file:
   map it in `FILE_MAP` and in the plan's §3.2 table;
3. the targeted suites of whatever the merge touched.

A new `RecordKind` or store means a new mapping row in plan §3.3 and a contract case; a new
direct writer is a new seam kind, file backend first; a schema version bump needs its
vendored data migration (plan §6).

---

## 7. Conventions you must follow

- **The model owns truth.** No domain rule lives in SQL or in the worker. SQL constraints
  are backstops; the handlers' own checks give the user-facing answer.
- **Byte identity is the contract.** Key order is data (`body json`), list order is data
  (`ord`), store-sorted files use the store's own sort, in JS.
- **Forward-only migrations**, never edited after release; a `CHECKSUMS` test; RLS on
  every new org table; data migrations vendor the model code they call.
- **The file backend stays first-class** (tests, development, small installs). Every new
  seam kind lands there first, with a contract test.
- **Tests that need Postgres or S3** skip with one line when `WIREHUB_TEST_PG_URL` /
  `WIREHUB_TEST_S3_URL` is unset, so `pnpm test` stays green without Docker.
- **Plan edits:** when reality differs from the plan, update `specs/postgres-backend.md` in
  the same branch, add a changelog line, and say so in your report.

---

## 8. Decisions you must NOT make alone

Raise each as a question in your report (and as a bead labelled `decision`), and keep
working on anything that does not depend on it:

- changing an API response a browser sees (shape, status or wording), except where the
  plan says so (`/api/backup` in pg mode, plan §7.6; setup mode, plan §9);
- changing catalog data values (A0 may change bytes only);
- a runtime dependency in `model`, `catalog` or `modules`, or any dependency beyond `pg`,
  Kysely, `@aws-sdk/client-s3` (+ `lib-storage`), `pg-boss` and Better Auth's pg adapter
  in `apps/studio`;
- weakening a gate (a non-identical byte, a parity diff, a missed latency target) — report
  the numbers;
- dropping RLS, backing up derived blobs, adding an agent or AI field to the change set,
  storing tokens in a recoverable form, or making the setup page reachable without the
  setup code — these are design changes;
- choosing the licence, the public registry for release images, or default hostnames;
- editing `AGENTS.md`, `CLAUDE.md` or `SPEC.md`.

---

## 9. Quick reference

| Thing | Where |
| --- | --- |
| The plan | `specs/postgres-backend.md` (rev 6) |
| The seam | `specs/storage-seam.md`; `apps/studio/server/storage/{change-set,unit-of-work,catalog-version,write-lock}.ts` |
| Stores wired today | `apps/studio/server/default-deps.ts` |
| The routes | `ROUTES` in `apps/studio/server/api.ts` and every `*_ROUTES` it spreads, plus `DEPICTION_ROUTES` and the module route prefix |
| Edit locks | `apps/studio/src/locks/records.ts` (`recordsOfWrite`, `LEASE_MS`), `apps/studio/server/locks/*` |
| Model links + caches | `apps/studio/server/models/{links,cache,api}.ts` |
| Auth | `apps/studio/server/auth/*` |
| The git export (pg retires it) | `apps/studio/server/backup/*`, `write-journal.ts` |
| Loaders | `packages/catalog/src/catalog.ts` (`loadDb`), `source.ts` (`CatalogSource`) |
| Modules | `packages/modules/src/index.ts`, `apps/studio/modules.config.ts`, `docs/modules.md` |
