import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mountAuth } from '../server/auth/gate.ts';
import { readAuthConfig } from '../server/auth/config.ts';
import type { StudioAuth } from '../server/auth/studio-auth.ts';

function fixture() {
  let allowed = true;
  const auth = {
    config: readAuthConfig({ AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'synthetic-only-secret-01234567890123456789', BETTER_AUTH_URL: 'http://studio.test', WIREHUB_BACKEND: 'pg', AUTH_ALLOWED_EMAILS: 'owner@example.test' }),
    sessionUser: async (headers: Headers) => headers.get('cookie') === 'synthetic-session' ? { id: 'owner', email: 'owner@example.test', name: 'Owner' } : null,
    isAllowed: async () => allowed,
    providers: [{ providerId: 'github', name: 'GitHub' }],
    people: { hasPasswordLogin: async () => true },
    tokens: {},
  } as unknown as StudioAuth;
  const app = new Hono(); mountAuth(app, auth, { spaAccountPages: true });
  app.get('*', c => c.html('<main id="spa-shell">App navigation</main>'));
  const request = (path: string, signedIn = true) => app.request('http://studio.test'+path, { headers: signedIn ? { cookie: 'synthetic-session' } : {} });
  return { request, refuse: () => { allowed = false; } };
}

describe('account pages inside app navigation', () => {
  it('serves the SPA at authenticated account URLs and the exact server controls only in embedded mode', async () => {
    const f = fixture();
    for (const path of ['/sign-in', '/settings/people', '/account/tokens']) {
      expect(await (await f.request(path)).text()).toContain('spa-shell');
      const embedded = await f.request(path+'?embed=1');
      expect(embedded.status).toBe(200);
      expect(embedded.headers.get('cache-control')).toBe('no-store');
      expect(embedded.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
      expect(await embedded.text()).not.toContain('spa-shell');
    }
  });
  it('brands the signed-out page with bundled fonts and gives invalid addresses a public 404', async () => {
    const f = fixture();
    const login = await (await f.request('/sign-in', false)).text();
    expect(login).toContain('class="brand" aria-label="WireHub"');
    expect(login).toContain("font-family:'IBM Plex Sans'");
    expect(login).toContain('data:font/woff2;base64,');
    const unknown = await f.request('/does-not-exist', false);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('location')).toBeNull();
    expect(await unknown.text()).toContain('Page not found');
    const design = await f.request('/cables/example', false);
    expect(design.status).toBe(302);
    expect(design.headers.get('location')).toContain('/sign-in?');
    const api = await f.request('/api/unknown', false);
    expect(api.status).toBe(401);
  });
  it('keeps signed-out login standalone and refuses account frames for missing or disallowed sessions', async () => {
    const f = fixture();
    expect(await (await f.request('/sign-in', false)).text()).toContain('id="password"');
    expect((await f.request('/sign-in?embed=1', false)).status).toBe(401);
    for (const path of ['/settings/people', '/account/tokens']) expect((await f.request(path+'?embed=1', false)).status).toBe(401);
    const expired = await f.request('/settings/people?embed=1', false);
    expect(await expired.text()).toContain('target="_top" class="btn primary" href="/sign-in"');
    f.refuse();
    expect((await f.request('/sign-in?embed=1')).status).toBe(403);
    for (const path of ['/settings/people', '/account/tokens']) expect((await f.request(path+'?embed=1')).status).toBe(403);
  });
  it('uses top-level navigation for provider flows, callbacks, logout and home links', async () => {
    const f = fixture(); const page = await (await f.request('/sign-in?embed=1')).text();
    expect(page).toContain('function go(url){window.top.location.href=url}');
    expect(page).toContain('go(r.body.url)');
    expect(page).toContain("callbackURL:'/sign-in',errorCallbackURL:'/sign-in'");
    expect(page).toContain("go('/sign-in')");
    expect(page).toContain('<a target="_top" class="btn primary"');
    expect(page).not.toContain('function go(url){location.href=url}');
  });
});
