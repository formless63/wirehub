/** The monitoring webhook (plan §8.6): formats, token scrubbing, never throws, throttling. */

import { describe, expect, it } from 'vitest';

import { createNotifier, notifierFromEnv, notifyFormatOf, throttled } from '../server/notify.ts';

const EVENT = { event: 'backup-failed', severity: 'urgent', title: 'Backup failed', message: 'the dump exited 1', data: { code: 1 } } as const;

function recorder(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('createNotifier', () => {
  it('posts one JSON body per event and logs it', async () => {
    const { calls, fetchImpl } = recorder();
    const log: string[] = [];
    const n = createNotifier({ url: 'http://hook.test/x', fetch: fetchImpl, env: 'prod', version: '1.2.3', log: (l) => log.push(l), now: () => new Date('2026-10-05T00:00:00Z') });
    await n.notify(EVENT);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ ...EVENT, at: '2026-10-05T00:00:00.000Z', env: 'prod', version: '1.2.3' });
    expect(log[0]).toContain('backup-failed');
  });

  it('speaks ntfy and slack', async () => {
    const a = recorder();
    await createNotifier({ url: 'http://ntfy.test/t', format: 'ntfy', fetch: a.fetchImpl, log: () => {} }).notify(EVENT);
    expect(a.calls[0]!.init.body).toBe('the dump exited 1');
    expect(a.calls[0]!.init.headers).toMatchObject({ title: 'Backup failed', priority: '5', tags: 'rotating_light' });
    const b = recorder();
    await createNotifier({ url: 'http://slack.test/t', format: 'slack', fetch: b.fetchImpl, log: () => {} }).notify(EVENT);
    expect(JSON.parse(b.calls[0]!.init.body as string).text).toContain('Backup failed');
  });

  it('never carries a token, and never throws', async () => {
    const { calls, fetchImpl } = recorder(500);
    const log: string[] = [];
    const n = createNotifier({ url: 'http://hook.test/x', fetch: fetchImpl, log: (l) => log.push(l) });
    const token = 'cst_prod_0123456789ab_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
    await n.notify({ ...EVENT, message: `used ${token}`, data: { nested: [token] } });
    expect(JSON.stringify(calls) + log.join()).not.toContain('cst_prod_0123');
    const down = createNotifier({ url: 'http://hook.test/x', fetch: (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch, log: (l) => log.push(l) });
    await expect(down.notify(EVENT)).resolves.toBeUndefined();
    expect(log.join('\n')).toContain('was not reached');
  });

  it('without a URL only logs', async () => {
    const log: string[] = [];
    const n = createNotifier({ log: (l) => log.push(l) });
    expect(n.enabled).toBe(false);
    await n.notify(EVENT);
    expect(log).toHaveLength(1);
  });

  it('is configured by the environment', () => {
    expect(notifierFromEnv({}).enabled).toBe(false);
    expect(notifierFromEnv({ WIREHUB_NOTIFY_URL: 'https://hook.test/x' }).enabled).toBe(true);
    expect(() => notifierFromEnv({ WIREHUB_NOTIFY_URL: 'ftp://x' })).toThrow(/http/);
    expect(notifyFormatOf('NTFY')).toBe('ntfy');
    expect(() => notifyFormatOf('xml')).toThrow(/json, ntfy or slack/);
  });

  it('throttles repeats of one event', async () => {
    const { calls, fetchImpl } = recorder();
    let t = 0;
    const n = throttled(createNotifier({ url: 'http://hook.test/x', fetch: fetchImpl, log: () => {} }), 1000, () => t);
    await n.notify(EVENT);
    await n.notify(EVENT);
    t = 1500;
    await n.notify(EVENT);
    expect(calls).toHaveLength(2);
  });
});

describe('RateLimiter.failure', () => {
  it('reports a run of refusals once, then the throttle once', async () => {
    const { RateLimiter } = await import('../server/auth/tokens.ts');
    const limiter = new RateLimiter(() => 0);
    const outcomes = Array.from({ length: 12 }, () => limiter.failure('1.2.3.4'));
    expect(outcomes.filter((o) => o === 'repeated')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'blocked')).toHaveLength(1);
    expect(outcomes[4]).toBe('repeated');
    expect(outcomes[10]).toBe('blocked');
  });
});
