/**
 * Store browsing (`docs/catalog-store.md` §4): the packs listed by the store
 * indexes this deployment trusts, and install / update from one of them.
 *
 *   GET  /api/packs/store           the packs of every configured index, each index
 *                                   fetched and its signature verified against the
 *                                   public key configured for it; an index that does
 *                                   not verify is listed as refused, with its packs left out
 *   POST /api/packs/store/install   { index, id, version?, apply?, sha256?, acceptMajor?, force? }: download
 *                                   the bundle the (verified) index names, check its size
 *                                   and sha256 against the index and, when the index names
 *                                   the pack's publisher, the publisher's signature over the
 *                                   manifest (`wirehub-pack.sig`) and every file the manifest
 *                                   pins; then hand it to the ordinary install flow
 *                                   (`POST /api/packs/install`): without `apply` the diff,
 *                                   with it one change set
 *
 * Phase 5 (`docs/catalog-store.md` §4): the index carries each version's review status
 * (information; source policies and `WIREHUB_STORE_HIDE_UNREVIEWED` can hide unreviewed versions here), yanked
 * versions (listed with a warning, never offered; installed only with `force` by an owner)
 * and revoked keys (a pack signed only by one is refused, and flagged where installed).
 * The list also carries `notices` for installed packs: a yanked version, a revoked
 * signature or a flagged review, with the version to update to.
 *
 * The trusted indexes are `WIREHUB_STORE_INDEXES` (`storeIndexesFromEnv`) plus the stores added in
 * Settings (`store-sources.ts`; `WIREHUB_STORE_ALLOW_USER_SOURCES=false` ignores those): a list of
 * `<url> <public key>`; `official` names WireHub's own index once its key is published.
 * WireHub does not police what third-party packs contain: the licence and provenance
 * are shown as the author states them, beside the disclaimer (`STORE_DISCLAIMER`).
 *
 * Under `/api/packs`, so the same rules hold: owners and editors install, viewers read,
 * and no API token may write.
 */

import { compareVersions, type InstalledPack } from '@wirehub/catalog';
import { STORE_DISCLAIMER, STORE_SIGNATURE_SUFFIX, offeredVersion, packFileProblems, parseStoreIndex, parseStorePublicKey, publisherKeys, reviewOf, revokedKeysOf, verifyPackSignature, verifyStoreSignature, versionVisible, type StoreIndex, type StoreIndexVersion, type StoreRevokedKey } from '@wirehub/catalog/src/server.ts';
import type { ModuleRegistry } from '@wirehub/modules';

import type { ApiResponse } from './api.ts';
import type { Env } from './env.ts';
import type { StudioUser } from './me.ts';
import type { CodeModuleHost } from './code-modules/host.ts';
import { PackArchiveError, fetchPack, isZip, readPackBytes, sha256, type FetchPackOptions } from './pack-archive.ts';
import { handlePacksRequest } from './packs.ts';
import type { SetupDeps } from './setup.ts';
import type { DocStore } from './storage/doc-store.ts';
import { effectiveIndexes } from './store-sources.ts';

export const STORE_ROUTES = ['GET    /api/packs/store', 'POST   /api/packs/store/install'] as const;

/** Where the official index of WireHub's bundled packs is published (the pages workflow). */
export const OFFICIAL_STORE_INDEX_URL = 'https://formless63.github.io/wirehub/store/index.json';

/**
 * The official index's public key (minisign `RW…` form).
 *
 * Recorded 2026-10-05 (key id 289BB53D1B721017); `node scripts/store-index.mjs pubkey --key <private key file>`
 * prints it. Hubs trust the official index by default. Tests never reach the real index: they set
 * `WIREHUB_STORE_INDEXES=none` (vitest.config.ts) or pass their own `official` to `storeIndexesFromEnv`.
 */
export const OFFICIAL_STORE_PUBLIC_KEY: string = 'RWQXEHIbPbWbKH32jyM29IRDsITWmTwGdtDQzcVaY2peD2aQnCHCoVlj';

export const MAX_STORE_INDEX_BYTES = 4 * 1024 * 1024;
export const MAX_STORE_SIGNATURE_BYTES = 16 * 1024;

export interface TrustedStoreIndex {
  /** Optional policy for this source; the deployment-wide restriction still applies. */
  hideUnreviewed?: boolean;
  url: string;
  /** minisign public key, `RW…` */
  publicKey: string;
  /** where the entry comes from: the deployment (`env`), the official index, or Settings (`user`) */
  origin?: 'env' | 'official' | 'user';
  /** the name a person gave an added store */
  label?: string;
}

export interface StoreDeps {
  indexes: readonly TrustedStoreIndex[];
  /** sentences about `WIREHUB_STORE_INDEXES` entries that were ignored */
  problems?: readonly string[];
  /** how indexes and bundles are fetched (tests inject one); else the setup's `packFetch` */
  fetch?: FetchPackOptions;
  /** `WIREHUB_STORE_HIDE_UNREVIEWED`: list and offer only versions the index marks reviewed or flagged (default: show all) */
  hideUnreviewed?: boolean;
  /** `WIREHUB_STORE_ALLOW_USER_SOURCES` (default true): may owners and editors add stores in Settings? */
  allowUserSources?: boolean;
  /** where the stores added in Settings are kept (`data/settings/stores.json`) */
  docs?: DocStore;
}

const yes = (value: string | undefined): boolean => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

/**
 * `WIREHUB_STORE_INDEXES`: entries separated by commas or new lines, each
 * `<https url> <public key>`; the word `official` stands for WireHub's own index.
 * Unset: the official index (fetched lazily, on the first store request), else none if the build has no key. Empty or `none`: none.
 */
export function storeIndexesFromEnv(env: Env = process.env, officialIndex: { url: string; publicKey: string } = { url: OFFICIAL_STORE_INDEX_URL, publicKey: OFFICIAL_STORE_PUBLIC_KEY }): StoreDeps {
  const raw = env['WIREHUB_STORE_INDEXES'];
  const hide = {
    ...(yes(env['WIREHUB_STORE_HIDE_UNREVIEWED']) ? { hideUnreviewed: true } : {}),
    ...(/^(0|false|no|off)$/i.test((env['WIREHUB_STORE_ALLOW_USER_SOURCES'] ?? '').trim()) ? { allowUserSources: false } : {}),
  };
  const official = (): TrustedStoreIndex[] => (officialIndex.publicKey === '' ? [] : [{ url: officialIndex.url, publicKey: officialIndex.publicKey, origin: 'official' }]);
  if (raw === undefined) return { indexes: official(), ...hide };
  const indexes: TrustedStoreIndex[] = [];
  const problems: string[] = [];
  for (const entry of raw.split(/[,\n]/).map((e) => e.trim()).filter((e) => e !== '' && e !== 'none')) {
    if (entry === 'official') {
      if (officialIndex.publicKey === '') problems.push("'official': this build has no public key for the official index yet; name it with its key instead.");
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
    indexes.push({ url, publicKey: key, origin: 'env' });
  }
  return { indexes, problems, ...hide };
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
  const get = async (url: string, what: string, maxBytes: number): Promise<Uint8Array> => {
    try {
      return await fetchPack(url, { ...options, maxBytes: Math.min(options.maxBytes ?? maxBytes, maxBytes) });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new StoreIndexError(`Could not fetch the ${what} (${why})`, error instanceof PackArchiveError && error.status === 413 ? 413 : 502);
    }
  };
  const bytes = await get(trusted.url, 'index', MAX_STORE_INDEX_BYTES);
  const signature = await get(`${trusted.url}${STORE_SIGNATURE_SUFFIX}`, 'index signature; an unsigned index is refused', MAX_STORE_SIGNATURE_BYTES);
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
  origin?: InstalledPack['origin'];
}

async function installedPacks(setup: SetupDeps, modules: ModuleRegistry | undefined): Promise<InstalledView[]> {
  const answer = await handlePacksRequest({ method: 'GET', path: '/api/packs' }, setup, modules);
  return answer.status === 200 ? ((answer.body as { packs: InstalledView[] }).packs ?? []) : [];
}

/**
 * What the store can do with a pack here: install the offered version, update to it,
 * nothing (current, or the hub has a newer one), or nothing because every version is
 * yanked (`unavailable`).
 */
function actionOf(offered: StoreIndexVersion | undefined, installed: string | undefined): 'install' | 'update' | 'current' | 'newer-installed' | 'unavailable' {
  if (offered === undefined) return installed === undefined ? 'unavailable' : 'current';
  if (installed === undefined) return 'install';
  const order = compareVersions(offered.version, installed);
  return order > 0 ? 'update' : order === 0 ? 'current' : 'newer-installed';
}

/** The keys that signed a version, as the index says (`signedBy`), and whether every one of them is revoked. */
function revokedSigners(signers: readonly string[] | undefined, revoked: ReadonlyMap<string, StoreRevokedKey>): StoreRevokedKey[] | undefined {
  if (signers === undefined || signers.length === 0) return undefined;
  const hits = signers.map((k) => revoked.get(k));
  return hits.every((h) => h !== undefined) ? (hits as StoreRevokedKey[]) : undefined;
}

/** May this person install a yanked version anyway? Owners only (everyone, where the host keeps no roles). */
const mayForce = (user: StudioUser | undefined): boolean => user?.role === undefined || user.role === 'owner';

/** `/api/packs/store…`; the install runs under the write lock (the caller takes it). */
export async function handleStoreRequest(
  request: { method: string; path: string; body?: unknown },
  setup: SetupDeps | undefined,
  modules: ModuleRegistry | undefined,
  store: StoreDeps = storeIndexesFromEnv(),
  user?: StudioUser,
  code?: CodeModuleHost,
): Promise<ApiResponse> {
  if (setup === undefined) return refuse(501, 'This host has no pack management.', 'Catalog packs are installed by the deployment here.');
  const method = request.method.toUpperCase();
  const p = (request.path.split('?')[0] ?? '').replace(/\/+$/, '');
  const options = store.fetch ?? setup.packFetch ?? {};
  // the deployment's indexes plus the ones added in Settings (store-sources.ts)
  const trustedNow = await effectiveIndexes(store);

  if (p === '/api/packs/store') {
    if (method !== 'GET') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const installedList = await installedPacks(setup, modules);
    const installed = new Map(installedList.map((pack) => [pack.id, pack]));
    const indexes: unknown[] = [];
    const packs: unknown[] = [];
    const verified: { url: string; index: StoreIndex; hideUnreviewed: boolean }[] = [];
    let hidden = 0;
    // every store is fetched on its own: one that is down or does not verify is listed as refused, the others still show
    const fetched = await Promise.all(
      trustedNow.indexes.map(async (trusted) => {
        try {
          return { trusted, index: await fetchVerifiedIndex(trusted, options), error: '' };
        } catch (error) {
          return { trusted, index: undefined, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    for (const got of fetched) {
      const trusted = got.trusted;
      if (got.index === undefined) {
        indexes.push({ url: trusted.url, ok: false, source: trusted.origin ?? 'env', ...(trusted.label === undefined ? {} : { label: trusted.label }), error: got.error });
        continue;
      }
      const index = got.index;
      const label = trusted.label ?? index.store.name;
      const visibility = { hideUnreviewed: store.hideUnreviewed === true || trusted.hideUnreviewed === true };
      verified.push({ url: trusted.url, index, ...visibility });
      const revoked = revokedKeysOf(index);
      indexes.push({ url: trusted.url, ok: true, source: trusted.origin ?? 'env', label, store: index.store, ...(visibility.hideUnreviewed ? { hideUnreviewed: true } : {}), packs: index.packs.length, ...(index.generated === undefined ? {} : { generated: index.generated }) });
      for (const pack of index.packs) {
        const visible = pack.versions.filter((v) => versionVisible(v, visibility));
        if (visible.length === 0) {
          hidden += 1;
          continue;
        }
        const offered = offeredVersion(pack, visibility);
        const here = installed.get(pack.id);
        // an installed pack keeps the store it came from: another store listing the same id does not offer it an update
        const from = here?.origin?.index;
        const elsewhere = here !== undefined && from !== undefined && from !== trusted.url;
        const have = here?.version;
        const publisher = pack.publisher === undefined ? undefined : index.publishers?.find((p) => p.id === pack.publisher);
        packs.push({
          index: trusted.url,
          store: index.store,
          storeLabel: label,
          id: pack.id,
          name: pack.name,
          ...(pack.description === undefined ? {} : { description: pack.description }),
          domain: pack.domain,
          license: offered?.license ?? pack.license,
          author: pack.author,
          // who signs it: the index's publisher entry; absent = the pack is pinned by the index's sha256 only
          ...(publisher === undefined ? {} : { publisher: { id: publisher.id, name: publisher.name, ...(publisher.url === undefined ? {} : { url: publisher.url }) } }),
          ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
          latest: offered === undefined ? undefined : { version: offered.version, size: offered.size, ...(offered.module === undefined ? {} : { module: offered.module }), review: reviewOf(offered), ...(offered.requires === undefined ? {} : { requires: offered.requires }) },
          versions: visible.map((v) => v.version),
          releases: visible.map((v) => {
            const gone = revokedSigners(v.signedBy, revoked);
            return { version: v.version, review: reviewOf(v), ...(v.yanked === undefined ? {} : { yanked: v.yanked }), ...(gone === undefined ? {} : { revoked: true }) };
          }),
          ...(have === undefined ? {} : { installed: have }),
          ...(elsewhere ? { installedFrom: from } : {}),
          action: elsewhere ? 'other-store' : actionOf(offered, have),
        });
      }
    }
    return json(200, {
      disclaimer: STORE_DISCLAIMER,
      indexes,
      packs,
      domains: [...new Set(packs.map((pack) => (pack as { domain: string }).domain))].sort(),
      notices: installedNotices(installedList, verified),
      ...(store.hideUnreviewed === true ? { hideUnreviewed: true } : {}),
      ...(verified.some((i) => i.hideUnreviewed) ? { hidden } : {}),
      ...([...(store.problems ?? []), ...trustedNow.problems].length === 0 ? {} : { problems: [...(store.problems ?? []), ...trustedNow.problems] }),
      ...(trustedNow.indexes.length === 0
        ? { hint: store.allowUserSources === false ? 'No store index is configured. Ask whoever runs the server to name one.' : 'No store is configured. Add one under Settings > Catalog stores.' }
        : {}),
    });
  }

  if (p === '/api/packs/store/install') {
    if (method !== 'POST') return refuse(405, `${method} is not something this address accepts.`, 'It answers POST.');
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as { index?: unknown; id?: unknown; version?: unknown; apply?: unknown; acceptMajor?: unknown; sha256?: unknown; force?: unknown; consent?: unknown };
    if (typeof body.index !== 'string' || typeof body.id !== 'string') return refuse(400, 'Name the index and the pack: { "index": "<index url>", "id": "<pack id>" }.', 'GET /api/packs/store lists them.');
    const trusted = trustedNow.indexes.find((i) => i.url === body.index);
    if (trusted === undefined) return refuse(404, `'${body.index}' is not a store index this hub trusts.`, 'The trusted indexes are WIREHUB_STORE_INDEXES and the stores added (and enabled) in Settings; GET /api/packs/store lists them.');
    let index: StoreIndex;
    try {
      index = await fetchVerifiedIndex(trusted, options);
    } catch (error) {
      if (error instanceof StoreIndexError) return refuse(error.status, error.message, 'Nothing was installed.');
      throw error;
    }
    const pack = index.packs.find((candidate) => candidate.id === body.id);
    if (pack === undefined) return refuse(404, `The index does not list a pack '${body.id}'.`);
    const visibility = { hideUnreviewed: store.hideUnreviewed === true || trusted.hideUnreviewed === true };
    const named = typeof body.version === 'string';
    const version = named ? pack.versions.find((v) => v.version === body.version) : offeredVersion(pack, visibility);
    if (version === undefined && !named && pack.versions.some((v) => versionVisible(v, visibility))) {
      return refuse(409, `Every version of '${pack.id}' the index lists is yanked, so none is offered for install.`, 'An owner can still install a named version with { "version": "…", "force": true }.', { yanked: pack.versions.map((v) => ({ version: v.version, ...v.yanked })) });
    }
    if (version === undefined || !versionVisible(version, visibility)) {
      const hiddenHere = version !== undefined || (!named && pack.versions.length > 0);
      const which = named ? `version '${String(body.version)}'` : 'a version';
      return refuse(
        404,
        hiddenHere ? `This hub does not offer ${which} of '${pack.id}': only reviewed versions are shown here by this store's review policy.` : `The index does not list ${which} of '${pack.id}'.`,
        `It lists ${pack.versions.filter((v) => versionVisible(v, visibility)).map((v) => v.version).join(', ') || 'none this hub offers'}.`,
      );
    }
    if (version.yanked !== undefined) {
      if (body.force !== true) {
        return refuse(409, `${pack.id} ${version.version} was yanked by the index publisher: ${version.yanked.reason}`, `It is never offered for install${offeredVersion(pack, visibility) === undefined ? '' : `; ${offeredVersion(pack, visibility)?.version} is`}. An owner can install it anyway with { "force": true }.`, { yanked: version.yanked });
      }
      if (!mayForce(user)) return refuse(403, `Only an owner can install a yanked version (${pack.id} ${version.version}: ${version.yanked.reason}).`, 'Nothing was installed. Ask an owner.');
    }
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
    let origin: NonNullable<InstalledPack['origin']> = { index: trusted.url };
    try {
      const read = readPackBytes(bytes);
      const manifestBytes = read.shipped.get('wirehub-pack.json');
      const manifest = manifestBytes === undefined ? undefined : (JSON.parse(new TextDecoder().decode(manifestBytes)) as { id?: unknown; version?: unknown; publisher?: { id?: unknown }; files?: unknown });
      if (manifest?.id !== pack.id || manifest.version !== version.version) {
        return refuse(422, `The bundle the index lists as ${pack.id} ${version.version} is ${manifest === undefined ? 'not a pack' : `${String(manifest.id)} ${String(manifest.version)}`}.`, 'Nothing was installed. Tell the store; the index and the bundle disagree.');
      }
      // the publisher's signature, on top of the index's: the manifest signed by a current key of the publisher the index names, every file pinned by it
      if (pack.publisher !== undefined) {
        const signed = (why: string, extra?: object): ApiResponse => refuse(422, `${pack.id} ${version.version} was refused: ${why}.`, 'Nothing was installed. Tell the store or the publisher.', extra);
        if (manifest.publisher?.id !== pack.publisher) return signed(`the index says '${pack.publisher}' publishes it, the manifest says '${String(manifest.publisher?.id ?? '(nobody)')}'`);
        const revoked = revokedKeysOf(index);
        const check = verifyPackSignature(manifest, read.signature, publisherKeys(index, pack.publisher), revoked);
        if (!check.ok) {
          const reasons = (check.revoked ?? []).map((k) => revoked.get(k)?.reason).filter((r): r is string => r !== undefined);
          return signed(`its signature does not hold (${check.reason}${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''})`, check.revoked === undefined ? undefined : { revoked: check.revoked });
        }
        if (manifest.files === undefined) return signed('its signed manifest pins no files ("files"), so the signature does not cover them');
        const pins = packFileProblems(manifest, read.shipped);
        if (pins.length > 0) return signed(`its files do not match the signed manifest (${pins.slice(0, 3).join('; ')})`, { problems: pins });
        origin = { index: trusted.url, publisher: pack.publisher, signedBy: check.signers };
      }
      source = isZip(bytes) ? { zip: Buffer.from(bytes).toString('base64') } : { bundle: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
    } catch (error) {
      if (error instanceof PackArchiveError || error instanceof SyntaxError) return refuse(422, `The download is not a usable pack: ${error.message}`, 'Nothing was installed.');
      throw error;
    }
    // the ordinary install flow: verification, the diff, and with apply one change set
    const answer = await handlePacksRequest(
      { method: 'POST', path: '/api/packs/install', body: { ...source, ...(body.apply === true ? { apply: true } : {}), ...(body.acceptMajor === true ? { acceptMajor: true } : {}), ...(body.consent === undefined ? {} : { consent: body.consent }) }, ...(user === undefined ? {} : { user }) },
      setup,
      modules,
      // a pack with code is trusted only through a publisher the index names, whose signature held above
      { origin, store: origin.signedBy === undefined ? { index: trusted.url, unsigned: true } : { index: trusted.url, keys: origin.signedBy }, ...(code === undefined ? {} : { code }) },
    );
    const from = {
      index: trusted.url,
      store: index.store,
      id: pack.id,
      version: version.version,
      sha256: digest,
      size: bytes.length,
      license: version.license ?? pack.license,
      review: reviewOf(version),
      ...(version.yanked === undefined ? {} : { yanked: version.yanked }),
      ...(origin.publisher === undefined ? {} : { publisher: origin.publisher, signedBy: origin.signedBy }),
    };
    return { ...answer, body: { ...(answer.body as object), disclaimer: STORE_DISCLAIMER, from } };
  }

  return refuse(404, 'There is no such address.', `The store answers ${STORE_ROUTES.join(', ')}.`);
}

/**
 * What an installed pack should be warned about, from every verified index that
 * lists it: its version yanked, its signature by keys all since revoked, or its
 * review flagged; with the version the index now offers (`suggest`).
 */
function installedNotices(installed: readonly InstalledView[], verified: readonly { url: string; index: StoreIndex; hideUnreviewed: boolean }[]): unknown[] {
  const revoked = new Map<string, StoreRevokedKey>();
  for (const { index } of verified) for (const [key, r] of revokedKeysOf(index)) revoked.set(key, r);
  const notices: unknown[] = [];
  for (const pack of installed) {
    for (const { url, index, hideUnreviewed } of verified) {
      // an installed pack is checked against the store it came from (packs of unknown origin: any store listing them)
      if (pack.origin?.index !== undefined && pack.origin.index !== url) continue;
      const listed = index.packs.find((p) => p.id === pack.id);
      const version = listed?.versions.find((v) => v.version === pack.version);
      if (listed === undefined || version === undefined) continue;
      // who signed what is installed: recorded at install from this index, else what the index says of that version
      const signers = pack.origin?.index === url && pack.origin.signedBy !== undefined ? pack.origin.signedBy : version.signedBy;
      const gone = revokedSigners(signers, revoked);
      const review = reviewOf(version);
      if (version.yanked === undefined && gone === undefined && review.status !== 'flagged') continue;
      const offered = offeredVersion(listed, { hideUnreviewed });
      notices.push({
        id: pack.id,
        version: pack.version,
        index: url,
        store: index.store,
        ...(version.yanked === undefined ? {} : { yanked: version.yanked }),
        ...(gone === undefined ? {} : { revoked: gone.map((r) => ({ key: r.key, ...(r.reason === undefined ? {} : { reason: r.reason }), ...(r.on === undefined ? {} : { on: r.on }) })) }),
        ...(review.status === 'flagged' ? { review } : {}),
        ...(offered === undefined || offered.version === pack.version ? {} : { suggest: offered.version }),
      });
    }
  }
  return notices;
}
