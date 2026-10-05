# Contributing to WireHub

Thank you for helping. Bug reports, catalog corrections, documentation and
code are all welcome.

## Before you start

- Read `SPEC.md` (the model and the plan) and `AGENTS.md` (the conventions).
- For anything larger than a fix, open an issue first so the design can be
  agreed before you write it.
- Something only one shop needs belongs in a **module**, not in the base
  (`docs/modules.md`). Domain vocabulary and catalog records (a video
  standard, an automotive connector family) belong in a domain module's
  catalog pack (`modules/`).

## Set up

Node 24 or newer and pnpm 10 (`corepack enable`):

```
pnpm install          # also enables the git hooks below
pnpm build            # tsc --noEmit, strict, every package
pnpm test             # vitest, each workspace in turn
```

On a shared or small machine, run one workspace at a time with
`pnpm --filter <package> exec vitest run --maxWorkers=2`.

## Privacy hooks

`pnpm install` sets `core.hooksPath=.githooks`, which runs
`scripts/privacy-check.sh` before every commit:

- **pre-commit** blocks home-directory paths, your machine's hostname and
  login, private keys and tokens, `.env` files, and an author email that is
  not a GitHub noreply address;
- **commit-msg** blocks agent session trailers and links.

If you cannot use the noreply address, set `PRIVACY_ALLOWED_EMAILS` (an
extended regex) for your commits. CI runs the same check over every pull
request's commits.

**Private terms.** If you also work on a private deployment, list the words
that must never reach the public repository (a customer, a host, an internal
product) in `.privacy-terms` at the repository root, one extended regex per
line (`c:` prefix for case-sensitive). The file is gitignored; the hooks and
`bash scripts/privacy-check.sh --tree` (or `--history`) check against it.
Never commit that list.

A line that must contain a match (a test of the check itself) can carry the
marker `privacy-check: allow`.

## Commits and pull requests

- Small, focused commits with conventional messages: `feat:`, `fix:`,
  `docs:`, `refactor:`, `test:`, `chore:`, `ci:`.
- No AI-agent session trailers or links in commit messages.
- `pnpm build` and `pnpm test` green; new behaviour comes with tests; test
  data comes from the starter catalog or a module's own fixtures, never from
  a private catalog.
- Every catalog record carries `src`, its citation; inferred values say so.

## Agent skills

If you use an AI coding agent, point it at `.agents/skills/` (also reachable as `.claude/skills`):
short task guides for writing a module (`wirehub-module`), authoring catalog records
(`wirehub-catalog-data`), building a pack (`wirehub-catalog-pack`), importing from public sources
within their licences (`wirehub-import-public-data`) and contributing a change
(`wirehub-contribute`). They are plain Markdown and worth reading yourself. A test
(`packages/modules/test/agent-skills.test.ts`) keeps them in step with the code.

## Licence of contributions

WireHub is `AGPL-3.0-only` with the WireHub Module Exception
(`LICENSE`, `MODULE-EXCEPTION.md`); `packages/modules` is MIT. By
contributing you agree that your contribution is licensed under the same
terms as the files it changes — including the Module Exception, so that
modules keep the freedom to choose their own licence — and you confirm you
have the right to contribute it ([Developer Certificate of
Origin](https://developercertificate.org/); a `Signed-off-by:` line is
welcome but not required).

Catalog data you contribute must come from a source you may use (a public
standard cited by number, a datasheet, your own measurement) and carry its
licence if it differs from the pack's (`docs/catalog-store.md` §5). The starter
catalog and the bundled packs are CC0-1.0: data contributed to them is
dedicated to the public domain under the same terms.

## Code of conduct

See `CODE_OF_CONDUCT.md`. Security problems: `SECURITY.md`.
