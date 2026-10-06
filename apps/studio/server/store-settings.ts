/**
 * Store sources in Settings (`docs/catalog-store.md` §4.4): the stores this hub
 * trusts, listed with where each comes from, and added, renamed, disabled and
 * removed by an owner or an editor.
 *
 *   GET /api/settings/stores                the configured stores (the deployment's, read-only,
 *                                           and the ones added here), the official one's state, an ETag
 *   PUT /api/settings/stores                replace the added stores (If-Match). Every new or re-keyed
 *                                           store is fetched and its signature verified first.
 *   GET /api/settings/stores/preview?url=&key=
 *                                           fetch and verify an index with a key; what the person
 *                                           confirms before saving: name, publishers, packs, fingerprint
 *   GET /api/settings/stores/key?url=       fetch `wirehub-store.pub` from beside the index: a convenience
 *                                           (trust on first use; the person confirms the fingerprint)
 *   GET /api/settings/stores/check?url=     "re-check now": fetch and verify a configured store again
 *
 * Every fetch is the pack URL install's: https only, the same size and time limits,
 * private addresses refused (`fetchPack`). The added stores are the catalog document
 * `data/settings/stores.json`, so both backends keep them with the catalog.
 */

import { normalStoreKey, parseStorePublicKey } from '@wirehub/catalog';

import type { ApiResponse } from './api.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { PackArchiveError, fetchPack, type FetchPackOptions } from './pack-archive.ts';
import type { DocStore } from './storage/doc-store.ts';
import { OFFICIAL_STORE_INDEX_URL, OFFICIAL_STORE_PUBLIC_KEY, StoreIndexError, fetchVerifiedIndex, storeIndexesFromEnv, type StoreDeps, type TrustedStoreIndex } from './store.ts';
import { MAX_USER_SOURCES, STORES_PATH, checkSource, keyView, readStores, storesRecord, type StoreSource } from './store-sources.ts';

export const STORE_SOURCE_ROUTES = [
  'GET    /api/settings/stores',
  'PUT    /api/settings/stores',
  'GET    /api/settings/stores/preview?url=&key=',
  'GET    /api/settings/stores/key?url=',
  'GET    /api/settings/stores/check?url=',
] as const;

/** the trust-on-first-use sentence the page shows beside a fetched key */
export const TOFU_NOTICE =
  'This key was fetched from the store itself, so it only proves the store matches itself. Compare the fingerprint with one the store owner gave you another way before you trust it.';

export interface StoreSourceDeps {
  docs?: DocStore;
  store?: StoreDeps;
  setup?: { packFetch?: FetchPackOptions };
}

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });
const optionsOf = (deps: StoreSourceDeps): FetchPackOptions => storeOf(deps).fetch ?? deps.setup?.packFetch ?? {};
const storeOf = (deps: StoreSourceDeps): StoreDeps => deps.store ?? storeIndexesFromEnv();
const envIndexes = (deps: StoreSourceDeps): readonly TrustedStoreIndex[] => storeOf(deps).indexes;
const allowed = (deps: StoreSourceDeps): boolean => storeOf(deps).allowUserSources !== false;

/** `/api/settings/stores…`: the GET / PUT pair, which runs in the unit of work like the other settings. */
export function isStoreSourcesPath(parts: string[]): boolean {
  return parts[0] === 'api' && parts[1] === 'settings' && parts[2] === 'stores' && parts.length === 3;
}

/** The query routes: no write, no lock. */
export function isStoreSourcesQueryPath(path: string, method: string): boolean {
  const p = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  return method.toUpperCase() === 'GET' && /^\/api\/settings\/stores\/(preview|key|check)$/.test(p);
}

async function view(deps: StoreSourceDeps): Promise<{ body: Record<string, unknown>; etag: string }> {
  const record = await readStores(deps.docs);
  const env = envIndexes(deps);
  const envUrls = new Set(env.map((i) => i.url));
  const lock = !allowed(deps);
  const entry = (url: string, publicKey: string): Record<string, unknown> => ({ url, publicKey, ...keyView(publicKey) });
  const sources: Record<string, unknown>[] = [
    ...env.map((i) => ({ ...entry(i.url, i.publicKey), ...(i.label === undefined ? {} : { label: i.label }), enabled: true, hideUnreviewed: storeOf(deps).hideUnreviewed === true || i.hideUnreviewed === true, origin: i.origin ?? 'env', readOnly: true })),
    ...(Array.isArray(record?.sources) ? record.sources : []).flatMap((raw, n) => {
      const got = checkSource(raw, `Store ${n + 1}`);
      if ('error' in got) return [];
      const s = got.source;
      return [{ ...entry(s.url, s.publicKey), ...(s.label === undefined ? {} : { label: s.label }), enabled: s.enabled, ...(s.hideUnreviewed === undefined ? {} : { hideUnreviewed: s.hideUnreviewed }), origin: 'user', readOnly: false, ...(envUrls.has(s.url) ? { shadowed: true } : {}), ...(lock ? { ignored: true } : {}) }];
    }),
  ];
  const official = {
    url: OFFICIAL_STORE_INDEX_URL,
    state: OFFICIAL_STORE_PUBLIC_KEY === '' ? 'not-signed-yet' : env.some((i) => i.url === OFFICIAL_STORE_INDEX_URL) ? 'trusted' : 'not-enabled',
    ...(OFFICIAL_STORE_PUBLIC_KEY === '' ? {} : keyView(OFFICIAL_STORE_PUBLIC_KEY)),
  };
  return {
    body: { allowUserSources: !lock, official, sources, ...((storeOf(deps).problems ?? []).length === 0 ? {} : { problems: storeOf(deps).problems }), src: record?.src ?? 'Hub settings (entered in the app)' },
    etag: contentETag(record ?? null),
  };
}

/** What a person confirms: the verified store, with the key's fingerprint. */
async function describe(url: string, publicKey: string, options: FetchPackOptions): Promise<ApiResponse> {
  try {
    const index = await fetchVerifiedIndex({ url, publicKey }, options);
    return {
      status: 200,
      body: {
        ok: true,
        url,
        publicKey,
        ...keyView(publicKey),
        store: index.store,
        publishers: (index.publishers ?? []).map((p) => ({ id: p.id, name: p.name, ...(p.url === undefined ? {} : { url: p.url }) })),
        packs: index.packs.length,
        ...(index.generated === undefined ? {} : { generated: index.generated }),
      },
    };
  } catch (error) {
    if (error instanceof StoreIndexError) return fail(error.status, error.message, 'Nothing was saved.');
    throw error;
  }
}

/** `GET /api/settings/stores/(preview|key|check)?…` */
export async function handleStoreSourcesQuery(request: { method: string; path: string; user?: { role?: string } }, deps: StoreSourceDeps): Promise<ApiResponse> {
  const [pathPart = '', query = ''] = request.path.split('?');
  const what = pathPart.replace(/\/+$/, '').split('/').pop();
  const params = new URLSearchParams(query);
  const options = optionsOf(deps);
  const url = (params.get('url') ?? '').trim();
  if (url === '') return fail(400, "Name the store's index URL (?url=).");

  if (what === 'check') {
    const user = allowed(deps) ? ((await readStores(deps.docs))?.sources ?? []) : [];
    const known = [...envIndexes(deps), ...user].find((s) => s.url === url);
    if (known === undefined) return fail(404, `'${url}' is not a configured store.`, 'GET /api/settings/stores lists them.');
    return await describe(known.url, known.publicKey, options);
  }

  if (request.user?.role === 'viewer') return fail(403, 'Adding a store is for owners and editors.', 'Ask an owner for the editor role.');
  if (!allowed(deps)) return fail(403, 'This deployment does not allow adding stores in the app.', 'An administrator sets WIREHUB_STORE_INDEXES on the server.');
  const checked = checkSource({ url, publicKey: 'x' }, 'The store');
  if ('error' in checked && !/public key/.test(checked.error)) return fail(400, checked.error);
  const href = new URL(url).href;

  if (what === 'key') {
    let bytes: Uint8Array;
    try {
      bytes = await fetchPack(new URL('wirehub-store.pub', href).href, { ...options, maxBytes: 4096 });
    } catch (error) {
      if (error instanceof PackArchiveError) return fail(502, `Could not fetch wirehub-store.pub from the store (${error.message})`, 'Ask the store owner for the public key (the RW… line) and paste it.');
      throw error;
    }
    let publicKey: string;
    try {
      const text = new TextDecoder().decode(bytes);
      parseStorePublicKey(text);
      publicKey = normalStoreKey(text);
    } catch {
      return fail(422, 'The store\'s wirehub-store.pub is not a minisign public key.', 'Ask the store owner for the key (the RW… line) and paste it.');
    }
    return { status: 200, body: { publicKey, ...keyView(publicKey), from: new URL('wirehub-store.pub', href).href, notice: TOFU_NOTICE } };
  }

  if (what === 'preview') {
    let publicKey: string;
    try {
      publicKey = normalStoreKey(params.get('key') ?? '');
    } catch {
      return fail(400, 'The public key is not a minisign key (RW…).', 'Paste the key line the store publishes, or fetch it from the store.');
    }
    const answer = await describe(href, publicKey, options);
    const body = answer.body as Record<string, unknown>;
    const configured = [...envIndexes(deps), ...((await readStores(deps.docs))?.sources ?? [])].some((s) => s.url === href);
    return configured ? { ...answer, body: { ...body, alreadyConfigured: true } } : answer;
  }
  return fail(404, 'There is no such address.', `The store sources answer ${STORE_SOURCE_ROUTES.join(', ')}.`);
}

/** `GET`/`PUT /api/settings/stores` */
export async function handleStoreSources(method: string, body: unknown, deps: StoreSourceDeps, ifMatch: string | undefined, user?: { role?: string }): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.', 'Hub settings are stored with the catalog.');
  const current = await view(deps);
  if (method === 'GET') return { status: 200, body: current.body, headers: { ETag: current.etag } };
  if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
  if (user?.role === 'viewer') return fail(403, 'Changing store sources is for owners and editors.', 'Ask an owner for the editor role.');
  if (!allowed(deps)) return fail(403, 'This deployment does not allow adding stores in the app.', 'An administrator sets WIREHUB_STORE_INDEXES on the server, or WIREHUB_STORE_ALLOW_USER_SOURCES=true.');
  const guard = checkIfMatch(ifMatch, current.etag, 'settings', 'stores');
  if (guard !== undefined) return guard;
  const list = typeof body === 'object' && body !== null ? (body as { sources?: unknown }).sources : undefined;
  if (!Array.isArray(list)) return fail(400, 'Send { "sources": [ { "url", "publicKey", "label"?, "enabled"?, "hideUnreviewed"? } ] }.');
  if (list.length > MAX_USER_SOURCES) return fail(400, `A hub keeps at most ${MAX_USER_SOURCES} added stores.`);
  const envUrls = new Set(envIndexes(deps).map((i) => i.url));
  const before = new Map(((await readStores(deps.docs))?.sources ?? []).map((s) => [s.url, s]));
  const next: StoreSource[] = [];
  const seen = new Set<string>();
  for (const [n, raw] of list.entries()) {
    const got = checkSource(raw, `Store ${n + 1}`);
    if ('error' in got) return fail(400, got.error);
    const s = got.source;
    if (envUrls.has(s.url)) return fail(409, `${s.url} is set by the server (WIREHUB_STORE_INDEXES); it cannot be added here.`, 'The server entry wins; remove the one you added.');
    if (seen.has(s.url)) return fail(400, `${s.url} is listed twice.`);
    seen.add(s.url);
    // a store that is new, or re-keyed, is fetched and verified before it is kept
    if (before.get(s.url)?.publicKey !== s.publicKey) {
      const check = await describe(s.url, s.publicKey, optionsOf(deps));
      if (check.status !== 200) return fail(check.status, `Could not add ${s.url}: ${String((check.body as { error?: unknown }).error)}`, 'Nothing was saved.');
    }
    next.push(s);
  }
  if (next.length === 0) await deps.docs.remove(STORES_PATH);
  else await deps.docs.write(STORES_PATH, storesRecord(next));
  const after = await view({ ...deps, docs: { read: (p) => (p === STORES_PATH && next.length > 0 ? storesRecord(next) : undefined), write: () => undefined, remove: () => undefined } });
  return { status: 200, body: after.body, headers: { ETag: after.etag } };
}
