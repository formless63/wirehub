/**
 * The vocab and tag endpoints (data model v2 §5).
 *
 * Pure again: the lists are objects, the tag table is rebuilt by the real
 * generator (`buildTags`) from the committed catalog and an in-memory review
 * file — so "a tag set in the Library comes back out of the generator" is
 * tested end to end without touching a file.
 */

import { loadConnectors, loadDb, loadDesigns, loadPcbas, loadVocab, loadWires } from '@cable-studio/catalog';
import { buildTags, type TagReview } from '@cable-studio/catalog/src/tags/build.ts';
import type { Db, SignalTags, VocabList } from '@cable-studio/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { DefinitionKind, DefinitionRecord, DefinitionStore } from '../server/definition-store.ts';
import type { DesignStore } from '../server/designs.ts';
import { LIBRARY_TAG_WHY, vocabIdOf } from '../server/vocab.ts';
import type { TagStore, VocabStore } from '../server/vocab-store.ts';

const VOCAB = loadVocab();
const DB = loadDb();
const INPUTS = {
  vocab: VOCAB,
  connectors: loadConnectors(),
  pcbas: loadPcbas(),
  wires: loadWires(),
  designs: loadDesigns(),
};
const EMPTY_REVIEW: TagReview = { src: 'test', connectors: {}, pcbas: {}, wires: {}, slots: {} };

function memoryVocab(): VocabStore & { lists: Map<string, VocabList>; writes: number } {
  const lists = new Map(Object.entries(structuredClone(VOCAB)));
  const store = {
    lists,
    writes: 0,
    ids: () => [...lists.keys()].sort(),
    read: (id: string) => structuredClone(lists.get(id)),
    write: (list: VocabList) => {
      store.writes += 1;
      lists.set(list.id, structuredClone(list));
    },
  };
  return store;
}

function memoryTags(): TagStore & { reviewed: TagReview; regenerations: number } {
  let table: SignalTags = buildTags({ ...INPUTS, review: EMPTY_REVIEW }).tags;
  const store = {
    reviewed: structuredClone(EMPTY_REVIEW),
    regenerations: 0,
    tags: () => structuredClone(table),
    review: () => structuredClone(store.reviewed),
    writeReview: (review: TagReview) => {
      store.reviewed = structuredClone(review);
    },
    preview: (review: TagReview) => buildTags({ ...INPUTS, review }).tags,
    regenerate: () => {
      store.regenerations += 1;
      table = buildTags({ ...INPUTS, review: store.reviewed }).tags;
      return true;
    },
  };
  return store;
}

const noDesigns: DesignStore = {
  list: () => [],
  has: () => false,
  read: () => undefined,
  write: () => ({ changed: false }),
  remove: () => undefined,
};

let vocab: ReturnType<typeof memoryVocab>;
let tags: ReturnType<typeof memoryTags>;
let deps: WorkbenchDeps;

beforeEach(async () => {
  vocab = memoryVocab();
  tags = memoryTags();
  deps = {
    designs: noDesigns,
    vocab,
    tags,
    loadDb: (): Db => ({ ...DB, vocab: Object.fromEntries(vocab.lists), tags: tags.tags() as SignalTags }),
  };
});

/**
 * One request. An edit of an existing record (PATCH an entry, PUT a
 * definition) quotes the version on disk as If-Match unless `headers` is
 * given — the guard is required; `{}` sends none.
 */
async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  const entry = /^(\/api\/vocab\/[^/]+)\/[^/]+$/.exec(path);
  const versionOf = method === 'PATCH' && entry !== null ? entry[1] : method === 'PUT' && path.startsWith('/api/definitions/') ? path : undefined;
  if (headers === undefined && versionOf !== undefined) {
    const etag = (await handleWorkbenchRequest({ method: 'GET', path: versionOf as string }, deps)).headers?.['ETag'];
    if (etag !== undefined) headers = { 'if-match': etag };
  }
  return await handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) }, deps);
}

describe('GET /api/vocab', () => {
  it('lists every list with its size', async () => {
    const response = await call('GET', '/api/vocab');
    expect(response.status).toBe(200);
    const ids = response.body.lists.map((list: { id: string }) => list.id);
    expect(ids).toContain('signals');
    expect(ids).toContain('pad-roles');
    expect(response.body.lists.find((l: { id: string }) => l.id === 'families').count).toBe(VOCAB['families']?.entries.length);
  });

  it('answers one list, and 404 for a list that is not there', async () => {
    expect((await call('GET', '/api/vocab/genders')).body.entries.map((e: { id: string }) => e.id)).toEqual(['male', 'female']);
    expect((await call('GET', '/api/vocab/nope')).status).toBe(404);
  });
});

describe('POST /api/vocab/:list — append-only, src required', () => {
  it('appends a new family, deriving the id from the label', async () => {
    const response = await call('POST', '/api/vocab/families', { label: 'S-Video', src: 'bench, 2026-09-24' });
    expect(response.status).toBe(201);
    expect(response.body.entry).toEqual({ id: 's-video', label: 'S-Video', src: 'bench, 2026-09-24' });
    const list = vocab.lists.get('families');
    expect(list?.entries.at(-1)?.id).toBe('s-video');
    expect(list?.entries.length).toBe((VOCAB['families']?.entries.length ?? 0) + 1);
  });

  it('writes a signal in the committed key order, kind included', async () => {
    const response = await call('POST', '/api/vocab/signals', { label: 'Composite sync out', kind: 'sync', src: 'ground-truth §5' });
    expect(response.status).toBe(201);
    expect(Object.keys(response.body.entry)).toEqual(['id', 'label', 'kind', 'src']);
    expect(response.body.entry.id).toBe('composite-sync-out');
  });

  it('refuses an entry with no source, and writes nothing', async () => {
    const response = await call('POST', '/api/vocab/families', { label: 'S-Video' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/where it comes from/);
    expect(vocab.writes).toBe(0);
  });

  it('refuses a signal with no kind', async () => {
    expect((await call('POST', '/api/vocab/signals', { label: 'Mystery', src: 'x' })).status).toBe(400);
  });

  it('adds accepted entries only — `pending` is owner question Q8 (b), not in use', async () => {
    const response = await call('POST', '/api/vocab/families', { label: 'S-Video', src: 'x', pending: true });
    expect(response.status).toBe(400);
  });

  it('refuses a pad role whose lane is not a lane', async () => {
    const response = await call('POST', '/api/vocab/pad-roles', { label: 'Mystery pad', lane: 'nowhere', src: 'x' });
    expect(response.status).toBe(422);
    expect(response.body.issues[0].code).toBe('vocab-unknown');
  });
});

describe('PATCH /api/vocab/:list/:entry — renames via alias', () => {

  it('refuses an entry edit with no If-Match (428), and a stale one (409)', async () => {
    expect((await call('PATCH', '/api/vocab/families/multi-out', { label: 'Blind' }, {})).status).toBe(428);
    expect((await call('PATCH', '/api/vocab/families/multi-out', { label: 'Stale' }, { 'if-match': '"nope"' })).status).toBe(409);
  });

});



describe('vocabIdOf', () => {
  it('spells the catalog symbols out', async () => {
    expect(vocabIdOf('75 Ω sync')).toBe('75-ohm-sync');
    expect(vocabIdOf('220 µF')).toBe('220-uf');
    expect(vocabIdOf('  Video R pad ')).toBe('video-r-pad');
  });
});
