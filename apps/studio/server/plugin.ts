/**
 * The workbench's JSON API (`/api/*`, everything but the artwork endpoints) as
 * a plain Connect-style middleware, plus the Vite dev-server plugin that
 * mounts it.
 *
 * `workbenchJsonMiddleware` is the thin adapter: it reads the request, hands
 * `handleWorkbenchRequest` a plain object, and writes the response back as
 * JSON — the rules all live in `api.ts` (and `definitions.ts`, `etag.ts`),
 * which is why they can be tested without ever starting a server. This file
 * and `depictions.ts`'s `depictionMiddleware` are the only two places that
 * touch a socket for the dev host; `server/hono-adapter.ts` is the standalone
 * host's equivalent thin adapter over the exact same core
 * — same rules, same store interfaces, a different socket.
 *
 * Sidecar phase, deliberately: a dev server (this file) or the standalone
 * server (`server/serve.ts`) is the host today, and another app could be the host
 * tomorrow. When that swap happens these adapters get replaced; `api.ts`,
 * `definitions.ts` and the store interfaces travel unchanged.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Plugin } from 'vite';

import { handleWorkbenchRequest, type WorkbenchDeps } from './api.ts';
import { defaultWorkbenchDeps } from './default-deps.ts';
import { defaultDepictionDeps, depictionMiddleware, isDepictionPath, type DepictionDeps } from './depictions.ts';
import { editLockLayer, type EditLockDeps } from './locks/lock-api.ts';
import { LOCK_HEADER } from '../src/locks/records.ts';

import { isModelPath, MAX_MODEL_REQUEST_BYTES } from './models/api.ts';
import { legacyEnvWarning } from './env.ts';
import { MAX_JSON_BODY_BYTES as MAX_JSON_BYTES, contentTypeRefusal, crossSiteRefusal, type GuardRefusal } from './request-guard.ts';

export { defaultWorkbenchDeps } from './default-deps.ts';

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The shared write rails (`request-guard.ts`): cross-site first, then the body's type. */
export function guardWrite(req: IncomingMessage, upload: boolean, hasBody: boolean): GuardRefusal | undefined {
  const method = req.method ?? 'GET';
  return (
    crossSiteRefusal({
      method,
      origin: header(req, 'origin'),
      secFetchSite: header(req, 'sec-fetch-site'),
      host: header(req, 'x-forwarded-host') ?? header(req, 'host'),
    }) ?? (hasBody ? contentTypeRefusal(method, header(req, 'content-type'), upload) : undefined)
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  // a model upload (50a.55) is a base64 file, bigger than any document
  const MAX_BODY_BYTES = isModelPath(req.url ?? '') ? MAX_MODEL_REQUEST_BYTES : MAX_JSON_BYTES;
  return new Promise((resolve, reject) => {
    let text = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // past the limit: keep draining (so the 413 can be sent) but hold nothing
      if (size <= MAX_BODY_BYTES) text += chunk.toString('utf8');
    });
    req.on('end', () =>
      size > MAX_BODY_BYTES ? reject(new Error('that document is too large for the workbench to accept')) : resolve(text),
    );
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // the workbench writes files; a cached answer would show stale work
  res.setHeader('cache-control', 'no-store');
  if (headers !== undefined) {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  }
  res.end(payload);
}

/** The one request header this router reads: the stale-write guard's `If-Match`. */
function ifMatchOf(req: IncomingMessage): string | undefined {
  const value = req.headers['if-match'];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The JSON half of the workbench API (everything under `/api/` that is not
 * `/api/depictions/…`) as a Connect-style middleware: `(req, res, next)`,
 * nothing Vite-specific about it. Shared, not copied, between the Vite plugin
 * below and the standalone host's Hono adapter (`hono-adapter.ts` calls
 * `handleWorkbenchRequest` the same way; this function and that one are the
 * two thin transports around the one core).
 */
export function workbenchJsonMiddleware(
  deps: WorkbenchDeps = defaultWorkbenchDeps(),
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    const path = req.url ?? '';
    if (!path.startsWith('/api/') && path !== '/api') {
      next();
      return;
    }
    void (async (): Promise<void> => {
      const crossSite = guardWrite(req, false, false);
      if (crossSite !== undefined) {
        send(res, crossSite.status, crossSite.body);
        return;
      }
      let body: unknown;
      try {
        const text = await readBody(req);
        const typeRefusal = text.trim() === '' ? undefined : guardWrite(req, false, true);
        if (typeRefusal !== undefined) {
          send(res, typeRefusal.status, typeRefusal.body);
          return;
        }
        if (text.trim() !== '') body = JSON.parse(text);
      } catch (error) {
        send(res, /too large/.test((error as Error).message) ? 413 : 400, {
          error: 'The studio could not read what was sent with that request.',
          hint: `Nothing was changed. (${(error as Error).message})`,
        });
        return;
      }
      try {
        // edit locks: `/api/locks/*` and the 423 gate
        const locked = await editLockLayer(
          { method: req.method ?? 'GET', path, ...(body === undefined ? {} : { body }), lockHeader: header(req, LOCK_HEADER) },
          lockDepsOf(deps),
        );
        if (locked !== undefined) {
          send(res, locked.status, locked.body, locked.headers);
          return;
        }
        const ifMatch = ifMatchOf(req);
        const response = await handleWorkbenchRequest(
          {
            method: req.method ?? 'GET',
            path,
            ...(body === undefined ? {} : { body }),
            ...(ifMatch === undefined ? {} : { headers: { 'if-match': ifMatch } }),
          },
          deps,
        );
        if (response.bytes !== undefined) {
          res.statusCode = response.status;
          res.setHeader('content-type', response.contentType ?? 'application/octet-stream');
          res.setHeader('cache-control', 'no-store');
          res.setHeader('x-content-type-options', 'nosniff');
          res.end(Buffer.from(response.bytes));
          return;
        }
        send(res, response.status, response.body, response.headers);
      } catch (error) {
        // a bug in here must still leave the user with a next step
        send(res, 500, {
          error: 'The workbench hit an unexpected problem and stopped before changing anything.',
          hint: `Check the terminal running the studio for details. (${(error as Error).message})`,
        });
      }
    })();
  };
}

function lockDepsOf(deps: WorkbenchDeps): EditLockDeps {
  return { ...(deps.locks === undefined ? {} : { locks: deps.locks }), ...(deps.lockClock === undefined ? {} : { clock: deps.lockClock }) };
}

/**
 * The lock gate for the artwork endpoints, ahead of
 * `depictionMiddleware`: path only, so the upload's body is left unread for it.
 */
export function depictionLockMiddleware(
  deps: WorkbenchDeps,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    const path = req.url ?? '';
    if (!isDepictionPath(path)) {
      next();
      return;
    }
    void editLockLayer({ method: req.method ?? 'GET', path, lockHeader: header(req, LOCK_HEADER) }, lockDepsOf(deps)).then(
      (locked) => (locked === undefined ? next() : send(res, locked.status, locked.body)),
      () => next(),
    );
  };
}

/**
 * Both halves of the workbench API — artwork and JSON — as one Connect-style
 * middleware. What the Vite plugin mounts, and what a plain `node:http` host
 * (the standalone-vs-dev-server parity tests) can mount too.
 */
export function workbenchMiddleware(
  deps: WorkbenchDeps = defaultWorkbenchDeps(),
  depictionDeps: DepictionDeps = defaultDepictionDeps(),
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const gate = depictionLockMiddleware(deps);
  const artwork = depictionMiddleware(depictionDeps);
  const json = workbenchJsonMiddleware(deps);
  return (req, res, next) => {
    gate(req, res, () => artwork(req, res, () => json(req, res, next)));
  };
}

export function workbenchApi(deps: WorkbenchDeps = defaultWorkbenchDeps()): Plugin {
  return {
    name: 'wirehub:workbench-api',
    // dev only: a static bundle has no filesystem to write to, and the studio
    // says so in plain words rather than pretending Save worked
    apply: 'serve',
    configureServer(server) {
      // the login (`server/auth/`) is a standalone-server feature; say so
      // rather than let AUTH_ENABLED=true suggest the dev server is protected
      if (/^(true|1|yes|on)$/i.test(process.env.AUTH_ENABLED?.trim() ?? '')) {
        server.config.logger.warn(
          'AUTH_ENABLED=true is ignored by the Vite dev server — no login here. Use `pnpm --filter studio start` for the gated server.',
        );
      }
      const legacyEnv = legacyEnvWarning(process.env);
      if (legacyEnv !== undefined) server.config.logger.warn(legacyEnv);
      // artwork first: those endpoints carry bytes in and images out, which the
      // JSON pipe below cannot express. Everything else falls through to it.
      server.middlewares.use(depictionLockMiddleware(deps));
      server.middlewares.use(depictionMiddleware());
      server.middlewares.use(workbenchJsonMiddleware(deps));
    },
  };
}
