/**
 * Where firmware bytes live: uploaded source, compiled images, size reports and build logs,
 * content-addressed (`firmware/sha256/<hash>`). The hub's blob store when one is configured
 * (`WIREHUB_BLOBS`, `blobs.ts`), else a directory beside the catalog (`data/.firmware-blobs/`,
 * gitignored) — the same fallback the model cache uses.
 */

import { dataPath } from '@wirehub/catalog';
import { blobStoreFromEnv, fsBlobStore, type BlobStore } from '../blobs.ts';

export interface FirmwareBytes {
  get(sha256: string): Promise<Buffer | undefined>;
  put(sha256: string, bytes: Uint8Array): Promise<void>;
}

let store: BlobStore | undefined;
let override: FirmwareBytes | undefined;

/** Tests (and a host that wires its own store) set this. */
export function setFirmwareBytes(bytes: FirmwareBytes | undefined): void {
  override = bytes;
}

const keyOf = (sha: string): string => {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`Not a content address: ${sha}`);
  return `firmware/sha256/${sha}`;
};

export function firmwareBytes(): FirmwareBytes {
  if (override !== undefined) return override;
  store ??= blobStoreFromEnv(process.env) ?? fsBlobStore(dataPath('.firmware-blobs'));
  const s = store;
  return {
    get: (sha) => s.get(keyOf(sha)),
    async put(sha, bytes) {
      const key = keyOf(sha);
      if (!(await s.has(key))) await s.put(key, Buffer.from(bytes), 'application/octet-stream');
    },
  };
}
