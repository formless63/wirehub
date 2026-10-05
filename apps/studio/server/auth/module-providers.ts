/**
 * Sign-in methods modules contribute (`AuthProviderContribution`,
 * `docs/modules.md`), resolved into what Better Auth's generic-OAuth plugin
 * takes. The allow-list (and, on the database backend, the people) still
 * decides who may hold a session: a provider only proves who someone is.
 *
 * A provider's `config` is plain data, so no secret has to sit in the module's
 * source: any key ending in `Env` names an environment variable and is read
 * from it (`clientSecretEnv: 'ACME_SSO_SECRET'` becomes `clientSecret`). A
 * variable that is not set stops the server at startup, naming it.
 *
 *   kind 'oidc'    { issuer, clientId, clientSecret?, scopes?, emailClaim?, name? }
 *   kind 'oauth2'  { authorizationUrl, tokenUrl, userInfoUrl, clientId, clientSecret?,
 *                    scopes?, emailClaim?, name? }
 *   kind 'other'   { plugin } — a Better Auth plugin object, mounted as it is
 *                  (trusted code; it adds its own endpoints and sign-in page is not touched)
 */

import type { AuthProviderContribution } from '@wirehub/modules';

import { AuthConfigError, DEFAULT_OIDC_EMAIL_CLAIM, DEFAULT_OIDC_SCOPES } from './config.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** One resolved OAuth-style provider. */
export interface ModuleOAuthProvider {
  providerId: string;
  name: string;
  kind: 'oidc' | 'oauth2';
  /** oidc: the issuer (discovery is `<issuer>/.well-known/openid-configuration`) */
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  emailClaim: string;
}

export interface ResolvedModuleProviders {
  oauth: ModuleOAuthProvider[];
  /** Better Auth plugins of `kind: 'other'` providers */
  plugins: unknown[];
}

function fail(provider: AuthProviderContribution, message: string): never {
  throw new AuthConfigError(`module auth provider '${provider.id}' ${message}`);
}

/** `fooEnv: 'VAR'` entries replaced by `foo: process value`. */
function withEnv(provider: AuthProviderContribution, env: Env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(provider.config)) {
    if (key.endsWith('Env') && key.length > 3) {
      if (typeof value !== 'string') fail(provider, `has ${key} that is not an environment variable name.`);
      const read = env[value as string]?.trim();
      if (read === undefined || read === '') fail(provider, `needs the environment variable ${value as string} (config.${key}), which is not set.`);
      out[key.slice(0, -3)] = read;
    } else out[key] = value;
  }
  return out;
}

const text = (provider: AuthProviderContribution, config: Record<string, unknown>, key: string, required: boolean): string | undefined => {
  const value = config[key];
  if (value === undefined) {
    if (required) fail(provider, `has no ${key} in its config.`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') fail(provider, `has a ${key} that is not text.`);
  return (value as string).trim();
};

function httpUrl(provider: AuthProviderContribution, config: Record<string, unknown>, key: string): string {
  const value = text(provider, config, key, true) as string;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)');
  } catch {
    fail(provider, `has a ${key} that is not an http(s) URL.`);
  }
  return value.replace(/\/+$/, '');
}

export function resolveModuleProviders(providers: readonly (AuthProviderContribution & { module?: string })[], env: Env, taken: readonly string[] = []): ResolvedModuleProviders {
  const oauth: ModuleOAuthProvider[] = [];
  const plugins: unknown[] = [];
  const ids = new Set(taken);
  for (const provider of providers) {
    if (!/^[a-z0-9-]+$/.test(provider.id)) fail(provider, 'must have an id of lowercase letters, digits and hyphens.');
    if (ids.has(provider.id)) fail(provider, 'has an id that another sign-in provider already uses.');
    ids.add(provider.id);
    const config = withEnv(provider, env);
    if (provider.kind === 'other') {
      if (typeof config['plugin'] !== 'object' || config['plugin'] === null) fail(provider, "of kind 'other' needs config.plugin, a Better Auth plugin.");
      plugins.push(config['plugin']);
      continue;
    }
    const scopesRaw = config['scopes'];
    const scopes = scopesRaw === undefined ? [...DEFAULT_OIDC_SCOPES] : Array.isArray(scopesRaw) && scopesRaw.every((s) => typeof s === 'string') ? (scopesRaw as string[]) : fail(provider, 'has scopes that are not a list of text.');
    const clientSecret = text(provider, config, 'clientSecret', false);
    const base = {
      providerId: provider.id,
      name: text(provider, config, 'name', false) ?? provider.label,
      clientId: text(provider, config, 'clientId', true) as string,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      scopes,
      emailClaim: text(provider, config, 'emailClaim', false) ?? DEFAULT_OIDC_EMAIL_CLAIM,
    };
    if (provider.kind === 'oidc') oauth.push({ ...base, kind: 'oidc', issuer: httpUrl(provider, config, 'issuer') });
    else
      oauth.push({
        ...base,
        kind: 'oauth2',
        authorizationUrl: httpUrl(provider, config, 'authorizationUrl'),
        tokenUrl: httpUrl(provider, config, 'tokenUrl'),
        userInfoUrl: httpUrl(provider, config, 'userInfoUrl'),
      });
  }
  return { oauth, plugins };
}
