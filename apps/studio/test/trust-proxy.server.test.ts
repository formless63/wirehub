/** WIREHUB_TRUST_PROXY: forwarded headers count only behind a trusted proxy. */

import { describe, expect, it } from 'vitest';

import { clientAddress, requestOrigin, trustProxy } from '../server/env.ts';

const forwarded = new Request('http://10.0.0.5:5183/api/designs', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub.example.com' } });

describe('trusted proxy', () => {
  it('is off unless asked', () => {
    expect(trustProxy({})).toBe(false);
    expect(requestOrigin(forwarded, {})).toBe('http://10.0.0.5:5183');
    expect(clientAddress(forwarded.headers, '10.0.0.1', {})).toBe('10.0.0.1');
  });
  it('reads the forwarded client, scheme and host when on', () => {
    const env = { WIREHUB_TRUST_PROXY: '1' };
    expect(trustProxy(env)).toBe(true);
    expect(requestOrigin(forwarded, env)).toBe('https://hub.example.com');
    expect(clientAddress(forwarded.headers, '10.0.0.1', env)).toBe('203.0.113.7');
    expect(clientAddress(new Headers(), '10.0.0.1', env)).toBe('10.0.0.1');
  });
});
