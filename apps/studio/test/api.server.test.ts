/**
 * The workbench API.
 *
 * `handleWorkbenchRequest` is a pure function of `(request, deps)`, so every
 * endpoint is exercised here with no server, no socket and no filesystem: the
 * store is a `Map`. What that leaves untested — that the *real* store writes
 * the bytes it claims — is covered by the filesystem cases at the bottom
 * (read-only against the committed catalog) and by the curl round-trip in the
 * task's transcript, which byte-compares a saved file.
 */

import { loadDb, loadDesign, listDesignIds } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  handleWorkbenchRequest,
  readDesignBody,
  type ApiError,
  type ApiRequest,
  type WorkbenchDeps,
} from '../server/api.ts';
import { cableListEntry } from '../src/cable-list.ts';
import {
  designPath,
  fileDesignStore,
  formatDesignJson,
  type DesignStore,
} from '../server/designs.ts';

const db: Db = loadDb();

/** The store interface, backed by a Map — the same contract, no disk. */
function memoryStore(seed: CableDesign[] = []): DesignStore & { files: Map<string, string> } {
  // stored as text, exactly as the real one does, so a test can see that a
  // refused write really left the previous bytes in place
  const files = new Map<string, string>(seed.map((d) => [d.id, formatDesignJson(d)]));
  return {
    files,
    list: () =>
      [...files.keys()].sort().map((id) => ({
        id,
        label: (JSON.parse(files.get(id) as string) as CableDesign).label,
      })),
    has: (id) => files.has(id),
    read: (id) => {
      const text = files.get(id);
      return text === undefined ? undefined : (JSON.parse(text) as CableDesign);
    },
    write: (id, design) => {
      const next = formatDesignJson(design);
      const changed = files.get(id) !== next;
      files.set(id, next);
      return { changed };
    },
    remove: (id) => void files.delete(id),
  };
}

const BLANK: CableDesign = {
  schemaVersion: 1,
  id: 'test-blank',
  label: 'A blank design',
  src: 'test fixture',
  instances: { connectors: [], segments: [], components: [], pcbas: [] },
  joints: [],
};

/** A real catalog design, so the validator has something substantial to chew. */
const REAL = loadDesign('db9-null-modem');

let store: ReturnType<typeof memoryStore>;
let deps: WorkbenchDeps;

beforeEach(async () => {
  store = memoryStore([structuredClone(REAL), structuredClone(BLANK)]);
  deps = { designs: store, loadDb: () => db };
});

/**
 * One request. A design edit (PUT, rename) with no `headers` given quotes the
 * version on disk as If-Match — an editor that loaded it just now — since the
 * guard is required; pass `{}` to send a write with no If-Match at all.
 */
async function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
  const edit = /^\/api\/designs\/([^/]+)(\/rename)?$/.exec(path);
  if (headers === undefined && edit !== null && ((method === 'PUT' && edit[2] === undefined) || (method === 'POST' && edit[2] !== undefined))) {
    const etag = (await handleWorkbenchRequest({ method: 'GET', path: `/api/designs/${edit[1]}` }, deps)).headers?.['ETag'];
    if (etag !== undefined) headers = { 'if-match': etag };
  }
  const request: ApiRequest = {
    method,
    path,
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
  };
  return await handleWorkbenchRequest(request, deps);
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

describe('GET /api/designs', () => {
  it('lists ids and labels, sorted — and the cable-list columns computed from each design', async () => {
    const response = await call('GET', '/api/designs');
    expect(response.status).toBe(200);
    expect(response.body.designs).toEqual([
      cableListEntry(REAL, db),
      cableListEntry(BLANK, db),
    ]);
  });

  it('picks up a design the store gained without any code change', async () => {
    store.write('later-arrival', { ...BLANK, id: 'later-arrival', label: 'Dropped in later' });
    expect((await call('GET', '/api/designs')).body.designs.map((d: { id: string }) => d.id)).toContain(
      'later-arrival',
    );
  });
});

describe('GET /api/designs/:id', () => {
  it('returns the stored design', async () => {
    const response = await call('GET', '/api/designs/test-blank');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(BLANK);
  });

  it('says which design it could not find, and what to do instead', async () => {
    const response = await call('GET', '/api/designs/no-such-cable');
    expect(response.status).toBe(404);
    expect((response.body as ApiError).error).toContain("'no-such-cable'");
    expect((response.body as ApiError).hint).toBeDefined();
  });
});

describe('GET /api/db', () => {
  it('hands back the whole definition bundle', async () => {
    const response = await call('GET', '/api/db');
    expect(response.status).toBe(200);
    expect(response.body.connectors.length).toBe(db.connectors.length);
    expect(response.body.pcbas.length).toBe(db.pcbas.length);
  });
});

/* ------------------------------------------------------------------ *
 * Validate-then-write
 * ------------------------------------------------------------------ */

describe('PUT /api/designs/:id', () => {
  it('stores a design the validator accepts and returns what was stored', async () => {
    const edited = { ...structuredClone(REAL), label: 'renamed in the GUI' };
    const response = await call('PUT', `/api/designs/${REAL.id}`, edited);
    expect(response.status).toBe(200);
    expect(response.body.label).toBe('renamed in the GUI');
    expect((await store.read(REAL.id))?.label).toBe('renamed in the GUI');
  });

  it('leaves the file untouched when nothing about the design changed', async () => {
    const before = store.files.get(REAL.id);
    expect((await call('PUT', `/api/designs/${REAL.id}`, structuredClone(REAL))).status).toBe(200);
    expect(store.files.get(REAL.id)).toBe(before);
  });

  it('refuses a design with errors with 422, the issues, and writes nothing', async () => {
    const before = store.files.get(REAL.id);
    const broken = structuredClone(REAL);
    broken.instances.connectors.push({ id: 'j99', def: 'no-such-connector' });

    const response = await call('PUT', `/api/designs/${REAL.id}`, broken);
    expect(response.status).toBe(422);
    const body = response.body as ApiError;
    expect(body.issues?.some((issue) => issue.code === 'unknown-def')).toBe(true);
    expect(body.error).toContain(REAL.id);
    expect(body.hint).toContain('Nothing was written');
    expect(store.files.get(REAL.id)).toBe(before);
  });

  it('will not let a save move a design to another id', async () => {
    const response = await call('PUT', '/api/designs/test-blank', { ...BLANK, id: 'somewhere-else' });
    expect(response.status).toBe(400);
    expect((response.body as ApiError).hint).toContain('Rename');
    expect(store.has('somewhere-else')).toBe(false);
  });

  it('refuses to create by saving — that is what New is for', async () => {
    expect((await call('PUT', '/api/designs/not-yet-a-design', { ...BLANK, id: 'not-yet-a-design' })).status).toBe(404);
  });

  it('names the missing provenance rather than writing a record without it', async () => {
    const { src: _dropped, ...noSrc } = structuredClone(BLANK);
    const response = await call('PUT', '/api/designs/test-blank', noSrc);
    expect(response.status).toBe(400);
    expect((response.body as ApiError).error).toContain('where its information comes from');
  });
});

/* ------------------------------------------------------------------ *
 * The stale-write guard:
 * GET carries an ETag; PUT with a matching If-Match writes normally, a stale
 * one is refused with 409 and nothing written, and PUT with no If-Match at
 * all is refused with 428 (review fix, 2026-09-26: a stale bundled copy saved
 * over newer server data).
 * ------------------------------------------------------------------ */

describe('the stale-write guard', () => {
  it('answers GET /api/designs/:id with an ETag', async () => {
    const response = await call('GET', `/api/designs/${REAL.id}`);
    expect(response.headers?.['ETag']).toMatch(/^".+"$/);
  });

  it('writes normally when If-Match names the version on disk', async () => {
    const etag = (await call('GET', `/api/designs/${REAL.id}`)).headers?.['ETag'];
    expect(etag).toBeDefined();
    const response = await call(
      'PUT',
      `/api/designs/${REAL.id}`,
      { ...structuredClone(REAL), label: 'checked against the version I loaded' },
      { 'if-match': etag as string },
    );
    expect(response.status).toBe(200);
    expect((await store.read(REAL.id))?.label).toBe('checked against the version I loaded');
  });

  it('refuses with 409 and writes nothing when the design changed since If-Match was issued', async () => {
    const etag = (await call('GET', `/api/designs/${REAL.id}`)).headers?.['ETag'];
    expect(etag).toBeDefined();

    // another tab (or the other owner) saves first
    expect(
      (await call('PUT', `/api/designs/${REAL.id}`, { ...structuredClone(REAL), label: 'saved elsewhere' })).status,
    ).toBe(200);

    const response = await call(
      'PUT',
      `/api/designs/${REAL.id}`,
      { ...structuredClone(REAL), label: 'my stale edit' },
      { 'if-match': etag as string },
    );
    expect(response.status).toBe(409);
    const body = response.body as ApiError;
    expect(body.issues?.some((issue) => issue.code === 'stale-write')).toBe(true);
    expect(body.error).toContain(REAL.id);
    expect(body.hint).toContain('Nothing was written');
    // the other save survived
    expect((await store.read(REAL.id))?.label).toBe('saved elsewhere');
  });

  it('refuses a save with no If-Match at all with 428, and writes nothing — the guard is required', async () => {
    const response = await call(
      'PUT',
      `/api/designs/${REAL.id}`,
      { ...structuredClone(REAL), label: 'no version sent' },
      {},
    );
    expect(response.status).toBe(428);
    expect((response.body as ApiError).issues?.[0]?.code).toBe('if-match-required');
    expect((response.body as ApiError).hint).toContain('Nothing was written');
    expect((await store.read(REAL.id))?.label).toBe(REAL.label);
  });

  it('refuses a rename with no If-Match (428), and a stale one (409)', async () => {
    expect((await call('POST', `/api/designs/${REAL.id}/rename`, { newId: 'renamed-blind' }, {})).status).toBe(428);
    const etag = (await call('GET', `/api/designs/${REAL.id}`)).headers?.['ETag'] as string;
    expect((await call('PUT', `/api/designs/${REAL.id}`, { ...structuredClone(REAL), label: 'moved on' })).status).toBe(200);
    expect((await call('POST', `/api/designs/${REAL.id}/rename`, { newId: 'renamed-stale' }, { 'if-match': etag })).status).toBe(409);
    expect(store.has('renamed-stale' as never)).toBe(false);
  });

  it('accepts If-Match: * as an explicit "overwrite whatever is there"', async () => {
    expect((await call('PUT', `/api/designs/${REAL.id}`, { ...structuredClone(REAL), label: 'forced' }, { 'if-match': '*' })).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * Create / duplicate / rename / delete
 * ------------------------------------------------------------------ */

describe('POST /api/designs', () => {
  it('creates a new design', async () => {
    const fresh = { ...BLANK, id: 'brand-new-cable', label: 'Brand new' };
    const response = await call('POST', '/api/designs', fresh);
    expect(response.status).toBe(201);
    expect((await store.read('brand-new-cable'))?.label).toBe('Brand new');
  });

  it('refuses to overwrite an existing design', async () => {
    const response = await call('POST', '/api/designs', { ...BLANK, id: REAL.id });
    expect(response.status).toBe(409);
    expect((response.body as ApiError).hint).toContain(REAL.id);
    expect((await store.read(REAL.id))?.label).toBe(REAL.label);
  });

  it('validates before it writes', async () => {
    const broken = { ...structuredClone(BLANK), id: 'broken-new' };
    broken.instances.pcbas.push({ id: 'u1', def: 'no-such-board' });
    expect((await call('POST', '/api/designs', broken)).status).toBe(422);
    expect(store.has('broken-new')).toBe(false);
  });
});

describe('POST /api/designs/:id/duplicate', () => {
  it('copies the design under a new id and records where the copy came from', async () => {
    const response = await call('POST', `/api/designs/${REAL.id}/duplicate`, {
      newId: 'rs485-experiment',
      newLabel: 'RS-485 experiment',
    });
    expect(response.status).toBe(201);
    const copy = await store.read('rs485-experiment');
    expect(copy?.label).toBe('RS-485 experiment');
    expect(copy?.joints).toEqual(REAL.joints);
    expect(copy?.src).toContain(`duplicated from design '${REAL.id}'`);
    // the original is untouched
    expect((await store.read(REAL.id))?.label).toBe(REAL.label);
  });

  it('names the copy for the user when they did not', async () => {
    await call('POST', '/api/designs/test-blank/duplicate', { newId: 'test-blank-copy' });
    expect((await store.read('test-blank-copy'))?.label).toBe('A blank design (copy)');
  });

  it('will not copy a design that is not there', async () => {
    expect((await call('POST', '/api/designs/ghost-cable/duplicate', { newId: 'x-copy' })).status).toBe(404);
  });

  it('will not copy onto an id already in use', async () => {
    const response = await call('POST', '/api/designs/test-blank/duplicate', { newId: REAL.id });
    expect(response.status).toBe(409);
  });

  it('refuses an unusable new id and says what a usable one looks like', async () => {
    const response = await call('POST', '/api/designs/test-blank/duplicate', { newId: 'Not A Slug' });
    expect(response.status).toBe(400);
    expect((response.body as ApiError).hint).toContain('lowercase words joined by hyphens');
  });
});

describe('POST /api/designs/:id/rename', () => {
  it('writes the new file and removes the old one', async () => {
    const response = await call('POST', '/api/designs/test-blank/rename', {
      newId: 'test-renamed',
      newLabel: 'Renamed design',
    });
    expect(response.status).toBe(200);
    expect(store.has('test-blank')).toBe(false);
    expect(await store.read('test-renamed')).toMatchObject({ id: 'test-renamed', label: 'Renamed design' });
  });

  it('can change only the label, leaving the id alone', async () => {
    const response = await call('POST', '/api/designs/test-blank/rename', {
      newId: 'test-blank',
      newLabel: 'Same id, better name',
    });
    expect(response.status).toBe(200);
    expect((await store.read('test-blank'))?.label).toBe('Same id, better name');
  });

  it('will not rename onto an id already in use', async () => {
    const response = await call('POST', '/api/designs/test-blank/rename', { newId: REAL.id });
    expect(response.status).toBe(409);
    expect(store.has('test-blank')).toBe(true);
    expect((await store.read(REAL.id))?.label).toBe(REAL.label);
  });

  it('will not rename a design that is not there', async () => {
    expect((await call('POST', '/api/designs/ghost-cable/rename', { newId: 'x-new' })).status).toBe(404);
  });
});

describe('DELETE /api/designs/:id', () => {
  it('refuses without the confirm token and keeps the design', async () => {
    const response = await call('DELETE', '/api/designs/test-blank');
    expect(response.status).toBe(400);
    expect((response.body as ApiError).error).toContain('has to be confirmed');
    expect(store.has('test-blank')).toBe(true);
  });

  it('refuses a confirm token for a different design', async () => {
    const response = await call('DELETE', '/api/designs/test-blank', { confirm: REAL.id });
    expect(response.status).toBe(400);
    expect(store.has('test-blank')).toBe(true);
  });

  it('deletes once the id is confirmed', async () => {
    const response = await call('DELETE', '/api/designs/test-blank', { confirm: 'test-blank' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 'test-blank' });
    expect(store.has('test-blank')).toBe(false);
  });

  it('says so when there is nothing to delete', async () => {
    expect((await call('DELETE', '/api/designs/ghost-cable', { confirm: 'ghost-cable' })).status).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * Path safety
 * ------------------------------------------------------------------ */

describe('ids are slugs, never paths', () => {
  const evil = [
    '../../../etc/passwd',
    '..',
    '.',
    'designs/../../secret',
    'test-blank.json',
    'Test-Blank',
    'test blank',
    'test%2Fblank',
    '%2e%2e%2f%2e%2e%2fetc',
    'test\\blank',
    'a'.repeat(200),
  ];

  it('refuses every one of them, on every endpoint that names a design', async () => {
    for (const id of evil) {
      const encoded = encodeURIComponent(id);
      for (const [method, path, body] of [
        ['GET', `/api/designs/${encoded}`, undefined],
        ['PUT', `/api/designs/${encoded}`, BLANK],
        ['DELETE', `/api/designs/${encoded}`, { confirm: id }],
        ['POST', `/api/designs/${encoded}/duplicate`, { newId: 'safe-copy' }],
        ['POST', `/api/designs/${encoded}/rename`, { newId: 'safe-name' }],
      ] as [string, string, unknown][]) {
        const response = await call(method, path, body);
        expect(response.status, `${method} ${path}`).toBe(400);
      }
      // and as the *target* of a move, where it would become a new file
      expect((await call('POST', '/api/designs/test-blank/duplicate', { newId: id })).status).toBe(400);
      expect((await call('POST', '/api/designs/test-blank/rename', { newId: id })).status).toBe(400);
      expect((await call('POST', '/api/designs', { ...BLANK, id })).status).toBe(400);
    }
    // nothing above created or destroyed anything
    expect([...store.files.keys()].sort()).toEqual([REAL.id, 'test-blank'].sort());
  });

});

/* ------------------------------------------------------------------ *
 * Router manners
 * ------------------------------------------------------------------ */

describe('the router', () => {
  it('lists its own routes at /api', async () => {
    const response = await call('GET', '/api');
    expect(response.status).toBe(200);
    expect(response.body.routes.length).toBeGreaterThan(0);
  });

  it('says which methods an address answers', async () => {
    const response = await call('PATCH', '/api/designs/test-blank');
    expect(response.status).toBe(405);
    expect((response.body as ApiError).hint).toContain('GET');
  });

  it('points a wrong address at the real ones', async () => {
    const response = await call('GET', '/api/cables');
    expect(response.status).toBe(404);
    expect((response.body as ApiError).hint).toContain('/api/designs');
  });

  it('ignores a query string', async () => {
    expect((await call('GET', '/api/designs?t=1')).status).toBe(200);
  });
});

describe('the structural gate', () => {
  it('refuses things that are not designs at all, in plain words', async () => {
    for (const value of [null, 'a string', 42, [], { schemaVersion: 2 }]) {
      const result = readDesignBody(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.response.body as ApiError).error.length).toBeGreaterThan(0);
        expect((result.response.body as ApiError).hint).toBeDefined();
      }
    }
  });

  it('accepts a real catalog design unchanged', async () => {
    const result = readDesignBody(structuredClone(REAL));
    expect(result.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The real store, read-only
 * ------------------------------------------------------------------ */

describe('the filesystem store', () => {
  const real = fileDesignStore();

  it('lists exactly what the catalog directory holds', async () => {
    expect((await real.list()).map((d) => d.id)).toEqual(listDesignIds());
  });

  it('reads a design and knows what it does not have', async () => {
    expect((await real.read(REAL.id))?.label).toBe(REAL.label);
    expect(real.has('no-such-cable')).toBe(false);
    expect(await real.read('no-such-cable')).toBeUndefined();
  });

  it('formats a design the way the committed files are formatted', async () => {
    const text = formatDesignJson(BLANK);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "id": "test-blank"');
    expect(JSON.parse(text)).toEqual(BLANK);
  });
});
