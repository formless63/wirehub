/**
 * The login gate on the standalone Hono app — mounted by `standalone-app.ts`
 * only when a `StudioAuth` was built (`AUTH_ENABLED=true`); with auth off none
 * of this is registered and the app is exactly what it was before.
 *
 * Order matters and is fixed here:
 *
 * 1. `/api/auth/*` → Better Auth's own handler (sign-in, callbacks, sign-out).
 * 2. `/sign-in` → the server-rendered sign-in page.
 * 3. Everything else passes the gate: no session → `401` JSON under `/api/`
 *    (in the API's own `{ error, hint }` voice) or a redirect to `/sign-in`
 *    for the SPA; a session whose email has left the allow-list → `403`.
 *
 * Writes (`POST`/`PUT`/`PATCH`/`DELETE` under `/api/`) that succeed are
 * attributed: the response carries `X-Studio-User: <email>` and a line lands
 * in `<AUTH_DATA_DIR>/saves.jsonl` (plus the server log) — the audit trail a
 * later commit step can read. Catalog file formats are untouched.
 */

import type { Context, Hono } from 'hono';

import { sessionStudioUser, type StudioUser } from '../me.ts';
import { renderSignInPage } from './sign-in-page.ts';
import { AUTH_BASE_PATH, EMAIL_NOT_ALLOWED, SIGN_IN_PATH, type StudioAuth } from './studio-auth.ts';

export const USER_HEADER = 'x-studio-user';

/** the session user the gate found for each request it let through — read by the API adapter */
const signedIn = new WeakMap<Request, StudioUser>();

/** Who the gate let this request through as; `undefined` with auth off. */
export function signedInUser(request: Request): StudioUser | undefined {
  return signedIn.get(request);
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Only same-site, non-auth paths are valid post-sign-in destinations. */
export function safeNext(value: string | undefined): string {
  if (value === undefined || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (value.startsWith(SIGN_IN_PATH) || value.startsWith(AUTH_BASE_PATH)) return '/';
  return value;
}

function json(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function signInRedirect(c: Context, extra?: Record<string, string>): Response {
  const url = new URL(c.req.url);
  const params = new URLSearchParams({ next: safeNext(`${url.pathname}${url.search}`), ...(extra ?? {}) });
  return new Response(null, { status: 302, headers: { location: `${SIGN_IN_PATH}?${params}`, 'cache-control': 'no-store' } });
}

export function mountAuth(app: Hono, auth: StudioAuth): void {
  const { config } = auth;

  app.on(['GET', 'POST'], [AUTH_BASE_PATH, `${AUTH_BASE_PATH}/*`], (c) => auth.handler(c.req.raw));

  app.get(SIGN_IN_PATH, async (c) => {
    const user = await auth.sessionUser(c.req.raw.headers);
    const error = c.req.query('error');
    return html(
      renderSignInPage({
        ...(config.oidc === undefined
          ? {}
          : { oidc: { providerId: config.oidc.providerId, name: config.oidc.name, emailClaim: config.oidc.emailClaim } }),
        magicLink: config.smtp !== undefined,
        next: safeNext(c.req.query('next')),
        ...(error === undefined || error === '' ? {} : { error }),
        ...(user === null ? {} : { signedInAs: { email: user.email, allowed: auth.isAllowed(user.email) } }),
      }),
    );
  });

  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === SIGN_IN_PATH || path === AUTH_BASE_PATH || path.startsWith(`${AUTH_BASE_PATH}/`)) return next();
    const api = isApiPath(path);
    const user = await auth.sessionUser(c.req.raw.headers);

    if (user === null) {
      if (api) {
        return json(401, {
          error: 'You are signed out, so the studio did not do that.',
          hint: 'Nothing was changed. Reload the page to sign in again.',
          signIn: SIGN_IN_PATH,
        });
      }
      if (c.req.method === 'GET' || c.req.method === 'HEAD') return signInRedirect(c);
      return c.text('Sign in first.', 401);
    }

    if (!auth.isAllowed(user.email)) {
      if (api) {
        return json(403, {
          error: `${user.email} is not allowed to use the studio.`,
          hint: 'Ask the owner to add it to AUTH_ALLOWED_EMAILS, or sign out and use another account.',
          code: EMAIL_NOT_ALLOWED,
        });
      }
      return signInRedirect(c, { error: EMAIL_NOT_ALLOWED });
    }

    signedIn.set(c.req.raw, sessionStudioUser(user));
    await next();

    if (api && WRITE_METHODS.has(c.req.method)) {
      c.res.headers.set(USER_HEADER, user.email);
      if (c.res.status < 400) {
        auth.recordSave({
          at: new Date().toISOString(),
          email: user.email,
          method: c.req.method,
          path,
          status: c.res.status,
        });
      }
    }
  });
}
