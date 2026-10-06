/**
 * The pack lifecycle as the browser sees it (`/api/packs`, `server/packs.ts`):
 * what is installed, the update diff, disable, and install from a file or URL.
 * Answers keep the server's whole body (plans, references, problems), because
 * a refusal here carries the list the person has to act on.
 */

export interface RecordRef {
  file: string;
  id: string;
  kind: string;
  label?: string;
}
export interface FieldChange {
  path: string;
  before?: unknown;
  after?: unknown;
}
export interface PackDiff {
  added: RecordRef[];
  changed: (RecordRef & { fields: FieldChange[] })[];
  removed: RecordRef[];
  unchanged: number;
}
export interface PackReference {
  from: RecordRef;
  field: string;
  to: string;
}
export interface PackPlan {
  pack: { id: string; name?: string; version?: string; from?: string; to?: string; license: string };
  diff?: PackDiff;
  major?: boolean;
  licenseChanged?: boolean;
  conflicts?: string[];
  references?: PackReference[];
  /** records the new version drops that something outside the pack still uses: kept, as the deployment's own */
  retired?: RecordRef[];
  issues?: { code: string; message: string }[];
  records?: RecordRef[];
  unmetRequires?: string[];
  ok: boolean;
}
export interface InstalledPackView {
  id: string;
  version: string;
  license: string;
  records: number;
  module?: string;
  available?: string;
  /** installed from a store index: which, and the publisher keys whose signature verified */
  origin?: { index: string; publisher?: string; signedBy?: string[] };
}
export interface PackAnswer {
  ok: boolean;
  status: number;
  /** the server's sentence, when it refused */
  error?: string;
  hint?: string;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown): Promise<PackAnswer> {
  try {
    const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const parsed = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    return {
      ok: response.ok,
      status: response.status,
      ...(typeof parsed['error'] === 'string' ? { error: parsed['error'] } : {}),
      ...(typeof parsed['hint'] === 'string' ? { hint: parsed['hint'] } : {}),
      body: parsed,
    };
  } catch (error) {
    return { ok: false, status: 0, error: 'The studio could not reach the workbench.', hint: error instanceof Error ? error.message : String(error), body: {} };
  }
}

const enc = encodeURIComponent;

export const listPacks = (base = '/api'): Promise<PackAnswer> => call('GET', `${base}/packs`);
export const previewUpdate = (id: string, base = '/api'): Promise<PackAnswer> => call('GET', `${base}/packs/${enc(id)}/update`);
export const applyUpdate = (id: string, acceptMajor: boolean, base = '/api'): Promise<PackAnswer> => call('POST', `${base}/packs/${enc(id)}/update`, { acceptMajor });
export const previewDisable = (id: string, base = '/api'): Promise<PackAnswer> => call('GET', `${base}/packs/${enc(id)}/references`);
export const disablePack = (id: string, base = '/api'): Promise<PackAnswer> => call('DELETE', `${base}/packs/${enc(id)}`);

/** What the person gave Install pack…: an uploaded file (zip or JSON bundle) or a URL. */
export type PackSource = { url: string } | { zip: string } | { bundle: unknown };

/** An uploaded file as a pack source: a zip travels base64, a JSON bundle as itself. */
export async function sourceOfFile(file: File): Promise<PackSource> {
  const buffer: ArrayBuffer =
    typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(file);
        });
  const bytes = new Uint8Array(buffer);
  const zip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (zip) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { zip: btoa(binary) };
  }
  return { bundle: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
}

/** For a pack that carries a code module: the publisher key to trust (an upload) and the owner's consent (`specs/runtime-modules.md` §2). */
export interface CodeInstallExtras {
  trustKey?: string;
  consent?: { code: string };
}
const extrasOf = (extra: CodeInstallExtras): CodeInstallExtras => ({ ...(extra.trustKey === undefined || extra.trustKey.trim() === '' ? {} : { trustKey: extra.trustKey.trim() }), ...(extra.consent === undefined ? {} : { consent: extra.consent }) });

export const previewInstall = (source: PackSource, base = '/api', extra: CodeInstallExtras = {}): Promise<PackAnswer> => call('POST', `${base}/packs/install`, { ...source, ...extrasOf(extra) });
export const applyInstall = (source: PackSource, sha256: string, acceptMajor: boolean, base = '/api', extra: CodeInstallExtras = {}): Promise<PackAnswer> =>
  call('POST', `${base}/packs/install`, { ...source, apply: true, sha256, acceptMajor, ...extrasOf(extra) });

/* ------------------------------------------------------------------ *
 * The store (`/api/packs/store`, `server/store.ts`)
 * ------------------------------------------------------------------ */

/** What the index publisher says about a version: information, not a gate. */
export type StoreReviewView = { status: 'unreviewed' } | { status: 'reviewed'; by: string; on: string; note?: string } | { status: 'flagged'; reason: string; by?: string; on?: string };
export interface StoreReleaseView {
  version: string;
  review: StoreReviewView;
  /** withdrawn by the index publisher: never offered, installed only when an owner forces it */
  yanked?: { reason: string; on?: string };
  /** every key that signed it is revoked: refused for install */
  revoked?: boolean;
}
/** A warning about an installed pack from a store index that lists it. */
export interface StoreNotice {
  id: string;
  version: string;
  index: string;
  store: { id: string; name: string };
  yanked?: { reason: string; on?: string };
  revoked?: { key: string; reason?: string; on?: string }[];
  review?: StoreReviewView;
  /** the version the index offers now */
  suggest?: string;
}

/** One pack a trusted, verified store index lists. Licence and author are the author's statement, shown as information. */
export interface StorePackView {
  index: string;
  store: { id: string; name: string; homepage?: string };
  /** the name shown for the store: the label it was given here, else its own name */
  storeLabel?: string;
  id: string;
  name: string;
  description?: string;
  domain: string;
  license: string;
  author: { id?: string; name: string };
  /** the publisher whose key signs it; absent = pinned by the index's sha256 only */
  publisher?: { id: string; name: string; url?: string };
  homepage?: string;
  /** the version offered for install: the newest not yanked */
  latest?: { version: string; size: number; review?: StoreReviewView; module?: { id: string; version: string; label: string; apiVersion: string; extensionPoints: string[]; permissions: string[] } };
  versions: string[];
  releases?: StoreReleaseView[];
  /** the version installed here, if any */
  installed?: string;
  /** the installed pack came from another store (this index URL): no install or update is offered from here */
  installedFrom?: string;
  action: 'install' | 'update' | 'current' | 'newer-installed' | 'unavailable' | 'other-store';
}
export interface StoreIndexView {
  url: string;
  ok: boolean;
  store?: { id: string; name: string };
  /** `env`/`official`: named by the deployment; `user`: added in Settings */
  source?: 'env' | 'official' | 'user';
  label?: string;
  packs?: number;
  error?: string;
}

export const listStore = (base = '/api'): Promise<PackAnswer> => call('GET', `${base}/packs/store`);
/** `force`: install a yanked version anyway (owners only; the server refuses anyone else). */
export const previewStoreInstall = (pack: { index: string; id: string; version?: string; force?: boolean }, base = '/api'): Promise<PackAnswer> =>
  call('POST', `${base}/packs/store/install`, { index: pack.index, id: pack.id, ...(pack.version === undefined ? {} : { version: pack.version }), ...(pack.force === true ? { force: true } : {}) });
export const applyStoreInstall = (pack: { index: string; id: string; version: string; force?: boolean }, sha256: string, acceptMajor: boolean, base = '/api', consent?: { code: string }): Promise<PackAnswer> =>
  call('POST', `${base}/packs/store/install`, { index: pack.index, id: pack.id, version: pack.version, apply: true, sha256, acceptMajor, ...(pack.force === true ? { force: true } : {}), ...(consent === undefined ? {} : { consent }) });

/** One line for a review status. */
export function reviewText(review: StoreReviewView | undefined): string {
  if (review === undefined || review.status === 'unreviewed') return 'unreviewed';
  if (review.status === 'reviewed') return `reviewed by ${review.by} on ${review.on}`;
  return `flagged: ${review.reason}`;
}

/** One sentence for a notice about an installed pack. */
export function noticeText(n: StoreNotice): string {
  const parts: string[] = [];
  if (n.yanked !== undefined) parts.push(`${n.version} was yanked by ${n.store.name}: ${n.yanked.reason}`);
  if (n.revoked !== undefined) parts.push(`${n.version} is signed only by a revoked key${n.revoked.some((r) => r.reason !== undefined) ? ` (${n.revoked.map((r) => r.reason).filter((r) => r !== undefined).join('; ')})` : ''}`);
  if (n.review?.status === 'flagged') parts.push(`${n.version} is flagged by ${n.store.name}: ${n.review.reason}`);
  return `${parts.join('. ')}.${n.suggest === undefined ? '' : ` Update to ${n.suggest} suggested.`}`;
}
