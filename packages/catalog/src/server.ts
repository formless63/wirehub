/**
 * The server-only half of `@wirehub/catalog`: the store index and pack signatures,
 * which use `node:crypto` (ed25519, blake2b). Kept out of the package root so the
 * browser bundle (and Vite's dev server) never loads it.
 *
 *   import { verifyPackSignature } from '@wirehub/catalog/src/server.ts';
 */

export {
  STORE_DISCLAIMER,
  STORE_INDEX_FORMAT,
  STORE_SIGNATURE_SUFFIX,
  buildStoreIndex,
  latestVersion,
  normalStoreKey,
  offeredVersion,
  parseStoreIndex,
  publisherKeys,
  reviewOf,
  revokedKeysOf,
  versionVisible,
  parseStorePublicKey,
  signStoreIndex,
  storeKeyFingerprint,
  storeKeyId,
  storePrivateKey,
  storePublicKeyFile,
  storePublicKeyOf,
  verifyStoreSignature,
} from './store-index.ts';
export type { StoreBundle, StoreIndex, StoreIndexModule, StoreIndexPack, StoreIndexVersion, StoreMeta, StorePublisher, StoreReview, StoreRevokedKey, StoreSignatureCheck, StoreYank } from './store-index.ts';
export { PACK_SIGNATURE, packDigests, packFileDigest, packFileProblems, packManifestMessage, signPackManifest, splitPackSignatures, verifyPackSignature } from './pack-signature.ts';
export type { PackSignatureCheck } from './pack-signature.ts';
