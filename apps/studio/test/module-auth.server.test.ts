/**
 * Auth providers modules contribute (`server/auth/module-providers.ts`): an
 * OIDC and a plain OAuth 2 provider mounted beside Better Auth's own, their
 * buttons on the sign-in page, secrets read from the environment by name, and
 * the allow-list still deciding who may hold a session.
 */

import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { serve, type ServerType } from '@hono/node-server';
import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { defineModule, type AuthProviderContribution } from '@wirehub/modules';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthConfigError, readAuthConfig, type AuthConfigEnabled } from '../server/auth/config.ts';
import { resolveModuleProviders } from '../server/auth/module-providers.ts';
import { renderSignInPage } from '../server/auth/sign-in-page.ts';
import { createStudioAuth } from '../server/auth/studio-auth.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { createStandaloneApp } from '../server/standalone-app.ts';

const BASE = 'http://studio.test';
const OWNER = 'owner@example.test';
const STRANGER = 'stranger@elsewhere.test';
const REAL: CableDesign = loadDesign('de9-terminal-board');

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
function signJwt(key: KeyObject, claims: Record<string, unknown>): string {
  const input = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64url(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}

interface Idp {
  issuer: string;
  next: { sub: string; email?: string; nonce?: string };
  close(): Promise<void>;
}

async function startIdp(clientId: string): Promise<Idp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const app = new Hono();
  const state: Idp = { issuer: '', next: { sub: 'u1' }, close: async () => undefined };
  app.get('/.well-known/openid-configuration', (c) =>
    c.json({ issuer: state.issuer, authorization_endpoint: `${state.issuer}/authorize`, token_endpoint: `${state.issuer}/token`, userinfo_endpoint: `${state.issuer}/userinfo`, jwks_uri: `${state.issuer}/jwks`, id_token_signing_alg_values_supported: ['RS256'] }),
  );
  app.get('/jwks', (c) => c.json({ keys: [jwk] }));
  app.post('/token', (c) => {
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      access_token: 'at-1',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: signJwt(privateKey, { iss: state.issuer, aud: clientId, sub: state.next.sub, iat: now, exp: now + 600, name: 'Test Person', ...(state.next.email === undefined ? {} : { work_email: state.next.email }), ...(state.next.nonce === undefined ? {} : { nonce: state.next.nonce }) }),
    });
  });
  // the plain OAuth 2 provider's profile endpoint
  app.get('/userinfo', (c) => c.json({ sub: state.next.sub, name: 'Test Person', ...(state.next.email === undefined ? {} : { work_email: state.next.email }) }));
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
  });
  state.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

let idp: Idp;
let distDir: string;
let dataDir: string;
let database: DatabaseSync;

beforeAll(async () => {
  idp = await startIdp('mod-client');
});
afterAll(async () => idp.close());
beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'mod-auth-dist-'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>studio shell</body></html>\n');
  dataDir = mkdtempSync(join(tmpdir(), 'mod-auth-data-'));
  database = new DatabaseSync(':memory:');
});
afterEach(() => {
  database.close();
  rmSync(distDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const providers = (): AuthProviderContribution[] =>
  defineModule({
    id: 'sso',
    label: 'SSO',
    version: '1.0.0',
    authProviders: [
      { id: 'corp-oidc', label: 'Corporate SSO', kind: 'oidc', config: { issuer: idp.issuer, clientId: 'mod-client', clientSecretEnv: 'MOD_SSO_SECRET', emailClaim: 'work_email' } },
      { id: 'corp-oauth', label: 'Plain OAuth', kind: 'oauth2', config: { authorizationUrl: `${idp.issuer}/authorize`, tokenUrl: `${idp.issuer}/token`, userInfoUrl: `${idp.issuer}/userinfo`, clientId: 'mod-client', clientSecret: 'x', emailClaim: 'work_email' } },
    ],
  }).authProviders ?? [];

const authEnv = (): Record<string, string> => ({ AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123', BETTER_AUTH_URL: BASE, AUTH_ALLOWED_EMAILS: OWNER, AUTH_DATA_DIR: dataDir });

function store(): DesignStore {
  const files = new Map<string, string>([[REAL.id, formatDesignJson(REAL)]]);
  return { list: () => [...files.keys()].map((id) => ({ id, label: id })), has: (id) => files.has(id), read: (id) => (files.has(id) ? (JSON.parse(files.get(id) as string) as CableDesign) : undefined), write: () => ({ changed: true }), remove: () => undefined };
}

async function app(overrides: { providers: AuthProviderContribution[]; env?: Record<string, string> }) {
  const config = readAuthConfig(authEnv(), { moduleProviders: overrides.providers.length }) as AuthConfigEnabled;
  const auth = await createStudioAuth(config, { database, providers: overrides.providers, providerEnv: overrides.env ?? { MOD_SSO_SECRET: 'sso-secret' } });
  const standalone = createStandaloneApp({
    distDir,
    deps: { designs: store(), loadDb: () => loadDb() },
    depictionDeps: { store: { listDefIds: () => [], readMeta: () => undefined, writeMeta: () => undefined, readAsset: () => undefined, writeAsset: () => undefined, dirFor: () => undefined }, loadDb: () => loadDb() },
    auth,
  });
  const call = (path: string, init: RequestInit = {}, cookie?: string) => {
    const headers = new Headers(init.headers);
    if (cookie !== undefined) headers.set('cookie', cookie);
    if (init.method !== undefined && init.method !== 'GET') headers.set('origin', BASE);
    return standalone.request(`${BASE}${path}`, { ...init, headers });
  };
  return { auth, call };
}

async function signIn(call: Awaited<ReturnType<typeof app>>['call'], provider: string, email: string): Promise<Response> {
  const start = await call('/api/auth/sign-in/social', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, callbackURL: '/', errorCallbackURL: '/sign-in' }) });
  expect(start.status).toBe(200);
  const cookie = start.headers.getSetCookie().map((l) => l.split(';')[0]).join('; ');
  const authorize = new URL(((await start.json()) as { url: string }).url);
  expect(authorize.origin).toBe(idp.issuer);
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${BASE}/api/auth/callback/${provider}`);
  const nonce = authorize.searchParams.get('nonce') ?? undefined;
  idp.next = { sub: `sub-${email}`, email, ...(nonce === undefined ? {} : { nonce }) };
  return call(`/api/auth/callback/${provider}?code=c1&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, {}, cookie);
}

describe('module auth providers', () => {
  it('count as a sign-in method, so a deployment with only them starts', () => {
    expect(() => readAuthConfig(authEnv())).toThrow(/no sign-in method/);
    expect(() => readAuthConfig(authEnv(), { moduleProviders: 1 })).not.toThrow();
  });

  it('read secrets from the environment by name, and say which variable is missing', () => {
    const resolved = resolveModuleProviders(providers(), { MOD_SSO_SECRET: 's3' });
    expect(resolved.oauth.map((p) => [p.providerId, p.kind, p.clientSecret, p.emailClaim])).toEqual([
      ['corp-oidc', 'oidc', 's3', 'work_email'],
      ['corp-oauth', 'oauth2', 'x', 'work_email'],
    ]);
    expect(() => resolveModuleProviders(providers(), {})).toThrow(/MOD_SSO_SECRET/);
    expect(() => resolveModuleProviders([{ id: 'Bad Id', label: 'x', kind: 'oidc', config: {} }], {})).toThrow(AuthConfigError);
    expect(() => resolveModuleProviders([{ id: 'oidc', label: 'x', kind: 'oidc', config: { issuer: 'https://a.test', clientId: 'c' } }], {}, ['oidc'])).toThrow(/already uses/);
    expect(() => resolveModuleProviders([{ id: 'p', label: 'x', kind: 'oauth2', config: { clientId: 'c' } }], {})).toThrow(/authorizationUrl/);
    expect(() => resolveModuleProviders([{ id: 'p', label: 'x', kind: 'other', config: {} }], {})).toThrow(/config\.plugin/);
  });

  it('puts a button for each on the sign-in page', async () => {
    const { auth, call } = await app({ providers: providers() });
    expect(auth.providers).toEqual([{ providerId: 'corp-oidc', name: 'Corporate SSO' }, { providerId: 'corp-oauth', name: 'Plain OAuth' }]);
    const html = await (await call('/sign-in')).text();
    expect(html).toContain('data-provider="corp-oidc"');
    expect(html).toContain('Sign in with Plain OAuth');
    expect(renderSignInPage({ providers: [{ providerId: 'p', name: 'P' }], magicLink: false, next: '/' })).toContain('class="btn primary" type="button" data-sso data-provider="p"');
  });

  it('refuses to start when a named variable is not set', async () => {
    await expect(app({ providers: providers(), env: {} })).rejects.toThrow(/MOD_SSO_SECRET/);
  });

  for (const provider of ['corp-oidc', 'corp-oauth']) {
    it(`signs an allowed person in through ${provider}, and refuses a stranger`, async () => {
      const { call } = await app({ providers: providers() });
      const landing = await signIn(call, provider, OWNER);
      expect(landing.status).toBe(302);
      expect(landing.headers.get('location')).not.toMatch(/error/i);
      const cookie = landing.headers.getSetCookie().map((l) => l.split(';')[0]).join('; ');
      expect((await call('/api/designs', {}, cookie)).status).toBe(200);
      const refused = await signIn(call, provider, STRANGER);
      expect(refused.headers.get('location') ?? '').toMatch(/error=/i);
    });
  }
});
