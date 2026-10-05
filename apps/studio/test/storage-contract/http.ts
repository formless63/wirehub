/**
 * The write contract over HTTP (SA1): requests sent to a mounted app the way
 * a script sends them — JSON in, JSON (or bytes) out, an `Authorization`
 * header when given — and answered in the router's shape, so a session run
 * through the API compares line for line with one run against the router.
 */

import type { ApiRequest, ApiResponse } from '../../server/api.ts';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function answer(res: Response): Promise<ApiResponse & { bytes?: Uint8Array }> {
  const etag = res.headers.get('etag');
  const type = res.headers.get('content-type') ?? '';
  const headers = etag === null ? undefined : { ETag: etag };
  if (type.includes('application/json')) return { status: res.status, body: await res.json(), ...(headers === undefined ? {} : { headers }) };
  return { status: res.status, body: null, bytes: new Uint8Array(await res.arrayBuffer()), ...(headers === undefined ? {} : { headers }) };
}

export function httpTransport(fetcher: Fetcher, base: string, authorization?: string) {
  const headersOf = (extra: Record<string, string> = {}): Record<string, string> => ({ ...extra, ...(authorization === undefined ? {} : { authorization }) });
  return {
    call: async (request: ApiRequest): Promise<ApiResponse> =>
      answer(
        await fetcher(`${base}${request.path}`, {
          method: request.method,
          headers: headersOf({ ...(request.body === undefined ? {} : { 'content-type': 'application/json' }), ...(request.headers ?? {}) }),
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }),
      ),
    depiction: async (request: { method: string; path: string; json?: unknown }) =>
      answer(
        await fetcher(`${base}${request.path}`, {
          method: request.method,
          headers: headersOf(request.json === undefined ? {} : { 'content-type': 'application/json' }),
          ...(request.json === undefined ? {} : { body: JSON.stringify(request.json) }),
        }),
      ),
  };
}
