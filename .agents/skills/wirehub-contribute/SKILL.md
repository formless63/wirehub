---
name: wirehub-contribute
description: Contribute a change to the WireHub repository - worktree and branch, conventional commits, the privacy hooks and private-terms file, which tests to run (per workspace, with Postgres via the test compose file, the compose generator test), the beads tracker, and what a pull request needs. Load before committing, opening a pull request, or running the test suites.
---

# Contributing to WireHub

Authority: `CONTRIBUTING.md` (people), `AGENTS.md` (conventions), `SPEC.md` (the model and plan).
Read all three once; this is the working procedure.

## Before you write code

- Something only one shop needs is a **module** (`wirehub-module`), not base code. Domain data
  (a video standard, a connector family) is a **domain module's pack** (`wirehub-catalog-pack`).
- Larger than a fix: open an issue first so the design is agreed.
- Nothing shop-specific and nothing domain-specific in the base: no customer, supplier or person
  names, hosts, addresses or private paths; no hard-coded signal names (read them through
  `packages/model/src/signal-words.ts`). The model owns truth; presentation never leaks into it.
- Library code is deterministic: no `Date.now()`, no randomness, no network. TypeScript strict,
  ESM, kebab-case ids. `@wirehub/model`, `@wirehub/catalog` and `@wirehub/modules` have zero runtime
  dependencies.

## Branch, commits, pull request

- Work on a branch (a git worktree is the clean way on a shared machine:
  `git worktree add ../<name> -b <branch> main`, then `pnpm install` in it) and open a pull request
  against `main`. Never commit to `main` or push to it directly.
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`, with a
  scope where it helps (`feat(modules): ...`). release-please reads them to build `CHANGELOG.md`
  (`release-please-config.json`), so the type matters: `feat` for behaviour, `fix` for a bug.
- Small, focused commits. New behaviour comes with tests. Test data comes from the starter
  catalog or a module's own fixtures, never a private catalog.
- **No agent or tool attribution**: no session links, no `Co-Authored-By` agent trailers. The
  commit-msg hook blocks session trailers and links.
- Commit with your own GitHub noreply (or public) address (`git config user.email`). If you cannot,
  set `PRIVACY_ALLOWED_EMAILS` (an extended regex) for your commits.
- **Never `--no-verify`.** If a hook fails, fix the cause.
- Do not push, tag, release or change repository settings unless you were asked to; release PRs are
  merged by the maintainers.
- Contributions are licensed as the files they change (AGPL-3.0-only with the module exception;
  `packages/modules` MIT; bundled packs and starter data CC0-1.0). By contributing you confirm you
  have the right to (`CONTRIBUTING.md`, "Licence of contributions").

## The privacy hooks

`pnpm install` sets `core.hooksPath=.githooks` (the root `prepare` script). Then:

- `.githooks/pre-commit` runs `scripts/privacy-check.sh --staged`: home-directory paths, this
  machine's hostname and login, keys and tokens, `.env` files, non-noreply author emails.
- `.githooks/commit-msg` runs `scripts/privacy-check.sh --commit-msg`: agent session trailers and links.
- Check everything yourself: `bash scripts/privacy-check.sh --tree` (also `pnpm privacy-check`);
  `--history` and `--range <a>..<b>` exist too. CI runs the same checks over every pull request.
- **Private terms**: words that must never reach the public repository (a customer, a host, an
  internal product) go in the gitignored `.privacy-terms` at the repository root, one extended regex
  per line (`c:` prefix for case-sensitive). The file is local: copy it into a new worktree,
  never commit it, never quote its contents in a commit, an issue or a skill.
- A line that must contain a match (a test of the check itself) carries the marker
  `privacy-check: allow`. Do not use it to hide real data.
- Never put absolute paths of your machine in a file; write repo-relative paths.

## Tests

- Install and build: `pnpm install`, `pnpm build` (`tsc --noEmit` per package, strict).
- `pnpm test` runs each workspace in turn. On a shared or small machine run **one workspace at a
  time** with `pnpm --filter <package> exec vitest run --maxWorkers=2`; package names include
  `@wirehub/model`, `@wirehub/catalog`, `@wirehub/modules`, `@wirehub/module-<id>`, `@wirehub/layout`,
  `@wirehub/render-svg`, `@wirehub/docs`, `@wirehub/editor-react`, `studio` and `site`.
- One test file: `pnpm --filter @wirehub/model test -- test/trace.test.ts`.
- Touching catalog data, a pack or a module: that package's tests, `@wirehub/catalog` (canonical
  JSON, starter designs, tag tables) and `bash scripts/privacy-check.sh --tree`.
- Touching the app server: `pnpm --filter studio test` runs three projects (browser-path,
  workbench-api, shell; `apps/studio/vitest.config.ts`).
- **Postgres suites** (`apps/studio/test/pg/`) need a database; without `WIREHUB_TEST_PG_URL` they
  are skipped. Start a disposable one with the test compose file (pick a unique project name, use
  your own, remove only what you created):

  ```
  docker compose -f apps/studio/test/pg/compose.test.yaml -p wirehub-pg-test up -d --wait
  port=$(docker compose -f apps/studio/test/pg/compose.test.yaml -p wirehub-pg-test port pg-test 5432 | cut -d: -f2)
  WIREHUB_TEST_PG_URL=postgres://postgres:test-only@127.0.0.1:$port/postgres \
    pnpm --filter studio test -- --maxWorkers=2 test/pg/
  docker compose -f apps/studio/test/pg/compose.test.yaml -p wirehub-pg-test down
  ```

  The port is random on 127.0.0.1 and nothing persists (tmpfs). Never run a global
  `docker system prune` or `docker builder prune`.
- **Compose and the generator.** `compose.yaml` is what the config generator (`site/`) produces by
  default, byte for byte. When you touch `compose.yaml`, `docker/`, `.env.example` or
  `site/src/generate.js`, run `pnpm --filter site test` (`site/test/generate.test.js`: the default
  output equals `compose.yaml`) and `node site/check-variants.mjs`, plus
  `docker compose config --quiet`. CI also runs `scripts/stack-smoke.sh` against a built image.
- Adding a bundled domain module changes the lists asserted in `site/test/generate.test.js` and
  the studio setup tests (`wirehub-module`).

## Agent skills

These skills live in `.agents/skills/` (with `.claude/skills` a symlink to it). After editing a
skill or a path or command it mentions, run
`pnpm --filter @wirehub/modules exec vitest run test/agent-skills.test.ts`: it checks the
frontmatter and that every repo path a skill names exists.

## Tracking

The project uses `bd` (beads) for issue tracking (`AGENTS.md`): `bd ready`, `bd show <id>`,
`bd update <id> --claim`, `bd close <id>`. Do not keep markdown TODO lists.

## Checklist for a pull request

- [ ] branch from `main`, conventional commits, no attribution trailers, noreply email
- [ ] `pnpm build` and the affected workspaces' tests green; pg suites run if the store changed
- [ ] `bash scripts/privacy-check.sh --tree` clean
- [ ] every catalog record has `src`; inferred values say so; data comes from a source you may use
- [ ] new modules/packs follow `wirehub-module` and `wirehub-catalog-pack`
- [ ] docs updated where behaviour or a path changed
