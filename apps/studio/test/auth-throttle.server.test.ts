/** A throttled auth endpoint speaks in a rate-limit voice (cs-8cl), not as a signed-out session. */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { mountAuth, throttledAuthResponse } from '../server/auth/gate.ts';
import { renderSignInPage } from '../server/auth/sign-in-page.ts';
import type { StudioAuth } from '../server/auth/studio-auth.ts';

describe('throttled auth', () => {
  it('rewrites Better Auth 429 with Retry-After and a rate-limit message', async () => {
    const raw = new Response(JSON.stringify({ message: 'Too many requests. Please try again later.' }), { status: 429, headers: { 'x-retry-after': '7' } });
    const res = throttledAuthResponse(raw);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    const body = (await res.json()) as { error: string; message: string; retryAfter: number };
    expect(body.error).toBe('Too many attempts, try again in 7 s.');
    expect(body.error).not.toMatch(/signed out/i);
    expect(body.retryAfter).toBe(7);
  });

  it('passes other statuses through untouched and defaults the wait', async () => {
    const ok = new Response('x', { status: 200 });
    expect(throttledAuthResponse(ok)).toBe(ok);
    expect(throttledAuthResponse(new Response('{}', { status: 429 })).headers.get('retry-after')).toBe('10');
  });

  it('is applied on the mounted /api/auth route', async () => {
    const auth = {
      config: { localAccounts: true },
      handler: async () => new Response('{}', { status: 429, headers: { 'x-retry-after': '4' } }),
      sessionUser: async () => null,
      isAllowed: async () => false,
    } as unknown as StudioAuth;
    const app = new Hono();
    mountAuth(app, auth);
    const res = await app.request('http://studio.test/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://studio.test' }, body: '{}' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('4');
  });

  it('the sign-in page shows the wait on 429', () => {
    const page = renderSignInPage({ localAccounts: true, next: '/' } as never);
    expect(page).toContain('Too many attempts, try again in ');
    expect(page).toContain("r.status===429");
  });
});
