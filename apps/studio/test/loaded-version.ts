/**
 * Test helper: the If-Match an editor would send. Every write that edits an
 * existing record must quote the version it was made from (the guard is
 * required — `server/etag.ts`); a test that is not about the guard stands in
 * for "an editor that loaded it just now" by reading the version first.
 *
 * A request that already carries `headers` is left alone, so a test can send
 * `{}` (no If-Match) or a stale tag on purpose.
 */

import { handleWorkbenchRequest, type ApiRequest, type WorkbenchDeps } from '../server/api.ts';

/** The GET whose ETag versions the record `request` edits, if it edits one. */
function versionPath(request: ApiRequest): string | undefined {
  const method = request.method.toUpperCase();
  const path = request.path.split('?')[0] ?? '';
  let m: RegExpExecArray | null;
  if ((m = /^(\/api\/designs\/[^/]+)$/.exec(path)) !== null && method === 'PUT') return m[1];
  if ((m = /^(\/api\/designs\/[^/]+)\/rename$/.exec(path)) !== null && method === 'POST') return m[1];
  if ((m = /^(\/api\/drawings\/[^/]+)(\/photo)?$/.exec(path)) !== null && method === 'PUT') return m[1];
  if ((m = /^(\/api\/definitions\/[^/]+\/[^/]+)$/.exec(path)) !== null && method === 'PUT') return m[1];
  if ((m = /^(\/api\/vocab\/[^/]+)\/[^/]+$/.exec(path)) !== null && method === 'PATCH') return m[1];
  if ((m = /^(\/api\/builds\/[^/]+)$/.exec(path)) !== null && method === 'PUT') return m[1];
  if (/^\/api\/wire-library\/stocks\/[^/]+$/.test(path) && method === 'PUT') {
    const create = (request.body as { create?: unknown } | undefined)?.create === true;
    return create ? undefined : '/api/wire-library';
  }
  return undefined;
}

export async function withLoadedVersion(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiRequest> {
  if (request.headers !== undefined) return request;
  const from = versionPath(request);
  if (from === undefined) return request;
  const etag = (await handleWorkbenchRequest({ method: 'GET', path: from }, deps)).headers?.['ETag'];
  return etag === undefined ? request : { ...request, headers: { 'if-match': etag } };
}
