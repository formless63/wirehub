/**
 * The write rails every host applies before a request reaches the API
 * (review fix, 2026-09-26) — one module, so the Vite dev host (`plugin.ts`,
 * `depictions.ts`) and the standalone Hono host (`hono-adapter.ts`) cannot
 * disagree:
 *
 * - **Body size.** JSON documents up to 4 MB, artwork uploads up to 24 MB;
 *   anything larger is answered 413 without being parsed.
 * - **Cross-site writes are refused.** A write whose `Sec-Fetch-Site` is
 *   anything but `same-origin`/`none`, or (for a client that sends no
 *   `Sec-Fetch-Site`) whose `Origin` names another host, gets 403. A request
 *   with neither header (curl, a script) is allowed.
 * - **Writes are JSON.** A write that carries a body must say
 *   `Content-Type: application/json` (an upload may also be
 *   `multipart/form-data`) — `text/plain`, the type a cross-site `<form>` or
 *   "simple" fetch can send, gets 415.
 */

/** Bodies are small documents, not uploads; anything larger is a mistake. */
export const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
/** Artwork is bigger than a design document, and still not an unbounded pipe. */
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

export interface GuardRefusal {
  status: number;
  body: { error: string; hint: string };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isWriteMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export interface WriteHeaders {
  method: string;
  origin?: string | undefined;
  secFetchSite?: string | undefined;
  /** the `Host` the request was sent to (or `X-Forwarded-Host` behind a proxy) */
  host?: string | undefined;
}

/** 403 for a cross-site write; `undefined` when the request may go on. */
export function crossSiteRefusal(headers: WriteHeaders): GuardRefusal | undefined {
  if (!isWriteMethod(headers.method)) return undefined;
  const refuse = (): GuardRefusal => ({
    status: 403,
    body: {
      error: 'WireHub only accepts changes from its own pages.',
      hint: 'Nothing was changed. This request came from another site.',
    },
  });
  const site = headers.secFetchSite?.trim().toLowerCase();
  if (site !== undefined && site !== '') return site === 'same-origin' || site === 'none' ? undefined : refuse();
  const origin = headers.origin?.trim();
  if (origin === undefined || origin === '') return undefined;
  if (origin === 'null') return refuse();
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return refuse();
  }
  const host = headers.host?.split(',')[0]?.trim().toLowerCase();
  return host !== undefined && host !== '' && originHost === host ? undefined : refuse();
}

/** 415 for a write body that is not JSON (or, for an upload, multipart). */
export function contentTypeRefusal(method: string, contentType: string | undefined, upload: boolean): GuardRefusal | undefined {
  if (!isWriteMethod(method)) return undefined;
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const allowed = upload ? ['application/json', 'multipart/form-data'] : ['application/json'];
  if (allowed.includes(type)) return undefined;
  return {
    status: 415,
    body: {
      error: `WireHub does not accept ${type === '' ? 'a body with no type' : `'${type}'`} here.`,
      hint: `Nothing was changed. Send it as ${allowed.join(' or ')}.`,
    },
  };
}

export function tooLargeRefusal(limit: number): GuardRefusal {
  return {
    status: 413,
    body: {
      error: `That is larger than WireHub accepts (${Math.round(limit / (1024 * 1024))} MB).`,
      hint: 'Nothing was changed.',
    },
  };
}

/**
 * A Fetch `Request`'s body, read up to `limit` bytes: the declared
 * `Content-Length` is checked first, then the stream is counted as it
 * arrives, so an oversized body is never held whole.
 */
export async function readLimited(request: Request, limit: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return { ok: false };
  if (request.body === null) return { ok: true, bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}
