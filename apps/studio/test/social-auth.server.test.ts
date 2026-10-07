/** Synthetic fixed-host providers through real Better Auth callbacks and SQLite. */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAuthConfig, type AuthConfigEnabled } from '../server/auth/config.ts';
import { mountAuth } from '../server/auth/gate.ts';
import { renderSignInPage, signInErrorMessage } from '../server/auth/sign-in-page.ts';
import { createStudioAuth } from '../server/auth/studio-auth.ts';
import type { PeopleStore, Person } from '../server/auth/people.ts';

const BASE = 'http://studio.test';
const EMAIL = 'owner@example.test';
const env = (extra: Record<string, string> = {}) => ({ AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'synthetic-social-secret-at-least-32-characters', BETTER_AUTH_URL: BASE, AUTH_ALLOWED_EMAILS: `${EMAIL}, other@example.test`, AUTH_GITHUB_ENABLED: 'true', AUTH_GITHUB_CLIENT_ID: 'github-client', AUTH_GITHUB_CLIENT_SECRET: 'synthetic-github-secret', AUTH_GOOGLE_ENABLED: 'true', AUTH_GOOGLE_CLIENT_ID: 'google-client', AUTH_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret', ...extra });
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' };
function jwt(claims: Record<string, unknown> = {}, wrongSignature = false) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: 'synthetic' })}.${encode({ iss: 'https://accounts.google.com', aud: 'google-client', sub: 'google-person', iat: now, exp: now + 600, email: EMAIL, email_verified: true, name: 'Synthetic owner', ...claims })}`;
  return `${input}.${wrongSignature ? Buffer.from('invalid').toString('base64url') : createSign('RSA-SHA256').update(input).sign(keys.privateKey).toString('base64url')}`;
}
class Jar {
  values = new Map<string, string>();
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0]!;
      const index = pair.indexOf('=');
      const key = pair.slice(0, index);
      if (/max-age=0/i.test(line)) this.values.delete(key); else this.values.set(key, pair.slice(index + 1));
    }
  }
  header() { return [...this.values].map(([key, value]) => `${key}=${value}`).join('; '); }
}
let database: DatabaseSync;
let googleToken: string;
let emails: unknown;
let profile: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  database = new DatabaseSync(':memory:');
  googleToken = jwt();
  profile = { id: 42, login: 'synthetic', name: 'Synthetic owner', email: 'unverified-public@example.test' };
  emails = [{ email: EMAIL, primary: true, verified: true, visibility: 'private' }];
  fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-google-access', token_type: 'Bearer', expires_in: 3600, id_token: googleToken });
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'synthetic-github-access', token_type: 'Bearer', scope: 'read:user,user:email' });
    if (url === 'https://api.github.com/user') return Response.json(profile);
    if (url === 'https://api.github.com/user/emails?per_page=100') return Response.json(emails);
    throw new Error('Unexpected synthetic provider URL');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); database.close(); });
async function fixture(extra: Record<string, string> = {}, people?: PeopleStore) {
  const config = readAuthConfig(env(extra)) as AuthConfigEnabled;
  // SQLite is disposable; PG-like people assertions share its migrated auth tables.
  if (people) await createStudioAuth(config, { database });
  const auth = await createStudioAuth(config, { database, fetch: fetchMock, ...(people ? { pg: { url: 'postgres://unused.invalid', people }, sharedDatabase: database } : {}) });
  const app = new Hono(); mountAuth(app, auth);
  const call = async (path: string, body?: unknown, jar?: Jar) => {
    const response = await app.request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin: BASE, 'content-type': 'application/json', cookie: jar?.header() ?? '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    jar?.take(response); return response;
  };
  const oauth = async (provider: 'github' | 'google', jar = new Jar(), linking = false) => {
    const start = await call(`/api/auth/${linking ? 'link-social' : 'sign-in/social'}`, { provider, callbackURL: '/sign-in', errorCallbackURL: '/sign-in' }, jar);
    if (start.status !== 200) return { jar, response: start };
    const { url } = await start.json() as { url: string };
    const authorization = new URL(url);
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${BASE}/api/auth/callback/${provider}`);
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy();
    if (provider === 'github') expect(authorization.searchParams.get('scope')).toContain('user:email');
    const response = await call(`/api/auth/callback/${provider}?code=synthetic&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`, undefined, jar);
    return { jar, response };
  };
  return { auth, app, call, oauth };
}
const rows = (table: 'user' | 'account') => database.prepare(`SELECT * FROM "${table}"`).all();

describe('built-in social configuration', () => {
  it('requires explicit enablement and complete credentials, with social-only support', () => {
    expect(readAuthConfig(env({ AUTH_GITHUB_ENABLED: 'false', AUTH_GOOGLE_ENABLED: 'false', AUTH_SMTP_HOST: 'mail.invalid', AUTH_SMTP_FROM: EMAIL, AUTH_GOOGLE_CLIENT_SECRET: '' }))).not.toHaveProperty('google');
    expect(() => readAuthConfig(env({ AUTH_GOOGLE_CLIENT_SECRET: '' }))).toThrow('AUTH_GOOGLE_CLIENT_SECRET');
    expect(() => readAuthConfig(env({ AUTH_GITHUB_CLIENT_ID: '' }))).toThrow('AUTH_GITHUB_CLIENT_ID');
    expect(() => readAuthConfig(env({ AUTH_GOOGLE_ENABLED: 'perhaps' }))).toThrow('AUTH_GOOGLE_ENABLED');
    expect(readAuthConfig(env())).toMatchObject({ github: { clientId: 'github-client' }, google: { clientId: 'google-client' }, localAccounts: false });
  });
  it('reserves enabled builtin IDs against generic OIDC and module IDs', async () => {
    expect(() => readAuthConfig(env({ AUTH_OIDC_ISSUER: 'https://idp.example.test', AUTH_OIDC_CLIENT_ID: 'oidc-client', AUTH_OIDC_PROVIDER_ID: 'github' }))).toThrow('already used');
    await expect(createStudioAuth(readAuthConfig(env()) as AuthConfigEnabled, { database, providers: [{ id: 'github', label: 'Duplicate', kind: 'oauth2', config: {} }] })).rejects.toThrow('another sign-in provider');
  });
});

describe('verified social identities', () => {
  it('uses GitHub verified private primary email rather than public profile email', async () => {
    const f = await fixture(); const { jar, response } = await f.oauth('github');
    expect(response.status).toBe(302); expect(await f.auth.sessionUser(new Headers({ cookie: jar.header() }))).toMatchObject({ email: EMAIL });
    expect(rows('user')).toHaveLength(1); expect(rows('user')[0]).toMatchObject({ email: EMAIL, emailVerified: 1 });
    expect(f.auth.providers).toEqual([{ providerId: 'github', name: 'GitHub' }, { providerId: 'google', name: 'Google' }]);
    const page = await (await f.call('/sign-in')).text();
    expect(page).toContain('Sign in with GitHub'); expect(page).toContain('Sign in with Google');
  });
  it.each([[], [{ email: EMAIL, primary: false, verified: true }], [{ email: EMAIL, primary: true, verified: false }], [{ email: EMAIL, primary: true, verified: 'true' }]].map((value) => [value]))('refuses missing/unverified primary email without user or account creation: %j', async (value) => {
    emails = value; const f = await fixture(); const result = await f.oauth('github');
    expect(result.response.headers.get('location')).toContain('error='); expect(rows('user')).toHaveLength(0); expect(rows('account')).toHaveLength(0); expect(await f.auth.sessionUser(new Headers({ cookie: result.jar.header() }))).toBeNull();
  });
  it.each([0, -1, '', 'not-an-id'])('rejects malformed GitHub identity IDs: %j', async (id) => {
    profile.id = id; const f = await fixture(); await f.oauth('github'); expect(rows('user')).toHaveLength(0);
  });
  it('refuses GitHub profile failures and verified but uninvited emails', async () => {
    emails = [{ email: 'stranger@example.test', primary: true, verified: true }];
    const f = await fixture(); await f.oauth('github'); expect(rows('user')).toHaveLength(0);
    fetchMock.mockImplementation(async (input) => { if (String(input).startsWith('https://api.github.com/')) throw new Error('synthetic-secret-payload'); return Response.json({ access_token: 'synthetic-github-access', token_type: 'Bearer', scope: 'read:user,user:email' }); }); const result = await f.oauth('github');
    expect(result.response.headers.get('location')).not.toContain('synthetic-secret-payload'); expect(rows('account')).toHaveLength(0);
  });
  it('accepts signed verified Google tokens on callbacks and direct token signin', async () => {
    const f = await fixture(); const result = await f.oauth('google');
    expect(await f.auth.sessionUser(new Headers({ cookie: result.jar.header() }))).toMatchObject({ email: EMAIL });
    const direct = await f.call('/api/auth/sign-in/social', { provider: 'google', idToken: { token: googleToken } });
    expect(direct.status).toBe(200); expect(rows('user')).toHaveLength(1);
  });
  it.each([{ email_verified: false }, { email_verified: 'true' }, { aud: 'wrong-client' }, { iss: 'https://wrong.example.test' }, { exp: 1 }, { email: 'stranger@example.test' }, { email: 'owner space@example.test' }, { iat: 1 }])('rejects invalid Google claims on callback and direct token signin: %j', async (claims) => {
    googleToken = jwt(claims); const f = await fixture(); await f.oauth('google');
    expect((await f.call('/api/auth/sign-in/social', { provider: 'google', idToken: { token: googleToken } })).status).toBeGreaterThanOrEqual(400);
    expect(rows('user')).toHaveLength(0); expect(rows('account')).toHaveLength(0);
  });
  it('checks a supplied Google nonce and rejects absent or mismatched claims', async () => {
    const f = await fixture();
    const direct = () => f.call('/api/auth/sign-in/social', { provider: 'google', idToken: { token: googleToken, nonce: 'expected-nonce' } });
    expect((await direct()).status).toBe(401);
    googleToken = jwt({ nonce: 'wrong-nonce' }); expect((await direct()).status).toBe(401);
    googleToken = jwt({ nonce: 'expected-nonce' }); expect((await direct()).status).toBe(200);
  });
  it('rejects invalid signatures and fresh unverified identities for already-linked users', async () => {
    const f = await fixture(); await f.oauth('google'); await f.oauth('github'); const count = rows('account').length;
    googleToken = jwt({}, true); await f.oauth('google');
    googleToken = jwt({ email_verified: false }); const result = await f.oauth('google');
    expect(await f.auth.sessionUser(new Headers({ cookie: result.jar.header() }))).toBeNull();
    emails = [{ email: EMAIL, primary: true, verified: false }]; const gh = await f.oauth('github');
    expect(await f.auth.sessionUser(new Headers({ cookie: gh.jar.header() }))).toBeNull(); expect(rows('account')).toHaveLength(count);
  });
});

function peopleStore(person: Person): PeopleStore {
  return {
    personByEmail: async (address) => address.toLowerCase() === person.email ? person : undefined,
    ensurePerson: async () => person,
    linkAuthUser: async () => undefined,
    createInvitation: async () => { throw new Error('Not used'); },
    invitationByToken: async () => undefined,
    markAccepted: async () => undefined,
    listInvitations: async () => [],
    listPeople: async () => [person],
    setRole: async () => 'not-found',
    setDisabled: async () => 'not-found',
    revokeInvitation: async () => false,
    hasPasswordLogin: async () => false,
  };
}

describe('explicit authenticated connections', () => {
  async function localFixture() {
    const f = await fixture({ WIREHUB_BACKEND: 'pg' });
    await f.auth.createAccount!(EMAIL, 'Synthetic owner', 'synthetic-password-123');
    const jar = new Jar();
    expect((await f.call('/api/auth/sign-in/email', { email: EMAIL, password: 'synthetic-password-123' }, jar)).status).toBe(200);
    expect(rows('user')[0]).toMatchObject({ emailVerified: 0 });
    return { ...f, jar };
  }
  it.each(['github', 'google'] as const)('keeps unverified local users safe from implicit linking, but allows deliberate same-email %s connection', async (provider) => {
    const f = await localFixture(); const implicit = await f.oauth(provider);
    expect(implicit.response.headers.get('location')).toContain('error='); expect(rows('account')).toHaveLength(1);
    const page = await (await f.call('/sign-in', undefined, f.jar)).text();
    expect(page).toContain('Connect GitHub'); expect(page).toContain('Connect a provider using the same verified email as this account.');
    const explicit = await f.oauth(provider, f.jar, true); expect(explicit.response.headers.get('location')).not.toContain('error=');
    expect(rows('account')).toHaveLength(2);
    const signin = await f.oauth(provider); expect(await f.auth.sessionUser(new Headers({ cookie: signin.jar.header() }))).toMatchObject({ email: EMAIL });
  });
  it('refuses different or unverified email, anonymous connection, and cross-site connection', async () => {
    const f = await localFixture();
    expect((await f.call('/api/auth/link-social', { provider: 'github', callbackURL: '/sign-in' })).status).toBe(401);
    emails = [{ email: 'other@example.test', primary: true, verified: true }];
    expect((await f.oauth('github', f.jar, true)).response.headers.get('location')).toContain('error=');
    emails = [{ email: EMAIL, primary: true, verified: false }]; await f.oauth('github', f.jar, true); expect(rows('account')).toHaveLength(1);
    const response = await f.app.request(`${BASE}/api/auth/link-social`, { method: 'POST', headers: { origin: 'https://attacker.example.test', cookie: f.jar.header(), 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'github', callbackURL: '/sign-in' }) });
    expect(response.status).toBe(403);
  });
  it('checks direct Google links, including already linked accounts, before the pinned early return', async () => {
    const f = await localFixture();
    const link = () => f.call('/api/auth/link-social', { provider: 'google', idToken: { token: googleToken } }, f.jar);
    expect((await link()).status).toBe(200); expect(rows('account')).toHaveLength(2);
    googleToken = jwt({ email_verified: false }); expect((await link()).status).toBe(401);
    googleToken = jwt({ email: 'other@example.test' }); expect((await link()).status).toBe(401);
    googleToken = jwt(); expect((await link()).status).toBe(200); expect(rows('account')).toHaveLength(2);
  });
  it('cannot bind an identity already owned by another account', async () => {
    const f = await fixture({ WIREHUB_BACKEND: 'pg' });
    await f.oauth('google');
    await f.auth.createAccount!('other@example.test', 'Other owner', 'synthetic-password-123');
    const jar = new Jar(); await f.call('/api/auth/sign-in/email', { email: 'other@example.test', password: 'synthetic-password-123' }, jar);
    googleToken = jwt({ email: 'other@example.test' });
    const response = await f.call('/api/auth/link-social', { provider: 'google', idToken: { token: googleToken } }, jar);
    expect(response.status).toBe(409); expect(rows('account')).toHaveLength(2);
  });
  it('has no connect buttons for anonymous or refused sessions', () => {
    const model = { magicLink: false, next: '/', connectProviders: [{ providerId: 'github', name: 'GitHub' }] };
    expect(renderSignInPage(model)).not.toContain('type="button" data-connect');
    expect(renderSignInPage({ ...model, signedInAs: { email: EMAIL, allowed: false } })).not.toContain('type="button" data-connect');
  });
});

describe('people access with external identities', () => {
  it('lets a seeded social-only owner sign in without an allow-list, then refuses revoked access', async () => {
    const person: Person = { id: 'synthetic-owner', name: 'Synthetic owner', email: EMAIL, role: 'owner' };
    const f = await fixture({ WIREHUB_BACKEND: 'pg', AUTH_LOCAL_ACCOUNTS: 'false', AUTH_ALLOWED_EMAILS: '' }, peopleStore(person));
    const result = await f.oauth('google'); expect(await f.auth.sessionUser(new Headers({ cookie: result.jar.header() }))).toMatchObject({ email: EMAIL });
    person.disabledAt = '2026-01-01T00:00:00Z';
    expect((await f.call('/api/auth/link-social', { provider: 'google', idToken: { token: googleToken } }, result.jar)).status).toBe(403);
    const signin = await f.oauth('google'); expect(await f.auth.sessionUser(new Headers({ cookie: signin.jar.header() }))).toBeNull();
    expect(await (await f.call('/sign-in', undefined, result.jar)).text()).not.toContain('type="button" data-connect');
  });
});


it('refuses disabled people even when their verified email remains allow-listed', async () => {
  const person: Person = { id: 'synthetic-owner', name: 'Synthetic owner', email: EMAIL, role: 'owner', disabledAt: '2026-01-01T00:00:00Z' };
  const f = await fixture({ WIREHUB_BACKEND: 'pg', AUTH_LOCAL_ACCOUNTS: 'false' }, peopleStore(person));
  await f.oauth('github'); await f.oauth('google');
  expect(rows('user')).toHaveLength(0); expect(rows('account')).toHaveLength(0);
});


it('explains provider identity failures without attributing network failures to an unverified email', () => {
  expect(signInErrorMessage('unable_to_get_user_info', { connectProviders: [{ providerId: 'google', name: 'Google' }] })).toBe('Could not verify your provider identity. Use a verified email allowed on this hub and try again.');
  expect(signInErrorMessage('failed_to_get_user_info', {})).toBe('Sign-in did not complete (failed_to_get_user_info). Try again.');
});
