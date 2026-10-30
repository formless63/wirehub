/**
 * The required-process vocabulary over the workbench API (`server/processes-settings.ts`): a
 * replacement needs If-Match, an entry the language rejects is refused, and the hub's own record
 * shadows a pack's of the same id through the catalog layers.
 */

import { createCatalog, dataPath, fsCatalogSource, layeredCatalogSource, loadDesign, memoryCatalogSource } from '@wirehub/catalog';
import type { InstalledPacks } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type ApiRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { PROCESSES_PATH } from '../server/processes-settings.ts';
import { memoryDocStore } from '../server/storage/doc-store.ts';

const ID = 'de9-crossover';
// a synthetic pack's process: every backshell (the starter design has two)
const PACK_PROCESS = { id: 'shell-fit', label: 'Shell fitting', derive: [{ each: 'mechanical', where: { eq: [{ path: 'kind' }, 'shell'] } }], src: 'synthetic example' };

let deps: WorkbenchDeps;

beforeEach(() => {
  const docs = memoryDocStore();
  const seed = loadDesign(ID);
  const designs: DesignStore = {
    list: () => [{ id: ID, label: seed.label }],
    has: (id) => id === ID,
    read: (id) => (id === ID ? (JSON.parse(formatDesignJson(seed)) as CableDesign) : undefined),
    write: () => ({ changed: true }),
    remove: () => undefined,
  };
  deps = {
    designs,
    docs,
    // the hub's own file over the starter catalog over the pack's layer, read the way the catalog reads layers
    loadDb: () => {
      const local = docs.read(PROCESSES_PATH);
      return createCatalog(
        layeredCatalogSource([
          memoryCatalogSource(local === undefined ? {} : { 'processes.json': JSON.stringify(local) }),
          fsCatalogSource(dataPath('')),
          memoryCatalogSource({ 'processes.json': JSON.stringify([PACK_PROCESS]) }),
        ]),
      ).loadDb();
    },
    installedPacks: () => ({ packs: [{ id: 'synthetic-pack', added: { 'processes.json': ['shell-fit'] } }] }) as unknown as InstalledPacks,
    localUser: { name: 'Owner', source: 'local' },
  };
});

async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers?: Record<string, string>; bytes?: Uint8Array }> {
  const request: ApiRequest = { method, path, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) };
  return (await handleWorkbenchRequest(request, deps)) as { status: number; body: any; headers?: Record<string, string>; bytes?: Uint8Array };
}

describe('/api/processes', () => {
  it('PUT needs If-Match (428) and refuses an entry the language cannot use (422), saving nothing', async () => {
    const view = await call('GET', '/api/processes');
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ processes: [{ id: 'shell-fit', origin: 'pack', pack: 'synthetic-pack', problems: [] }], local: [], limits: { processes: 200, derivePerProcess: 10, declaredPerDesign: 100 } });
    const own = { id: 'potting', label: 'Potting', src: 'synthetic example' };
    expect((await call('PUT', '/api/processes', { processes: [own] })).status).toBe(428);
    const bad = await call('PUT', '/api/processes', { processes: [{ ...own, derive: [{ each: 'pcba', where: { run: 'code' } }] }] }, { 'if-match': view.headers!['ETag']! });
    expect(bad.status).toBe(422);
    expect(bad.body.problems.join(' ')).toMatch(/potting: derive\[0\]\.where: 'run' is not a condition/);
    expect(deps.docs!.read(PROCESSES_PATH)).toBeUndefined();
  });

  it('a local enabled:false shadows the pack\'s process of the same id', async () => {
    const live = async (): Promise<any> => JSON.parse(new TextDecoder().decode((await call('GET', `/api/designs/${ID}/exports/processes.json`)).bytes));
    expect((await live()).processes).toMatchObject([{ id: 'shell-fit', source: 'derived', derived: { matches: [{ subject: 'm1' }, { subject: 'm3' }] } }]);
    const view = await call('GET', '/api/processes');
    const off = await call('PUT', '/api/processes', { processes: [{ ...PACK_PROCESS, enabled: false }] }, { 'if-match': view.headers!['ETag']! });
    expect(off.status).toBe(200);
    expect(off.body.processes).toEqual([expect.objectContaining({ id: 'shell-fit', origin: 'pack', enabled: false })]);
    expect((await call('GET', '/api/processes')).body.processes).toEqual([expect.objectContaining({ id: 'shell-fit', enabled: false })]);
    expect((await live()).processes).toEqual([]);
  });
});
