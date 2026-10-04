/** Blob object key (`specs/postgres-backend.md` §5.1): `<org uuid>/sha256/<aa>/<bb>/<hex>`. */
export function blobObjectKey(orgId: string, sha256: string): string {
  return `${orgId}/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}
