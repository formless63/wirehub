/**
 * The workbench API mounted on a Hono app — the standalone host's thin
 * adapter, the sibling of `plugin.ts`'s Connect middleware.
 *
 * Same split as every other transport in this directory: `handleWorkbenchRequest`
 * (api.ts) and `handleDepictionRequest` (depictions.ts) are pure functions of a
 * plain request object, tested with no server at all. This file's only job is
 * to turn a Hono `Context` into that plain object and turn the answer back into
 * a Fetch `Response` — no rule about validation, ids, or the stale-write guard
 * lives here, so the standalone server and the Vite dev server can never
 * disagree about what `/api/*` does.
 */

import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';

import { handleWorkbenchRequest, transactingDepictionDeps, type WorkbenchDeps } from './api.ts';
import { streamSSE } from 'hono/streaming';
import type { StudioEvent } from './events.ts';
import { signedInUser } from './auth/gate.ts';
import { saveCommitFor, type StudioBackup } from './backup/backup.ts';
import type { StudioUser } from './me.ts';
import { editLockGate, editLockLayer } from './locks/lock-api.ts';
import { LOCK_HEADER } from '../src/locks/records.ts';
import { collectWritesAsync } from './write-journal.ts';
import { defaultWorkbenchDeps } from './default-deps.ts';

/** `/api/modules/…` — a module integration's route (`api.ts` `findModuleRoute`). */
function isModulePath(path: string): boolean {
  return path.startsWith('/api/modules/');
}
import { isModelPath, MAX_MODEL_REQUEST_BYTES } from './models/api.ts';
import { runtimeEnv } from './runtime-settings.ts';
import { importUploadLimit, importUploadRefusal, isImportPath, startImportUpload } from './jobs/api.ts';
import { parseModuleIoPath } from './module-io.ts';
import {
  defaultDepictionDeps,
  handleDepictionRequest,
  isDepictionPath,
  type DepictionDeps,
} from './depictions.ts';
import {
  MAX_JSON_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  contentTypeRefusal,
  crossSiteRefusal,
  readLimited,
  tooLargeRefusal,
} from './request-guard.ts';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // the workbench writes files; a cached answer would show stale work
      'cache-control': 'no-store',
      ...(headers ?? {}),
    },
  });
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Runs one handler. With the backup on, a write runs inside its serial queue
 * and what it wrote is committed as the person who made it;
 * everything else runs as it always did.
 */
async function perform<T extends { status: number; body?: unknown; changes?: string[] }>(
  backup: StudioBackup | undefined,
  request: { method: string; path: string; body?: unknown; user: StudioUser | undefined },
  handler: () => Promise<T>,
): Promise<T> {
  // module routes keep their own write discipline: never queued behind (or holding up) a save
  // — except an importer's accepted proposal, which writes the catalog like any save
  if (backup === undefined || !WRITE_METHODS.has(request.method) || (isModulePath(request.path) && !request.path.includes('/_import/'))) return handler();
  return backup.withSave(
    () => collectWritesAsync(handler),
    (response) =>
      response.status >= 400
        ? undefined
        : saveCommitFor(
            {
              method: request.method,
              path: request.path,
              ...(request.body === undefined ? {} : { body: request.body }),
              ...(response.body === undefined ? {} : { responseBody: response.body }),
              ...(response.changes === undefined ? {} : { changes: response.changes }),
            },
            request.user,
          ),
  );
}

/**
 * The artwork endpoints: bytes in (an upload, `multipart/form-data` or JSON
 * base64), and either JSON or raw image bytes out. Mirrors `depictionMiddleware`
 * in `depictions.ts`, over Hono's Fetch API request instead of a raw socket.
 */
async function handleDepiction(
  method: string,
  path: string,
  contentType: string | undefined,
  request: Request,
  deps: DepictionDeps,
  backup?: StudioBackup,
  workbench?: WorkbenchDeps,
): Promise<Response> {
  // edit locks: artwork belongs to the library record of its id
  const locked = await editLockLayer(
    { method, path, lockHeader: request.headers.get(LOCK_HEADER) ?? undefined, user: signedInUser(request) },
    {
      ...(workbench?.locks === undefined ? {} : { locks: workbench.locks }),
      ...(workbench?.lockClock === undefined ? {} : { clock: workbench.lockClock }),
      ...(workbench?.events === undefined ? {} : { events: workbench.events }),
    },
  );
  if (locked !== undefined) return jsonResponse(locked.status, locked.body);
  let raw: Uint8Array | undefined;
  try {
    const read = await readLimited(request, MAX_UPLOAD_BYTES);
    if (!read.ok) {
      const refusal = tooLargeRefusal(MAX_UPLOAD_BYTES);
      return jsonResponse(refusal.status, refusal.body);
    }
    if (read.bytes.byteLength > 0) {
      const refusal = contentTypeRefusal(method, contentType, true);
      if (refusal !== undefined) return jsonResponse(refusal.status, refusal.body);
      raw = read.bytes;
    }
  } catch (error) {
    return jsonResponse(413, {
      error: 'WireHub could not read that upload.',
      hint: `Nothing was changed. (${(error as Error).message})`,
    });
  }
  try {
    const response = await perform(backup, { method, path, user: signedInUser(request) }, () =>
      handleDepictionRequest(
        {
          method,
          path,
          ...(contentType === undefined ? {} : { contentType }),
          ...(raw === undefined ? {} : { raw }),
        },
        workbench === undefined ? deps : transactingDepictionDeps(deps, workbench, signedInUser(request), new URL(request.url).searchParams.get('dryRun') === '1'),
      ),
    );
    if ('bytes' in response) {
      return new Response(Buffer.from(response.bytes), {
        status: response.status,
        headers: { 'content-type': response.contentType, 'cache-control': 'no-store' },
      });
    }
    return jsonResponse(response.status, response.body);
  } catch (error) {
    return jsonResponse(500, {
      error: 'The server hit an unexpected problem and stopped before changing anything.',
      hint: `Check the terminal running WireHub for details. (${(error as Error).message})`,
    });
  }
}

/** `PUT /api/modules/:module/_import/:importer?fileName=…`: the file's bytes, queued as an import job (`jobs/api.ts`). */
async function handleImportUpload(io: NonNullable<ReturnType<typeof parseModuleIoPath>>, request: Request, deps: WorkbenchDeps, backup?: StudioBackup): Promise<Response> {
  const fileName = new URL(request.url).searchParams.get('fileName');
  // refuse before the body is read: a wrong importer or name never costs the upload
  const early = importUploadRefusal(deps, io, fileName);
  if (early !== undefined) return jsonResponse(early.status, early.body);
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/octet-stream') {
    return jsonResponse(415, { error: `WireHub does not accept ${type === '' || type === undefined ? 'a body with no type' : `'${type}'`} here.`, hint: 'Nothing was changed. Send the file as application/octet-stream.' });
  }
  const limit = importUploadLimit(runtimeEnv(deps));
  let bytes: Uint8Array;
  try {
    const read = await readLimited(request, limit);
    if (!read.ok) {
      const refusal = tooLargeRefusal(limit);
      return jsonResponse(refusal.status, refusal.body);
    }
    bytes = read.bytes;
  } catch (error) {
    return jsonResponse(400, { error: 'WireHub could not read that upload.', hint: `Nothing was changed. (${(error as Error).message})` });
  }
  try {
    const user = signedInUser(request);
    const response = await perform(backup, { method: 'PUT', path: `/api/modules/${io.module}/_import/${io.id}`, user }, () =>
      startImportUpload({ method: 'PUT', path: new URL(request.url).pathname, fileName, bytes, query: new URL(request.url).searchParams, ...(user === undefined ? {} : { user }) }, io, deps),
    );
    return jsonResponse(response.status, response.body, response.headers);
  } catch (error) {
    return jsonResponse(500, { error: 'The server hit an unexpected problem and stopped before changing anything.', hint: `Check the terminal running WireHub for details. (${(error as Error).message})` });
  }
}

/** The JSON half: every `/api/*` route but `/api/depictions/…`. */
async function handleJson(
  method: string,
  path: string,
  request: Request,
  deps: WorkbenchDeps,
  backup?: StudioBackup,
): Promise<Response> {
  let text: string;
  try {
    // a model upload (50a.55) is a base64 file, bigger than any document
    const limit = isModelPath(path) || isImportPath(path) ? MAX_MODEL_REQUEST_BYTES : MAX_JSON_BODY_BYTES;
    const read = await readLimited(request, limit);
    if (!read.ok) {
      const refusal = tooLargeRefusal(limit);
      return jsonResponse(refusal.status, refusal.body);
    }
    text = new TextDecoder().decode(read.bytes);
  } catch (error) {
    return jsonResponse(400, {
      error: 'WireHub could not read what was sent with that request.',
      hint: `Nothing was changed. (${(error as Error).message})`,
    });
  }
  if (text.trim() !== '') {
    const refusal = contentTypeRefusal(method, request.headers.get('content-type') ?? undefined, false);
    if (refusal !== undefined) return jsonResponse(refusal.status, refusal.body);
  }
  let body: unknown;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch (error) {
      return jsonResponse(400, {
        error: 'WireHub could not read what was sent with that request.',
        hint: `Nothing was changed. (${(error as Error).message})`,
      });
    }
  }
  try {
    const ifMatch = request.headers.get('if-match');
    // the login gate (when mounted) recorded who this request is from
    const user = signedInUser(request);
    // edit locks: `/api/locks/*`, and the 423 for a
    // write to a record someone else holds — before the backup's save queue
    const locked = await editLockLayer(
      { method, path, ...(body === undefined ? {} : { body }), lockHeader: request.headers.get(LOCK_HEADER) ?? undefined, user },
      {
        ...(deps.locks === undefined ? {} : { locks: deps.locks }),
        ...(deps.lockClock === undefined ? {} : { clock: deps.lockClock }),
        ...(deps.events === undefined ? {} : { events: deps.events }),
      },
    );
    if (locked !== undefined) return jsonResponse(locked.status, locked.body, locked.headers);
    // a batch: every request's records are checked against the leases before the first handler runs (§4.5)
    if (path.split('?')[0] === '/api/batch' && Array.isArray((body as { requests?: unknown } | undefined)?.requests)) {
      for (const item of (body as { requests: { method?: unknown; path?: unknown; body?: unknown }[] }).requests) {
        if (typeof item?.method !== 'string' || typeof item.path !== 'string') continue;
        const held = await editLockGate(
          { method: item.method, path: item.path, ...(item.body === undefined ? {} : { body: item.body }), lockHeader: request.headers.get(LOCK_HEADER) ?? undefined, user },
          { ...(deps.locks === undefined ? {} : { locks: deps.locks }), ...(deps.lockClock === undefined ? {} : { clock: deps.lockClock }) },
        );
        if (held !== undefined) return jsonResponse(held.status, held.body, held.headers);
      }
    }
    const response = await perform(backup, { method, path, body, user }, () =>
      handleWorkbenchRequest(
        {
          method,
          path,
          ...(body === undefined ? {} : { body }),
          ...(user === undefined ? {} : { user }),
          ...(ifMatch === null ? {} : { headers: { 'if-match': ifMatch } }),
        },
        deps,
      ),
    );
    if (response.bytes !== undefined) {
      return new Response(Buffer.from(response.bytes), {
        status: response.status,
        headers: {
          'content-type': response.contentType ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          // a route may say more (a content-addressed blob is immutable; an SVG is sandboxed)
          ...(response.headers ?? {}),
        },
      });
    }
    return jsonResponse(response.status, response.body, response.headers);
  } catch (error) {
    return jsonResponse(500, {
      error: 'The server hit an unexpected problem and stopped before changing anything.',
      hint: `Check the terminal running WireHub for details. (${(error as Error).message})`,
    });
  }
}

/**
 * Mounts `/api/*` on `app`. Registered ahead of the static/SPA route in
 * `standalone-app.ts`, so nothing under `/api/` ever falls through to it.
 */
export function mountWorkbenchApi(
  app: Hono,
  deps: WorkbenchDeps = defaultWorkbenchDeps(),
  depictionDeps: DepictionDeps = defaultDepictionDeps(),
  backup?: StudioBackup,
): void {
  const handler = async (c: Context): Promise<Response> => {
    const path = c.req.path;
    const method = c.req.method;
    // a write from another site (a page the owner happens to visit) never lands
    const crossSite = crossSiteRefusal({
      method,
      origin: c.req.header('origin'),
      secFetchSite: c.req.header('sec-fetch-site'),
      host: c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host,
    });
    if (crossSite !== undefined) return jsonResponse(crossSite.status, crossSite.body);
    if (isDepictionPath(path)) {
      return handleDepiction(method, path, c.req.header('content-type'), c.req.raw, depictionDeps, backup, deps);
    }
    // an importer's file as raw bytes (no base64, no JSON): always a job
    const io = parseModuleIoPath(path);
    if (io?.kind === 'import' && method === 'PUT') return handleImportUpload(io, c.req.raw, deps, backup);
    // module routes, the history, the design library (`?designs=`) and the documents and exports
    // (`?rev=`, `?format=`, `?explode=` …) take their options as a query string; a dry run is `?dryRun=1`
    const search = new URL(c.req.url).search;
    const withQuery =
      isModulePath(path) ||
      path === '/api/history' ||
      path.startsWith('/api/history/') ||
      path === '/api/assemblies' ||
      /^\/api\/designs\/[^/]+\/(documents|exports)\//.test(path) ||
      new URLSearchParams(search).get('dryRun') === '1';
    return handleJson(method, withQuery ? `${path}${search}` : path, c.req.raw, deps, backup);
  };
  // what changed, as server-sent events (B6): ahead of compression, which would buffer the stream
  app.get('/api/events', (c) => {
    const events = deps.events;
    if (events === undefined) return jsonResponse(501, { error: 'This hub does not stream events.', hint: 'Reload to see changes.' });
    return streamSSE(c, async (stream) => {
      const queue: StudioEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = events.subscribe((event) => {
        // process control is between the server's processes, not for the page
        if (event.type === 'control') return;
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ version: String((await deps.catalogVersion?.()) ?? '') }) });
      while (!stream.aborted) {
        const next = queue.shift();
        if (next !== undefined) {
          await stream.writeSSE({ event: next.type, data: JSON.stringify(next) });
          continue;
        }
        // a comment line every 25 s keeps proxies from closing an idle stream
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 25_000);
        });
        wake = undefined;
        if (queue.length === 0 && !stream.aborted) await stream.write(': keep-alive\n\n');
      }
      unsubscribe();
    });
  });
  // JSON answers (the catalog, the list, the library) are large and compress well
  app.use('/api/*', compress());
  // both the bare index (`GET /api`) and everything under it
  app.all('/api', handler);
  app.all('/api/*', handler);
}
