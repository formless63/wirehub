/**
 * `GET /api/events` (task B6): server-sent events — a greeting with the
 * catalog version, then one event per commit and per lease change.
 */

import { fixtureCatalog } from '@wirehub/catalog';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import { memoryEventHub } from '../server/events.ts';
import { mountWorkbenchApi } from '../server/hono-adapter.ts';
import { memoryLockStore } from '../server/locks/lock-store.ts';
import type { DesignStore } from '../server/designs.ts';
import type { CableDesign } from '@wirehub/model';

const fixture = fixtureCatalog();

function designs(): DesignStore {
  const files = new Map(fixture.listDesignIds().map((id) => [id, fixture.loadDesign(id)]));
  return {
    list: () => [...files.values()].map((d) => ({ id: d.id, label: d.label })),
    has: (id) => files.has(id),
    read: (id) => structuredClone(files.get(id)),
    write: (id, d: CableDesign) => (files.set(id, structuredClone(d)), { changed: true }),
    remove: (id) => void files.delete(id),
  };
}

describe('GET /api/events', () => {
  it('greets, then streams a commit and a lease change', async () => {
    let version = 1;
    const deps: WorkbenchDeps = { designs: designs(), loadDb: () => fixture.loadDb(), catalogVersion: () => String(version), locks: memoryLockStore(), events: memoryEventHub() };
    const app = new Hono();
    mountWorkbenchApi(app, deps);
    const controller = new AbortController();
    const response = await app.request('/api/events', { signal: controller.signal });
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += decoder.decode(value);
      }
    };
    await readUntil('event: hello');
    const read = await app.request('/api/designs/de9-crossover');
    const design = (await read.json()) as CableDesign;
    version = 2;
    const put = await app.request('/api/designs/de9-crossover', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': read.headers.get('etag') ?? '' },
      body: JSON.stringify({ ...design, label: 'streamed' }),
    });
    expect(put.status).toBe(200);
    await readUntil('event: catalog');
    expect(text).toContain('"version":"2"');
    const lock = await app.request('/api/locks/acquire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ record: 'design:de9-crossover', holder: { name: 'Alex', clientId: 'client-xxxxxx', tabId: 'tab-xxxxxx' } }),
    });
    expect(lock.status).toBe(200);
    await readUntil('event: locks');
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
