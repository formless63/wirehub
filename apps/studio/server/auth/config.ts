/**
 * The studio's own login — configuration, read from the environment.
 *
 * Off unless `AUTH_ENABLED=true`: with it off, `readAuthConfig` answers
 * `{ enabled: false }` and the standalone server mounts nothing auth-related,
 * so the studio behaves exactly as it did before auth existed (a reverse
 * proxy in front, if any, is the only access control). With it on, every setting it needs is
 * checked up front and a missing one stops the server at startup with one
 * line naming the variable — never a half-configured login at runtime.
 *
 * Pure: a function of the env object handed to it, so it is tested without
 * touching `process.env`. Every variable is listed in `apps/studio/README.md`
 * ("Auth") and as a commented placeholder in the root `docker-compose.yml`.
 */

import { fileURLToPath } from 'node:url';

export interface OidcConfig {
  /** the Better Auth provider id — also the last segment of the redirect URI */
  providerId: string;
  /** button label: "Sign in with <name>" */
  name: string;
  /** issuer URL; discovery is `<issuer>/.well-known/openid-configuration` */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** the ID-token / userinfo claim read as the person's email */
  emailClaim: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** implicit TLS (465) when true; STARTTLS negotiation (587) when false */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface AuthConfigEnabled {
  enabled: true;
  /** `BETTER_AUTH_SECRET` — signs cookies and tokens; at least 32 characters */
  secret: string;
  /** `BETTER_AUTH_URL` — the public origin people sign in at, e.g. `https://studio.example.com` */
  baseURL: string;
  /** lower-cased; the only emails that may hold a session */
  allowedEmails: ReadonlySet<string>;
  /** where the SQLite session store and the save audit log live */
  dataDir: string;
  oidc?: OidcConfig;
  smtp?: SmtpConfig;
}

export type AuthConfig = { enabled: false } | AuthConfigEnabled;

/** `<repo>/data/auth` — gitignored; the compose file mounts it as its own volume */
export const DEFAULT_AUTH_DATA_DIR = fileURLToPath(new URL('../../../../data/auth', import.meta.url));

export const DEFAULT_OIDC_SCOPES = ['openid', 'email', 'profile'];
export const DEFAULT_OIDC_EMAIL_CLAIM = 'email';

type Env = Readonly<Record<string, string | undefined>>;

/** A setting that stops the server from starting — the message names the variable. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(`Auth is enabled (AUTH_ENABLED=true) but ${message}`);
    this.name = 'AuthConfigError';
  }
}

function text(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function required(env: Env, key: string, why: string): string {
  const value = text(env, key);
  if (value === undefined) throw new AuthConfigError(`${key} is not set — ${why}.`);
  return value;
}

function flag(env: Env, key: string, fallback: boolean): boolean {
  const value = text(env, key)?.toLowerCase();
  if (value === undefined) return fallback;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new AuthConfigError(`${key} must be true or false; got '${env[key]}'.`);
}

function url(env: Env, key: string, why: string): string {
  const value = required(env, key, why);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)');
  } catch {
    throw new AuthConfigError(`${key} must be an http(s) URL; got '${value}'.`);
  }
  return value.replace(/\/+$/, '');
}

/** Comma- or whitespace-separated, lower-cased, de-duplicated. */
export function parseEmailList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(/[\s,]+/)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ''),
  );
}

/** Whether `AUTH_ENABLED` asks for the login at all — cheap, never throws on the rest. */
export function authRequested(env: Env): boolean {
  return flag(env, 'AUTH_ENABLED', false);
}

export function readAuthConfig(env: Env): AuthConfig {
  if (!authRequested(env)) return { enabled: false };

  const secret = required(env, 'BETTER_AUTH_SECRET', 'generate one with `openssl rand -base64 32`');
  if (secret.length < 32) {
    throw new AuthConfigError('BETTER_AUTH_SECRET is shorter than 32 characters — generate one with `openssl rand -base64 32`.');
  }
  const baseURL = url(env, 'BETTER_AUTH_URL', 'set it to the public address people sign in at, e.g. https://studio.example.com');

  const allowedEmails = parseEmailList(env.AUTH_ALLOWED_EMAILS);
  if (allowedEmails.size === 0) {
    throw new AuthConfigError('AUTH_ALLOWED_EMAILS is empty — nobody could sign in. List the allowed emails, comma-separated.');
  }

  let oidc: OidcConfig | undefined;
  if (text(env, 'AUTH_OIDC_ISSUER') !== undefined) {
    const clientSecret = text(env, 'AUTH_OIDC_CLIENT_SECRET');
    const scopes = text(env, 'AUTH_OIDC_SCOPES');
    oidc = {
      providerId: text(env, 'AUTH_OIDC_PROVIDER_ID') ?? 'oidc',
      name: text(env, 'AUTH_OIDC_NAME') ?? 'Single sign-on',
      issuer: url(env, 'AUTH_OIDC_ISSUER', 'set it to the OIDC issuer URL'),
      clientId: required(env, 'AUTH_OIDC_CLIENT_ID', 'copy it from the OIDC client in your identity provider'),
      ...(clientSecret === undefined ? {} : { clientSecret }),
      scopes: scopes === undefined ? DEFAULT_OIDC_SCOPES : scopes.split(/[\s,]+/).filter((s) => s !== ''),
      emailClaim: text(env, 'AUTH_OIDC_EMAIL_CLAIM') ?? DEFAULT_OIDC_EMAIL_CLAIM,
    };
    if (!/^[a-z0-9-]+$/.test(oidc.providerId)) {
      throw new AuthConfigError(`AUTH_OIDC_PROVIDER_ID must be lowercase letters, digits and hyphens; got '${oidc.providerId}'.`);
    }
  }

  let smtp: SmtpConfig | undefined;
  if (text(env, 'AUTH_SMTP_HOST') !== undefined) {
    const secure = flag(env, 'AUTH_SMTP_SECURE', true);
    const rawPort = text(env, 'AUTH_SMTP_PORT');
    const port = rawPort === undefined ? (secure ? 465 : 587) : Number(rawPort);
    if (!Number.isInteger(port) || port <= 0) {
      throw new AuthConfigError(`AUTH_SMTP_PORT must be a positive integer; got '${rawPort}'.`);
    }
    const user = text(env, 'AUTH_SMTP_USER');
    const pass = text(env, 'AUTH_SMTP_PASS');
    smtp = {
      host: required(env, 'AUTH_SMTP_HOST', 'set it to the SMTP server'),
      port,
      secure,
      ...(user === undefined ? {} : { user }),
      ...(pass === undefined ? {} : { pass }),
      from: text(env, 'AUTH_SMTP_FROM') ?? user ?? required(env, 'AUTH_SMTP_FROM', 'set the address sign-in links are sent from'),
    };
  }

  if (oidc === undefined && smtp === undefined) {
    throw new AuthConfigError('no sign-in method is configured — set AUTH_OIDC_ISSUER (+ client id/secret), AUTH_SMTP_HOST (+ credentials), or both.');
  }

  return {
    enabled: true,
    secret,
    baseURL,
    allowedEmails,
    dataDir: text(env, 'AUTH_DATA_DIR') ?? DEFAULT_AUTH_DATA_DIR,
    ...(oidc === undefined ? {} : { oidc }),
    ...(smtp === undefined ? {} : { smtp }),
  };
}
