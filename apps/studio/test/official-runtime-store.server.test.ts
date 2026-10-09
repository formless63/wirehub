import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packFileProblems, parseStoreIndex, storePublicKeyOf, verifyPackSignature } from '@wirehub/catalog/src/server.ts';
import { MODULE_API_VERSION } from '@wirehub/modules';
import { expect, it } from 'vitest';
import { readPackBytes } from '../server/pack-archive.ts';

const repo = join(process.cwd(), '../..');
const publisherKey = (): string => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const run = (script: string, args: string[], key = '', storeKey = ''): string => execFileSync(process.execPath, [join(repo, script), ...args], {
  cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, WIREHUB_PACK_SIGNING_KEY: key, WIREHUB_STORE_SIGNING_KEY: storeKey },
});

it('omits executable bundles entirely without a publisher key', () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-official-unsigned-'));
  try {
    expect(run('scripts/build-official-runtime.mjs', [root])).toContain('omitted');
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('publishes only the three signed optional modules alongside signed domain data in the official index', () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-official-runtime-'));
  try {
    const key = publisherKey();
    const publicKey = storePublicKeyOf(key);
    const out = join(root, 'store');
    const domain = join(root, 'domains', 'synthetic', 'pack');
    mkdirSync(domain, { recursive: true });
    writeFileSync(join(domain, 'wirehub-pack.json'), JSON.stringify({ format: 1, id: 'synthetic-domain', name: 'Synthetic domain', version: '1.0.0', license: 'CC0-1.0', domain: 'synthetic', publisher: { id: 'wirehub', name: 'WireHub' } }));
    writeFileSync(join(domain, 'components.json'), '[]\n');
    const meta = join(root, 'meta.json');
    writeFileSync(meta, JSON.stringify({ publishers: [{ id: 'wirehub', name: 'WireHub', key: publicKey }] }));
    run('scripts/store-index.mjs', ['sign-pack', domain], key);
    run('scripts/build-official-runtime.mjs', [out], key);
    run('scripts/store-index.mjs', ['official', '--out', out, '--modules', join(root, 'domains'), '--meta', meta]);
    const indexFile = join(out, 'index.json');
    const parsed = parseStoreIndex(JSON.parse(readFileSync(indexFile, 'utf8')));
    expect(parsed.problems).toEqual([]);
    const index = parsed.index!;
    expect(index.packs.map(pack => pack.id).sort()).toEqual(['fx-rates', 'standard-work', 'suppliers', 'synthetic-domain']);
    expect(index.packs.find(pack => pack.id === 'synthetic-domain')!.versions[0]!.module).toBeUndefined();
    for (const id of ['suppliers', 'fx-rates', 'standard-work', 'synthetic-domain']) {
      const release = index.packs.find(pack => pack.id === id)!.versions[0]!;
      expect(release.signedBy).toEqual([publicKey]);
      const bundle = readPackBytes(new Uint8Array(readFileSync(join(out, release.url))));
      const manifest = JSON.parse(new TextDecoder().decode(bundle.shipped.get('wirehub-pack.json')));
      expect(verifyPackSignature(manifest, bundle.signature, [publicKey]).ok).toBe(true);
      expect(packFileProblems(manifest, bundle.shipped)).toEqual([]);
      if (id !== 'synthetic-domain') {
        expect(release.module).toMatchObject({ id, apiVersion: MODULE_API_VERSION });
        expect(release.module!.extensionPoints).toContain('panels');
        expect(bundle.shipped.has(manifest.module.server)).toBe(true);
        expect(bundle.shipped.has(manifest.module.browser)).toBe(true);
      }
    }
    expect(readdirSync(out).filter(file => file.endsWith('.zip'))).toHaveLength(4);
    // Exact IDs above exclude every built-in package available to the builder.
    const storeKey = publisherKey();
    run('scripts/store-index.mjs', ['sign', indexFile, '--required'], '', storeKey);
    expect(run('scripts/store-index.mjs', ['verify', indexFile, '--pubkey', storePublicKeyOf(storeKey)])).toContain('verified');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
