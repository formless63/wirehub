/**
 * Modules on the server (`docs/modules.md`): an integration's routes answer
 * under `/api/modules/<module>/…`, and a module's validation rules refuse a
 * save the way the base validator does.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { createRegistry, defineModule } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type ApiRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';

const db = loadDb();

function memoryStore(seed: CableDesign[]): DesignStore {
  const files = new Map<string, string>(seed.map((d) => [d.id, formatDesignJson(d)]));
  return {
    list: () => [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
    has: (id) => files.has(id),
    read: (id) => (files.has(id) ? (JSON.parse(files.get(id) as string) as CableDesign) : undefined),
    write: (id, design) => {
      const next = formatDesignJson(design);
      const changed = files.get(id) !== next;
      files.set(id, next);
      return { changed };
    },
    remove: (id) => void files.delete(id),
  };
}

const example = defineModule({
  id: 'example',
  label: 'Example',
  version: '0.1.0',
  integrations: [
    {
      id: 'echo',
      label: 'Echo',
      routes: [
        { method: 'GET', path: 'status', handle: async (request) => ({ status: 200, body: { ok: true, q: request.query.get('q') } }) },
        { method: 'POST', path: 'echo', writes: true, handle: async (request) => ({ status: 201, body: request.body }) },
      ],
    },
  ],
  validationRules: [
    {
      id: 'needs-notes',
      label: 'A design must carry notes',
      check: (design: CableDesign) => ((design.notes ?? []).length === 0 ? [{ code: 'no-notes', severity: 'error' as const, message: 'this deployment wants build notes on every design' }] : []),
    },
  ],
});

function depsWith(design: CableDesign): WorkbenchDeps {
  return { designs: memoryStore([design]), loadDb: () => db, modules: createRegistry([example]) };
}

async function call(deps: WorkbenchDeps, request: ApiRequest): Promise<{ status: number; body: any }> {
  return await handleWorkbenchRequest(request, deps);
}

describe('module routes', () => {
  const deps = depsWith(loadDesign('db9-null-modem'));

  it('answers an integration route under /api/modules/<module>/', async () => {
    expect(await call(deps, { method: 'GET', path: '/api/modules/example/status?q=hi' })).toMatchObject({ status: 200, body: { ok: true, q: 'hi' } });
    expect(await call(deps, { method: 'POST', path: '/api/modules/example/echo', body: { a: 1 } })).toMatchObject({ status: 201, body: { a: 1 } });
  });

  it('says so when no module answers', async () => {
    expect((await call(deps, { method: 'GET', path: '/api/modules/example/nope' })).status).toBe(404);
    expect((await call(deps, { method: 'GET', path: '/api/modules/other/status' })).status).toBe(404);
    expect((await call({ ...deps, modules: undefined }, { method: 'GET', path: '/api/modules/example/status' })).status).toBe(404);
  });
});

describe('module validation rules', () => {
  it('refuse a save the rule rejects, with the module-prefixed code', async () => {
    const design = loadDesign('db9-null-modem');
    const bare = { ...structuredClone(design), notes: [] };
    const deps = depsWith(design);
    const etag = (await call(deps, { method: 'GET', path: `/api/designs/${design.id}` }) as { headers?: Record<string, string> }).headers?.['ETag'];
    const refused = await handleWorkbenchRequest({ method: 'PUT', path: `/api/designs/${design.id}`, body: bare, headers: etag === undefined ? {} : { 'if-match': etag } }, deps);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('example/no-notes');
  });
});
