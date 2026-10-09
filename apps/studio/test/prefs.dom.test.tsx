/**
 * The studio's preference client (cs-74m4): the hub's copy wins, a local-only choice goes up, a
 * change made offline stays and is sent later, and the local mirror answers until the hub does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrefsBackend } from '../src/prefs.browser.ts';

let hub: Record<string, unknown>;
let up: boolean;
const puts: unknown[] = [];

beforeEach(() => {
  window.localStorage.clear();
  hub = {};
  up = true;
  puts.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
    if (!up) throw new TypeError('offline');
    if (init?.method === 'PUT') {
      const patch = (JSON.parse(init.body ?? '{}') as { prefs: Record<string, unknown> }).prefs;
      puts.push(patch);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete hub[k];
        else hub[k] = v;
      }
    }
    return new Response(JSON.stringify({ prefs: hub }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('preferences on the hub', () => {
  it('adopts the hub\'s values on hydrate and mirrors them in this browser', async () => {
    hub = { theme: 'dark', 'slot-pins': ['a/b'] };
    const p = createPrefsBackend('/api', undefined, 0);
    await p.hydrate('ada');
    expect(p.get('theme')).toBe('dark');
    expect(JSON.parse(window.localStorage.getItem('wirehub:prefs:ada') ?? '{}').values).toEqual(hub);
    // another browser: no local copy yet, the same account
    window.localStorage.clear();
    const q = createPrefsBackend('/api', undefined, 0);
    await q.hydrate('ada');
    expect(q.get('slot-pins')).toEqual(['a/b']);
  });

  it('sends a change to the hub, and a choice only this browser has goes up on hydrate', async () => {
    window.localStorage.setItem('wirehub:prefs:ada', JSON.stringify({ values: { theme: 'light' }, dirty: [] }));
    const p = createPrefsBackend('/api', undefined, 0);
    await p.hydrate('ada');
    expect(hub).toEqual({ theme: 'light' });
    p.set('cols.designs', ['updated']);
    await p.flush();
    expect(hub).toEqual({ theme: 'light', 'cols.designs': ['updated'] });
  });

  it('keeps a change made while the hub is unreachable, and sends it on the next hydrate', async () => {
    const p = createPrefsBackend('/api', undefined, 0);
    await p.hydrate('ada');
    up = false;
    p.set('theme', 'dark');
    await p.flush();
    expect(p.get('theme')).toBe('dark');
    expect(hub).toEqual({});
    up = true;
    const again = createPrefsBackend('/api', undefined, 0);
    await again.hydrate('ada');
    expect(again.get('theme')).toBe('dark');
    expect(hub).toEqual({ theme: 'dark' });
  });
});
