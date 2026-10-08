/**
 * Static-file serving for the standalone server: the `vite build` bundle
 * (`apps/studio/dist/`), with SPA fallback to `index.html` for client routes
 * (`/cables/...`, `/library/...`) — TanStack Router's routes, which have no
 * file on disk and must all answer with the same shell.
 *
 * Cache policy: `index.html` is `no-cache` (it names the current hashed asset
 * bundle, so a stale copy points at files that may no longer exist); an
 * asset under `assets/` — every one is content-hashed by Vite — is cacheable
 * forever. Anything else at the root (`favicon`, fonts copied from `public/`)
 * gets a short, safe cache.
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';

import type { Hono } from 'hono';

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Whether the request looks like it names a file (`/foo.js`) rather than a client route (`/cables/foo`). */
function looksLikeFile(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.');
}

async function readIfFile(path: string): Promise<{ bytes: Buffer; mtimeMs: number } | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    return { bytes: await readFile(path), mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Compression: the bundle is several MB of JS; each file is compressed once
 * (brotli and gzip), kept in memory keyed by path + mtime, and served to any
 * client that accepts it.
 * ------------------------------------------------------------------ */

const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/;
const MIN_COMPRESS_BYTES = 1024;
const compressed = new Map<string, { mtimeMs: number; br: Buffer; gzip: Buffer }>();

/** The encoding to answer with: brotli over gzip, when the client accepts it. */
export function pickEncoding(acceptEncoding: string | undefined): 'br' | 'gzip' | undefined {
  const accepted = (acceptEncoding ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .filter((part) => !/;\s*q=0(\.0*)?$/.test(part))
    .map((part) => part.split(';')[0]?.trim());
  if (accepted.includes('br')) return 'br';
  if (accepted.includes('gzip')) return 'gzip';
  return undefined;
}

function encodedBody(
  path: string,
  file: { bytes: Buffer; mtimeMs: number },
  mediaType: string,
  acceptEncoding: string | undefined,
): { body: Buffer; encoding?: 'br' | 'gzip' } {
  const encoding = pickEncoding(acceptEncoding);
  if (encoding === undefined || file.bytes.byteLength < MIN_COMPRESS_BYTES || !COMPRESSIBLE.test(mediaType)) return { body: file.bytes };
  let entry = compressed.get(path);
  if (entry === undefined || entry.mtimeMs !== file.mtimeMs) {
    entry = {
      mtimeMs: file.mtimeMs,
      br: brotliCompressSync(file.bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: file.bytes.byteLength } }),
      gzip: gzipSync(file.bytes, { level: 9 }),
    };
    compressed.set(path, entry);
  }
  return { body: entry[encoding], encoding };
}

function fileResponse(
  path: string,
  file: { bytes: Buffer; mtimeMs: number },
  mediaType: string,
  cacheControl: string,
  acceptEncoding: string | undefined,
): Response {
  const { body, encoding } = encodedBody(path, file, mediaType, acceptEncoding);
  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': mediaType,
      'cache-control': cacheControl,
      vary: 'accept-encoding',
      ...(encoding === undefined ? {} : { 'content-encoding': encoding }),
    },
  });
}

/**
 * Mounts the SPA at `distDir`. Registered after `mountWorkbenchApi`, so this
 * never sees `/api/*` — those routes already answered.
 */
export function mountStaticApp(app: Hono, distDir: string): void {
  const root = resolve(distDir);
  app.get('*', async (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      // a malformed escape (`/%E0%A4%A`) is the client's mistake, not a crash
      return c.text('Bad request', 400);
    }
    const requested = resolve(join(root, pathname));
    // path traversal guard: the resolved path must stay inside `distDir`
    const inRoot = requested === root || requested.startsWith(root + sep);
    const file = inRoot ? await readIfFile(requested) : undefined;
    const acceptEncoding = c.req.header('accept-encoding');
    if (file !== undefined) {
      const immutable = pathname.startsWith('/assets/');
      return fileResponse(
        requested,
        file,
        mediaTypeOf(requested),
        immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
        acceptEncoding,
      );
    }
    // a real, missing asset (has an extension) is a 404, not the app shell
    if (looksLikeFile(pathname)) return c.text('Not found', 404);

    const indexPath = join(root, 'index.html');
    const index = await readIfFile(indexPath);
    if (index === undefined) {
      return c.text(
        'WireHub has not been built yet. Run `pnpm --filter studio bundle`, then start the server again.',
        501,
      );
    }
    return fileResponse(indexPath, index, 'text/html; charset=utf-8', 'no-cache', acceptEncoding);
  });
}
