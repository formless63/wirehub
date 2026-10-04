# Agent Instructions

(CLAUDE.md is a symlink to this file.)

**Read `SPEC.md` first — it is the single source of truth** for the domain model, the
starter catalog and the phase plan. Per-epic build specs live in `specs/`; the
module system is `docs/modules.md`, the catalog store `docs/catalog-store.md`, and
what this repository deliberately does not contain is `docs/boundaries.md`. When
SPEC.md and anything else disagree, SPEC wins; flag the conflict rather than
silently choosing.

## What this is

WireHub is an engineering tool that captures **real, buildable cable
assemblies** as canonical definitions — a hierarchical wire model, a connector
library (bodies + interfaces), discrete components, PCBAs as black boxes with
declared internal continuity — from which schematics, build sheets, BOMs,
continuity specs and drawings derive. It is the open base: anything specific to
one shop (an ERP link, a board importer for one file share, a product resolver,
branding, a numbering scheme) is a **module** (`docs/modules.md`), not base code.

## Commands

- `pnpm install` · `pnpm test` (each workspace in turn, vitest) · `pnpm build`
  (`tsc --noEmit` per package, strict).
- Single test file: `pnpm --filter @wirehub/model test -- test/trace.test.ts`.
- On a shared machine run vitest with `--maxWorkers=2`.
- `bash scripts/privacy-check.sh --tree` — must stay clean (`CONTRIBUTING.md`, `docs/boundaries.md` §9).
  The git hooks in `.githooks/` (enabled by `pnpm install`) run it on every commit; a
  local, gitignored `.privacy-terms` file adds private words without publishing them.
- The app: `pnpm --filter studio dev`, or `docker compose up --build`
  (`apps/studio/README.md`).

## Conventions

- TypeScript strict, ESM, packages export TS source (`main: ./src/index.ts`; `build` =
  `tsc --noEmit`). Dev deps pinned: typescript 7.0.2, vitest 4.1.10, @types/node 26.1.2.
  The server runs on Node's type stripping: no TS parameter properties, enums or
  namespaces in server code.
- `@wirehub/model`, `@wirehub/catalog` and `@wirehub/modules` have
  **zero runtime dependencies**. Downstream packages (`layout`, `render-svg`, …) may
  add deps, but keep them minimal and never let presentation concepts leak into the
  model — **the model owns truth**.
- Every catalog data record carries `"src"`: a citation for where its values came
  from (a public standard, a datasheet, a measurement, or "synthetic example").
  Inferred values are flagged as inferred inside the src text.
- Deterministic library code: no `Date.now()`, no randomness, no network.
- IDs kebab-case. Wire ends: `a` = source side, `b` = destination side.
- Part numbers go through the `PartNumberScheme` interface
  (`packages/model/src/part-numbers.ts`); never hard-code a numbering pattern.
- Nothing shop-specific in the base: no customer, supplier or person names, no
  hosts, addresses or private paths. A feature that only makes sense for one shop
  is a module.

## Git

No remote is configured by default. Agents working in worktrees commit on their own
branch and never push, pull, rebase the main branch, or touch the remote config.
Where the beads section below mandates `git push`, that applies only to the session
the owner has asked to push.

---

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full
workflow context and commands.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Non-Interactive Shell Commands

Use non-interactive flags with file operations (`cp -f`, `mv -f`, `rm -f`,
`rm -rf`) so an aliased `-i` never hangs a session; `ssh`/`scp` with
`-o BatchMode=yes`; `apt-get -y`.
