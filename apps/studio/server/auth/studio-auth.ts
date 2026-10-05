/**
 * The studio's Better Auth instance.
 *
 * Two ways in, one gate:
 *
 * - **OIDC** (any compliant identity provider) through Better Auth's generic-OAuth
 *   plugin: discovery from the issuer, PKCE, ID token verified against the
 *   provider's JWKS. The person's email is read from a configurable claim
 *   (`email` by default; set `AUTH_OIDC_EMAIL_CLAIM` for another).
 * - **Magic link** over SMTP — the backup when the IdP is down.
 *
 * Either way, only emails on `AUTH_ALLOWED_EMAILS` get a user row or a
 * session: the check runs before a link is mailed, before a user is created
 * and before a session is created, and the request gate (`gate.ts`) re-checks
 * on every request so removing someone from the list takes effect at once.
 *
 * **Session storage: SQLite through Node's built-in `node:sqlite`.** Better
 * Auth's stateless (cookie-only) mode would need no file at all, but the
 * magic link needs a server-side, single-use verification token, and
 * server-side sessions are what make sign-out and revocation real. Node 24
 * ships SQLite in the runtime (no native addon to build, no DB server to
 * run), and Better Auth's Kysely adapter speaks to `DatabaseSync` directly —
 * so the whole auth state is one file under `AUTH_DATA_DIR` (gitignored
 * `data/auth/`, its own volume in the compose file). The catalog stays git
 * JSON; nothing auth-related is ever written near it.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { genericOAuth, type GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import { magicLink } from 'better-auth/plugins/magic-link';

import { AsyncLocalStorage } from 'node:async_hooks';

import pg from 'pg';

import { requestOrigin } from '../env.ts';
import type { AuthProviderContribution } from '@wirehub/modules';

import { readAuthConfig, type AuthConfigEnabled, type OidcConfig } from './config.ts';
import { resolveModuleProviders, type ModuleOAuthProvider } from './module-providers.ts';
import type { PeopleStore, Role } from './people.ts';
import type { Notifier } from '../notify.ts';
import { RateLimiter, type TokenEnv, type TokenStore } from './tokens.ts';
import { magicLinkMessage, smtpTransport, type MailTransport } from './mailer.ts';

export const AUTH_BASE_PATH = '/api/auth';
export const SIGN_IN_PATH = '/sign-in';
export const EMAIL_NOT_ALLOWED = 'EMAIL_NOT_ALLOWED';
const MAGIC_LINK_MINUTES = 10;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface SaveRecord {
  at: string;
  email: string;
  method: string;
  path: string;
  status: number;
}

/** What the Hono gate needs — nothing Better-Auth-shaped leaks past this. */
export interface StudioAuth {
  config: AuthConfigEnabled;
  /** Better Auth's own endpoints, mounted at `/api/auth/*` */
  handler(request: Request): Promise<Response>;
  /** the signed-in person for this request's cookies, or `null` */
  sessionUser(headers: Headers): Promise<SessionUser | null>;
  /** the sign-in buttons modules added, beside the configured OIDC one */
  providers?: readonly { providerId: string; name: string }[];
  /** may this email hold a session: the allow-list, or (database backend) a person of the org */
  isAllowed(email: string): boolean | Promise<boolean>;
  /** the database backend's people and invitations (B8); absent on files */
  people?: PeopleStore;
  /** personal API tokens (database backend, B12), and the environment they must carry */
  tokens?: TokenStore;
  tokenEnv?: TokenEnv;
  /** the token request budgets (§4.5) */
  limiter?: RateLimiter;
  /** monitoring events (§8.6): token created, refused tokens; absent → none sent */
  notifier?: Notifier;
  /** first-run setup's admin: an email + password account (the person exists already) */
  createAccount?(email: string, name: string, password: string): Promise<void>;
  /** true while the hub has no organisation: the gate lets the setup page and its API through */
  setupMode?: () => boolean;
  /** close what the store holds open (the database backend's pool) */
  close?(): Promise<void>;
  /** accept an invitation: make the local account and sign it in (the response carries the session cookie) */
  acceptInvitation?(token: string, name: string, password: string): Promise<Response>;
  /** one line per successful write, appended to `<dataDir>/saves.jsonl` */
  recordSave(record: SaveRecord): void;
}

export interface StudioAuthOverrides {
  /** the magic-link transport — tests pass a stub; default is SMTP from config */
  mailTransport?: MailTransport;
  /** default: `<dataDir>/auth.sqlite` */
  database?: DatabaseSync;
  /** tests route the IdP's userinfo call through here; default global fetch */
  fetch?: typeof fetch;
  /**
   * The database backend (plan §3.15): Better Auth's tables are schema `auth`
   * of the app's database (migration 0012, never migrated at boot), and the
   * people and invitations decide who may sign in.
   */
  /** sign-in methods the deployment's modules contribute (`registry.authProviders()`, `module-providers.ts`) */
  providers?: readonly AuthProviderContribution[];
  /** the environment `…Env` entries of those providers are read from (default `process.env`) */
  providerEnv?: Readonly<Record<string, string | undefined>>;
  pg?: { url: string; people: PeopleStore; tokens?: TokenStore; tokenEnv?: TokenEnv; limiter?: RateLimiter; setupMode?: () => boolean; notifier?: Notifier };
}

function forbidden(email: string): APIError {
  return new APIError('FORBIDDEN', {
    code: EMAIL_NOT_ALLOWED,
    message: `${email} is not allowed to use this hub. Ask an administrator to add it to AUTH_ALLOWED_EMAILS.`,
  });
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (payload === undefined) return {};
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The OIDC profile, with the configured claim as `email`. The generic-OAuth
 * plugin has already verified the ID token (JWKS + nonce) before calling this;
 * if the claim is not in the ID token, the userinfo endpoint is asked.
 */
function oidcUserInfo(oidc: OidcConfig, fetchImpl: typeof fetch) {
  let userInfoUrl: Promise<string | undefined> | undefined;
  const discoverUserInfo = (): Promise<string | undefined> =>
    (userInfoUrl ??= fetchImpl(`${oidc.issuer}/.well-known/openid-configuration`)
      .then(async (res) => (res.ok ? ((await res.json()) as { userinfo_endpoint?: string }).userinfo_endpoint : undefined))
      .catch(() => undefined));

  return async (tokens: { idToken?: string; accessToken?: string }) => {
    let profile: Record<string, unknown> = tokens.idToken === undefined ? {} : decodeJwtClaims(tokens.idToken);
    if (profile[oidc.emailClaim] === undefined && tokens.accessToken !== undefined) {
      const endpoint = await discoverUserInfo();
      if (endpoint !== undefined) {
        const res = await fetchImpl(endpoint, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
        if (res.ok) profile = { ...profile, ...((await res.json()) as Record<string, unknown>) };
      }
    }
    const claim = profile[oidc.emailClaim];
    const sub = profile.sub;
    if (typeof sub !== 'string' && typeof sub !== 'number') return null;
    const name = profile.name ?? profile.preferred_username;
    return {
      ...profile,
      sub,
      id: sub,
      // missing claim → Better Auth redirects with `email_not_found`
      email: typeof claim === 'string' ? claim.toLowerCase() : undefined,
      // the IdP asserts it; the allow-list is the gate that matters
      emailVerified: true,
      name: typeof name === 'string' ? name : undefined,
      image: typeof profile.picture === 'string' ? profile.picture : undefined,
    };
  };
}

/** A plain OAuth 2 provider's profile: the userinfo endpoint's JSON, the configured claim as `email`. */
function oauth2UserInfo(provider: ModuleOAuthProvider, fetchImpl: typeof fetch) {
  return async (tokens: { accessToken?: string }) => {
    if (tokens.accessToken === undefined || provider.userInfoUrl === undefined) return null;
    const res = await fetchImpl(provider.userInfoUrl, { headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' } });
    if (!res.ok) return null;
    const profile = (await res.json()) as Record<string, unknown>;
    const sub = profile.sub ?? profile.id;
    if (typeof sub !== 'string' && typeof sub !== 'number') return null;
    const claim = profile[provider.emailClaim];
    const name = profile.name ?? profile.preferred_username ?? profile.login;
    return {
      ...profile,
      id: String(sub),
      email: typeof claim === 'string' ? claim.toLowerCase() : undefined,
      emailVerified: true,
      name: typeof name === 'string' ? name : undefined,
      image: typeof profile.picture === 'string' ? profile.picture : typeof profile.avatar_url === 'string' ? profile.avatar_url : undefined,
    };
  };
}

/** Better Auth's options for a config — exported so a test can ask `getMigrations` what it would change. */
export function authDatabaseOf(overrides: StudioAuthOverrides, config: AuthConfigEnabled): BetterAuthOptions['database'] {
  if (overrides.pg !== undefined) {
    // the auth schema of the app's own database, as studio_app
    const pool = new pg.Pool({ connectionString: overrides.pg.url, max: 4, options: '-c search_path=auth', application_name: 'wirehub-auth' });
    pool.on('error', (error) => console.warn(`[auth] idle connection error: ${error.message}`));
    return pool;
  }
  if (overrides.database !== undefined) return overrides.database;
  mkdirSync(config.dataDir, { recursive: true });
  return new DatabaseSync(join(config.dataDir, 'auth.sqlite'));
}

/** Who an account being created was invited as (set around the invitation's sign-up). */
const invited = new AsyncLocalStorage<{ email: string; role: Role }>();

export async function createStudioAuth(config: AuthConfigEnabled, overrides: StudioAuthOverrides = {}): Promise<StudioAuth> {
  const database = authDatabaseOf(overrides, config);
  const people = overrides.pg?.people;
  const listed = (email: string): boolean => config.allowedEmails.has(email.trim().toLowerCase());
  // a person whose access an owner revoked is refused, even when the allow-list names them
  const isAllowed = async (email: string): Promise<boolean> => {
    const person = people === undefined ? undefined : await people.personByEmail(email.trim());
    if (person?.disabledAt !== undefined && person.disabledAt !== null) return false;
    return listed(email) || person !== undefined;
  };
  const mail = overrides.mailTransport ?? (config.smtp === undefined ? undefined : smtpTransport(config.smtp));
  const fetchImpl = overrides.fetch ?? fetch;

  const plugins: BetterAuthPlugin[] = [];
  const fromModules = resolveModuleProviders(overrides.providers ?? [], overrides.providerEnv ?? process.env, config.oidc === undefined ? [] : [config.oidc.providerId]);
  const oauthConfigs: GenericOAuthConfig[] = [];
  if (config.oidc !== undefined) {
    const oidc = config.oidc;
    oauthConfigs.push({
      providerId: oidc.providerId,
      name: oidc.name,
      discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
      clientId: oidc.clientId,
      ...(oidc.clientSecret === undefined ? {} : { clientSecret: oidc.clientSecret }),
      scopes: oidc.scopes,
      pkce: true,
      getUserInfo: oidcUserInfo(oidc, fetchImpl),
    } as GenericOAuthConfig);
  }
  for (const provider of fromModules.oauth) {
    const asOidc: OidcConfig = { providerId: provider.providerId, name: provider.name, issuer: provider.issuer ?? '', clientId: provider.clientId, scopes: provider.scopes, emailClaim: provider.emailClaim };
    oauthConfigs.push({
      providerId: provider.providerId,
      name: provider.name,
      ...(provider.kind === 'oidc'
        ? { discoveryUrl: `${provider.issuer}/.well-known/openid-configuration`, getUserInfo: oidcUserInfo(asOidc, fetchImpl) }
        : { authorizationUrl: provider.authorizationUrl, tokenUrl: provider.tokenUrl, getUserInfo: oauth2UserInfo(provider, fetchImpl) }),
      clientId: provider.clientId,
      ...(provider.clientSecret === undefined ? {} : { clientSecret: provider.clientSecret }),
      scopes: provider.scopes,
      pkce: true,
    } as GenericOAuthConfig);
  }
  if (oauthConfigs.length > 0) plugins.push(genericOAuth({ config: oauthConfigs }));
  plugins.push(...(fromModules.plugins as BetterAuthPlugin[]));
  if (config.smtp !== undefined && mail !== undefined) {
    const from = config.smtp.from;
    plugins.push(
      magicLink({
        expiresIn: MAGIC_LINK_MINUTES * 60,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          if (!(await isAllowed(email))) throw forbidden(email);
          try {
            await mail.sendMail(magicLinkMessage(from, email, url, MAGIC_LINK_MINUTES));
          } catch (error) {
            console.error(`[auth] magic link to ${email} not sent: ${(error as Error).message}`);
            throw new APIError('BAD_GATEWAY', {
              code: 'MAIL_NOT_SENT',
              message: 'The studio could not send the sign-in mail. Try again later, or sign in another way.',
            });
          }
        },
      }),
    );
  }

  const options: BetterAuthOptions = {
    appName: 'Studio',
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database,
    telemetry: { enabled: false },
    // the public origin, and the origin the request itself was made to (same-origin is never cross-site):
    // a hub opened by its LAN address works without WIREHUB_PUBLIC_URL naming it
    trustedOrigins: (request?: Request) => [new URL(config.baseURL).origin, ...(request === undefined ? [] : [requestOrigin(request)])],
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: oauthConfigs.map((c) => c.providerId),
      },
    },
    // failed OAuth callbacks land back on the sign-in page with `?error=CODE`
    onAPIError: { errorURL: `${config.baseURL}${SIGN_IN_PATH}` },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const invite = invited.getStore();
            if (invite !== undefined && invite.email === user.email.toLowerCase()) return;
            if (!(await isAllowed(user.email))) throw forbidden(user.email);
          },
          // the account's person: who its changes are attributed to, and its role
          after: async (user) => {
            if (people === undefined) return;
            const invite = invited.getStore();
            await people.ensurePerson(user.email, user.name, invite?.email === user.email.toLowerCase() ? invite.role : undefined);
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            const invite = invited.getStore();
            const accepting = user !== undefined && user !== null && invite !== undefined && invite.email === user.email.toLowerCase();
            if (user !== undefined && user !== null && !accepting && !(await isAllowed(user.email))) throw forbidden(user.email);
            if (user !== undefined && user !== null && people !== undefined) await people.ensurePerson(user.email, user.name, accepting ? invite?.role : undefined);
          },
        },
      },
    },
    plugins,
    ...(config.localAccounts ? { emailAndPassword: { enabled: true, minPasswordLength: 12, autoSignIn: true } } : {}),
  };

  // the database backend's tables are migration 0012; the SQLite store migrates itself
  if (overrides.pg === undefined) {
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
  }

  const auth = betterAuth(options);
  const auditPath = join(config.dataDir, 'saves.jsonl');

  return {
    config,
    handler: (request) => auth.handler(request),
    async sessionUser(headers) {
      const session = await auth.api.getSession({ headers });
      if (session === null) return null;
      return { id: session.user.id, email: session.user.email, name: session.user.name };
    },
    providers: fromModules.oauth.map((p) => ({ providerId: p.providerId, name: p.name })),
    isAllowed,
    ...(overrides.pg?.tokens === undefined ? {} : { tokens: overrides.pg.tokens, tokenEnv: overrides.pg.tokenEnv ?? 'dev', limiter: overrides.pg.limiter ?? new RateLimiter() }),
    close: async () => {
      if (database instanceof pg.Pool) await database.end();
    },
    ...(overrides.pg?.notifier === undefined ? {} : { notifier: overrides.pg.notifier }),
    ...(overrides.pg?.setupMode === undefined ? {} : { setupMode: overrides.pg.setupMode }),
    ...(config.localAccounts
      ? {
          async createAccount(email: string, name: string, password: string) {
            await auth.api.signUpEmail({ body: { email, password, name } });
          },
        }
      : {}),
    ...(people === undefined
      ? {}
      : {
          people,
          async acceptInvitation(token, name, password) {
            const invitation = await people.invitationByToken(token);
            if (invitation === undefined) {
              return Response.json({ error: 'That invitation has expired, was already used, or never existed.', hint: 'Ask whoever invited you for a new link.' }, { status: 410 });
            }
            if (!config.localAccounts) {
              return Response.json({ error: 'This hub signs in with its identity provider only.', hint: 'Use the sign-in page.' }, { status: 409 });
            }
            const response = await invited.run({ email: invitation.email, role: invitation.role }, () =>
              auth.api.signUpEmail({ body: { email: invitation.email, password, name: name.trim() || invitation.email }, asResponse: true }),
            );
            if (response.ok) await people.markAccepted(invitation.id);
            return response;
          },
        }),
    recordSave(record) {
      console.log(`[auth] ${record.method} ${record.path} → ${record.status} by ${record.email}`);
      // on the database backend the change set is the record of every save (plan §2)
      if (overrides.pg !== undefined) return;
      try {
        mkdirSync(config.dataDir, { recursive: true });
        appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
      } catch (error) {
        console.error(`[auth] could not append to ${auditPath}: ${(error as Error).message}`);
      }
    },
  };
}

/** `serve.ts`'s entry: `undefined` when `AUTH_ENABLED` is not `true`. */
export async function studioAuthFromEnv(env: Readonly<Record<string, string | undefined>>, overrides: StudioAuthOverrides = {}): Promise<StudioAuth | undefined> {
  const config = readAuthConfig(env, { moduleProviders: overrides.providers?.length ?? 0 });
  if (!config.enabled) return undefined;
  return createStudioAuth(config, overrides);
}
