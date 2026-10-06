import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storePublicKeyOf, verifyPackSignature } from '@wirehub/catalog';
import { createRegistry, type WireHubModule } from '@wirehub/modules';
import { expect, it, vi } from 'vitest';
import { buildModule } from '../scripts/wirehub-module.ts';

it('signs and loads both supplier entries with disabled providers and no network side effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-suppliers-build-'));
  const fetch = vi.fn(() => { throw new Error('Unexpected network access'); });
  vi.stubGlobal('fetch', fetch);
  vi.stubEnv('WIREHUB_SUPPLIERS_PROVIDERS', '');
  try {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const built = await buildModule({ moduleDir: join(process.cwd(), '../../modules/suppliers'), exportName: 'suppliers', out: root, keys: [pem], publisher: { id: 'synthetic-publisher', name: 'Synthetic publisher' }, log: () => {} });
    expect(verifyPackSignature(built.manifest, readFileSync(join(built.dir, 'wirehub-pack.sig'), 'utf8'), [storePublicKeyOf(pem)]).ok).toBe(true);
    expect(built.module.browser).toBeTruthy();
    for (const entry of [built.module.server, built.module.browser!]) {
      const namespace = await import(pathToFileURL(join(built.dir, entry)).href) as { default: WireHubModule };
      const module = namespace.default;
      expect(createRegistry([module]).module('suppliers')?.id).toBe('suppliers');
      expect(module.importers?.[0]?.id).toBe('selected-quote');
      const config = module.integrations?.[0]?.routes?.find(route => route.method === 'GET' && route.path === 'config');
      expect(config).toBeDefined();
      const response = await config!.handle({ query: new URLSearchParams() });
      expect(response).toMatchObject({ status: 200, body: { providers: [{ id: 'mouser', enabled: false }, { id: 'digikey', enabled: false }, { id: 'lcsc', enabled: false }] } });
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
