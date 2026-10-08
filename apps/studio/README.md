# WireHub — the app

The editor and its server — see `../../SPEC.md` for the model.

## Running

For day-to-day development, with hot reload and the workbench API on the same
port:

```
pnpm --filter studio dev
```

To run it the way a deployment runs — no dev server, just the built bundle and
the workbench API on plain Node:

```
pnpm --filter studio bundle   # vite build → dist/
pnpm --filter studio start    # serves dist/ + /api/* on HOST:PORT
```

`HOST` (default `0.0.0.0`) and `PORT` (default `5183`) are read from the
environment — `PORT=5190 pnpm --filter studio start` runs a second copy
alongside the first. `start` refuses to run without a build, with one line
saying so.

## Container

`compose.yaml` at the repository root runs the published image
(`ghcr.io/formless63/wirehub`, built from `docker/app.Dockerfile`) with
PostgreSQL and Garage (S3-compatible blob storage) — no `.env` needed; see
`../../docs/self-hosting.md`:

```
docker compose up -d           # then open http://localhost:5183/setup
docker compose logs wirehub    # the first-run setup code
```

The image also carries the stack's one-shots (`stack/`): `bootstrap.ts`
generates every secret into the `secrets` volume, `garage-init.ts` sets up
Garage and has it create the S3 keys, `backup-init.ts` stages the backup
scripts and configures Backrest; `migrate` runs `server/pg/cli.ts bootstrap`
and `migrate`. The server reads any variable from a file as `NAME_FILE`
(`server/env.ts`, applied by `server/boot-env.ts` before anything else).

The catalog lives in the `catalog` volume (seeded from the image's starter
catalog on first start); packs installed at first-run setup live in the
`packs` volume (`WIREHUB_PACKS_DIR=/data/packs`), layered under it. Uploaded
file bytes go to the blob store named by `WIREHUB_BLOBS` (`server/blobs.ts`):
`s3` (Garage, by default), `fs:<dir>`, or unset — beside the catalog, as in
development. `GET /healthz` is the healthcheck. `.env.example` documents
every setting. WireHub's own variables are `WIREHUB_*`; the pre-rename
`STUDIO_*` names are still read as a deprecated fallback, with one warning at
startup (`server/env.ts`).

To work on the catalog in your checkout instead, run the app from source
(`pnpm --filter studio dev`), where saves land in `packages/catalog/data` and
packs enabled at setup in the gitignored `data/packs/` — never in the starter.

## Modules

`modules.config.ts` is the deployment's module manifest: the modules this
build includes — the bundled domain modules (offered at first-run setup) and
board import. See `../../docs/modules.md`.

## Importing boards

A board (PCBA) comes in from the files its designer already has. Open
**Library › Import › Board import** (`/m/board-import/boards`), and in this order:

1. **KiCad board.** Pick the `.kicad_pcb` (a `.net` netlist works too, without
   art). Fill in what the file does not say — the part number, the revision if
   the title block has none, an id — and press *Read the board*. The import runs
   as a job; when it is done you see the board it would add (its terminals are
   the landing pads and connector pins, its internal links the copper and the
   two-legged parts between them), the files that would change and a preview of
   its art. Check the notes — every derived record is marked for review — and
   press *Publish*. Then *Attach … as its 3D model*: the studio builds the
   board's model with the KiCad library parts it names (the first build fetches
   them, so it needs the internet once; the viewer says "not built yet" until
   the model-cache job has run).
2. **Gerber set.** Pick the board and the `.zip` you send to the board house,
   press *Render the art*, look at the top and bottom previews and publish. The
   art replaces the outline drawing from step 1, and the wires land on the same
   pads; a note says if a pad is not on copper (the board file and the Gerbers
   are of different revisions).
3. **BOM and placement.** Pick the board, the BOM `.csv` and, optionally, the
   placement (CPL) `.csv`. The columns are found by their usual names; change
   any that are wrong (a BOM from an unusual tool) before *Read the parts*.
   Publishing adds one component record per distinct part (reusing ones the
   Library has, by manufacturer or supplier number) and the board's
   "Components on this board" list.

Nothing is written before *Publish*, and nothing the Library already has is
changed: re-importing a board under the same id keeps the one you have. The
Library's *Import…* button takes the same files without the options.

## Optional git export of saves

Off unless `WIREHUB_GIT_AUTOCOMMIT=true`. The repository is the checkout the
server runs from (`WIREHUB_GIT_DIR` overrides); `WIREHUB_GIT_REMOTE` (`origin`)
and `WIREHUB_GIT_BRANCH` pick where commits are pushed. Code: `server/backup/`.

- **Every save is a commit.** After a successful write, exactly the files that
  request wrote (the stores report them, `server/write-journal.ts`; generated
  tag files only when their content changed) are committed. Author: the
  signed-in person; with the login off, `WireHub (local)
  <studio@localhost>`. Message: `studio: <action> <kind> <id>`, the version
  note if any, and a `Studio-Request: <METHOD> <path>` trailer. Saves and
  commits run in one serial queue.
- **Push.** About 20 s after the last commit: `git pull --rebase`, then
  `git push <remote> <branch>`. Also a pull before serving. Network errors
  retry with backoff (10 s doubling to 10 min). Never force-pushes, resets or
  discards. Credentials are whatever git in the container has (mount an SSH
  key and known_hosts, or use a credential helper).
- **Status.** `GET /api/backup` → `{enabled, state: ok|pushing|offline|blocked,
  message, lastCommit, lastPush, pendingCommits, remote, branch,
  nextAttemptAt}`; the top bar shows it; click for details and Retry.

**Recovering from "blocked".** The indicator's details say why. Saves keep
committing locally meanwhile; nothing is lost. A conflict with the remote:
`git pull --rebase` in the checkout, resolve, `git rebase --continue`, push,
then **Retry now**. Uncommitted changes in the checkout: commit or restore
them, then Retry.

## Change history

`server/history/`, `src/history/`. **History** in the rail lists the hub's
changes (person, date and kind filters); the History button of a cable
(beside its revision chip) and of a library record lists that record's
changes, opens each to a field-level diff, and restores an earlier state.

| Route | |
|---|---|
| `GET /api/history` | the hub's entries, newest first: `?person=` (name or email), `from=`/`to=` (YYYY-MM-DD), `kind=` (`design`, `library`, `vocab`, `builds`, `other`), `before=` (paging), `limit=` |
| `GET /api/history/records/:subject` | one record's entries; a subject is named as its edit lock is: `design:<id>`, `definition:<kind>:<id>` (also `vocab:<list>`, `build:<name>`) |
| `GET /api/history/entries/:id` | one entry: every record it changed, before and after; with `?subject=`, that record's parts and their current versions (`current`) |
| `POST /api/history/records/:subject/restore` | `{ entry, current }`: the design (and its drawing details) or library record back to its state right after `entry` |

Every answer carries `capabilities`: where the history comes from and what
it can do. On the database backend it is the change sets (every save, its
person, and since migration 0017 each record's state before the change); on
the file backend it is the git log of the catalog directory when that is in
a git work tree (with the git export above, every save), else nothing. A
restore is a new save — a new change set, or a new commit with the export on
— through the design and definition routes: validated, refused (423) while
someone else holds the record's edit lock, and refused (409) when the record
changed since `current` was read. History is never rewritten.

On the database backend the worker can also mirror every change set to git
as a commit by its person (`WIREHUB_GIT_MIRROR_*`, `server/history/mirror.ts`;
`docs/self-hosting.md`, "History and the git mirror").

## Auth

`server/auth/` — Better Auth on the standalone server, **off unless
`AUTH_ENABLED=true`**. On: every `/api/*` route answers `401` without a
session, the SPA redirects to `/sign-in`, and only allow-listed emails get in.
Standalone server only — `vite dev` ignores it (and warns if
`AUTH_ENABLED=true`).

Sign-in: **email + password** accounts (database backend), built-in **GitHub** and **Google**, **OIDC**
against any compliant provider, and/or an emailed **magic link**; at least one must
be configured. A missing or invalid variable stops the server at startup with
one line naming it.

**On the database backend** (`WIREHUB_BACKEND=pg`, the compose stack's
default, where `AUTH_ENABLED` defaults to `true`): Better Auth's tables are in
the app's database (schema `auth`), email + password accounts are on
(`AUTH_LOCAL_ACCOUNTS`), first-run setup makes the admin (owner), and the
admin invites everyone else with a role (`/settings/people`). Anyone with a
person in the organisation may sign in; `AUTH_ALLOWED_EMAILS` is an extra
allow-list there (and may be empty). Personal API tokens for scripts and
agents: `/account/tokens`. Every save is a change set in the database, so
`saves.jsonl` is not written.

**Scripts and agents: `studio-api`.** Work on the catalog as JSON files and let the
studio's own API do the writing, as the person whose token you use:

```bash
export WIREHUB_API_URL=https://wirehub.example.com WIREHUB_API_TOKEN=cst_dev_…   # the token: environment only
pnpm --filter studio studio-api pull ./work                  # GET /api/export + every record's ETag
# edit the JSON in ./work
pnpm --filter studio studio-api push ./work --dry-run        # one dry-run batch; prints the diff
pnpm --filter studio studio-api push ./work -m "Re-pin the RS-485 adapters" [--lock]
pnpm --filter studio studio-api call GET /api/designs        # a single route
```

Designs, the definition lists (connectors are pulled in the composed form the API
takes), a module's declared documents, the vocabularies (`data/vocab/*.json`: new
entries, and a changed label, more aliases or a note), tag corrections
(`data/tags/review.json`), the wire parts library (`data/wire-parts.json`: new parts;
`data/wire-recipes.json`: stock recipes), board build files (`data/builds/*.json`) and
drawing details (`data/drawings/*.json`) can be pushed; a changed file with no write
route, or a change in those files no route can express (removing a vocabulary entry,
changing an existing wire part), stops the push with the reason. A record changed since the pull fails its `If-Match`, the whole
batch is refused and nothing is retried. `--lock` holds edit leases for the run. A
`cst_prod_` token is refused by a development server and the other way round
(`WIREHUB_API_ENV` can say which one the URL is; the server's `/api/me` does too).
`specs/postgres-backend.md` §4.5.

**Documents without a browser: `render`.** The same documents and exports the Documents tab makes,
from a terminal or a script (`docs/exports.md`):

```bash
pnpm --filter studio render de9-crossover bom --format csv
pnpm --filter studio render de9-crossover build-sheet --format pdf --rev latest --out ./out
curl -H "authorization: Bearer $WIREHUB_API_TOKEN" "$WIREHUB_API_URL/api/designs/de9-crossover/documents/schematic?format=pdf" -o schematic.pdf
```

**Most of these are set in the app.** The sign-in methods (GitHub, Google,
OIDC, magic link, email + password), the allowed emails and the API token budgets are under **Settings > Sign-in &
accounts** (owners), and a change there rebuilds the sign-in in the running server, with
everyone staying signed in (`specs/runtime-settings.md`). Each variable below still works
and, when set, wins: Settings then shows it as "set by the server". `AUTH_ENABLED`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `AUTH_DATA_DIR` are install settings and stay
in the environment.

| Variable | Default | |
|---|---|---|
| `AUTH_ENABLED` | `false` | `true` turns the login on |
| `BETTER_AUTH_SECRET` | — | required; ≥32 chars, `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | — | required; the public origin, e.g. `https://studio.example.com` (cookies and redirects are bound to it) |
| `AUTH_ALLOWED_EMAILS` | — | required on the file backend (optional on pg); comma-separated, case-insensitive; checked at sign-in and on every request |
| `AUTH_LOCAL_ACCOUNTS` | `true` on pg, else `false` | email + password accounts (database backend only); new ones through setup or an invitation |
| `AUTH_DATA_DIR` | `<repo>/data/auth` | `auth.sqlite` (sessions) + `saves.jsonl` (save audit) |
| `AUTH_GITHUB_ENABLED` / `AUTH_GOOGLE_ENABLED` | `false` | enables the built-in provider when its ID and secret are configured |
| `AUTH_GITHUB_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_ID` | — | OAuth client ID from the provider |
| `AUTH_GITHUB_CLIENT_SECRET` / `AUTH_GOOGLE_CLIENT_SECRET` | — | confidential client secret; encrypted and write-only when saved in Settings |
| `AUTH_OIDC_ISSUER` | — | enables OIDC; discovery at `<issuer>/.well-known/openid-configuration` |
| `AUTH_OIDC_CLIENT_ID` | — | required with the issuer |
| `AUTH_OIDC_CLIENT_SECRET` | — | confidential client secret |
| `AUTH_OIDC_SCOPES` | `openid email profile` | space- or comma-separated |
| `AUTH_OIDC_EMAIL_CLAIM` | `email` | claim read as the person's email (ID token, else userinfo) |
| `AUTH_OIDC_PROVIDER_ID` | `oidc` | last segment of the redirect URI |
| `AUTH_OIDC_NAME` | `Single sign-on` | button label: "Sign in with …" |
| `AUTH_SMTP_HOST` | — | enables the magic link |
| `AUTH_SMTP_PORT` | `465` (`587` if not secure) | |
| `AUTH_SMTP_SECURE` | `true` | implicit TLS; `false` = STARTTLS |
| `AUTH_SMTP_USER` / `AUTH_SMTP_PASS` | — | |
| `AUTH_SMTP_FROM` | `AUTH_SMTP_USER` | sender address |
| `WIREHUB_LOCAL_USER` | `git config user.name`, else `local` | who the studio names with the login **off**; `GET /api/me` answers either |

**GitHub / Google:** set `WIREHUB_PUBLIC_URL` (`BETTER_AUTH_URL` on a standalone
server) before registering the OAuth client. The exact callbacks are
`<public URL>/api/auth/callback/github` and
`<public URL>/api/auth/callback/google`. Both require a verified provider
email; GitHub private emails are supported. Existing membership, invitations
and allowed-email rules apply. To add a provider to an existing password
account, sign in locally, click the avatar, then **Connect GitHub** or
**Connect Google** with the same verified email. Test it before disabling
password accounts. See the [provider setup and provider-only
first-run guide](../../docs/self-hosting.md#github-and-google-sign-in).
The default Compose does not pass runtime auth variables: prefer Settings,
or explicitly pass them in an override. Any variable also supports `NAME_FILE`;
server-provided values lock their Settings fields until adopted and removed.

**OIDC client:** a confidential client with PKCE, callback URL
`<BETTER_AUTH_URL>/api/auth/callback/<AUTH_OIDC_PROVIDER_ID>`.

**Sessions** live in SQLite via Node's built-in `node:sqlite` — no native
addon, no database server, one file. The catalog never holds auth state.

**Save attribution:** a successful write under `/api/` answers with
`X-Studio-User: <email>` and appends `{at, email, method, path, status}` to
`<AUTH_DATA_DIR>/saves.jsonl`; with the git export on, the same person is the
author of the save's commit.
