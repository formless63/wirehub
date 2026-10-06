/** Index downloads use independent streaming limits before parsing or signature checks. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchVerifiedIndex, MAX_STORE_INDEX_BYTES, MAX_STORE_SIGNATURE_BYTES } from '../server/store.ts';
import { createTestStore, STORE_URL, type TestStore } from './store-fixture.ts';

describe('store index download limits', () => {
  let store: TestStore;
  beforeAll(() => { store = createTestStore(); store.publish('alpha', '1.0.0', '10'); });
  afterAll(() => store?.close());

  for (const declared of [undefined, '1']) {
    it(`stops a streamed oversized index with ${declared === undefined ? 'no' : 'misleading'} Content-Length`, async () => {
      let cancelled = false;
      let pulls = 0;
      let fetches = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(256 * 1024)); },
        cancel() { cancelled = true; },
      });
      const options = { ...store.fetch, fetch: (async () => { fetches += 1; return new Response(body, { headers: declared === undefined ? {} : { 'content-length': declared } }); }) as typeof fetch };
      await expect(fetchVerifiedIndex({ url: STORE_URL, publicKey: store.publicKey }, options)).rejects.toMatchObject({ status: 413 });
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThanOrEqual(MAX_STORE_INDEX_BYTES / (256 * 1024) + 2);
      expect(fetches).toBe(1); // no signature is fetched for an oversized index
    });
  }

  it('caps the signature separately and retains tighter caller limits', async () => {
    const real = store.fetch.fetch!;
    const options = { ...store.fetch, maxBytes: MAX_STORE_INDEX_BYTES * 2, fetch: (async (input, init) => String(input).endsWith('.minisig') ? new Response(new Uint8Array(MAX_STORE_SIGNATURE_BYTES + 1)) : real(input, init)) as typeof fetch };
    await expect(fetchVerifiedIndex({ url: STORE_URL, publicKey: store.publicKey }, options)).rejects.toMatchObject({ status: 413 });
    await expect(fetchVerifiedIndex({ url: STORE_URL, publicKey: store.publicKey }, { ...store.fetch, maxBytes: 10 })).rejects.toMatchObject({ status: 413 });
  });

  it('keeps the download timeout active', async () => {
    const options = { ...store.fetch, timeoutMs: 20, fetch: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch };
    await expect(fetchVerifiedIndex({ url: STORE_URL, publicKey: store.publicKey }, options)).rejects.toThrow(/took too long/);
  });

  it('reports an interrupted index stream and still verifies normal signatures', async () => {
    const options = { ...store.fetch, fetch: (async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken')); } }))) as typeof fetch };
    await expect(fetchVerifiedIndex({ url: STORE_URL, publicKey: store.publicKey }, options)).rejects.toThrow(/interrupted/);
    await expect(fetchVerifiedIndex({ url: STORE_URL, publicKey: store.publicKey }, store.fetch)).resolves.toMatchObject({ packs: [{ id: 'alpha' }] });
    await expect(fetchVerifiedIndex({ url: STORE_URL, publicKey: store.otherPublicKey }, store.fetch)).rejects.toThrow(/refused/);
  });
});
