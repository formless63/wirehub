import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storePublicKeyOf, verifyPackSignature } from '@wirehub/catalog/src/server.ts';
import { createRegistry, MODULE_API_VERSION, type WireHubModule } from '@wirehub/modules';
import { expect, it, vi } from 'vitest';
import { buildModule } from '../scripts/wirehub-module.ts';

it('signs and loads both supplier entries with disabled providers and no network side effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-suppliers-build-'));
  const fetch = vi.fn(() => { throw new Error('Unexpected network access'); });
  vi.stubGlobal('fetch', fetch);
  // the module never reads the process environment: the host resolves its declared settings (and their env overrides)
  vi.stubEnv('WIREHUB_SUPPLIERS_PROVIDERS', 'mouser');
  vi.stubEnv('WIREHUB_SUPPLIERS_MOUSER_KEY', 'synthetic-env-key');
  try {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const built = await buildModule({ moduleDir: join(process.cwd(), '../../modules/suppliers'), exportName: 'suppliers', out: root, keys: [pem], publisher: { id: 'synthetic-publisher', name: 'Synthetic publisher' }, log: () => {} });
    expect(verifyPackSignature(built.manifest, readFileSync(join(built.dir, 'wirehub-pack.sig'), 'utf8'), [storePublicKeyOf(pem)]).ok).toBe(true);
    expect(built.module.browser).toBeTruthy();
    // declared settings (module API 1.5): their env overrides are permissions the owner consents to
    expect(built.module.apiVersion).toBe(MODULE_API_VERSION);
    expect(built.module.extensionPoints).toContain('settings');
    expect(built.module.permissions).toEqual(expect.arrayContaining(['env:WIREHUB_SUPPLIERS_PROVIDERS', 'env:WIREHUB_SUPPLIERS_MOUSER_KEY', 'env:WIREHUB_SUPPLIERS_LCSC_SECRET']));
    for (const entry of [built.module.server, built.module.browser!]) {
      // Runtime browsers import verified bytes from an opaque blob URL, not a
      // filesystem path; a data URL exercises the same relative-URL boundary.
      const url = entry === built.module.browser ? `data:text/javascript;base64,${readFileSync(join(built.dir, entry)).toString('base64')}` : pathToFileURL(join(built.dir, entry)).href;
      const namespace = await import(url) as { default: WireHubModule };
      const module = namespace.default;
      expect(createRegistry([module]).module('suppliers')?.id).toBe('suppliers');
      expect(module.importers?.[0]?.id).toBe('selected-quote');
      expect(module.settings?.map((setting) => setting.key)).toEqual(['providers', 'mouserKey', 'digikeyClientId', 'digikeyClientSecret', 'digikeyAccountId', 'lcscKey', 'lcscSecret']);
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
