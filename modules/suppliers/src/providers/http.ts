import type { ProviderContext } from '../types.ts';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Messages are fixed here: upstream bodies, URLs and credentials never become job errors. */
export class SupplierHttpError extends Error {
  constructor(message: string) { super(message); this.name = 'SupplierHttpError'; }
}

/** Bounded transport for supplier JSON and OAuth responses; never follows redirects. */
export async function jsonRequest(url: string | URL, init: RequestInit, context: ProviderContext): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new SupplierHttpError('Supplier request timed out.')); }, TIMEOUT_MS);
  });
  const read = async (): Promise<unknown> => {
    const response = await context.fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new SupplierHttpError('Supplier redirect refused.');
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = retry !== null && /^\d{1,4}$/.test(retry) ? Number(retry) : undefined;
      throw new SupplierHttpError(seconds !== undefined && seconds <= 3600
        ? `Supplier rate limit reached; retry after ${seconds} seconds.` : 'Supplier rate limit reached; retry later.');
    }
    if (!response.ok) throw new SupplierHttpError('Supplier request failed.');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > MAX_BYTES) throw new SupplierHttpError('Supplier response is too large.');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new SupplierHttpError('Supplier response is invalid.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new SupplierHttpError('Supplier response is too large.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new SupplierHttpError('Supplier response is invalid.'); }
  };
  try { return await Promise.race([read(), timeout]); }
  catch (error) {
    controller.abort();
    if (error instanceof SupplierHttpError) throw error;
    throw new SupplierHttpError('Supplier request failed.');
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
