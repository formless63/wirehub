/**
 * The catalog store's **index** (`docs/catalog-store.md` §4): a static JSON
 * document listing packs, their versions, download URLs, sizes and sha256
 * hashes, signed with ed25519 by the store's key. Anyone can host one on a
 * static host; a deployment trusts an index by its public key
 * (`WIREHUB_STORE_INDEXES`).
 *
 * Signatures are **minisign-compatible**: `index.json.minisig` beside the
 * index is a minisign signature (the prehashed `ED` algorithm: ed25519 over
 * the BLAKE2b-512 of the file, plus the global signature over the trusted
 * comment), and the public key is minisign's one-line base64 form (`RW…`), so
 * `minisign -Vm index.json -P <key>` verifies an index too. The private key is
 * an ordinary PKCS#8 PEM ed25519 key (what `node:crypto` and `openssl genpkey
 * -algorithm ed25519` produce); the key id is derived from the public key
 * (the first 8 bytes of its sha256), so the public key can always be printed
 * again from the private one.
 *
 * Pure and deterministic: no clock, no randomness, no network. Key generation
 * and fetching live in the callers (`scripts/store-index.mjs`, the studio
 * server's `store.ts`).
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

import type { PackManifest } from './packs.ts';

// kept free of other runtime imports, so `scripts/store-index.mjs` runs it with plain Node (no install)
const parts = (v: string): number[] => (v.split(/[-+]/)[0] ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
/** -1, 0, 1 (prerelease tags ignored), as `compareVersions` in `pack-lifecycle.ts`. */
function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export const STORE_INDEX_FORMAT = 1;
/** The signature sits at the index URL plus this. */
export const STORE_SIGNATURE_SUFFIX = '.minisig';

/** The sentence every store view shows: the store lists, it does not vouch. */
export const STORE_DISCLAIMER =
  'Packs in a store are published by their authors, who are responsible for their content and licensing. WireHub does not review or police third-party packs; the licence and provenance shown are information from the author, not checked. A signature means the index is the one its store published, unmodified, not that the data is right.';

/**
 * What the index publisher says about a version's data (phase 5): information,
 * never a gate in WireHub itself. `unreviewed` is the default when the index says
 * nothing; `reviewed` names who checked it against its cited sources and when;
 * `flagged` says what is wrong with it. A deployment may choose to hide unreviewed
 * versions (`WIREHUB_STORE_HIDE_UNREVIEWED`).
 */
export type StoreReview =
  | { status: 'unreviewed' }
  | { status: 'reviewed'; by: string; on: string; note?: string }
  | { status: 'flagged'; reason: string; by?: string; on?: string };

/** A version the index publisher withdrew: still listed and downloadable (old designs re-validate against it), never offered for install. */
export interface StoreYank {
  reason: string;
  /** ISO date */
  on?: string;
}

/** A publisher of packs, with the keys its packs are signed with (`wirehub-pack.sig`). */
export interface StorePublisher {
  /** kebab; a pack's manifest names it as `publisher.id` */
  id: string;
  name: string;
  /** the current signing key (minisign `RW…`) */
  key: string;
  /** other keys still valid for packs signed before a rotation */
  keys?: string[];
  url?: string;
}

/** A key the index publisher revoked: packs signed only by it are refused for install and flagged where installed. */
export interface StoreRevokedKey {
  key: string;
  reason?: string;
  /** ISO date */
  on?: string;
}

export interface StoreIndexVersion {
  version: string;
  /** the bundle: absolute https, or relative to the index URL */
  url: string;
  /** lowercase hex of the bundle's bytes */
  sha256: string;
  /** bytes */
  size: number;
  /** when it differs from the pack's */
  license?: string;
  requires?: PackManifest['requires'];
  /** the review status; absent = `unreviewed` */
  review?: StoreReview;
  /** withdrawn by the index publisher */
  yanked?: StoreYank;
  /** the publisher keys whose signature over this version's manifest the builder verified (`RW…`); information, the hub verifies again */
  signedBy?: string[];
}

export interface StoreIndexPack {
  id: string;
  name: string;
  description?: string;
  /** the field it serves (`pro-audio`, `fieldbus` …); free text, for filtering */
  domain: string;
  /** SPDX, as the author states it: information, not a gate */
  license: string;
  author: { id?: string; name: string };
  /** the id of the publisher (`StoreIndex.publishers`) whose key must sign every version; absent = the pack is pinned by the index only */
  publisher?: string;
  homepage?: string;
  /** newest first */
  versions: StoreIndexVersion[];
}

export interface StoreIndex {
  format: 1;
  store: { id: string; name: string; homepage?: string };
  /** when the index was built (ISO 8601), as the builder said */
  generated?: string;
  /** the publishers whose keys sign packs (phase 5) */
  publishers?: StorePublisher[];
  /** keys revoked by the index publisher */
  revokedKeys?: StoreRevokedKey[];
  packs: StoreIndexPack[];
}

/* ------------------------------------------------------------------ *
 * Reading an index
 * ------------------------------------------------------------------ */

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isKey = (v: unknown): boolean => {
  try {
    parseStorePublicKey(String(v));
    return typeof v === 'string';
  } catch {
    return false;
  }
};

/** The review sentence problems of one version's `review`, if any. */
function reviewProblems(review: unknown, at: string): string[] {
  if (review === undefined) return [];
  const r = review as Partial<{ status: string; by: unknown; on: unknown; reason: unknown }> | null;
  if (typeof r !== 'object' || r === null) return [`${at}: review is not an object`];
  if (r.status === 'unreviewed') return [];
  if (r.status === 'reviewed') return isText(r.by) && isText(r.on) ? [] : [`${at}: a reviewed version names who reviewed it and when ({ by, on })`];
  if (r.status === 'flagged') return isText(r.reason) ? [] : [`${at}: a flagged version says why ({ reason })`];
  return [`${at}: review status must be unreviewed, reviewed or flagged`];
}

/** An index's shape checked: the index, or the sentences saying what is wrong with it. */
export function parseStoreIndex(value: unknown): { index: StoreIndex; problems: [] } | { index?: undefined; problems: string[] } {
  const problems: string[] = [];
  const v = value as Partial<StoreIndex> | null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { problems: ['the index is not a JSON object'] };
  if (v.format !== STORE_INDEX_FORMAT) problems.push(`unsupported index format ${String(v.format)}`);
  if (typeof v.store !== 'object' || v.store === null || !isText(v.store.id) || !isText(v.store.name)) problems.push('the index names no store ({ id, name })');
  if (!Array.isArray(v.packs)) problems.push('the index has no packs list');
  const publishers = new Set<string>();
  if (v.publishers !== undefined && !Array.isArray(v.publishers)) problems.push('publishers is not a list');
  for (const [i, pub] of (Array.isArray(v.publishers) ? v.publishers : []).entries()) {
    const at = `publishers[${i}]${isText(pub?.id) ? ` (${pub.id})` : ''}`;
    if (!KEBAB.test(pub?.id ?? '')) problems.push(`${at}: the id must be kebab-case`);
    else if (publishers.has(pub.id)) problems.push(`${at}: listed twice`);
    publishers.add(pub?.id);
    if (!isText(pub?.name)) problems.push(`${at}: no name`);
    if (!isKey(pub?.key)) problems.push(`${at}: key is not a minisign public key (RW…)`);
    if (pub?.keys !== undefined && (!Array.isArray(pub.keys) || !pub.keys.every(isKey))) problems.push(`${at}: keys is not a list of minisign public keys`);
  }
  if (v.revokedKeys !== undefined && !Array.isArray(v.revokedKeys)) problems.push('revokedKeys is not a list');
  for (const [i, r] of (Array.isArray(v.revokedKeys) ? v.revokedKeys : []).entries()) {
    if (!isKey(r?.key)) problems.push(`revokedKeys[${i}]: key is not a minisign public key (RW…)`);
  }
  const seen = new Set<string>();
  for (const [i, p] of (Array.isArray(v.packs) ? v.packs : []).entries()) {
    const at = `packs[${i}]${isText(p?.id) ? ` (${p.id})` : ''}`;
    if (typeof p !== 'object' || p === null) {
      problems.push(`${at} is not an object`);
      continue;
    }
    if (!KEBAB.test(p.id ?? '')) problems.push(`${at}: the id must be kebab-case`);
    else if (seen.has(p.id)) problems.push(`${at}: listed twice`);
    seen.add(p.id);
    if (!isText(p.name)) problems.push(`${at}: no name`);
    if (!isText(p.domain)) problems.push(`${at}: no domain`);
    if (!isText(p.license)) problems.push(`${at}: no licence`);
    if (typeof p.author !== 'object' || p.author === null || !isText(p.author.name)) problems.push(`${at}: no author ({ name })`);
    if (p.publisher !== undefined && !publishers.has(p.publisher)) problems.push(`${at}: publisher '${String(p.publisher)}' is not in the index's publishers`);
    if (!Array.isArray(p.versions) || p.versions.length === 0) {
      problems.push(`${at}: no versions`);
      continue;
    }
    for (const [j, ver] of p.versions.entries()) {
      const vat = `${at} versions[${j}]`;
      if (!SEMVER.test(ver?.version ?? '')) problems.push(`${vat}: the version is not semver`);
      if (!isText(ver?.url)) problems.push(`${vat}: no url`);
      if (!HEX64.test(ver?.sha256 ?? '')) problems.push(`${vat}: sha256 is not 64 lowercase hex digits`);
      if (!Number.isInteger(ver?.size) || (ver?.size ?? 0) <= 0) problems.push(`${vat}: size is not a positive whole number of bytes`);
      problems.push(...reviewProblems(ver?.review, vat));
      if (ver?.yanked !== undefined && (typeof ver.yanked !== 'object' || ver.yanked === null || !isText(ver.yanked.reason))) problems.push(`${vat}: a yanked version says why ({ reason })`);
      if (ver?.signedBy !== undefined && (!Array.isArray(ver.signedBy) || !ver.signedBy.every(isKey))) problems.push(`${vat}: signedBy is not a list of minisign public keys`);
    }
  }
  return problems.length > 0 ? { problems } : { index: v as StoreIndex, problems: [] };
}

/** The newest version of a pack the index lists. */
export function latestVersion(pack: StoreIndexPack): StoreIndexVersion | undefined {
  return [...pack.versions].sort((a, b) => compareVersions(b.version, a.version))[0];
}

/** A version's review status: `unreviewed` when the index says nothing. */
export const reviewOf = (version: StoreIndexVersion): StoreReview => version.review ?? { status: 'unreviewed' };

/** Is this version shown here? With `hideUnreviewed`, only versions someone reviewed (or flagged) are. */
export const versionVisible = (version: StoreIndexVersion, options: { hideUnreviewed?: boolean } = {}): boolean => options.hideUnreviewed !== true || reviewOf(version).status !== 'unreviewed';

/** The version the store offers for install: the newest one that is not yanked (and visible, with `hideUnreviewed`). */
export function offeredVersion(pack: StoreIndexPack, options: { hideUnreviewed?: boolean } = {}): StoreIndexVersion | undefined {
  return [...pack.versions].sort((a, b) => compareVersions(b.version, a.version)).find((v) => v.yanked === undefined && versionVisible(v, options));
}

/** A minisign public key in one canonical form (the bare `RW…` line), for comparing keys. */
export function normalStoreKey(text: string): string {
  const { keyId, key } = parseStorePublicKey(text);
  return Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey(key)]).toString('base64');
}

/** The keys a publisher of this index signs with (current first), normalised. */
export function publisherKeys(index: StoreIndex, publisherId: string): string[] {
  const pub = index.publishers?.find((p) => p.id === publisherId);
  return pub === undefined ? [] : [...new Set([pub.key, ...(pub.keys ?? [])].map(normalStoreKey))];
}

/** The keys this index revokes, normalised, with why. */
export function revokedKeysOf(index: StoreIndex): Map<string, StoreRevokedKey> {
  return new Map((index.revokedKeys ?? []).map((r) => [normalStoreKey(r.key), r] as const));
}

/* ------------------------------------------------------------------ *
 * Building an index from bundles
 * ------------------------------------------------------------------ */

/** One bundle file the builder found: its manifest and its bytes' digest. */
export interface StoreBundle {
  manifest: PackManifest & { domain?: string; author?: { id?: string; name: string } };
  /** where the index points at it: a file name relative to the index, or an absolute URL */
  url: string;
  sha256: string;
  size: number;
  /** the publisher keys whose signature over the manifest the builder verified */
  signedBy?: string[];
}

/**
 * What the index publisher says beside the bundles (`store-meta.json` for
 * `scripts/store-index.mjs build`): the publishers and their keys, revoked keys,
 * and per version (`"<id>@<version>"`) its review status and whether it is yanked.
 */
export interface StoreMeta {
  publishers?: StorePublisher[];
  revokedKeys?: StoreRevokedKey[];
  versions?: Record<string, { review?: StoreReview; yanked?: StoreYank }>;
}

/**
 * The index for a set of bundles: one entry per pack id, its versions newest
 * first; the pack's name, description, licence and author come from its newest
 * version. Packs sorted by id, so the same bundles always give the same bytes.
 * With `meta`, a pack whose manifest names a listed publisher carries it
 * (`publisher`), and each version its review status and yank.
 */
export function buildStoreIndex(store: StoreIndex['store'], bundles: readonly StoreBundle[], generated?: string, meta: StoreMeta = {}): StoreIndex {
  const byId = new Map<string, StoreBundle[]>();
  for (const b of bundles) byId.set(b.manifest.id, [...(byId.get(b.manifest.id) ?? []), b]);
  const packs: StoreIndexPack[] = [];
  for (const id of [...byId.keys()].sort()) {
    const list = (byId.get(id) ?? []).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
    const versions = new Set<string>();
    for (const b of list) {
      if (versions.has(b.manifest.version)) throw new Error(`Pack '${id}' ${b.manifest.version} is in the bundles twice.`);
      versions.add(b.manifest.version);
    }
    const top = list[0]!.manifest;
    const author = top.author ?? (top.publisher === undefined ? undefined : { id: top.publisher.id, name: top.publisher.name });
    const publisher = top.publisher?.id !== undefined && meta.publishers?.some((p) => p.id === top.publisher?.id) === true ? top.publisher.id : undefined;
    packs.push({
      id,
      name: top.name,
      ...(top.description === undefined ? {} : { description: top.description }),
      domain: top.domain ?? id,
      license: top.license,
      author: author ?? { name: store.name },
      ...(publisher === undefined ? {} : { publisher }),
      ...(top.homepage === undefined ? {} : { homepage: top.homepage }),
      versions: list.map((b) => {
        const said = meta.versions?.[`${id}@${b.manifest.version}`];
        return {
          version: b.manifest.version,
          url: b.url,
          sha256: b.sha256,
          size: b.size,
          ...(b.manifest.license === top.license ? {} : { license: b.manifest.license }),
          ...(b.manifest.requires === undefined ? {} : { requires: b.manifest.requires }),
          ...(said?.review === undefined || said.review.status === 'unreviewed' ? {} : { review: said.review }),
          ...(said?.yanked === undefined ? {} : { yanked: said.yanked }),
          ...(b.signedBy === undefined || b.signedBy.length === 0 ? {} : { signedBy: b.signedBy }),
        };
      }),
    });
  }
  const unknown = Object.keys(meta.versions ?? {}).filter((key) => !packs.some((p) => p.versions.some((v) => `${p.id}@${v.version}` === key)));
  if (unknown.length > 0) throw new Error(`The store metadata names versions no bundle has: ${unknown.join(', ')}.`);
  return {
    format: 1,
    store,
    ...(generated === undefined ? {} : { generated }),
    ...(meta.publishers === undefined || meta.publishers.length === 0 ? {} : { publishers: [...meta.publishers].sort((a, b) => a.id.localeCompare(b.id)) }),
    ...(meta.revokedKeys === undefined || meta.revokedKeys.length === 0 ? {} : { revokedKeys: meta.revokedKeys }),
    packs,
  };
}

/* ------------------------------------------------------------------ *
 * Keys and signatures (minisign-compatible)
 * ------------------------------------------------------------------ */

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

function rawPublicKey(key: KeyObject): Buffer {
  const x = (key.export({ format: 'jwk' }) as { x?: string }).x;
  if (x === undefined) throw new Error('That is not an ed25519 key.');
  return Buffer.from(x, 'base64url');
}

/** The 8-byte key id of a raw public key: the first 8 bytes of its sha256. */
export const storeKeyId = (publicKey: Uint8Array): Buffer => createHash('sha256').update(publicKey).digest().subarray(0, 8);

/** A key id as minisign prints it: the little-endian u64, upper-case hex. */
const keyIdHex = (id: Uint8Array): string => Buffer.from(id).reverse().toString('hex').toUpperCase();

/** The private key of a PKCS#8 PEM text (the `WIREHUB_STORE_SIGNING_KEY` secret). */
export function storePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem.trim().replace(/\\n/g, '\n'), format: 'pem' });
  } catch {
    throw new Error('The signing key is not a PKCS#8 PEM private key (the text openssl or store-index.mjs keygen writes).');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`The signing key is ${key.asymmetricKeyType ?? 'not'} an ed25519 key; the store signs with ed25519.`);
  return key;
}

/** The minisign public key line (`RW…`) of a private key: what a deployment puts in `WIREHUB_STORE_INDEXES`. */
export function storePublicKeyOf(pem: string): string {
  const pk = rawPublicKey(createPublicKey(storePrivateKey(pem)));
  return Buffer.concat([Buffer.from('Ed'), storeKeyId(pk), pk]).toString('base64');
}

/** The public key as a minisign `.pub` file (two lines). */
export function storePublicKeyFile(publicKey: string): string {
  const { keyId } = parseStorePublicKey(publicKey);
  return `untrusted comment: minisign public key ${keyIdHex(keyId)}\n${publicKey.trim()}\n`;
}

/** A minisign public key, the bare `RW…` line or the whole two-line file. */
export function parseStorePublicKey(text: string): { keyId: Buffer; key: KeyObject } {
  const line = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('untrusted comment:'))[0];
  const bytes = Buffer.from(line ?? '', 'base64');
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString() !== 'Ed') throw new Error('That is not a minisign ed25519 public key (RW…).');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(bytes.subarray(10)) }, format: 'jwk' });
  return { keyId: Buffer.from(bytes.subarray(2, 10)), key };
}

/**
 * What a person compares when they decide to trust a store's key: the minisign key
 * id (as `wirehub-store.pub` prints it) and a sha256 fingerprint of the whole key,
 * as eight groups of four upper-case hex digits. Throws on text that is not a key.
 */
export function storeKeyFingerprint(publicKey: string): { keyId: string; fingerprint: string } {
  const { keyId, key } = parseStorePublicKey(publicKey);
  const raw = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey(key)]);
  const hex = createHash('sha256').update(raw).digest('hex').toUpperCase().slice(0, 32);
  return { keyId: keyIdHex(keyId), fingerprint: (hex.match(/.{4}/g) ?? []).join(' ') };
}

const blake2b512 = (bytes: Uint8Array): Buffer => createHash('blake2b512').update(bytes).digest();

/**
 * A minisign signature (`.minisig` text) of `message` by the PEM key: the
 * prehashed `ED` algorithm, with `trustedComment` signed too (one line).
 */
export function signStoreIndex(message: Uint8Array, pem: string, trustedComment = 'wirehub store index', keyLabel = 'wirehub store key'): string {
  if (/[\r\n]/.test(trustedComment)) throw new Error('The trusted comment is one line.');
  const key = storePrivateKey(pem);
  const pk = rawPublicKey(createPublicKey(key));
  const id = storeKeyId(pk);
  const signature = sign(null, blake2b512(message), key);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), key);
  return [
    `untrusted comment: signature from ${keyLabel} ${keyIdHex(id)}`,
    Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64'),
    `trusted comment: ${trustedComment}`,
    global.toString('base64'),
    '',
  ].join('\n');
}

export type StoreSignatureCheck = { ok: true; trustedComment: string } | { ok: false; reason: string };

/**
 * Does `signature` (`.minisig` text) sign `message` with `publicKey`? Accepts
 * minisign's `ED` (prehashed) and legacy `Ed` signatures, and checks the
 * trusted comment's global signature as minisign does.
 */
export function verifyStoreSignature(message: Uint8Array, signature: string, publicKey: string, subject = 'index'): StoreSignatureCheck {
  let pub: { keyId: Buffer; key: KeyObject };
  try {
    pub = parseStorePublicKey(publicKey);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const lines = signature.split(/\r?\n/);
  const sigLine = lines[1]?.trim() ?? '';
  const comment = lines[2] ?? '';
  const globalLine = lines[3]?.trim() ?? '';
  if (!lines[0]?.startsWith('untrusted comment:') || !comment.startsWith('trusted comment: ')) return { ok: false, reason: 'the signature file is not in minisign format' };
  const sig = Buffer.from(sigLine, 'base64');
  if (sig.length !== 74) return { ok: false, reason: 'the signature file is not in minisign format' };
  const alg = sig.subarray(0, 2).toString();
  if (alg !== 'ED' && alg !== 'Ed') return { ok: false, reason: `unknown signature algorithm '${alg}'` };
  if (!sig.subarray(2, 10).equals(pub.keyId)) return { ok: false, reason: `the ${subject} was signed by a different key than the one trusted for it` };
  const raw = sig.subarray(10);
  if (!verify(null, alg === 'ED' ? blake2b512(message) : message, pub.key, raw)) return { ok: false, reason: `the signature does not match the ${subject}` };
  const trustedComment = comment.slice('trusted comment: '.length);
  const global = Buffer.from(globalLine, 'base64');
  if (global.length !== 64 || !verify(null, Buffer.concat([raw, Buffer.from(trustedComment)]), pub.key, global)) return { ok: false, reason: 'the trusted comment was changed' };
  return { ok: true, trustedComment };
}
