#!/usr/bin/env -S node --experimental-strip-types
/**
 * The standalone studio server: `pnpm --filter studio start`.
 *
 * Serves the `vite build` bundle (`dist/`) plus the workbench API, on plain
 * Node — no Vite, no dev server. This is what the two owners run on the desk
 * machine, and what either of them can reach over the LAN
 * (; see "Running" in `apps/studio/README.md`).
 *
 *   PORT=5190 pnpm --filter studio start
 *
 * `HOST` defaults to `0.0.0.0` (every interface — the LAN case this exists
 * for); `PORT` defaults to 5183, the same port `vite dev` uses, so whichever
 * one is running answers the same URL.
 *
 * Building is a separate, explicit step (`pnpm --filter studio bundle`): this
 * script does not build for you. It refuses to start against a missing bundle
 * with one line rather than serving a blank page.
 */

// first: `*_FILE` variables resolved before any other module reads the environment
import './boot-env.ts';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';

import { AuthConfigError } from './auth/config.ts';
import { studioAuthFromEnv, type StudioAuth } from './auth/studio-auth.ts';
import { pgPeople } from './auth/people.ts';
import { pgTokens, tokenEnvOf } from './auth/tokens.ts';
import { studioBackupFromEnv } from './backup/backup.ts';
import { createStandaloneApp } from './standalone-app.ts';
import { blobStoreFromEnv, type BlobStore } from './blobs.ts';
import { workbenchDepsFromEnv } from './default-deps.ts';
import { backendFromEnv } from './pg/config.ts';
import { envVar, legacyEnvWarning } from './env.ts';
import { environmentRefusal, wirehubEnv } from './env-guard.ts';
import { registry } from './modules.ts';
import { deepHealthCheck, startHealthMonitor } from './health.ts';
import { notifierFromEnv } from './notify.ts';
import { generateSetupCode, parseSuggestedModules, setupBanner, setupNeeded } from './setup.ts';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(
    `No build found at ${distDir}. Run \`pnpm --filter studio bundle\` first, then \`pnpm --filter studio start\` again.`,
  );
  process.exit(1);
}

// hubs set up before the rename still use STUDIO_* names: they work, with one warning
const legacyEnv = legacyEnvWarning(process.env);
if (legacyEnv !== undefined) console.warn(`[env] ${legacyEnv}`);

// a development and a production instance kept apart (WIREHUB_ENV; specs/postgres-backend.md §8.7)
const refusal = environmentRefusal(process.env);
if (refusal !== undefined) {
  console.error(`[env] ${refusal}`);
  process.exit(1);
}

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 5183);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`PORT must be a positive integer; got '${process.env.PORT}'.`);
  process.exit(1);
}

// every save a git commit, pushed to the remote (WIREHUB_GIT_AUTOCOMMIT=true;
// "Backup" in the README). The repo is the checkout this file is in.
const repoDir = envVar('GIT_DIR') ?? fileURLToPath(new URL('../../..', import.meta.url));
// the database backend is its own history: no git export there (specs/postgres-backend.md §7.6)
let usesDatabase = false;
try {
  usesDatabase = backendFromEnv(process.env) === 'pg';
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (usesDatabase && envVar('GIT_AUTOCOMMIT') !== undefined) console.warn('[backup] WIREHUB_GIT_* is ignored with WIREHUB_BACKEND=pg: the database is the history.');
const backup = usesDatabase ? undefined : studioBackupFromEnv(process.env, repoDir);
if (backup !== undefined) {
  // pull --rebase before serving, so the first save lands on the remote's latest
  await backup.start();
  const status = backup.status();
  console.log(`[backup] ${status.remote}/${status.branch}: ${status.state}${status.message === '' ? '' : ` — ${status.message}`}`);
}

// where uploaded file bytes go: an S3-compatible store, a directory, or (unset)
// beside the catalog — WIREHUB_BLOBS, see server/blobs.ts and .env.example
let blobs: BlobStore | undefined;
try {
  blobs = blobStoreFromEnv(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (blobs !== undefined && 'ensureBucket' in blobs && typeof blobs.ensureBucket === 'function') {
  // the store may still be starting: retry for a minute before giving up
  const ensure = blobs.ensureBucket as () => Promise<void>;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ensure();
      break;
    } catch (error) {
      if (attempt >= 30) {
        console.error(`[blobs] ${blobs.describe}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      await new Promise((done) => setTimeout(done, 2000));
    }
  }
}

// first-run setup asks for a one-time code: the stack's generated one
// (WIREHUB_SETUP_CODE / _FILE), else one made up now; printed below
const configuredCode = process.env.WIREHUB_SETUP_CODE?.trim();
const setupCode = configuredCode !== undefined && configuredCode !== '' ? configuredCode : process.env.WIREHUB_SETUP_PROMPT === '1' ? generateSetupCode() : undefined;
const suggested = parseSuggestedModules(process.env.WIREHUB_SUGGESTED_MODULES) ?? [];
const unknownSuggested = suggested.filter((id) => !registry.domains().some((m) => m.id === id));
if (unknownSuggested.length > 0) {
  console.warn(`[setup] WIREHUB_SUGGESTED_MODULES names no domain module of this build: ${unknownSuggested.join(', ')} (offered: ${registry.domains().map((m) => m.id).join(', ')}).`);
}

// the monitoring webhook (WIREHUB_NOTIFY_URL, plan §8.6): optional; events are logged either way
let notifier: ReturnType<typeof notifierFromEnv>;
try {
  notifier = notifierFromEnv(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// the stores: files (default) or Postgres (WIREHUB_BACKEND=pg; specs/postgres-backend.md)
let workbench: Awaited<ReturnType<typeof workbenchDepsFromEnv>>;
try {
  workbench = await workbenchDepsFromEnv(process.env, { ...(blobs === undefined ? {} : { blobs }), ...(setupCode === undefined ? {} : { setupCode }) });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const deps = workbench.deps;

// the studio's own login — off unless AUTH_ENABLED=true (see "Auth" in the README);
// on the database backend its accounts, people and invitations are in Postgres
let auth: StudioAuth | undefined;
try {
  auth = await studioAuthFromEnv(process.env, {
      // sign-in methods the deployment's modules add (docs/modules.md)
      providers: registry.authProviders(),
      ...(workbench.pg === undefined
      ? {}
      : {
          pg: {
            url: workbench.pg.url,
            people: pgPeople(workbench.pg.db, workbench.pg.orgId),
            tokens: pgTokens(workbench.pg.db, workbench.pg.orgId),
            tokenEnv: tokenEnvOf(process.env),
            setupMode: workbench.pg.setupMode,
            notifier,
          },
        }),
    });
} catch (error) {
  if (!(error instanceof AuthConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// first-run setup on the database makes the admin's account through the sign-in
workbench.pg?.attachAuth(auth);
// what the browser shows: a development instance's banner; People and API tokens when there are accounts
const instanceEnv = wirehubEnv(process.env);
deps.instance = { ...(instanceEnv === undefined ? {} : { env: instanceEnv }), accounts: auth?.people !== undefined };

// /healthz?deep=1 (plan §8.3) and the monitor that turns its failures into alerts
const deepHealth = deepHealthCheck({
  ...(workbench.pg === undefined ? {} : { db: workbench.pg.db }),
  ...(blobs === undefined ? {} : { blobs }),
  modules: registry.modules,
  ...((process.env.WIREHUB_BACKUP_MARKER ?? '').trim() === '' ? {} : { backupMarker: (process.env.WIREHUB_BACKUP_MARKER as string).trim() }),
  ...(instanceEnv === undefined ? {} : { env: instanceEnv }),
  ...((process.env.WIREHUB_VERSION ?? '') === '' ? {} : { version: process.env.WIREHUB_VERSION as string }),
});
if (notifier.enabled) startHealthMonitor(deepHealth, notifier);

const app = createStandaloneApp({ distDir, deps, depictionDeps: workbench.depictionDeps, deepHealth, ...(auth === undefined ? {} : { auth }), ...(backup === undefined ? {} : { backup }) });

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`WireHub serving ${distDir}`);
  console.log(`  http://${info.address === '0.0.0.0' || info.address === '::' ? 'localhost' : info.address}:${info.port}`);
  console.log(`  (bound to ${host}:${info.port} — reachable on the LAN unless HOST was narrowed)`);
  console.log(`  catalog: ${workbench.describe}`);
  console.log(`  blobs: ${blobs === undefined ? 'beside the catalog (WIREHUB_BLOBS unset)' : blobs.describe}`);
  if (auth !== undefined) {
    const methods = [auth.config.oidc === undefined ? '' : auth.config.oidc.name, auth.config.smtp === undefined ? '' : 'magic link', ...(auth.providers ?? []).map((p) => p.name)]
      .filter((m) => m !== '')
      .join(' + ');
    console.log(`  auth ON (${methods}) — sign in at ${auth.config.baseURL}/sign-in; ${auth.config.allowedEmails.size} allowed email(s)`);
  }
  if (setupCode !== undefined && deps.setup !== undefined && setupNeeded(deps.setup)) {
    const url = (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '') || `http://localhost:${info.port}`;
    console.log(`\n${setupBanner(url, setupCode)}\n`);
  }
});
