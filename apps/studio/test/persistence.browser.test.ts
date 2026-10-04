/**
 * `workbenchDrawings()`'s stale-write guard, client side (
 * drawing-form fix): the remembered `ETag` that gets sent back as `If-Match`,
 * and `noteTag` — the escape hatch a caller who knows a *different* request
 * just rewrote this design's drawing (a version save) uses to keep that
 * remembered tag current, so this form's own next save does not find out only
 * as a 409.
 *
 * `fetch` is stubbed directly (real `Response` objects — Node's own, not a
 * mock) rather than driving the actual workbench API: this is the adapter's
 * own bookkeeping, not the server's refusal, which `versions.server.test.ts`
 * and `drawings.server.test.ts` already cover.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { workbenchDrawings } from '../src/persistence.browser.ts';

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.etag === undefined ? {} : { etag: init.etag },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the drawing sidecar adapter\'s remembered ETag', () => {
  it('sends back the tag a GET (or a save) last saw, as If-Match', async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({ input, init });
        return jsonResponse({ meta: { partNumber: 'CBL-1' } }, { etag: '"v1"' });
      }),
    );
    const drawings = workbenchDrawings();

    await drawings.load('db9-null-modem');
    await drawings.save('db9-null-modem', { partNumber: 'CBL-2' });

    const saveCall = calls[1];
    expect(saveCall).toBeDefined();
    expect((saveCall!.init?.headers as Record<string, string>)['if-match']).toBe('"v1"');
  });

  it('noteTag primes the guard from a tag another request already knows — the version-save case', async () => {
    const calls: { init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init?: RequestInit) => {
        calls.push({ init });
        return jsonResponse({ meta: { partNumber: 'CBL-1', revision: '0' } }, { etag: '"v2"' });
      }),
    );
    const drawings = workbenchDrawings();

    // this form never loaded or saved the drawing itself — a version save
    // rewrote it and handed this adapter the fresh tag directly (`server/
    // versions.ts`'s `drawingTag`, applied in `VersionsPanel.onSave`)
    drawings.noteTag('db9-null-modem', '"v2"');
    await drawings.save('db9-null-modem', { partNumber: 'CBL-2' });

    expect((calls[0]!.init?.headers as Record<string, string>)['if-match']).toBe('"v2"');
  });

  it('a later noteTag replaces an earlier remembered tag', async () => {
    const calls: { init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init?: RequestInit) => {
        calls.push({ init });
        return jsonResponse({ meta: {} }, { etag: '"stale-would-be"' });
      }),
    );
    const drawings = workbenchDrawings();

    await drawings.load('db9-null-modem'); // remembers "stale-would-be"
    drawings.noteTag('db9-null-modem', '"fresh"'); // a version save moved it on
    await drawings.save('db9-null-modem', { partNumber: 'CBL-2' });

    expect((calls[1]!.init?.headers as Record<string, string>)['if-match']).toBe('"fresh"');
  });
});
