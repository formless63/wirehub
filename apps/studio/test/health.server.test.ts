/** `/healthz` stays the container probe; `/healthz?deep=1` checks the dependencies (plan §8.3). */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fsBlobStore } from '../server/blobs.ts';
import { CANARY_KEY, deepHealthCheck, startHealthMonitor } from '../server/health.ts';
import { createStandaloneApp } from '../server/standalone-app.ts';
import { defaultWorkbenchDeps } from '../server/default-deps.ts';

function dist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wirehub-health-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><title>x</title>');
  return join(dir, 'dist');
}

describe('/healthz', () => {
  it('plain: unchanged, and never calls the deep check', async () => {
    let called = 0;
    const app = createStandaloneApp({ distDir: dist(), deps: defaultWorkbenchDeps(), deepHealth: async () => { called += 1; return { ok: false, checks: [], env: null, version: null }; } });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, backup: { enabled: false } });
    expect(called).toBe(0);
  });

  it('deep: 200 with the checks, 503 when one fails, plain shape kept', async () => {
    const blobs = fsBlobStore(mkdtempSync(join(tmpdir(), 'wirehub-health-blobs-')));
    const marker = join(mkdtempSync(join(tmpdir(), 'wirehub-health-m-')), '.last-snapshot');
    writeFileSync(marker, '');
    const check = deepHealthCheck({ blobs, backupMarker: marker, env: 'prod', version: '9.9.9' });
    const app = createStandaloneApp({ distDir: dist(), deps: defaultWorkbenchDeps(), deepHealth: check });
    const ok = await app.request('/healthz?deep=1');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; backup: unknown; deep: { checks: { name: string; ok: boolean }[]; env: string; version: string } };
    expect(body.backup).toBeDefined();
    expect(body.deep.checks.map((c) => [c.name, c.ok])).toEqual([['blobs', true], ['backup', true]]);
    expect(body.deep).toMatchObject({ env: 'prod', version: '9.9.9' });
    expect(await blobs.has(CANARY_KEY)).toBe(true);
    // a backup older than 30 h
    const old = new Date(Date.now() - 31 * 3_600_000);
    utimesSync(marker, old, old);
    const stale = await app.request('/healthz?deep=1');
    expect(stale.status).toBe(503);
    expect(((await stale.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('a blob store that throws is reported as unreachable, without its message', async () => {
    const broken = { describe: 'broken', get: async () => undefined, has: async () => { throw new Error('secret-host:9000 refused'); }, put: async () => {}, delete: async () => {} };
    const result = await deepHealthCheck({ blobs: broken, log: () => {} })();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-host');
    expect(result.checks[0]).toMatchObject({ name: 'blobs', detail: 'unreachable' });
  });

  it('the monitor alerts on a failing check', async () => {
    const sent: string[] = [];
    const stop = startHealthMonitor(
      async () => ({ ok: false, checks: [{ name: 'blobs', ok: false, detail: 'unreachable', ms: 1 }], env: null, version: null }),
      { enabled: true, notify: async (e) => void sent.push(`${e.severity}:${e.event}`) },
      { intervalMs: 10 },
    );
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(sent).toEqual(['high:blob-canary-failing']);
  });
});
