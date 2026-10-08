/**
 * Signed pack manifests and the phase 5 index fields (`src/pack-signature.ts`,
 * `src/store-index.ts`): file pins, publisher signatures (with rotation and
 * revocation), review status, yanked versions. Every key pair is generated here;
 * no private key is ever committed.
 */

import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildStoreIndex, offeredVersion, packDigests, packFileDigest, packFileProblems, parseStoreIndex, publisherKeys, reviewOf, revokedKeysOf, signPackManifest, splitPackSignatures, storePublicKeyOf, verifyPackSignature, versionVisible, type StoreBundle, type StoreIndexPack } from '../src/server.ts';

const freshPem = (): string => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const files = (): Map<string, Uint8Array> =>
  new Map([
    ['wirehub-pack.json', text('{}')],
    ['components.json', text('[{"id":"r","src":"synthetic example"}]')],
    ['depictions/r/face.svg', text('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ]);

describe('pack file pins', () => {
  it('pins every file but the manifest and signature, JSON in canonical form, images as shipped', () => {
    const digests = packDigests(files());
    expect(Object.keys(digests)).toEqual(['components.json', 'depictions/r/face.svg']);
    // the same JSON however it is spaced: a zip and a JSON bundle verify alike
    expect(packFileDigest('a.json', text('[{"id":"r","src":"synthetic example"}]'))).toBe(packFileDigest('a.json', text('[\n  {\n    "id": "r",\n    "src": "synthetic example"\n  }\n]\n')));
    expect(packFileDigest('a.svg', text('<svg/>'))).not.toBe(packFileDigest('a.svg', text('<svg />')));
  });

  it('says which file is missing, changed or not pinned; nothing when the manifest pins none', () => {
    const manifest = { files: packDigests(files()) };
    expect(packFileProblems(manifest, files())).toEqual([]);
    expect(packFileProblems({}, files())).toEqual([]);
    const changed = files();
    changed.set('components.json', text('[]'));
    changed.delete('depictions/r/face.svg');
    changed.set('extra.json', text('{}'));
    expect(packFileProblems(manifest, changed)).toEqual([
      "'components.json' does not match the sha256 the manifest pins",
      "'depictions/r/face.svg' is pinned by the manifest but not in the pack",
      "'extra.json' is in the pack but the manifest does not pin it",
    ]);
    expect(packFileProblems({ files: [] }, files())[0]).toMatch(/not a map/);
  });
});

describe('pack signatures', () => {
  const manifest = { format: 1, id: 'alpha', version: '1.0.0', publisher: { id: 'pub', name: 'Pub' }, files: packDigests(files()) };

  it('verifies with the publisher key, and not after the manifest changed or with another key', () => {
    const pem = freshPem();
    const key = storePublicKeyOf(pem);
    const sig = signPackManifest(manifest, [pem]);
    expect(sig).toMatch(/^untrusted comment: signature from wirehub publisher key [0-9A-F]{16}\n/);
    expect(sig).toMatch(/trusted comment: wirehub pack alpha 1.0.0/);
    expect(verifyPackSignature(manifest, sig, [key])).toEqual({ ok: true, signers: [key] });
    expect(verifyPackSignature({ ...manifest, version: '1.0.1' }, sig, [key])).toMatchObject({ ok: false, reason: /does not match the manifest/ });
    expect(verifyPackSignature(manifest, sig, [storePublicKeyOf(freshPem())])).toMatchObject({ ok: false, reason: /no signature in it is by a key of its publisher/ });
    expect(verifyPackSignature(manifest, undefined, [key])).toMatchObject({ ok: false, reason: /not signed/ });
    expect(verifyPackSignature(manifest, sig, [])).toMatchObject({ ok: false, reason: /no key/ });
    expect(() => signPackManifest(manifest, [])).toThrow();
  });

  it('carries several signatures for a key rotation; a revoked key never counts', () => {
    const oldPem = freshPem();
    const newPem = freshPem();
    const oldKey = storePublicKeyOf(oldPem);
    const newKey = storePublicKeyOf(newPem);
    const both = signPackManifest(manifest, [oldPem, newPem]);
    expect(splitPackSignatures(both)).toHaveLength(2);
    expect(verifyPackSignature(manifest, both, [newKey])).toEqual({ ok: true, signers: [newKey] });
    expect(verifyPackSignature(manifest, both, [newKey, oldKey], new Set([oldKey]))).toEqual({ ok: true, signers: [newKey] });
    // signed only by the revoked key: refused, and said so, even when the publisher no longer lists it
    const onlyOld = signPackManifest(manifest, [oldPem]);
    expect(verifyPackSignature(manifest, onlyOld, [oldKey], new Set([oldKey]))).toEqual({ ok: false, reason: 'it is signed only by a revoked key', revoked: [oldKey] });
    expect(verifyPackSignature(manifest, onlyOld, [newKey], new Map([[oldKey, { key: oldKey }]]))).toMatchObject({ ok: false, revoked: [oldKey] });
  });
});

describe('the phase 5 index', () => {
  const pubPem = freshPem();
  const pubKey = storePublicKeyOf(pubPem);
  const bundle = (version: string, signedBy?: string[]): StoreBundle => ({
    manifest: { format: 1, id: 'alpha', name: 'Alpha', version, license: 'CC0-1.0', publisher: { id: 'pub', name: 'Publisher' } },
    url: `alpha-${version}.zip`,
    sha256: 'a'.repeat(64),
    size: 10,
    ...(signedBy === undefined ? {} : { signedBy }),
  });

  it('builds publishers, revoked keys, review and yank from the store metadata, and parses them back', () => {
    const index = buildStoreIndex({ id: 's', name: 'S' }, [bundle('1.0.0', [pubKey]), bundle('1.1.0', [pubKey]), bundle('2.0.0', [pubKey])], undefined, {
      publishers: [{ id: 'pub', name: 'Publisher', key: pubKey, url: 'https://pub.example' }],
      revokedKeys: [{ key: storePublicKeyOf(freshPem()), reason: 'lost' }],
      versions: {
        'alpha@2.0.0': { yanked: { reason: 'wrong pinout', on: '2026-10-05' } },
        'alpha@1.1.0': { review: { status: 'reviewed', by: 'reviewer', on: '2026-10-04' } },
        'alpha@1.0.0': { review: { status: 'flagged', reason: 'unsourced values' } },
      },
    });
    expect(parseStoreIndex(index).problems).toEqual([]);
    const alpha = index.packs[0]!;
    expect(alpha.publisher).toBe('pub');
    expect(alpha.versions.map((v) => [v.version, reviewOf(v).status, v.yanked?.reason])).toEqual([
      ['2.0.0', 'unreviewed', 'wrong pinout'],
      ['1.1.0', 'reviewed', undefined],
      ['1.0.0', 'flagged', undefined],
    ]);
    expect(alpha.versions[0]?.signedBy).toEqual([pubKey]);
    expect(publisherKeys(index, 'pub')).toEqual([pubKey]);
    expect(publisherKeys(index, 'nobody')).toEqual([]);
    expect(revokedKeysOf(index).size).toBe(1);
    // the newest version not yanked is offered
    expect(offeredVersion(alpha)?.version).toBe('1.1.0');
    expect(() => buildStoreIndex({ id: 's', name: 'S' }, [bundle('1.0.0')], undefined, { versions: { 'alpha@9.0.0': { yanked: { reason: 'x' } } } })).toThrow(/no bundle/);
    // a publisher the metadata does not list leaves the pack unsigned in the index
    expect(buildStoreIndex({ id: 's', name: 'S' }, [bundle('1.0.0')]).packs[0]?.publisher).toBeUndefined();
  });

  it('hides unreviewed versions when the deployment asks', () => {
    const pack: StoreIndexPack = {
      id: 'p',
      name: 'P',
      domain: 'p',
      license: 'CC0-1.0',
      author: { name: 'A' },
      versions: [
        { version: '2.0.0', url: 'x', sha256: 'a'.repeat(64), size: 1 },
        { version: '1.0.0', url: 'x', sha256: 'a'.repeat(64), size: 1, review: { status: 'reviewed', by: 'r', on: '2026-10-01' } },
      ],
    };
    expect(offeredVersion(pack)?.version).toBe('2.0.0');
    expect(offeredVersion(pack, { hideUnreviewed: true })?.version).toBe('1.0.0');
    expect(versionVisible(pack.versions[0]!, { hideUnreviewed: true })).toBe(false);
  });

  it('reports a malformed review, yank, publisher or revoked key', () => {
    const v = { version: '1.0.0', url: 'x', sha256: 'a'.repeat(64), size: 1 };
    const problems = parseStoreIndex({
      format: 1,
      store: { id: 's', name: 'S' },
      publishers: [{ id: 'Bad Id', name: '', key: 'nope' }],
      revokedKeys: [{ key: 'nope' }],
      packs: [
        {
          id: 'p',
          name: 'P',
          domain: 'p',
          license: 'CC0-1.0',
          author: { name: 'A' },
          publisher: 'ghost',
          versions: [
            { ...v, review: { status: 'reviewed' } },
            { ...v, version: '1.0.1', review: { status: 'flagged' } },
            { ...v, version: '1.0.2', review: { status: 'great' } },
            { ...v, version: '1.0.3', yanked: {} },
          ],
        },
      ],
    }).problems.join('\n');
    expect(problems).toMatch(/publishers\[0\].*kebab/);
    expect(problems).toMatch(/publishers\[0\].*no name/);
    expect(problems).toMatch(/publishers\[0\].*not a minisign public key/);
    expect(problems).toMatch(/revokedKeys\[0\]/);
    expect(problems).toMatch(/publisher 'ghost' is not in the index's publishers/);
    expect(problems).toMatch(/names who reviewed it and when/);
    expect(problems).toMatch(/a flagged version says why/);
    expect(problems).toMatch(/unreviewed, reviewed or flagged/);
    expect(problems).toMatch(/a yanked version says why/);
  });
});
