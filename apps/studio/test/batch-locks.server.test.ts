/** A batch is checked against the edit leases of every request it carries, before any handler runs (§4.5). */

import { fixtureCatalog } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import type { DesignStore } from '../server/designs.ts';
import { mountWorkbenchApi } from '../server/hono-adapter.ts';
import { memoryLockStore } from '../server/locks/lock-store.ts';

const fixture = fixtureCatalog();

describe('POST /api/batch and edit locks', () => {
  it('answers 423 when any request touches a record someone else holds; nothing is written', async () => {
    const files = new Map(fixture.listDesignIds().map((id) => [id, fixture.loadDesign(id)]));
    const writes: string[] = [];
    const designs: DesignStore = {
      list: () => [...files.values()].map((d) => ({ id: d.id, label: d.label })),
      has: (id) => files.has(id),
      read: (id) => structuredClone(files.get(id)),
      write: (id, d: CableDesign) => (writes.push(id), files.set(id, structuredClone(d)), { changed: true }),
      remove: (id) => void files.delete(id),
    };
    const locks = memoryLockStore();
    const deps: WorkbenchDeps = { designs, loadDb: () => fixture.loadDb(), locks };
    const app = new Hono();
    mountWorkbenchApi(app, deps);
    await locks.acquire('design:dc-led-lead', { name: 'Alex', clientId: 'client-alex', tabId: 'tab-alex' }, Date.now());
    const lead = fixture.loadDesign('dc-led-lead');
    const response = await app.request('/api/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ method: 'PUT', path: '/api/designs/dc-led-lead', body: { ...lead, label: 'locked out' } }] }),
    });
    expect(response.status).toBe(423);
    expect(writes).toEqual([]);
  });
});
