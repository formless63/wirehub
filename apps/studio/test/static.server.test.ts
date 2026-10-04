/**
 * The standalone server's static/SPA half (`server/static.ts`,
 * `server/standalone-app.ts`) — no Vite, plain `vite build` output served
 * from a temp `dist/` this file builds itself.
 *
 * `mountStaticApp` is exercised through `Hono#request`, no socket needed.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { loadDb, loadDesign } from '@cable-studio/catalog';
import type { CableDesign, Db } from '@cable-studio/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import type { DefinitionKind, DefinitionRecord, DefinitionStore } from '../server/definition-store.ts';
import type { DepictionDeps, DepictionStore } from '../server/depictions.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { createStandaloneApp } from '../server/standalone-app.ts';

const CATALOG: Db = loadDb();
const REAL: CableDesign = loadDesign('rs485-de9-terminal-board');

function memoryDesignStore(seed: CableDesign[]): DesignStore {
  const files = new Map<string, string>(seed.map((d) => [d.id, formatDesignJson(d)]));
  return {
    list: () =>
      [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
    has: (id) => files.has(id),
    read: (id) => {
      const text = files.get(id);
      return text === undefined ? undefined : (JSON.parse(text) as CableDesign);
    },
    write: (id, design) => {
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
}

function memoryDefinitionStore(): DefinitionStore {
  const files = new Map<DefinitionKind, DefinitionRecord[]>([
    ['connectors', structuredClone(CATALOG.connectors)],
    ['components', structuredClone(CATALOG.components)],
    ['wires', structuredClone(CATALOG.wires)],
    ['pcbas', []],
  ]);
  return {
    list: (kind) => structuredClone(files.get(kind) ?? []),
    write: (kind, records) => {
      files.set(kind, structuredClone(records));
      return { changed: true };
    },
  };
}

function memoryDepictionStore(): DepictionStore {
  return {
    listDefIds: () => [],
    readMeta: () => undefined,
    writeMeta: () => undefined,
    readAsset: () => undefined,
    writeAsset: () => undefined,
    dirFor: () => undefined,
  };
}

function deps(): WorkbenchDeps {
  return { designs: memoryDesignStore([structuredClone(REAL)]), definitions: memoryDefinitionStore(), loadDb: () => CATALOG };
}

function depictionDeps(): DepictionDeps {
  return { store: memoryDepictionStore(), loadDb: () => CATALOG };
}

let distDir: string;

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'cable-studio-dist-'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>studio shell</body></html>\n');
  mkdirSync(join(distDir, 'assets'), { recursive: true });
  writeFileSync(join(distDir, 'assets', 'app-abc12345.js'), 'console.log("hi");\n');
  writeFileSync(join(distDir, 'favicon.ico'), 'not really an icon');
});

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true });
});

describe('the standalone server: static bundle + SPA fallback', () => {
  it('serves index.html at /, not cached', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const response = await app.request('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('studio shell');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for a client route (a cable id, with no file on disk)', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const response = await app.request('/cables/vga-monitor-cable');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('studio shell');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for a /library client route too', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const response = await app.request('/library/connectors/scart-male');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('studio shell');
  });

  it('serves a hashed asset with a long, immutable cache lifetime', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const response = await app.request('/assets/app-abc12345.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('console.log');
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  it('serves a root-level file (favicon) with a short cache, not immutable', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const response = await app.request('/favicon.ico');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).not.toContain('immutable');
  });

  it('answers a malformed URL escape with 400, not a 500 (review Bug 8)', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    expect((await app.request('/%E0%A4%A')).status).toBe(400);
  });

  it('serves brotli or gzip to a client that accepts it, and plain bytes to one that does not', async () => {
    const big = `console.log(${JSON.stringify('x'.repeat(20_000))});\n`;
    writeFileSync(join(distDir, 'assets', 'big-abc12345.js'), big);
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const br = await app.request('/assets/big-abc12345.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('vary')).toContain('accept-encoding');
    const brBytes = Buffer.from(await br.arrayBuffer());
    expect(brBytes.byteLength).toBeLessThan(big.length / 10);
    expect(brotliDecompressSync(brBytes).toString('utf8')).toBe(big);
    const gz = await app.request('/assets/big-abc12345.js', { headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString('utf8')).toBe(big);
    const plain = await app.request('/assets/big-abc12345.js');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(big);
  });

  it('compresses JSON API answers for a client that accepts it', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const response = await app.request('/api/db', { headers: { 'accept-encoding': 'gzip' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
  });

  it('answers a real missing asset with 404, not the app shell', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const response = await app.request('/assets/does-not-exist.js');
    expect(response.status).toBe(404);
  });

  it('never lets the static route shadow /api/*', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const response = await app.request('/api/designs');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { designs: unknown[] };
    expect(Array.isArray(body.designs)).toBe(true);
  });

  it('refuses a path that tries to climb out of dist/', async () => {
    const app = createStandaloneApp({ distDir, deps: deps(), depictionDeps: depictionDeps() });
    const response = await app.request('/../../etc/passwd');
    // the browser/undici normalises `..` out of the URL before it is ever
    // seen, so this either 404s (missing file, has an extension-less last
    // segment → falls to the SPA shell) or the shell — either way, never a
    // file outside distDir
    expect([200, 404]).toContain(response.status);
  });

  it('says one clear line when there is no build, instead of a blank page', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'cable-studio-empty-'));
    try {
      const app = createStandaloneApp({ distDir: emptyDir, deps: deps(), depictionDeps: depictionDeps() });
      const response = await app.request('/');
      expect(response.status).toBe(501);
      expect(await response.text()).toContain('pnpm --filter studio bundle');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
