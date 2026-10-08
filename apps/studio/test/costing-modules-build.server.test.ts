import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storePublicKeyOf, verifyPackSignature } from '@wirehub/catalog/src/server.ts';
import { createRegistry, MODULE_API_VERSION, type WireHubModule } from '@wirehub/modules';
import { expect, it, vi } from 'vitest';
import { buildModule } from '../scripts/wirehub-module.ts';

it('signs both optional costing modules and loads their server/browser entries without network side effects or singleton hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-costing-build-'));
  const fetch = vi.fn(() => { throw new Error('Unexpected network access'); });
  vi.stubGlobal('fetch', fetch);
  try {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const loaded: WireHubModule[] = [];
    for (const [id, name] of [['fx-rates', 'fxRates'], ['standard-work', 'standardWork']]) {
      const built = await buildModule({ moduleDir: join(process.cwd(), '../../modules', id!), exportName: name, out: root, keys: [pem], publisher: { id: 'synthetic-publisher', name: 'Synthetic publisher' }, log: () => {} });
      expect(built.module.apiVersion).toBe(MODULE_API_VERSION);
      expect(verifyPackSignature(built.manifest, readFileSync(join(built.dir, 'wirehub-pack.sig'), 'utf8'), [storePublicKeyOf(pem)]).ok).toBe(true);
      for (const entry of [built.module.server, built.module.browser!]) {
        // Verified browser bytes load from opaque blob URLs in production.
        const url = entry === built.module.browser ? `data:text/javascript;base64,${readFileSync(join(built.dir, entry)).toString('base64')}` : pathToFileURL(join(built.dir, entry)).href;
        const namespace = await import(url) as { default: WireHubModule };
        expect(namespace.default.id).toBe(id);
        expect(namespace.default.commitHook).toBeUndefined();
        if (entry === built.module.server) loaded.push(namespace.default);
      }
    }
    expect(createRegistry(loaded).modules.map(module => module.id)).toEqual(['fx-rates', 'standard-work']);
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
