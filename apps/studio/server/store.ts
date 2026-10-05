/**
 * Store browsing (`docs/catalog-store.md` §4): the packs listed by the store
 * indexes this deployment trusts, and install / update from one of them.
 *
 *   GET  /api/packs/store           the packs of every configured index, each index
 *                                   fetched and its signature verified against the
 *                                   public key configured for it; an index that does
 *                                   not verify is listed as refused, with its packs left out
 *   POST /api/packs/store/install   { index, id, version?, apply?, sha256?, acceptMajor? }: download
 *                                   the bundle the (verified) index names, check its size
 *                                   and sha256 against the index, then hand it to the
 *                                   ordinary install flow (`POST /api/packs/install`):
 *                                   without `apply` the diff, with it one change set
 *
 * The trusted indexes are `WIREHUB_STORE_INDEXES` (`storeIndexesFromEnv`): a list of
 * `<url> <public key>`; `official` names WireHub's own index once its key is published.
 * WireHub does not police what third-party packs contain: the licence and provenance
 * are shown as the author states them, beside the disclaimer (`STORE_DISCLAIMER`).
 *
 * Under `/api/packs`, so the same rules hold: owners and editors install, viewers read,
 * and no API token may write.
 */

import { STORE_DISCLAIMER, STORE_SIGNATURE_SUFFIX, compareVersions, latestVersion, parseStoreIndex, parseStorePublicKey, verifyStoreSignature, type StoreIndex, type StoreIndexPack } from '@wirehub/catalog';
import type { ModuleRegistry } from '@wirehub/modules';

import type { ApiResponse } from './api.ts';
import type { Env } from './env.ts';
import { PackArchiveError, fetchPack, isZip, readPackBytes, sha256, type FetchPackOptions } from './pack-archive.ts';
import { handlePacksRequest } from './packs.ts';
import type { SetupDeps } from './setup.ts';

export const STORE_ROUTES = ['GET    /api/packs/store', 'POST   /api/packs/store/install'] as const;

/** Where the official index of WireHub's bundled packs is published (the pages workflow). */
export const OFFICIAL_STORE_INDEX_URL = 'https://formless63.github.io/wirehub/store/index.json';

/**
 * The official index's public key (minisign `RW…` form).
 *
 * PLACEHOLDER: empty until the owner creates the signing key. Then:
 *   node scripts/store-index.mjs pubkey --key <private key file>
 * prints the line to put here (and in docs/catalog-store.md). While it is empty the
 * official index is not trusted by default; `WIREHUB_STORE_INDEXES` can still name it
 * with a key.
 */
export const OFFICIAL_STORE_PUBLIC_KEY = '';

export interface TrustedStoreIndex {
  url: string;
  /** minisign public key, `RW…` */
  publicKey: string;
}

export interface StoreDeps {
  indexes: readonly TrustedStoreIndex[];
  /** sentences about `WIREHUB_STORE_INDEXES` entries that were ignored */
  problems?: readonly string[];
  /** how indexes and bundles are fetched (tests inject one); else the setup's `packFetch` */
  fetch?: FetchPackOptions;
}

/**
 * `WIREHUB_STORE_INDEXES`: entries separated by commas or new lines, each
 * `<https url> <public key>`; the word `official` stands for WireHub's own index.
 * Unset: the official index when its key is published, else none. Empty or `none`: none.
 */
export function storeIndexesFromEnv(env: Env = process.env): StoreDeps {
  const raw = env['WIREHUB_STORE_INDEXES'];
  const official = (): TrustedStoreIndex[] => (OFFICIAL_STORE_PUBLIC_KEY === '' ? [] : [{ url: OFFICIAL_STORE_INDEX_URL, publicKey: OFFICIAL_STORE_PUBLIC_KEY }]);
  if (raw === undefined) return { indexes: official() };
  const indexes: TrustedStoreIndex[] = [];
  const problems: string[] = [];
  for (const entry of raw.split(/[,\n]/).map((e) => e.trim()).filter((e) => e !== '' && e !== 'none')) {
    if (entry === 'official') {
      if (OFFICIAL_STORE_PUBLIC_KEY === '') problems.push("'official': this build has no public key for the official index yet; name it with its key instead.");
      indexes.push(...official());
      continue;
    }
    const [url, key, ...extra] = entry.split(/\s+/);
    if (url === undefined || key === undefined || extra.length > 0) {
      problems.push(`'${entry}': an entry is '<https url> <public key>'.`);
      continue;
    }
    if (!/^https:\/\//.test(url)) {
      problems.push(`'${url}': a store index is fetched over https only.`);
      continue;
    }
    try {
      parseStorePublicKey(key);
    } catch {
      problems.push(`'${url}': '${key}' is not a minisign public key (RW…).`);
      continue;
    }
    indexes.push({ url, publicKey: key });
  }
  return { indexes, problems };
}

/**
 * Is this a store route? (Checked before the other `/api/packs` routes.) Only
 * `GET /api/packs/store` and `/api/packs/store/install`, so a pack whose id is
 * `store` is still updated and disabled at `/api/packs/store…` like any other.
 */
export function isStorePath(path: string, method = 'GET'): boolean {
  const p = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  const m = method.toUpperCase();
  return (p === '/api/packs/store' && (m === 'GET' || m === 'HEAD')) || p === '/api/packs/store/install';
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const refuse = (status: number, error: string, hint?: string, extra?: object): ApiResponse => json(status, { error, ...(hint === undefined ? {} : { hint }), ...extra });

export class StoreIndexError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'StoreIndexError';
    this.status = status;
  }
}

/** Fetch an index and its `.minisig`, verify the signature with the trusted key, check its shape. */
export async function fetchVerifiedIndex(trusted: TrustedStoreIndex, options: FetchPackOptions = {}): Promise<StoreIndex> {
  const get = async (url: string, what: string): Promise<Uint8Array> => {
    try {
      return await fetchPack(url, options);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new StoreIndexError(`Could not fetch the ${what} (${why})`);
    }
  };
  const bytes = await get(trusted.url, 'index');
  const signature = await get(`${trusted.url}${STORE_SIGNATURE_SUFFIX}`, 'index signature; an unsigned index is refused');
  const check = verifyStoreSignature(bytes, new TextDecoder().decode(signature), trusted.publicKey);
  if (!check.ok) throw new StoreIndexError(`The index was refused: ${check.reason}.`, 422);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new StoreIndexError('The index is signed but is not JSON.', 422);
  }
  const parsed = parseStoreIndex(value);
  if (parsed.index === undefined) throw new StoreIndexError(`The index is signed but not valid: ${parsed.problems.slice(0, 3).join('; ')}.`, 422);
  return parsed.index;
}

interface InstalledView {
  id: string;
  version: string;
}

async function installedPacks(setup: SetupDeps, modules: ModuleRegistry | undefined): Promise<InstalledView[]> {
  const answer = await handlePacksRequest({ method: 'GET', path: '/api/packs' }, setup, modules);
  return answer.status === 200 ? ((answer.body as { packs: InstalledView[] }).packs ?? []) : [];
}

/** What the store can do with a pack here: install it, update to the newest, nothing (current), or nothing (the hub has a newer one). */
function actionOf(pack: StoreIndexPack, installed: string | undefined): 'install' | 'update' | 'current' | 'newer-installed' {
  const latest = latestVersion(pack)?.version ?? '0.0.0';
  if (installed === undefined) return 'install';
  const order = compareVersions(latest, installed);
  return order > 0 ? 'update' : order === 0 ? 'current' : 'newer-installed';
}

/** `/api/packs/store…`; the install runs under the write lock (the caller takes it). */
export async function handleStoreRequest(
  request: { method: string; path: string; body?: unknown },
  setup: SetupDeps | undefined,
  modules: ModuleRegistry | undefined,
  store: StoreDeps = storeIndexesFromEnv(),
): Promise<ApiResponse> {
  if (setup === undefined) return refuse(501, 'This host has no pack management.', 'Catalog packs are installed by the deployment here.');
  const method = request.method.toUpperCase();
  const p = (request.path.split('?')[0] ?? '').replace(/\/+$/, '');
  const options = store.fetch ?? setup.packFetch ?? {};

  if (p === '/api/packs/store') {
    if (method !== 'GET') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const installed = new Map((await installedPacks(setup, modules)).map((pack) => [pack.id, pack.version]));
    const indexes: unknown[] = [];
    const packs: unknown[] = [];
    for (const trusted of store.indexes) {
      try {
        const index = await fetchVerifiedIndex(trusted, options);
        indexes.push({ url: trusted.url, ok: true, store: index.store, packs: index.packs.length, ...(index.generated === undefined ? {} : { generated: index.generated }) });
        for (const pack of index.packs) {
          const latest = latestVersion(pack);
          const have = installed.get(pack.id);
          packs.push({
            index: trusted.url,
            store: index.store,
            id: pack.id,
            name: pack.name,
            ...(pack.description === undefined ? {} : { description: pack.description }),
            domain: pack.domain,
            license: latest?.license ?? pack.license,
            author: pack.author,
            ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
            latest: latest === undefined ? undefined : { version: latest.version, size: latest.size, ...(latest.requires === undefined ? {} : { requires: latest.requires }) },
            versions: pack.versions.map((v) => v.version),
            ...(have === undefined ? {} : { installed: have }),
            action: actionOf(pack, have),
          });
        }
      } catch (error) {
        indexes.push({ url: trusted.url, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return json(200, {
      disclaimer: STORE_DISCLAIMER,
      indexes,
      packs,
      domains: [...new Set(packs.map((pack) => (pack as { domain: string }).domain))].sort(),
      ...(store.problems === undefined || store.problems.length === 0 ? {} : { problems: store.problems }),
      ...(store.indexes.length === 0 ? { hint: 'No store index is configured. Set WIREHUB_STORE_INDEXES to "<index url> <public key>" (docs/self-hosting.md).' } : {}),
    });
  }

  if (p === '/api/packs/store/install') {
    if (method !== 'POST') return refuse(405, `${method} is not something this address accepts.`, 'It answers POST.');
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as { index?: unknown; id?: unknown; version?: unknown; apply?: unknown; acceptMajor?: unknown; sha256?: unknown };
    if (typeof body.index !== 'string' || typeof body.id !== 'string') return refuse(400, 'Name the index and the pack: { "index": "<index url>", "id": "<pack id>" }.', 'GET /api/packs/store lists them.');
    const trusted = store.indexes.find((i) => i.url === body.index);
    if (trusted === undefined) return refuse(404, `'${body.index}' is not a store index this hub trusts.`, 'The trusted indexes are WIREHUB_STORE_INDEXES; GET /api/packs/store lists them.');
    let index: StoreIndex;
    try {
      index = await fetchVerifiedIndex(trusted, options);
    } catch (error) {
      if (error instanceof StoreIndexError) return refuse(error.status, error.message, 'Nothing was installed.');
      throw error;
    }
    const pack = index.packs.find((candidate) => candidate.id === body.id);
    if (pack === undefined) return refuse(404, `The index does not list a pack '${body.id}'.`);
    const version = typeof body.version === 'string' ? pack.versions.find((v) => v.version === body.version) : latestVersion(pack);
    if (version === undefined) return refuse(404, `The index does not list version '${String(body.version)}' of '${pack.id}'.`, `It lists ${pack.versions.map((v) => v.version).join(', ')}.`);
    let bytes: Uint8Array;
    try {
      bytes = await fetchPack(new URL(version.url, trusted.url).href, options);
    } catch (error) {
      if (error instanceof PackArchiveError) return refuse(error.status, `The pack download failed: ${error.message}`, 'Nothing was installed.');
      throw error;
    }
    const digest = sha256(bytes);
    if (bytes.length !== version.size || digest !== version.sha256) {
      return refuse(422, `The download of ${pack.id} ${version.version} does not match the index (${bytes.length !== version.size ? `size ${bytes.length}, the index says ${version.size}` : 'sha256 differs'}).`, 'Nothing was installed. The file may have been changed after the index was signed; tell the store.', {
        expected: { sha256: version.sha256, size: version.size },
        got: { sha256: digest, size: bytes.length },
      });
    }
    if (body.apply === true && typeof body.sha256 === 'string' && body.sha256 !== digest) {
      return refuse(409, `${pack.id} ${version.version} changed since you looked at it.`, 'Preview it again, check the diff, then install.');
    }
    // the bundle must be the pack and version the index says it is, before anything is planned
    let source: { zip: string } | { bundle: unknown };
    try {
      const manifestBytes = readPackBytes(bytes).files.get('wirehub-pack.json');
      const manifest = manifestBytes === undefined ? undefined : (JSON.parse(new TextDecoder().decode(manifestBytes)) as { id?: unknown; version?: unknown });
      if (manifest?.id !== pack.id || manifest.version !== version.version) {
        return refuse(422, `The bundle the index lists as ${pack.id} ${version.version} is ${manifest === undefined ? 'not a pack' : `${String(manifest.id)} ${String(manifest.version)}`}.`, 'Nothing was installed. Tell the store; the index and the bundle disagree.');
      }
      source = isZip(bytes) ? { zip: Buffer.from(bytes).toString('base64') } : { bundle: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
    } catch (error) {
      if (error instanceof PackArchiveError || error instanceof SyntaxError) return refuse(422, `The download is not a usable pack: ${error.message}`, 'Nothing was installed.');
      throw error;
    }
    // the ordinary install flow: verification, the diff, and with apply one change set
    const answer = await handlePacksRequest(
      { method: 'POST', path: '/api/packs/install', body: { ...source, ...(body.apply === true ? { apply: true } : {}), ...(body.acceptMajor === true ? { acceptMajor: true } : {}) } },
      setup,
      modules,
    );
    const from = { index: trusted.url, store: index.store, id: pack.id, version: version.version, sha256: digest, size: bytes.length, license: version.license ?? pack.license };
    return { ...answer, body: { ...(answer.body as object), disclaimer: STORE_DISCLAIMER, from } };
  }

  return refuse(404, 'There is no such address.', `The store answers ${STORE_ROUTES.join(', ')}.`);
}
