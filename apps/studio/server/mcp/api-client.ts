/**
 * The MCP tools' way into WireHub: every tool call is one or more ordinary
 * `/api/*` requests, dispatched in process through the same Hono app, with the
 * caller's own credentials (`Authorization: Bearer cst_…`, or the session
 * cookie). So a tool can do exactly what that person's token may do through
 * the HTTP API — same auth gate, scopes, role, write budget, rate limits,
 * edit locks, If-Match/ETag checks, dry runs, batches and change sets — and
 * nothing more. There is no second permission system here.
 */

export interface ApiAnswer {
  status: number;
  ok: boolean;
  etag?: string;
  contentType: string;
  /** the parsed JSON body; `undefined` for a non-JSON answer */
  body: unknown;
  /** the raw bytes of a non-JSON answer (a document, an image) */
  bytes?: Uint8Array;
}

export interface CallOptions {
  body?: unknown;
  ifMatch?: string;
  /** add `dryRun=1`: the request runs up to the commit, then nothing is written */
  dryRun?: boolean;
}

export type Dispatch = (request: Request) => Response | Promise<Response>;

export interface ApiClient {
  call(method: string, path: string, options?: CallOptions): Promise<ApiAnswer>;
}

/** Credentials that travel from the MCP request to its tools' requests: nothing else does. */
const FORWARDED = ['authorization', 'cookie'] as const;

export function inProcessClient(dispatch: Dispatch, incoming: Request): ApiClient {
  const origin = new URL(incoming.url).origin;
  const credentials: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = incoming.headers.get(name);
    if (value !== null) credentials[name] = value;
  }
  return {
    async call(method, path, options = {}) {
      const url = new URL(path, origin);
      if (options.dryRun === true) url.searchParams.set('dryRun', '1');
      const headers: Record<string, string> = { ...credentials, accept: 'application/json' };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
      const response = await dispatch(
        new Request(url, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }),
      );
      const contentType = response.headers.get('content-type') ?? '';
      const etag = response.headers.get('etag') ?? undefined;
      const base = { status: response.status, ok: response.status < 400, contentType, ...(etag === undefined ? {} : { etag }) };
      if (contentType.includes('json')) return { ...base, body: await response.json().catch(() => undefined) };
      return { ...base, body: undefined, bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}
