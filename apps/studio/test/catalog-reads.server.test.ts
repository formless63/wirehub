/**
 * The catalog reads the browser takes from the API: drawings and the
 * part-number configuration — each served as stored, over the frozen fixture
 * catalog so the expected values never drift.
 */

import { fixtureCatalog } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { DesignStore } from '../server/designs.ts';
import type { DrawingStore } from '../server/drawings.ts';

const fixture = fixtureCatalog();

function deps(overrides: Partial<WorkbenchDeps> = {}): WorkbenchDeps {
  const designs: DesignStore = {
    list: () => fixture.listDesignSummaries(),
    has: (id) => fixture.designExists(id),
    read: (id) => (fixture.designExists(id) ? fixture.loadDesign(id) : undefined),
    write: () => ({ changed: false }),
    remove: () => undefined,
  };
  const drawings = {
    read: (id: string) => ({ meta: fixture.readJsonFile<Record<string, unknown>>(`drawings/${id}.json`) ?? {} }),
  } as unknown as DrawingStore;
  return {
    designs,
    drawings,
    loadDb: () => fixture.loadDb(),
    loadPartNumberFiles: () => ({ scheme: fixture.readJsonFile('part-numbers.json') }),
    ...overrides,
  };
}

const get = async (path: string, d = deps()): Promise<{ status: number; body: any }> => await handleWorkbenchRequest({ method: 'GET', path }, d);

describe('catalog reads', () => {
  it('GET /api/drawings indexes every design that has drawing details', async () => {
    const out = await get('/api/drawings');
    expect(out.status).toBe(200);
    // the length family: a family PN with per-length suffixes
    expect(out.body.drawings['xlr-mic-cable'].partNumber).toBe('CBL-00010-XX');
    expect(out.body.drawings['xlr-mic-cable'].lengths.length).toBe(3);
    for (const id of Object.keys(out.body.drawings)) expect(fixture.designExists(id), id).toBe(true);
  });

  it('GET /api/part-numbers carries the scheme configuration, the designs and their drawings', async () => {
    const out = await get('/api/part-numbers');
    expect(out.status).toBe(200);
    expect(out.body.scheme).toBeUndefined();
    expect(out.body.designs.length).toBe(fixture.listDesignIds().length);
    expect(out.body.drawings['xlr-mic-cable'].partNumber).toBe('CBL-00010-XX');
  });

  it('says so in words when the host keeps none of it, and refuses writes', async () => {
    const bare: WorkbenchDeps = { designs: deps().designs, loadDb: () => fixture.loadDb() };
    expect((await get('/api/drawings', bare)).status).toBe(501);
    expect((await get('/api/part-numbers', bare)).status).toBe(501);
    const write = await handleWorkbenchRequest({ method: 'PUT', path: '/api/part-numbers', body: {} }, deps());
    expect(write.status).toBe(405);
  });

  it('lists the new routes in the index', async () => {
    const routes = ((await get('/api')).body as { routes: string[] }).routes.join('\n');
    for (const route of ['/api/drawings', '/api/part-numbers', '/api/modules/:module']) {
      expect(routes).toContain(route);
    }
  });

  it('keeps per-design drawing reads working beside the index', async () => {
    const design = fixture.loadDesign('xlr-mic-cable') as CableDesign;
    const out = await get(`/api/drawings/${design.id}`);
    expect(out.status).toBe(200);
  });
});
