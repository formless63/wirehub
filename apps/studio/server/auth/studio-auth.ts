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
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { magicLink } from 'better-auth/plugins/magic-link';

import { readAuthConfig, type AuthConfigEnabled, type OidcConfig } from './config.ts';
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
  isAllowed(email: string): boolean;
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

export async function createStudioAuth(config: AuthConfigEnabled, overrides: StudioAuthOverrides = {}): Promise<StudioAuth> {
  let database = overrides.database;
  if (database === undefined) {
    mkdirSync(config.dataDir, { recursive: true });
    database = new DatabaseSync(join(config.dataDir, 'auth.sqlite'));
  }
  const isAllowed = (email: string): boolean => config.allowedEmails.has(email.trim().toLowerCase());
  const mail = overrides.mailTransport ?? (config.smtp === undefined ? undefined : smtpTransport(config.smtp));
  const fetchImpl = overrides.fetch ?? fetch;

  const plugins: BetterAuthPlugin[] = [];
  if (config.oidc !== undefined) {
    const oidc = config.oidc;
    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: oidc.providerId,
            name: oidc.name,
            discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
            clientId: oidc.clientId,
            ...(oidc.clientSecret === undefined ? {} : { clientSecret: oidc.clientSecret }),
            scopes: oidc.scopes,
            pkce: true,
            getUserInfo: oidcUserInfo(oidc, fetchImpl),
          },
        ],
      }),
    );
  }
  if (config.smtp !== undefined && mail !== undefined) {
    const from = config.smtp.from;
    plugins.push(
      magicLink({
        expiresIn: MAGIC_LINK_MINUTES * 60,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          if (!isAllowed(email)) throw forbidden(email);
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
    trustedOrigins: [new URL(config.baseURL).origin],
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: config.oidc === undefined ? [] : [config.oidc.providerId],
      },
    },
    // failed OAuth callbacks land back on the sign-in page with `?error=CODE`
    onAPIError: { errorURL: `${config.baseURL}${SIGN_IN_PATH}` },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isAllowed(user.email)) throw forbidden(user.email);
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            if (user !== undefined && user !== null && !isAllowed(user.email)) throw forbidden(user.email);
          },
        },
      },
    },
    plugins,
  };

  const { runMigrations } = await getMigrations(options);
  await runMigrations();

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
    isAllowed,
    recordSave(record) {
      console.log(`[auth] ${record.method} ${record.path} → ${record.status} by ${record.email}`);
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
export async function studioAuthFromEnv(env: Readonly<Record<string, string | undefined>>): Promise<StudioAuth | undefined> {
  const config = readAuthConfig(env);
  if (!config.enabled) return undefined;
  return createStudioAuth(config);
}
