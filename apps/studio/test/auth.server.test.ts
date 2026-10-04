/**
 * The studio's own login (`server/auth/`, / `50a.40`).
 *
 * Auth off: `readAuthConfig` says so and `createStandaloneApp` without `auth`
 * mounts nothing new (the rest of the suite — `static.server.test.ts`,
 * `hosts.server.test.ts` — is the proof the off path is unchanged).
 *
 * Auth on: a real Better Auth instance over an in-memory `node:sqlite`
 * database, a mock OIDC provider on a loopback socket (discovery, JWKS, token
 * endpoint issuing RS256 ID tokens carrying a custom `studio_email` claim), and a stub mail
 * transport for the magic link. Everything goes through `app.request()`.
 */

import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { serve, type ServerType } from '@hono/node-server';
import { loadDb, loadDesign } from '@cable-studio/catalog';
import type { CableDesign, Db } from '@cable-studio/model';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import { AuthConfigError, readAuthConfig, type AuthConfigEnabled } from '../server/auth/config.ts';
import { USER_HEADER } from '../server/auth/gate.ts';
import type { MailMessage } from '../server/auth/mailer.ts';
import { createStudioAuth } from '../server/auth/studio-auth.ts';
import type { DepictionDeps } from '../server/depictions.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { createStandaloneApp } from '../server/standalone-app.ts';

const CATALOG: Db = loadDb();
const REAL: CableDesign = loadDesign('rs485-de9-terminal-board');
const BASE = 'http://studio.test';
const OWNER = 'owner@example.test';
const STRANGER = 'stranger@elsewhere.test';

function memoryDesignStore(): DesignStore {
  const files = new Map<string, string>([[REAL.id, formatDesignJson(REAL)]]);
  return {
    list: () => [...files.keys()].map((id) => ({ id, label: id })),
    has: (id) => files.has(id),
    read: (id) => {
      const text = files.get(id);
      return text === undefined ? undefined : (JSON.parse(text) as CableDesign);
    },
    write: (id, design) => {
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
}

const deps = (): WorkbenchDeps => ({ designs: memoryDesignStore(), loadDb: () => CATALOG });
const depictionDeps = (): DepictionDeps => ({
  store: {
    listDefIds: () => [],
    readMeta: () => undefined,
    writeMeta: () => undefined,
    readAsset: () => undefined,
    writeAsset: () => undefined,
    dirFor: () => undefined,
  },
  loadDb: () => CATALOG,
});

/* ------------------------------------------------------------------ *
 * A mock OIDC provider
 * ------------------------------------------------------------------ */

interface MockIdp {
  issuer: string;
  /** what the next token response's ID token carries */
  next: { sub: string; studio_email?: string; nonce?: string };
  close(): Promise<void>;
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJwt(key: KeyObject, claims: Record<string, unknown>): string {
  const input = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64url(claims)}`;
  const signature = createSign('RSA-SHA256').update(input).sign(key).toString('base64url');
  return `${input}.${signature}`;
}

async function startIdp(clientId: string): Promise<MockIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const idp = new Hono();
  const state: MockIdp = { issuer: '', next: { sub: 'u1' }, close: async () => undefined };
  idp.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer: state.issuer,
      authorization_endpoint: `${state.issuer}/authorize`,
      token_endpoint: `${state.issuer}/token`,
      userinfo_endpoint: `${state.issuer}/userinfo`,
      jwks_uri: `${state.issuer}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
    }),
  );
  idp.get('/jwks', (c) => c.json({ keys: [jwk] }));
  idp.post('/token', (c) => {
    const now = Math.floor(Date.now() / 1000);
    const { sub, studio_email, nonce } = state.next;
    return c.json({
      access_token: 'at-1',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: signJwt(privateKey, {
        iss: state.issuer,
        aud: clientId,
        sub,
        iat: now,
        exp: now + 600,
        name: 'Test Person',
        email: 'standard-claim@ignored.test',
        ...(studio_email === undefined ? {} : { studio_email }),
        ...(nonce === undefined ? {} : { nonce }),
      }),
    });
  });
  idp.get('/userinfo', (c) => c.json({ sub: state.next.sub }));

  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: idp.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
  });
  state.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

/* ------------------------------------------------------------------ *
 * Cookies, by hand
 * ------------------------------------------------------------------ */

class Jar {
  private cookies = new Map<string, string>();
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  has(fragment: string): boolean {
    return [...this.cookies.keys()].some((k) => k.includes(fragment));
  }
}

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ */

let idp: MockIdp;
let distDir: string;
let dataDir: string;
let mails: MailMessage[];
let smtpDown: boolean;
let database: DatabaseSync;

beforeAll(async () => {
  idp = await startIdp('studio-client');
});
afterAll(async () => {
  await idp.close();
});

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'studio-auth-dist-'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>studio shell</body></html>\n');
  dataDir = mkdtempSync(join(tmpdir(), 'studio-auth-data-'));
  mails = [];
  smtpDown = false;
  database = new DatabaseSync(':memory:');
});
afterEach(() => {
  database.close();
  rmSync(distDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
    BETTER_AUTH_URL: BASE,
    AUTH_ALLOWED_EMAILS: `${OWNER}, alex@example.test`,
    AUTH_DATA_DIR: dataDir,
    AUTH_OIDC_ISSUER: idp.issuer,
    AUTH_OIDC_CLIENT_ID: 'studio-client',
    AUTH_OIDC_CLIENT_SECRET: 'studio-secret',
    AUTH_SMTP_HOST: 'smtp.invalid',
    AUTH_SMTP_FROM: 'studio@example.test',
    // a custom claim, so the tests prove the configured claim is read, not the standard one
    AUTH_OIDC_EMAIL_CLAIM: 'studio_email',
    ...extra,
  };
}

async function authedApp(extra: Record<string, string> = {}) {
  const config = readAuthConfig(env(extra)) as AuthConfigEnabled;
  const auth = await createStudioAuth(config, {
    database,
    mailTransport: {
      sendMail: async (message) => {
        if (smtpDown) throw new Error('connect ECONNREFUSED');
        mails.push(message);
      },
    },
  });
  const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps(), auth });
  const call = (path: string, init: RequestInit = {}, jar?: Jar) => {
    const headers = new Headers(init.headers);
    if (jar !== undefined) headers.set('cookie', jar.header());
    if (init.method !== undefined && init.method !== 'GET') headers.set('origin', BASE);
    return app.request(`${BASE}${path}`, { ...init, headers });
  };
  return { app, call };
}

type Call = Awaited<ReturnType<typeof authedApp>>['call'];

async function oidcSignIn(call: Call, email: string | undefined): Promise<{ jar: Jar; landing: Response }> {
  const jar = new Jar();
  const start = await call('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'oidc', callbackURL: '/', errorCallbackURL: '/sign-in' }),
  });
  expect(start.status).toBe(200);
  jar.take(start);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.origin).toBe(idp.issuer);
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${BASE}/api/auth/callback/oidc`);
  const nonce = authorize.searchParams.get('nonce') ?? undefined;
  idp.next = { sub: `sub-${email ?? 'none'}`, ...(email === undefined ? {} : { studio_email: email }), ...(nonce === undefined ? {} : { nonce }) };
  const state = authorize.searchParams.get('state')!;
  const landing = await call(`/api/auth/callback/oidc?code=c1&state=${encodeURIComponent(state)}`, {}, jar);
  jar.take(landing);
  return { jar, landing };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('auth config', () => {
  it('is off unless AUTH_ENABLED=true', () => {
    expect(readAuthConfig({})).toEqual({ enabled: false });
    expect(readAuthConfig({ AUTH_ENABLED: 'false', BETTER_AUTH_SECRET: 'x' })).toEqual({ enabled: false });
  });

  it('refuses to start half-configured, naming the variable', () => {
    expect(() => readAuthConfig({ ...env(), BETTER_AUTH_SECRET: '' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => readAuthConfig({ ...env(), AUTH_ALLOWED_EMAILS: ' , ' })).toThrow(AuthConfigError);
    expect(() => readAuthConfig({ ...env(), AUTH_OIDC_ISSUER: '', AUTH_SMTP_HOST: '' })).toThrow(/no sign-in method/);
  });

  it('reads the OIDC claim and SMTP defaults', () => {
    const config = readAuthConfig({ ...env(), AUTH_OIDC_EMAIL_CLAIM: undefined }) as AuthConfigEnabled;
    expect(config.oidc).toMatchObject({ providerId: 'oidc', emailClaim: 'email', scopes: ['openid', 'email', 'profile'] });
    expect(config.smtp).toMatchObject({ port: 465, secure: true });
    expect([...config.allowedEmails]).toEqual([OWNER, 'alex@example.test']);
  });
});

describe('auth off', () => {
  it('mounts nothing: the API and the SPA answer without a session', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    expect((await app.request('/api/designs')).status).toBe(200);
    expect(await (await app.request('/')).text()).toContain('studio shell');
    expect((await app.request('/api/auth/get-session')).status).not.toBe(200);
  });
});

describe('auth on', () => {
  it('unauthenticated: /api/* is 401 in the API voice, the SPA redirects to /sign-in', async () => {
    const { call } = await authedApp();
    const api = await call('/api/designs');
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ error: expect.stringContaining('signed out'), signIn: '/sign-in' });

    const spa = await call('/cables/foo?x=1');
    expect(spa.status).toBe(302);
    expect(spa.headers.get('location')).toBe(`/sign-in?next=${encodeURIComponent('/cables/foo?x=1')}`);

    const page = await call('/sign-in');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Sign in with Single sign-on');
    expect(html).toContain('id="magic"');
  });

  it('OIDC: an allow-listed studio_email gets a session, the API answers 200, saves are attributed', async () => {
    const { call } = await authedApp();
    const { jar, landing } = await oidcSignIn(call, OWNER.toUpperCase());
    expect(landing.status).toBe(302);
    expect(landing.headers.get('location')).toBe('/');
    expect(jar.has('session_token')).toBe(true);

    expect((await call('/api/designs', {}, jar)).status).toBe(200);
    expect(await (await call('/', {}, jar)).text()).toContain('studio shell');

    //: the session user is who the studio says is here
    expect(await (await call('/api/me', {}, jar)).json()).toEqual({ user: { name: 'Test Person', email: OWNER, source: 'session' } });

    const etag = (await call(`/api/designs/${REAL.id}`, {}, jar)).headers.get('etag') as string;
    const save = await call(
      `/api/designs/${REAL.id}`,
      { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': etag }, body: JSON.stringify(REAL) },
      jar,
    );
    expect(save.status).toBe(200);
    expect(save.headers.get(USER_HEADER)).toBe(OWNER);
    const log = readFileSync(join(dataDir, 'saves.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log).toEqual([expect.objectContaining({ email: OWNER, method: 'PUT', path: `/api/designs/${REAL.id}`, status: 200 })]);
  });

  it('OIDC: a non-allow-listed email is refused with a clear message and no session', async () => {
    const { call } = await authedApp();
    const { jar, landing } = await oidcSignIn(call, STRANGER);
    expect(landing.status).toBe(302);
    const location = new URL(landing.headers.get('location')!, BASE);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('error')).toBe('EMAIL_NOT_ALLOWED');
    expect(jar.has('session_token')).toBe(false);
    expect((await call('/api/designs', {}, jar)).status).toBe(401);

    const page = await (await call(`${location.pathname}${location.search}`)).text();
    expect(page).toContain('not allowed to use the studio');
  });

  it('OIDC: a missing studio_email claim is refused, naming the claim', async () => {
    const { call } = await authedApp();
    const { jar, landing } = await oidcSignIn(call, undefined);
    const location = new URL(landing.headers.get('location')!, BASE);
    expect(location.searchParams.get('error')?.toUpperCase()).toBe('EMAIL_NOT_FOUND');
    expect(jar.has('session_token')).toBe(false);
    expect(await (await call(`${location.pathname}${location.search}`)).text()).toContain('studio_email');
  });

  it('a session whose email has left the allow-list is refused on the next request', async () => {
    const first = await authedApp();
    const { jar } = await oidcSignIn(first.call, OWNER);
    expect((await first.call('/api/designs', {}, jar)).status).toBe(200);

    // same database, owner removed from the list
    const second = await authedApp({ AUTH_ALLOWED_EMAILS: 'alex@example.test' });
    const res = await second.call('/api/designs', {}, jar);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'EMAIL_NOT_ALLOWED' });
  });

  it('magic link: an allow-listed email gets exactly one mail, and the link signs in', async () => {
    const { call } = await authedApp();
    const res = await call('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alex@example.test', callbackURL: '/', errorCallbackURL: '/sign-in' }),
    });
    expect(res.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'alex@example.test', from: 'studio@example.test' });

    const link = new URL(/https?:\/\/\S+/.exec(mails[0]!.text)![0]);
    expect(link.origin).toBe(BASE);
    const jar = new Jar();
    const verify = await call(`${link.pathname}${link.search}`, {}, jar);
    jar.take(verify);
    expect(verify.status).toBe(302);
    expect((await call('/api/designs', {}, jar)).status).toBe(200);
  });

  it('magic link: a non-allow-listed email is refused and nothing is sent', async () => {
    const { call } = await authedApp();
    const res = await call('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: STRANGER, callbackURL: '/' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'EMAIL_NOT_ALLOWED', message: expect.stringContaining('not allowed') });
    expect(mails).toHaveLength(0);
  });

  it('magic link: an SMTP failure is reported in words, not a bare 500', async () => {
    const { call } = await authedApp();
    smtpDown = true;
    const res = await call('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER, callbackURL: '/' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'MAIL_NOT_SENT' });
  });
});
