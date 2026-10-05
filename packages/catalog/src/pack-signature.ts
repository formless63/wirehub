/**
 * Signed pack manifests (`docs/catalog-store.md` §4, phase 5): a publisher signs
 * its pack's `wirehub-pack.json`, and the manifest pins every other file of the
 * pack by sha256 (`files`), so one signature covers the whole pack.
 *
 * - **What is hashed.** A `.json` file's digest is the sha256 of its canonical
 *   form (`JSON.stringify(value, null, 2)` plus a newline: what the catalog writes,
 *   and what a JSON bundle is re-encoded to), so the same pack verifies as a zip
 *   or as a JSON bundle. An image's digest is the sha256 of its bytes as shipped
 *   (before a studio strips anything active from an SVG).
 * - **What is signed.** The canonical form of the manifest, `files` included.
 * - **The signature** is `wirehub-pack.sig` beside the manifest (in a JSON
 *   bundle, its `signature` field): one or more minisign signatures (the format
 *   of the index's `.minisig`, `store-index.ts`) one after the other, so a
 *   publisher rotating its key can sign with the old and the new key at once.
 *
 * The keys come from the store index (`publishers`, `revokedKeys`): a pack is
 * accepted when one signature verifies with a current key of its publisher that
 * the index has not revoked. Pure and deterministic, like `store-index.ts`.
 */

import { createHash } from 'node:crypto';

import { normalStoreKey, signStoreIndex, verifyStoreSignature } from './store-index.ts';

export const PACK_MANIFEST_FILE = 'wirehub-pack.json';
export const PACK_SIGNATURE = 'wirehub-pack.sig';

const canonicalText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** A pack file's digest as the manifest's `files` pins it (lowercase hex sha256; JSON in canonical form). */
export function packFileDigest(path: string, bytes: Uint8Array): string {
  if (!path.endsWith('.json')) return hex(bytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return hex(bytes);
  }
  return hex(canonicalText(value));
}

/** The `files` a manifest pins: every file of the pack but the manifest and the signature, sorted. */
export function packDigests(files: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of [...files.keys()].sort()) {
    if (path === PACK_MANIFEST_FILE || path === PACK_SIGNATURE) continue;
    out[path] = packFileDigest(path, files.get(path)!);
  }
  return out;
}

/** The bytes a pack signature covers: the manifest in canonical form. */
export function packManifestMessage(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalText(manifest));
}

/**
 * What is wrong with the files of a pack against the `files` its manifest pins:
 * a listed file missing or different, a file present but not listed. Empty when
 * they agree, or when the manifest pins nothing (`files` absent).
 */
export function packFileProblems(manifest: { files?: unknown }, files: ReadonlyMap<string, Uint8Array>): string[] {
  if (manifest.files === undefined) return [];
  if (typeof manifest.files !== 'object' || manifest.files === null || Array.isArray(manifest.files)) return ['the manifest\'s "files" is not a map of file to sha256'];
  const pinned = manifest.files as Record<string, unknown>;
  const actual = packDigests(files);
  const problems: string[] = [];
  for (const [path, digest] of Object.entries(pinned)) {
    const want = typeof digest === 'string' ? digest.replace(/^sha256-/, '').toLowerCase() : '';
    if (actual[path] === undefined) problems.push(`'${path}' is pinned by the manifest but not in the pack`);
    else if (actual[path] !== want) problems.push(`'${path}' does not match the sha256 the manifest pins`);
  }
  for (const path of Object.keys(actual)) if (!(path in pinned)) problems.push(`'${path}' is in the pack but the manifest does not pin it`);
  return problems;
}

/** The minisign signatures in a `wirehub-pack.sig` (each four lines). */
export function splitPackSignatures(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 4) out.push(`${lines.slice(i, i + 4).join('\n')}\n`);
  return out;
}

/** `wirehub-pack.sig` for a manifest: one minisign signature per private key (PEM), in the order given. */
export function signPackManifest(manifest: unknown, pems: readonly string[]): string {
  if (pems.length === 0) throw new Error('Signing a pack needs at least one private key.');
  const m = manifest as { id?: unknown; version?: unknown };
  const comment = `wirehub pack ${String(m.id ?? '')} ${String(m.version ?? '')}`.trim();
  const message = packManifestMessage(manifest);
  return pems.map((pem) => signStoreIndex(message, pem, comment, 'wirehub publisher key')).join('');
}

export type PackSignatureCheck =
  /** signed by a current, unrevoked key of the publisher: `signers` are the keys that verified */
  | { ok: true; signers: string[] }
  /** not accepted: `revoked` lists the revoked keys that did sign it (signed only by revoked keys) */
  | { ok: false; reason: string; revoked?: string[] };

/**
 * Does `signature` (`wirehub-pack.sig`) sign `manifest` with one of `keys` (the
 * publisher's, from the index) that is not in `revoked`? A signature by a revoked
 * key never counts; when that is all there is, the answer says so.
 */
export function verifyPackSignature(manifest: unknown, signature: string | undefined, keys: readonly string[], revoked: ReadonlySet<string> | ReadonlyMap<string, unknown> = new Set()): PackSignatureCheck {
  if (signature === undefined || signature.trim() === '') return { ok: false, reason: 'the pack is not signed (no wirehub-pack.sig)' };
  if (keys.length === 0) return { ok: false, reason: 'its publisher has no key in the index' };
  const message = packManifestMessage(manifest);
  const blocks = splitPackSignatures(signature);
  const signers: string[] = [];
  const revokedSigners: string[] = [];
  let lastReason = 'the signature file is not in minisign format';
  // the publisher's keys, and the revoked ones (a key the publisher dropped when it was revoked still identifies a revoked signature)
  for (const key of new Set([...keys.map(normalStoreKey), ...revoked.keys()])) {
    for (const block of blocks) {
      const check = verifyStoreSignature(message, block, key, 'manifest');
      if (!check.ok) {
        if (!/different key/.test(check.reason)) lastReason = check.reason;
        continue;
      }
      if (revoked.has(key)) revokedSigners.push(key);
      else signers.push(key);
    }
  }
  if (signers.length > 0) return { ok: true, signers };
  if (revokedSigners.length > 0) return { ok: false, reason: 'it is signed only by a revoked key', revoked: revokedSigners };
  return { ok: false, reason: blocks.length === 0 ? lastReason : lastReason === 'the signature file is not in minisign format' ? 'no signature in it is by a key of its publisher' : lastReason };
}
