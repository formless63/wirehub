/**
 * A throwaway signed store for the store tests (files and Postgres): pack
 * directories bundled, indexed and signed by `scripts/store-index.mjs` with a
 * key pair generated here, served through an injected fetch at
 * `https://store.example/s/…`. No private key is committed: the keys (the
 * store's and the test publisher's) live in the temporary directory and are gone
 * with it.
 *
 * Phase 5: `signWith` (publisher key files) makes `publish` sign each pack
 * (`sign-pack`) before bundling, and `meta(...)` runs a store-metadata command
 * (`publisher`, `review`, `yank`, `revoke` …) and rebuilds and re-signs the index.
 */

import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { storePublicKeyOf } from '@wirehub/catalog/src/server.ts';

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
  /** the test publisher `tester`'s key pair (files in the temporary directory) */
  publisherKeyFile: string;
  publisherPublicKey: string;
  /** a second publisher key, for rotation and revocation */
  otherKeyFile: string;
  otherPublicKey: string;
  /** key files `publish` signs each pack with (`sign-pack`); empty = unsigned packs */
  signWith: string[];
  /** run a store-metadata command on the site (`store.meta('yank', 'alpha@1.0.0', '--reason', 'x')`), then rebuild and re-sign the index */
  meta: (command: string, ...args: string[]) => void;
  /** list `bytes` as version `version` of pack `id` in the index (a hand-made bundle), re-signing the index */
  relist: (id: string, version: string, bytes: Uint8Array, name?: string) => void;
  /** add (or replace) version `version` of the test pack `id`, then rebuild and re-sign the index */
  publish: (id: string, version: string, resistorValue: string, extra?: boolean, depiction?: string | null, face?: string) => void;
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
  const keyPair = (name: string): { file: string; pub: string } => {
    const k = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const file = join(dir, `${name}.key`);
    writeFileSync(file, k, { mode: 0o600 });
    return { file, pub: storePublicKeyOf(k) };
  };
  const publisher = keyPair('test-publisher');
  const other = keyPair('test-other');
  const rebuild = (): void => {
    cli('build', site, '--store-id', 'test-store', '--store-name', 'Test store');
    cli('sign', join(site, 'index.json'), '--key', keyFile);
  };
  const cli = (...args: string[]): string => {
    try {
      return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WIREHUB_STORE_SIGNING_KEY: '', WIREHUB_PACK_SIGNING_KEY: '' } });
    } catch (error) {
      // the script's own sentence, not only the command line
      const stderr = (error as { stderr?: string }).stderr;
      throw new Error(`store-index.mjs ${args[0] ?? ''}: ${stderr?.trim() || (error instanceof Error ? error.message : String(error))}`);
    }
  };
  const override = new Map<string, Uint8Array | null>();
  const fetched: string[] = [];
  const store: TestStore = {
    dir,
    site,
    keyFile,
    publicKey: storePublicKeyOf(pem),
    publisherKeyFile: publisher.file,
    publisherPublicKey: publisher.pub,
    otherKeyFile: other.file,
    otherPublicKey: other.pub,
    signWith: [],
    meta(command, ...args) {
      cli(command, site, ...args);
      rebuild();
    },
    relist(id, version, bytes, name = `${id}-${version}-hand.json`) {
      writeFileSync(join(site, name), bytes);
      const index = JSON.parse(readFileSync(join(site, 'index.json'), 'utf8'));
      const entry = index.packs.find((p: { id: string }) => p.id === id).versions.find((v: { version: string }) => v.version === version);
      Object.assign(entry, { url: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
      writeFileSync(join(site, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
      cli('sign', join(site, 'index.json'), '--key', keyFile);
    },
    cli,
    override,
    fetched,
    publish(id, version, value, extra = false, depiction = null, face) {
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
      // a depiction manifest, when asked: `depictions/<id>-face/meta.json` carrying `depiction` as its note
      // `face`: an SVG as `depictions/<id>-face/mating-face.svg`, listed in that manifest
      if (face !== undefined) {
        mkdirSync(join(pack, 'depictions', `${id}-face`), { recursive: true });
        writeFileSync(join(pack, 'depictions', `${id}-face`, 'mating-face.svg'), face);
        writeFileSync(
          join(pack, 'depictions', `${id}-face`, 'meta.json'),
          json({ defId: `${id}-face`, views: { 'mating-face': { file: 'mating-face.svg', kind: 'vector', mmPerUnit: 1, sourceKind: 'hand', widthUnits: 4, heightUnits: 4, src } }, ...(depiction === null ? {} : { note: depiction }), src, license: 'CC-BY-4.0' }),
        );
      } else if (depiction !== null) {
        mkdirSync(join(pack, 'depictions', `${id}-face`), { recursive: true });
        writeFileSync(join(pack, 'depictions', `${id}-face`, 'meta.json'), json({ defId: `${id}-face`, views: {}, note: depiction, src, license: 'CC-BY-4.0' }));
      }
      if (store.signWith.length > 0) cli('sign-pack', pack, ...store.signWith.flatMap((file) => ['--key', file]));
      cli('bundle', pack, '--out', site);
      rebuild();
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
