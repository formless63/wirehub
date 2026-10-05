/**
 * A throwaway signed store for the store tests (files and Postgres): pack
 * directories bundled, indexed and signed by `scripts/store-index.mjs` with a
 * key pair generated here, served through an injected fetch at
 * `https://store.example/s/…`. No private key is committed: the key lives in
 * the temporary directory and is gone with it.
 */

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { storePublicKeyOf } from '@wirehub/catalog';

import type { FetchPackOptions } from '../server/pack-archive.ts';

// process.cwd() is apps/studio under vitest (jsdom gives import.meta.url an http scheme)
const repo = join(process.cwd(), '../..');
const script = join(repo, 'scripts/store-index.mjs');

export const STORE_URL = 'https://store.example/s/index.json';
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const src = 'synthetic example: store test pack';

export interface TestStore {
  dir: string;
  site: string;
  keyFile: string;
  publicKey: string;
  /** add (or replace) version `version` of the test pack `id`, then rebuild and re-sign the index */
  publish: (id: string, version: string, resistorValue: string, extra?: boolean) => void;
  /** run the CLI */
  cli: (...args: string[]) => string;
  /** the fetch the server uses; `override` answers a path first (tamper tests) */
  fetch: FetchPackOptions;
  override: Map<string, Uint8Array | null>;
  /** fetches made, by URL */
  fetched: string[];
  close: () => void;
}

export function createTestStore(): TestStore {
  const dir = mkdtempSync(join(tmpdir(), 'wirehub-store-'));
  const site = join(dir, 'site');
  const packs = join(dir, 'packs');
  mkdirSync(site, { recursive: true });
  const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const keyFile = join(dir, 'test-store.key');
  writeFileSync(keyFile, pem, { mode: 0o600 });
  const cli = (...args: string[]): string => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WIREHUB_STORE_SIGNING_KEY: '' } });
  const override = new Map<string, Uint8Array | null>();
  const fetched: string[] = [];
  const store: TestStore = {
    dir,
    site,
    keyFile,
    publicKey: storePublicKeyOf(pem),
    cli,
    override,
    fetched,
    publish(id, version, value, extra = false) {
      const pack = join(packs, `${id}-${version}`);
      rmSync(pack, { recursive: true, force: true });
      mkdirSync(pack, { recursive: true });
      writeFileSync(join(pack, 'wirehub-pack.json'), json({ format: 1, id, name: `Store ${id}`, version, license: 'CC-BY-4.0', domain: 'test-domain', publisher: { id: 'tester', name: 'Test publisher' }, description: `The ${id} test pack.` }));
      writeFileSync(
        join(pack, 'components.json'),
        json([
          { id: `${id}-r`, label: `${value} resistor`, kind: 'resistor', value, terminals: [{ id: 'a' }, { id: 'b' }], src },
          ...(extra ? [{ id: `${id}-r2`, label: '2 resistor', kind: 'resistor', terminals: [{ id: 'a' }, { id: 'b' }], src }] : []),
        ]),
      );
      cli('bundle', pack, '--out', site);
      cli('build', site, '--store-id', 'test-store', '--store-name', 'Test store');
      cli('sign', join(site, 'index.json'), '--key', keyFile);
    },
    fetch: {
      lookup: async () => ['93.184.216.34'],
      fetch: (async (input: URL | string) => {
        const url = new URL(String(input));
        fetched.push(url.href);
        const name = decodeURIComponent(url.pathname.replace(/^\/s\//, ''));
        if (override.has(name)) {
          const bytes = override.get(name);
          return bytes === null || bytes === undefined ? new Response('gone', { status: 404 }) : new Response(bytes as BodyInit);
        }
        const path = join(site, name);
        if (url.host !== 'store.example' || name.includes('/') || !existsSync(path)) return new Response('not found', { status: 404 });
        return new Response(new Uint8Array(readFileSync(path)) as BodyInit);
      }) as typeof fetch,
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
  return store;
}
