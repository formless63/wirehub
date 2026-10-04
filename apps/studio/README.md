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

`docker-compose.yml` at the repository root builds `docker/app.Dockerfile`
(install, bundle, serve) and runs it on port 5183 with the catalog
(`packages/catalog/data`) mounted from the checkout, so saves land in your
working tree:

```
docker compose up --build      # then open http://localhost:5183
```

`GET /healthz` is the healthcheck. Settings go in `.env` at the repository
root (`.env.example` lists them); every one is optional.

## Modules

`modules.config.ts` is the deployment's module manifest: the modules this
build includes. It is empty in the base. See `../../docs/modules.md`.

## Optional git export of saves

Off unless `STUDIO_GIT_AUTOCOMMIT=true`. The repository is the checkout the
server runs from (`STUDIO_GIT_DIR` overrides); `STUDIO_GIT_REMOTE` (`origin`)
and `STUDIO_GIT_BRANCH` pick where commits are pushed. Code: `server/backup/`.

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

## Auth

`server/auth/` — Better Auth on the standalone server, **off unless
`AUTH_ENABLED=true`**. On: every `/api/*` route answers `401` without a
session, the SPA redirects to `/sign-in`, and only allow-listed emails get in.
Standalone server only — `vite dev` ignores it (and warns if
`AUTH_ENABLED=true`).

Sign-in: **OIDC** against any compliant provider and/or an emailed **magic
link**; at least one must be configured. A missing or invalid variable stops
the server at startup with one line naming it.

| Variable | Default | |
|---|---|---|
| `AUTH_ENABLED` | `false` | `true` turns the login on |
| `BETTER_AUTH_SECRET` | — | required; ≥32 chars, `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | — | required; the public origin, e.g. `https://studio.example.com` (cookies and redirects are bound to it) |
| `AUTH_ALLOWED_EMAILS` | — | required; comma-separated, case-insensitive; checked at sign-in and on every request |
| `AUTH_DATA_DIR` | `<repo>/data/auth` | `auth.sqlite` (sessions) + `saves.jsonl` (save audit) |
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
| `STUDIO_LOCAL_USER` | `git config user.name`, else `local` | who the studio names with the login **off**; `GET /api/me` answers either |

**OIDC client:** a confidential client with PKCE, callback URL
`<BETTER_AUTH_URL>/api/auth/callback/<AUTH_OIDC_PROVIDER_ID>`.

**Sessions** live in SQLite via Node's built-in `node:sqlite` — no native
addon, no database server, one file. The catalog never holds auth state.

**Save attribution:** a successful write under `/api/` answers with
`X-Studio-User: <email>` and appends `{at, email, method, path, status}` to
`<AUTH_DATA_DIR>/saves.jsonl`; with the git export on, the same person is the
author of the save's commit.
