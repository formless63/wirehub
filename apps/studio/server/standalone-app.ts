/**
 * The standalone server's app: the workbench API mounted on Hono, then the
 * built bundle served under it with SPA fallback.
 *
 * Split out from `serve.ts` so it can be built and exercised in a test
 * without binding a socket — `serve.ts` is the few lines that turn this into
 * a process listening on `HOST`/`PORT`.
 */

import { Hono } from 'hono';

import type { WorkbenchDeps } from './api.ts';
import { mountAuth } from './auth/gate.ts';
import type { StudioAuth } from './auth/studio-auth.ts';
import { BACKUP_DISABLED } from './backup/status.ts';
import type { StudioBackup } from './backup/backup.ts';
import { defaultWorkbenchDeps } from './default-deps.ts';
import { defaultDepictionDeps, type DepictionDeps } from './depictions.ts';
import { mountWorkbenchApi } from './hono-adapter.ts';
import { mountStaticApp } from './static.ts';

export interface StandaloneAppOptions {
  /** the `vite build` output directory to serve — `dist/index.html` must exist */
  distDir: string;
  deps?: WorkbenchDeps;
  depictionDeps?: DepictionDeps;
  /**
   * The studio's own login (`server/auth/`), built only when
   * `AUTH_ENABLED=true`. Absent → nothing auth-related is mounted and the app
   * is byte-for-byte what it was without it.
   */
  auth?: StudioAuth;
  /** the git backup (`WIREHUB_GIT_AUTOCOMMIT=true`); absent → saves are not committed */
  backup?: StudioBackup;
}

export function createStandaloneApp(options: StandaloneAppOptions): Hono {
  const app = new Hono();
  // the container healthcheck: ahead of the login gate, so it answers without a session
  app.get('/healthz', (c) => {
    const backup = options.backup?.status() ?? BACKUP_DISABLED;
    return c.json(
      {
        ok: true,
        backup: { enabled: backup.enabled, state: backup.state, pendingCommits: backup.pendingCommits, lastPush: backup.lastPush?.at ?? null },
      },
      200,
      { 'cache-control': 'no-store' },
    );
  });
  // the login gate first, when there is one: its sign-in routes, then the
  // session check every other route (API and SPA alike) passes through
  if (options.auth !== undefined) mountAuth(app, options.auth);
  // the API first: nothing under `/api/` should ever fall through to the
  // static/SPA route below it
  const deps = options.deps ?? defaultWorkbenchDeps();
  mountWorkbenchApi(
    app,
    options.backup === undefined ? deps : { ...deps, backup: options.backup },
    options.depictionDeps ?? defaultDepictionDeps(),
    options.backup,
  );
  mountStaticApp(app, options.distDir);
  return app;
}
