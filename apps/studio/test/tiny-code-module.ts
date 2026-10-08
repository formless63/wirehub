/**
 * A tiny hand-written code module bundle, for tests that need one without a
 * build: one validation rule, its server entry a plain ESM file, signed with a
 * key pair made here (nothing is a real key).
 */

import { generateKeyPairSync } from 'node:crypto';

import { packDigests, signPackManifest, storePublicKeyOf } from '@wirehub/catalog/src/server.ts';
import { MODULE_API_VERSION } from '@wirehub/modules';

import { zipFiles } from './pack-bundle-flow.ts';

export const TINY_SERVER = `export default {
  id: 'tiny',
  label: 'Tiny rule',
  version: '1.0.0',
  validationRules: [{ id: 'no-x', label: 'No X', check: (design) => (design.label.includes('XX') ? [{ code: 'no-x', severity: 'error', message: 'XX is not allowed' }] : []) }],
};
`;

/** The tiny module as its server entry evaluates to (for a host in a browser-like test environment, which imports no file URLs). */
export const TINY_MODULE = {
  id: 'tiny',
  label: 'Tiny rule',
  version: '1.0.0',
  validationRules: [{ id: 'no-x', label: 'No X', check: (design: { label: string }) => (design.label.includes('XX') ? [{ code: 'no-x', severity: 'error' as const, message: 'XX is not allowed' }] : []) }],
};

export function tinyKeys(): { pem: string; publicKey: string } {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  return { pem, publicKey: storePublicKeyOf(pem) };
}

/** The tiny module as a signed zip (`server` replaces its code). */
export function tinyBundle(pem: string, server: string = TINY_SERVER): Uint8Array {
  const files = new Map<string, Uint8Array>([['code/tiny/server.mjs', new TextEncoder().encode(server)]]);
  const manifest = {
    format: 1,
    id: 'tiny',
    name: 'Tiny rule',
    version: '1.0.0',
    license: 'MIT',
    publisher: { id: 'tiny-publisher', name: 'Tiny publisher' },
    module: { id: 'tiny', version: '1.0.0', label: 'Tiny rule', apiVersion: MODULE_API_VERSION, server: 'code/tiny/server.mjs', extensionPoints: ['validationRules'], permissions: ['server-code'] },
    files: packDigests(files),
  };
  return zipFiles({ 'wirehub-pack.json': `${JSON.stringify(manifest, null, 2)}\n`, ...Object.fromEntries(files), 'wirehub-pack.sig': signPackManifest(manifest, [pem]) });
}
