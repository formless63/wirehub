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
import { renderInvitePage, renderSignInPage } from './sign-in-page.ts';
import { ROLES, type PeopleStore, type Person, type Role } from './people.ts';
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

export const INVITE_PATH = '/invite';
export const INVITATIONS_PATH = '/api/invitations';

/** `/api/invitations` — owners only, with a session (never a token, plan §4.5). */
async function invitationsRoute(c: Context, people: PeopleStore, person: Person | undefined, baseURL: string): Promise<Response> {
  if (person?.role !== 'owner') return json(403, { error: 'Only an owner can invite people.', hint: 'Ask an owner of this hub.' });
  const id = c.req.path.slice(INVITATIONS_PATH.length + 1);
  if (id === '') {
    if (c.req.method === 'GET') return json(200, { invitations: await people.listInvitations() });
    if (c.req.method === 'POST') {
      const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return json(400, { error: 'Say whom to invite: an email address.' });
      const role = (ROLES as readonly unknown[]).includes(body.role) ? (body.role as Role) : 'editor';
      if ((await people.personByEmail(email)) !== undefined) return json(409, { error: `${email} is already in this hub.` });
      const { invitation, token } = await people.createInvitation({ email, role, invitedBy: person.id });
      // shown once: only its hash is stored
      return json(201, { invitation, link: `${baseURL}${INVITE_PATH}?token=${encodeURIComponent(token)}` });
    }
    return json(405, { error: `${c.req.method} is not something this address accepts.`, hint: 'It answers GET and POST.' });
  }
  if (c.req.method === 'DELETE') {
    return (await people.revokeInvitation(id)) ? json(200, { revoked: id }) : json(404, { error: 'No open invitation by that id.' });
  }
  return json(405, { error: `${c.req.method} is not something this address accepts.`, hint: 'It answers DELETE.' });
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
        localAccounts: config.localAccounts,
        next: safeNext(c.req.query('next')),
        ...(error === undefined || error === '' ? {} : { error }),
        ...(user === null ? {} : { signedInAs: { email: user.email, allowed: await auth.isAllowed(user.email) } }),
      }),
    );
  });

  // invitations (database backend, B8): an owner invites by email with a role; the link's page makes the account
  const people = auth.people;
  if (people !== undefined && auth.acceptInvitation !== undefined) {
    const accept = auth.acceptInvitation;
    app.get(INVITE_PATH, (c) => html(renderInvitePage({ token: c.req.query('token') ?? '', localAccounts: config.localAccounts })));
    app.post(`${INVITATIONS_PATH}/accept`, async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { token?: unknown; name?: unknown; password?: unknown };
      if (typeof body.token !== 'string' || typeof body.password !== 'string') return json(400, { error: 'Send the invitation token and a password.' });
      return accept(body.token, typeof body.name === 'string' ? body.name : '', body.password);
    });
  }

  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === SIGN_IN_PATH || path === AUTH_BASE_PATH || path.startsWith(`${AUTH_BASE_PATH}/`)) return next();
    if (people !== undefined && (path === INVITE_PATH || path === `${INVITATIONS_PATH}/accept`)) return next();
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

    if (!(await auth.isAllowed(user.email))) {
      if (api) {
        return json(403, {
          error: `${user.email} is not allowed to use the studio.`,
          hint: 'Ask an administrator to add it to AUTH_ALLOWED_EMAILS, or sign out and use another account.',
          code: EMAIL_NOT_ALLOWED,
        });
      }
      return signInRedirect(c, { error: EMAIL_NOT_ALLOWED });
    }

    signedIn.set(c.req.raw, sessionStudioUser(user));
    if (people !== undefined && api) {
      const person = await people.personByEmail(user.email);
      // the account is committed by now: link it to its person once
      if (person !== undefined && person.authUserId !== user.id) await people.linkAuthUser(user.email, user.id);
      // a viewer reads; every write needs an editor or an owner (plan §4.5)
      if (person?.role === 'viewer' && WRITE_METHODS.has(c.req.method) && !path.startsWith('/api/locks')) {
        return json(403, { error: `${user.email} can view this hub but not change it.`, hint: 'Nothing was changed. Ask an owner for the editor role.' });
      }
      if (path === INVITATIONS_PATH || path.startsWith(`${INVITATIONS_PATH}/`)) return invitationsRoute(c, people, person, config.baseURL);
    }
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
