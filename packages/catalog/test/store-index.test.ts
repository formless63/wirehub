/**
 * The store index (`src/store-index.ts`): shape checks, building from bundles,
 * and minisign-compatible ed25519 signatures. Every key pair is generated here;
 * no private key is ever committed.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildStoreIndex, latestVersion, parseStoreIndex, parseStorePublicKey, signStoreIndex, storeKeyId, storePrivateKey, storePublicKeyFile, storePublicKeyOf, verifyStoreSignature, type StoreBundle } from '../src/server.ts';

const freshPem = (): string => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const hex = (c: string): string => c.repeat(64);

const bundle = (id: string, version: string, extra: Partial<StoreBundle['manifest']> = {}): StoreBundle => ({
  manifest: { format: 1, id, name: id.toUpperCase(), version, license: 'CC0-1.0', publisher: { id: 'pub', name: 'Publisher' }, ...extra },
  url: `${id}-${version}.zip`,
  sha256: hex(version.at(-1) ?? 'a'),
  size: 100,
});

describe('buildStoreIndex', () => {
  it('groups versions per pack, newest first, packs sorted, metadata from the newest', () => {
    const index = buildStoreIndex({ id: 'test', name: 'Test store' }, [bundle('zeta', '1.0.0'), bundle('alpha', '1.0.0'), bundle('alpha', '1.10.0', { name: 'Alpha 2', domain: 'audio', license: 'CC-BY-4.0' }), bundle('alpha', '1.2.0')]);
    expect(index.packs.map((p) => p.id)).toEqual(['alpha', 'zeta']);
    const alpha = index.packs[0]!;
    expect(alpha.versions.map((v) => v.version)).toEqual(['1.10.0', '1.2.0', '1.0.0']);
    expect(alpha).toMatchObject({ name: 'Alpha 2', domain: 'audio', license: 'CC-BY-4.0', author: { id: 'pub', name: 'Publisher' } });
    // an older version under another licence says so
    expect(alpha.versions[1]).toMatchObject({ license: 'CC0-1.0' });
    expect(index.packs[1]!.domain).toBe('zeta');
    expect(latestVersion(alpha)?.version).toBe('1.10.0');
    expect(parseStoreIndex(index).problems).toEqual([]);
    expect(() => buildStoreIndex({ id: 't', name: 'T' }, [bundle('a', '1.0.0'), bundle('a', '1.0.0')])).toThrow(/twice/);
  });

  it('copies code summaries per version without code paths, while older data indexes remain valid', () => {
    const module = { id: 'sample', version: '1.1.0', label: 'Sample module', apiVersion: '1.2', server: 'code/sample/server.mjs', extensionPoints: ['integrations'], permissions: ['network'] };
    const index = buildStoreIndex({ id: 'test', name: 'Test store' }, [bundle('sample', '1.0.0'), bundle('sample', '1.1.0', { module })]);
    expect(index.packs[0]?.versions[0]?.module).toEqual({ id: 'sample', version: '1.1.0', label: 'Sample module', apiVersion: '1.2', extensionPoints: ['integrations'], permissions: ['network'] });
    expect(index.packs[0]?.versions[1]?.module).toBeUndefined();
    expect(parseStoreIndex(index).problems).toEqual([]);
    for (const bad of [null, [], 'code', { ...module, id: 'Bad id' }, { ...module, version: 'x' }, { ...module, label: '' }, { ...module, apiVersion: 'x' }, { ...module, permissions: [''] }, { ...module, extensionPoints: 'routes' }]) {
      const malformed = structuredClone(index);
      Object.assign(malformed.packs[0]!.versions[0]!, { module: bad });
      expect(parseStoreIndex(malformed).problems.join(' ')).toMatch(/module/);
    }
  });

  it('reports what is wrong with an index', () => {
    expect(parseStoreIndex([]).problems).toEqual(['the index is not a JSON object']);
    const bad = parseStoreIndex({ format: 2, store: {}, packs: [{ id: 'Bad Id', versions: [{ version: 'x', url: '', sha256: 'abc', size: 0 }] }] });
    expect(bad.index).toBeUndefined();
    expect(bad.problems.join('\n')).toMatch(/format 2[\s\S]*names no store[\s\S]*kebab-case[\s\S]*no name[\s\S]*no domain[\s\S]*no licence[\s\S]*no author[\s\S]*semver[\s\S]*no url[\s\S]*sha256[\s\S]*size/);
  });
});

describe('store signatures', () => {
  const message = new TextEncoder().encode('{"format":1}\n');

  it('signs and verifies; the public key is derived from the private one', () => {
    const pem = freshPem();
    const pub = storePublicKeyOf(pem);
    expect(pub).toMatch(/^RW[A-Za-z0-9+/]{54}$/);
    expect(storePublicKeyOf(pem)).toBe(pub);
    const sig = signStoreIndex(message, pem, 'wirehub store index test');
    expect(sig.split('\n')[2]).toBe('trusted comment: wirehub store index test');
    expect(verifyStoreSignature(message, sig, pub)).toEqual({ ok: true, trustedComment: 'wirehub store index test' });
    // the two-line .pub file works as well as the bare key
    expect(verifyStoreSignature(message, sig, storePublicKeyFile(pub)).ok).toBe(true);
  });

  it('refuses a changed index, another key, a changed trusted comment and junk', () => {
    const pem = freshPem();
    const sig = signStoreIndex(message, pem);
    const pub = storePublicKeyOf(pem);
    expect(verifyStoreSignature(new TextEncoder().encode('{"format":1} \n'), sig, pub)).toMatchObject({ ok: false, reason: /does not match/ });
    expect(verifyStoreSignature(message, sig, storePublicKeyOf(freshPem()))).toMatchObject({ ok: false, reason: /different key/ });
    const lines = sig.split('\n');
    lines[2] = 'trusted comment: something else';
    expect(verifyStoreSignature(message, lines.join('\n'), pub)).toMatchObject({ ok: false, reason: /trusted comment/ });
    expect(verifyStoreSignature(message, 'nonsense', pub).ok).toBe(false);
    expect(verifyStoreSignature(message, sig, 'RWnotakey').ok).toBe(false);
  });

  it('is minisign: ED over BLAKE2b-512, the key id in both, the global signature over sig || comment; legacy Ed verifies too', () => {
    const pem = freshPem();
    const pub = Buffer.from(storePublicKeyOf(pem), 'base64');
    const sig = signStoreIndex(message, pem, 'tc');
    const raw = Buffer.from(sig.split('\n')[1]!, 'base64');
    expect(raw.subarray(0, 2).toString()).toBe('ED');
    expect(raw.subarray(2, 10).equals(pub.subarray(2, 10))).toBe(true);
    expect(pub.subarray(2, 10).equals(storeKeyId(pub.subarray(10)))).toBe(true);
    // a legacy (non-prehashed) minisign signature made by hand
    const key = storePrivateKey(pem);
    const legacy = sign(null, message, key);
    const global = sign(null, Buffer.concat([legacy, Buffer.from('tc')]), key);
    const text = ['untrusted comment: x', Buffer.concat([Buffer.from('Ed'), pub.subarray(2, 10), legacy]).toString('base64'), 'trusted comment: tc', global.toString('base64'), ''].join('\n');
    expect(verifyStoreSignature(message, text, storePublicKeyOf(pem)).ok).toBe(true);
    expect(createHash('blake2b512').update(message).digest().length).toBe(64);
  });

  it('accepts only ed25519 PEM keys', () => {
    expect(() => storePrivateKey('not a key')).toThrow(/PEM/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    expect(() => storePrivateKey(rsa)).toThrow(/ed25519/);
    expect(() => parseStorePublicKey('RWQ')).toThrow(/minisign/);
    // a PEM pasted with literal \n (some secret stores) still reads
    const pem = freshPem();
    expect(storePublicKeyOf(pem.replace(/\n/g, '\\n'))).toBe(storePublicKeyOf(pem));
  });
});
