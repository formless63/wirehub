/** Blob object key (`specs/postgres-backend.md` §5.1): `<org uuid>/sha256/<aa>/<bb>/<hex>`. */
export function blobObjectKey(orgId: string, sha256: string): string {
  return `${orgId}/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** A derived blob's object key: under its own prefix, so a backup mirror can leave rebuildable bytes out (§5.5, §8.4). */
export function derivedObjectKey(orgId: string, sha256: string): string {
  return `${orgId}/derived/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}
