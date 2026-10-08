---
title: Self-hosting essentials
summary: The few things to settle before you rely on a hub.
---

# Self-hosting essentials

The full guide is [Self-hosting (full)](../reference/self-hosting/). These are the choices that matter on day one.

## What runs

| Service | What it does |
| --- | --- |
| `wirehub` | The app: interface and API. The only published port. |
| `postgres` | PostgreSQL 18: the library, designs, versions, accounts and history |
| `garage` | S3-compatible storage for uploaded photos, datasheets and 3D models |
| `worker` | Background jobs: imports, 3D model conversion, housekeeping |
| `bootstrap`, `migrate`, `garage-init` | One-shots that prepare secrets, the database and storage |

A machine with 2 GB of memory runs the stack; 4 GB leaves room for 3D model conversion.

## Public URL and TLS

By default the app binds to `127.0.0.1:5183`. For anyone else, put a reverse proxy that terminates TLS in front of it, and set the public URL in `.env`:

```
WIREHUB_PUBLIC_URL=https://wirehub.example.com
```

Sign-in cookies and links in invitations use this address. Set `WIREHUB_TRUST_PROXY` to match your proxy, because it decides how clients are identified for rate limits.

## Your own PostgreSQL or S3

Delete the bundled `postgres` or `garage` blocks from `compose.yaml` and set `DATABASE_ADMIN_URL` or the `S3_*` variables. The [config generator](../../generator/) does both for you.

## Backups

Set `COMPOSE_PROFILES=backup` for restic backups through Backrest on port 9898 (bound to localhost). It dumps the database and mirrors the file store. A backup you have not restored is a guess, so restore once to a scratch stack before you rely on it.

## Upgrades

Change the image tag in `.env` (`WIREHUB_IMAGE`) and run `docker compose up -d`. The `migrate` service applies pending migrations before the app starts. Read the release notes first; the upgrade section of the full guide covers each version's notes.

## Settings in the app

Sign-in methods, alerts, webhooks, job limits, document branding and validation rules live under **Settings** and apply without a redeploy. Only what must exist before the app starts is an environment variable.

| Variable | Does |
| --- | --- |
| `WIREHUB_PUBLIC_URL` | The address people use |
| `WIREHUB_PORT`, `WIREHUB_BIND` | The published port and interface |
| `COMPOSE_PROFILES` | Optional parts: `backup`, `pdf` |
| `WIREHUB_DOCS_URL` | Where the in-app help links go; set it to host these docs yourself |

## Printed PDFs

Printing works in the browser as is. `COMPOSE_PROFILES=pdf` adds a headless Chromium (Gotenberg) that prints the same HTML sheets to PDF on the server, for exact output regardless of the viewer's browser.
