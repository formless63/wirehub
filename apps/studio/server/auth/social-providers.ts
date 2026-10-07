/** Built-in providers use Better Auth's fixed OAuth endpoints and PKCE flows. */
import type { BetterAuthOptions } from 'better-auth';
import { type GithubProfile, type GoogleProfile, verifyGoogleIdToken } from 'better-auth/social-providers';
import type { AuthConfigEnabled } from './config.ts';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function email(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(normalized) ? normalized : undefined;
}

export function builtInProviders(config: AuthConfigEnabled): { providerId: string; name: string }[] {
  return [
    ...(config.github === undefined ? [] : [{ providerId: 'github', name: 'GitHub' }]),
    ...(config.google === undefined ? [] : [{ providerId: 'google', name: 'Google' }]),
  ];
}

export function socialProviders(config: AuthConfigEnabled, fetchImpl: typeof fetch, isAllowed: (email: string) => Promise<boolean>, linkingEmail: () => string | undefined = () => undefined): BetterAuthOptions['socialProviders'] {
  return {
    ...(config.github === undefined ? {} : { github: {
      ...config.github,
      // https://docs.github.com/en/rest/users/emails?apiVersion=2022-11-28
      // A public profile email is not evidence of verification. Require the
      // authenticated user's verified primary email, including private ones.
      async getUserInfo(tokens) {
        if (!tokens.accessToken) return null;
        try {
          const headers = { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'WireHub', 'x-github-api-version': '2022-11-28' };
          const request = async (url: string): Promise<unknown> => {
            const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
            if (!response.ok) return undefined;
            return response.json();
          };
          const profile = record(await request('https://api.github.com/user'));
          const addresses = await request('https://api.github.com/user/emails?per_page=100');
          if (!profile || !((typeof profile.id === 'string' && /^[1-9][0-9]*$/.test(profile.id)) || (typeof profile.id === 'number' && Number.isSafeInteger(profile.id) && profile.id > 0)) || !Array.isArray(addresses)) return null;
          const primary = addresses.map(record).filter((entry) => entry?.primary === true);
          if (primary.length !== 1 || primary[0]?.verified !== true) return null;
          const address = email(primary[0].email);
          if (!address || (linkingEmail() !== undefined && address !== linkingEmail()) || !(await isAllowed(address))) return null;
          return {
            user: { email: address, emailVerified: true, name: typeof profile.name === 'string' ? profile.name : typeof profile.login === 'string' ? profile.login : '', image: typeof profile.avatar_url === 'string' ? profile.avatar_url : undefined },
            data: { ...profile, id: String(profile.id) } as unknown as GithubProfile,
          };
        } catch { return null; }
      },
    } }),
    ...(config.google === undefined ? {} : { google: {
      ...config.google,
      // https://developers.google.com/identity/openid-connect/openid-connect
      // Also verify here: callbacks and direct-token account linking must both
      // reject fresh unverified identities, even for an already verified user.
      async getUserInfo(tokens) {
        if (!tokens.idToken) return null;
        const expectedNonce = record(tokens)?.expectedIdTokenNonce;
        const claims = await verifyGoogleIdToken({
          token: tokens.idToken,
          audience: config.google!.clientId,
          nonce: typeof expectedNonce === 'string' ? expectedNonce : undefined,
        });
        if (!claims || claims.email_verified !== true || typeof claims.sub !== 'string' || claims.sub === '') return null;
        const address = email(claims.email);
        if (!address || (linkingEmail() !== undefined && address !== linkingEmail()) || !(await isAllowed(address))) return null;
        return { user: { email: address, emailVerified: true, name: typeof claims.name === 'string' ? claims.name : '', image: typeof claims.picture === 'string' ? claims.picture : undefined }, data: claims as unknown as GoogleProfile };
      },
    } }),
  };
}
