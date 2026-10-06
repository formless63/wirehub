import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFxIntegration, ECB_DAILY_URL, fetchLatest, parseEcbXml } from '../src/server.ts';

/** Synthetic observations, not copied ECB exchange-rate data. */
const xml = (rows = "<Cube currency='USD' rate='2'/><Cube currency='GBP' rate='0.5'/>", date = '2026-01-02') => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<gesmes:subject>Reference rates</gesmes:subject><gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>
<Cube><Cube time='${date}'>${rows}</Cube></Cube></gesmes:Envelope>`;
const now = () => new Date('2026-01-03T04:05:06Z');
const fetcher = (body = xml(), init?: ResponseInit): typeof fetch => vi.fn(async () => new Response(body, init)) as typeof fetch;
afterEach(() => vi.useRealTimers());

describe('manual ECB daily snapshot', () => {
  it('maps only the exact dated rate table and tags source/retrieval separately', () => {
    expect(parseEcbXml(xml(), now().toISOString())).toEqual({ base: 'EUR', date: '2026-01-02', rates: { USD: 2, GBP: 0.5 }, source: ECB_DAILY_URL, retrievedAt: now().toISOString() });
    expect(parseEcbXml(xml('<Cube currency="USD" rate="2"/>'), now().toISOString()).rates).toEqual({ USD: 2 });
  });

  it.each([
    xml("<Cube currency='USD' rate='0'/>"), xml("<Cube currency='USD' rate='NaN'/>"),
    xml("<Cube currency='USD' rate='2'/><Cube currency='USD' rate='3'/>"), xml("<Cube currency='EUR' rate='2'/>"),
    xml("<Cube currency='usd' rate='2'/>"), xml('', '2026-02-30'), xml('', '2026-01-04'),
    xml().replace('2\'/>', '2"/>'), xml().replace('<Cube>', '<Cube unknown="x">'),
    xml().replace('Reference rates', '&external;'), `<!DOCTYPE x [<!ENTITY external SYSTEM 'file:///etc/passwd'>]>${xml()}`,
    xml().replace('</gesmes:Envelope>', '<script>bad</script></gesmes:Envelope>'),
  ])('rejects malformed, unsafe or ambiguous rate documents', (body) => {
    expect(() => parseEcbXml(body, now().toISOString())).toThrow(/^ECB response is invalid\.$/);
  });

  it('fetches only on explicit route invocation with a fixed URL and no redirects', async () => {
    const fetch = fetcher();
    const integration = createFxIntegration({ fetch, now });
    expect(fetch).not.toHaveBeenCalled();
    const result = await integration.routes![0]!.handle({ query: new URLSearchParams('url=https://attacker.invalid') });
    expect(result).toMatchObject({ status: 200, body: { snapshot: { rates: { USD: 2, GBP: 0.5 } } } });
    expect(fetch).toHaveBeenCalledWith(ECB_DAILY_URL, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });

  it('bounds the stream and hides arbitrary network or provider error details', async () => {
    await expect(fetchLatest({ fetch: fetcher('x'.repeat(65537)), now })).rejects.toThrow('too large');
    await expect(fetchLatest({ fetch: fetcher('{}', { headers: { 'content-length': '65537' } }), now })).rejects.toThrow('too large');
    await expect(fetchLatest({ fetch: fetcher('private provider body', { status: 502 }), now })).rejects.toThrow(/^ECB request failed\.$/);
    await expect(fetchLatest({ fetch: fetcher('', { status: 302 }), now })).rejects.toThrow(/^ECB request failed\.$/);
    const route = createFxIntegration({ fetch: async () => { throw new Error('Private network host details'); }, now }).routes![0]!;
    expect(await route.handle({ query: new URLSearchParams() })).toEqual({ status: 502, body: { error: 'ECB request failed.' } });
  });

  it('times out even when an injected transport ignores abort', async () => {
    vi.useFakeTimers();
    const pending = fetchLatest({ fetch: async () => new Promise<Response>(() => undefined), now });
    const check = expect(pending).rejects.toThrow(/^ECB request timed out\.$/);
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
  });
});
