import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonRequest } from '../src/providers/http.ts';
import type { ProviderContext } from '../src/types.ts';

const context = (fetcher: typeof fetch): ProviderContext => ({ credentials: {}, fetch: fetcher, now: () => new Date('2026-01-01Z'), nonce: () => 'synthetic' });
const url = 'https://api.mouser.com/synthetic?apiKey=test-only-credential';
afterEach(() => vi.useRealTimers());

describe('bounded supplier HTTP', () => {
  it('uses injected fetch and forbids redirects, without exposing request details in errors', async () => {
    const fetcher = vi.fn(async () => Response.json({ synthetic: true })) as typeof fetch;
    expect(await jsonRequest(url, { method: 'POST', redirect: 'follow' }, context(fetcher))).toEqual({ synthetic: true });
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
    const failure = vi.fn(async () => { throw new Error(`${url} private body`); }) as typeof fetch;
    await expect(jsonRequest(url, {}, context(failure))).rejects.toThrow(/^Supplier request failed\.$/);
    await expect(jsonRequest(url, {}, context(async () => new Response('', { status: 302, headers: { location: url } })))).rejects.toThrow(/^Supplier redirect refused\.$/);
  });

  it('bounds streamed bodies even without content-length and refuses malformed JSON', async () => {
    await expect(jsonRequest(url, {}, context(async () => new Response('x'.repeat(1024 * 1024 + 1))))).rejects.toThrow('too large');
    await expect(jsonRequest(url, {}, context(async () => new Response('{}', { headers: { 'content-length': '1048577' } })))).rejects.toThrow('too large');
    await expect(jsonRequest(url, {}, context(async () => new Response('secret upstream body')))).rejects.toThrow(/^Supplier response is invalid\.$/);
    await expect(jsonRequest(url, {}, context(async () => new Response(new Uint8Array([0xff]))))).rejects.toThrow(/^Supplier response is invalid\.$/);
  });

  it('exposes only a bounded numeric Retry-After hint', async () => {
    const limited = (retry: string) => context(async () => new Response('private upstream error', { status: 429, headers: { 'retry-after': retry } }));
    await expect(jsonRequest(url, {}, limited('60'))).rejects.toThrow('retry after 60 seconds');
    await expect(jsonRequest(url, {}, limited('9999'))).rejects.toThrow('retry later');
    await expect(jsonRequest(url, {}, limited('test-only-credential'))).rejects.toThrow(/^Supplier rate limit reached; retry later\.$/);
  });

  it('enforces a deadline even when injected fetch ignores abort', async () => {
    vi.useFakeTimers();
    const pending = jsonRequest(url, {}, context(async () => new Promise<Response>(() => undefined)));
    const check = expect(pending).rejects.toThrow(/^Supplier request timed out\.$/);
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
  });
});
