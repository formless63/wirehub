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
import type { DeepHealth } from './health.ts';
import { mountAuth } from './auth/gate.ts';
import type { StudioAuth } from './auth/studio-auth.ts';
import { BACKUP_DISABLED } from './backup/status.ts';
import type { StudioBackup } from './backup/backup.ts';
import { defaultWorkbenchDeps } from './default-deps.ts';
import { defaultDepictionDeps, type DepictionDeps } from './depictions.ts';
import { mountWorkbenchApi } from './hono-adapter.ts';
import { mountStaticApp } from './static.ts';
import type { inFlightCounter } from './system.ts';

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
  /** `/healthz?deep=1` (plan §8.3); absent → the deep form answers the plain one plus `deep: null` */
  deepHealth?: () => Promise<DeepHealth>;
  /** requests in flight, for a restart's drain (`system.ts`); the event stream is not counted */
  inFlight?: ReturnType<typeof inFlightCounter>;
  /** true once a restart drains: new requests are answered 503 (the boot address excepted, so the page can wait) */
  restarting?: () => boolean;
}

export function createStandaloneApp(options: StandaloneAppOptions): Hono {
  const app = new Hono();
  // a restart from Settings (`system.ts`): count what is in flight, refuse what comes after the drain began
  if (options.inFlight !== undefined || options.restarting !== undefined) {
    app.use('*', async (c, next) => {
      if (options.restarting?.() === true && c.req.path !== '/healthz' && c.req.path !== '/api/system/boot') {
        return c.json({ state: 'restarting', error: 'WireHub is restarting.', hint: 'It will be back in a moment; the page reconnects by itself.' }, 503, { 'retry-after': '5' });
      }
      if (options.inFlight === undefined || c.req.path === '/api/events') return next();
      const leave = options.inFlight.enter();
      try {
        await next();
      } finally {
        leave();
      }
    });
  }
  // the container healthcheck: ahead of the login gate, so it answers without a session
  app.get('/healthz', async (c) => {
    const backup = options.backup?.status() ?? BACKUP_DISABLED;
    const plain = {
      ok: true,
      backup: { enabled: backup.enabled, state: backup.state, pendingCommits: backup.pendingCommits, lastPush: backup.lastPush?.at ?? null },
    };
    // the plain form is the container probe and never touches the database; `?deep=1` checks the dependencies
    if (c.req.query('deep') !== '1') return c.json(plain, 200, { 'cache-control': 'no-store' });
    const deep = options.deepHealth === undefined ? null : await options.deepHealth();
    return c.json({ ...plain, ok: deep?.ok ?? true, deep }, deep !== null && !deep.ok ? 503 : 200, { 'cache-control': 'no-store' });
  });
  // the login gate first, when there is one: its sign-in routes, then the
  // session check every other route (API and SPA alike) passes through
  if (options.auth !== undefined) mountAuth(app, options.auth, { spaAccountPages: true });
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
