import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRegistry, forRuntime, type WireHubModule } from '@wirehub/modules';
import { storePublicKeyOf, verifyPackSignature } from '@wirehub/catalog/src/server.ts';
import { expect, it } from 'vitest';
import { buildModule } from '../scripts/wirehub-module.ts';

it('loads the shipped scaffold browser entry from an opaque URL and preserves server pack paths', async () => {
  const out = mkdtempSync(join(tmpdir(), 'wh-example-opaque-'));
  try {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const built = await buildModule({ moduleDir: join(process.cwd(), '../../modules/example'), out, exportName: 'example', keys: [pem], publisher: { id: 'synthetic-publisher', name: 'Synthetic publisher' }, log: () => {} });
    expect(verifyPackSignature(built.manifest, readFileSync(join(built.dir, 'wirehub-pack.sig'), 'utf8'), [storePublicKeyOf(pem)]).ok).toBe(true);
    const server = await import(pathToFileURL(join(built.dir, built.module.server)).href) as { default: WireHubModule };
    expect(server.default.catalogPacks?.[0]?.root).toMatch(/^file:/);
    const bytes = readFileSync(join(built.dir, built.module.browser!));
    const browser = await import(`data:text/javascript;base64,${bytes.toString('base64')}`) as { default: WireHubModule };
    expect(browser.default.catalogPacks).toEqual([]);
    const registry = createRegistry([forRuntime(browser.default)]);
    expect(registry.module('example')?.panels?.length).toBeGreaterThan(0);
    expect(registry.module('example')?.partNumberScheme).toBeDefined();
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
