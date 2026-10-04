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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';

import { AuthConfigError } from './auth/config.ts';
import { studioAuthFromEnv, type StudioAuth } from './auth/studio-auth.ts';
import { studioBackupFromEnv } from './backup/backup.ts';
import { createStandaloneApp } from './standalone-app.ts';
import { blobStoreFromEnv, type BlobStore } from './blobs.ts';
import { defaultWorkbenchDeps } from './default-deps.ts';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(
    `No build found at ${distDir}. Run \`pnpm --filter studio bundle\` first, then \`pnpm --filter studio start\` again.`,
  );
  process.exit(1);
}

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 5183);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`PORT must be a positive integer; got '${process.env.PORT}'.`);
  process.exit(1);
}

// the studio's own login — off unless AUTH_ENABLED=true (see "Auth" in the README)
let auth: StudioAuth | undefined;
try {
  auth = await studioAuthFromEnv(process.env);
} catch (error) {
  if (!(error instanceof AuthConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// every save a git commit, pushed to the remote (STUDIO_GIT_AUTOCOMMIT=true;
// "Backup" in the README). The repo is the checkout this file is in.
const repoDir = process.env.STUDIO_GIT_DIR ?? fileURLToPath(new URL('../../..', import.meta.url));
const backup = studioBackupFromEnv(process.env, repoDir);
if (backup !== undefined) {
  // pull --rebase before serving, so the first save lands on the remote's latest
  await backup.start();
  const status = backup.status();
  console.log(`[backup] ${status.remote}/${status.branch}: ${status.state}${status.message === '' ? '' : ` — ${status.message}`}`);
}

// where uploaded file bytes go: an S3-compatible store, a directory, or (unset)
// beside the catalog — STUDIO_BLOBS, see server/blobs.ts and .env.example
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

const app = createStandaloneApp({ distDir, deps: defaultWorkbenchDeps(blobs === undefined ? {} : { blobs }), ...(auth === undefined ? {} : { auth }), ...(backup === undefined ? {} : { backup }) });

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`WireHub serving ${distDir}`);
  console.log(`  http://${info.address === '0.0.0.0' || info.address === '::' ? 'localhost' : info.address}:${info.port}`);
  console.log(`  (bound to ${host}:${info.port} — reachable on the LAN unless HOST was narrowed)`);
  console.log(`  blobs: ${blobs === undefined ? 'beside the catalog (STUDIO_BLOBS unset)' : blobs.describe}`);
  if (auth !== undefined) {
    const methods = [auth.config.oidc === undefined ? '' : auth.config.oidc.name, auth.config.smtp === undefined ? '' : 'magic link']
      .filter((m) => m !== '')
      .join(' + ');
    console.log(`  auth ON (${methods}) — sign in at ${auth.config.baseURL}/sign-in; ${auth.config.allowedEmails.size} allowed email(s)`);
  }
});
