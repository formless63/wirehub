/**
 * The studio's adapter, wired straight to the studio's API.
 *
 * `workbenchPersistence` is the browser half and `handleWorkbenchRequest` is
 * the server half; the only thing between them in the real app is a socket.
 * Here `fetch` is replaced by a function that calls the router directly, which
 * tests the two halves as the pair they are: the URLs the adapter builds, the
 * bodies it sends, and — the part a unit test of either half alone would miss
 * — that a refusal arrives on the other side as a message, a hint, and the
 * issue list the GUI renders in plain language.
 */

import { loadDb, loadDesign } from '@cable-studio/catalog';
import type { CableDesign, Db } from '@cable-studio/model';
import type { PersistenceAdapter } from '@cable-studio/editor-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { cableListEntry } from '../src/cable-list.ts';
import { workbenchPersistence } from '../src/persistence.browser.ts';

const db: Db = loadDb();
const REAL: CableDesign = loadDesign('rs485-de9-terminal-board');

let files: Map<string, string>;
const realFetch = globalThis.fetch;

/** The whole transport, replaced by a function call. */
function serve(): void {
  const store: DesignStore = {
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
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
  const deps: WorkbenchDeps = { designs: store, loadDb: () => db };

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const requestHeaders = new Headers(init?.headers);
    const ifMatch = requestHeaders.get('if-match');
    const response = await handleWorkbenchRequest(
      {
        method: init?.method ?? 'GET',
        path,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
        ...(ifMatch === null ? {} : { headers: { 'if-match': ifMatch } }),
      },
      deps,
    );
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  }) as typeof fetch;
}

let adapter: PersistenceAdapter;

beforeEach(async () => {
  files = new Map([[REAL.id, formatDesignJson(REAL)]]);
  serve();
  // fresh per test: the adapter remembers an ETag per id
  // across calls, and a shared instance would leak a
  // version learned in one test into the next test's freshly-reset `files`
  adapter = workbenchPersistence();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
});

describe('the studio adapter over the studio API', () => {
  it('lists and loads', async () => {
    const listed = await adapter.list();
    // the adapter's own type is `DesignSummary[]` (id+label — the whole
    // contract editor-react's pickers need), but the wire bytes are the
    // richer `/cables` row — the same
    // `GET /api/designs` response `fetchCableList` reads too
    expect(listed).toEqual({ ok: true, value: [cableListEntry(REAL, db)] });

    const loaded = await adapter.load(REAL.id);
    expect(loaded.ok && loaded.value.id).toBe(REAL.id);
  });

  it('saves, and the stored bytes carry the catalog formatting', async () => {
    await adapter.load(REAL.id);
    const result = await adapter.save({ ...structuredClone(REAL), label: 'edited' });
    expect(result.ok).toBe(true);
    expect(files.get(REAL.id)?.endsWith('}\n')).toBe(true);
    expect(files.get(REAL.id)).toContain('\n  "label": "edited"');
  });

  it('carries a refusal across as words and an issue list', async () => {
    const broken = structuredClone(REAL);
    broken.instances.pcbas.push({ id: 'u9', def: 'no-such-board' });

    await adapter.load(REAL.id);
    const result = await adapter.save(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(REAL.id);
    expect(result.hint).toContain('Nothing was written');
    expect(result.issues?.some((issue) => issue.code === 'unknown-def')).toBe(true);
  });

  it('creates, duplicates, renames and deletes through the right addresses', async () => {
    const created = await adapter.create({
      schemaVersion: 1,
      id: 'adapter-scratch',
      label: 'Adapter scratch',
      instances: { connectors: [], segments: [], components: [], pcbas: [] },
      joints: [],
      src: 'test fixture',
    });
    expect(created.ok).toBe(true);

    expect((await adapter.duplicate('adapter-scratch', 'adapter-copy', 'A copy')).ok).toBe(true);
    expect((await adapter.rename('adapter-copy', 'adapter-final', 'Final')).ok).toBe(true);
    expect(files.has('adapter-copy')).toBe(false);

    const removed = await adapter.remove('adapter-final', 'adapter-final');
    expect(removed).toEqual({ ok: true, value: { id: 'adapter-final' } });
    expect(files.has('adapter-final')).toBe(false);
  });

  it('will not delete without the confirmation the host asks for', async () => {
    const result = await adapter.remove(REAL.id, 'not-the-id');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toContain('Nothing was deleted');
    expect(files.has(REAL.id)).toBe(true);
  });

  it('says the workbench is unreachable, and how to start it', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const result = await adapter.list();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('could not reach the workbench');
    expect(result.hint).toContain('dev');
  });
});

/* ------------------------------------------------------------------ *
 * The stale-write guard:
 * the adapter remembers the version a `load` (or a prior `save`) answered
 * with, and sends it back as `If-Match`. A save that would silently overwrite
 * a change made elsewhere comes back 409, nothing written, and marked with
 * `issues[0].code === 'stale-write'` so `studio-context.tsx` can tell it apart
 * from a validator refusal without parsing English.
 * ------------------------------------------------------------------ */

describe('the stale-write guard', () => {
  it('sends the version it loaded back as If-Match, and a stale save is refused with 409', async () => {
    const loaded = await adapter.load(REAL.id);
    expect(loaded.ok).toBe(true);

    // someone else (another tab, the other owner) saves first
    files.set(REAL.id, formatDesignJson({ ...structuredClone(REAL), label: 'saved elsewhere' }));

    const result = await adapter.save({ ...structuredClone(REAL), label: 'my edit' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues?.some((issue) => issue.code === 'stale-write')).toBe(true);
    // nothing was written over the other save
    expect((JSON.parse(files.get(REAL.id) as string) as CableDesign).label).toBe('saved elsewhere');
  });

  it('succeeds when nothing changed since load, and the id stays writable afterwards', async () => {
    await adapter.load(REAL.id);
    const result = await adapter.save({ ...structuredClone(REAL), label: 'fresh edit' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.label).toBe('fresh edit');

    // the version just written is now the one remembered — a second save in a
    // row (no reload in between) is still "the version I have" and succeeds
    const again = await adapter.save({ ...result.value, label: 'fresh edit, again' });
    expect(again.ok).toBe(true);
  });

  it('refuses a save the adapter never loaded a version for (428) — nothing to overwrite blind', async () => {
    // a copy that did not come from the workbench (the bundle, a script)
    // cannot say what it would overwrite
    const result = await adapter.save({ ...structuredClone(REAL), label: 'never loaded' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(428);
    expect(result.issues?.[0]?.code).toBe('if-match-required');
    expect(files.get(REAL.id)).not.toContain('never loaded');
  });
});
