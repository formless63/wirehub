/**
 * Store sources: the store indexes this hub trusts, from two places
 * (`docs/catalog-store.md` §4.4).
 *
 *   - the deployment: `WIREHUB_STORE_INDEXES` (and the official index), read-only in the app;
 *   - the organisation: `data/settings/stores.json`, added in Settings by an owner or editor
 *     (a URL and the store's public key), unless `WIREHUB_STORE_ALLOW_USER_SOURCES=false`.
 *
 * The two merge; on the same URL the deployment's entry wins. This file is the
 * pure half (the stored record, its checking and the merge); the routes are in
 * `store-settings.ts`.
 */

import { normalStoreKey, storeKeyFingerprint } from '@wirehub/catalog/src/server.ts';

import type { DocStore } from './storage/doc-store.ts';
import type { StoreDeps, TrustedStoreIndex } from './store.ts';

export const STORES_PATH = 'data/settings/stores.json';

/** a hub keeps at most this many added stores */
export const MAX_USER_SOURCES = 20;
const MAX_URL = 500;
const MAX_LABEL = 80;
const STORES_SRC = 'Hub settings (entered in the app)';

/** One store an organisation added: where its index is, the key it must be signed with, and whether browsing uses it. */
export interface StoreSource {
  url: string;
  /** minisign public key, canonical `RW…` */
  publicKey: string;
  label?: string;
  enabled: boolean;
  /** Hide versions without a review in this store (default: show all). */
  hideUnreviewed?: boolean;
}

export interface StoresRecord {
  sources: StoreSource[];
  src: string;
}

export async function readStores(docs: DocStore | undefined): Promise<StoresRecord | undefined> {
  return docs === undefined ? undefined : ((await docs.read(STORES_PATH)) as StoresRecord | undefined);
}

export const emptyStores = (): StoresRecord => ({ sources: [], src: STORES_SRC });
export const storesRecord = (sources: StoreSource[]): StoresRecord => ({ sources, src: STORES_SRC });

const CONTROL = /[\u0000-\u001f\u007f]/;

/** One entry of a request, checked and put in canonical form; or the sentence saying what is wrong. */
export function checkSource(input: unknown, at: string): { source: StoreSource } | { error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { error: `${at} is not a store (a url and a publicKey).` };
  const o = input as Record<string, unknown>;
  const url = typeof o['url'] === 'string' ? o['url'].trim() : '';
  if (url === '' || url.length > MAX_URL || CONTROL.test(url)) return { error: `${at}: the store's URL is missing or too long.` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `${at}: '${url}' is not a URL.` };
  }
  if (parsed.protocol !== 'https:') return { error: `${at}: a store index is fetched over https only.` };
  if (parsed.username !== '' || parsed.password !== '') return { error: `${at}: a store URL cannot carry a user name or password.` };
  let publicKey: string;
  try {
    publicKey = normalStoreKey(String(o['publicKey'] ?? ''));
  } catch {
    return { error: `${at}: the public key is not a minisign key (RW…).` };
  }
  let label: string | undefined;
  if (o['label'] !== undefined && o['label'] !== null) {
    if (typeof o['label'] !== 'string' || CONTROL.test(o['label'])) return { error: `${at}: the label must be text.` };
    const t = o['label'].trim();
    if (t.length > MAX_LABEL) return { error: `${at}: the label is longer than ${MAX_LABEL} characters.` };
    if (t !== '') label = t;
  }
  if (o['enabled'] !== undefined && typeof o['enabled'] !== 'boolean') return { error: `${at}: enabled is true or false.` };
  if (o['hideUnreviewed'] !== undefined && typeof o['hideUnreviewed'] !== 'boolean') return { error: `${at}: hideUnreviewed is true or false.` };
  return { source: { ...(o['hideUnreviewed'] === undefined ? {} : { hideUnreviewed: o['hideUnreviewed'] as boolean }), url: parsed.href, publicKey, ...(label === undefined ? {} : { label }), enabled: o['enabled'] !== false } };
}

export const keyView = (publicKey: string): { keyId: string; fingerprint: string } => storeKeyFingerprint(publicKey);

/**
 * The indexes browsing and installing use: the deployment's, then the enabled ones the
 * organisation added (unless the deployment locks sources, or the URL is already the
 * deployment's). Unreadable stored entries are skipped and reported in `problems`.
 */
export async function effectiveIndexes(store: StoreDeps): Promise<{ indexes: TrustedStoreIndex[]; problems: string[] }> {
  const env = store.indexes.map((i) => ({ ...i, origin: i.origin ?? ('env' as const) }));
  const problems: string[] = [];
  if (store.allowUserSources === false) return { indexes: env, problems };
  let record: StoresRecord | undefined;
  try {
    record = await readStores(store.docs);
  } catch {
    problems.push('The stores added in Settings could not be read.');
  }
  const seen = new Set(env.map((i) => i.url));
  const indexes = [...env];
  for (const [n, raw] of (Array.isArray(record?.sources) ? record.sources : []).entries()) {
    const got = checkSource(raw, `Added store ${n + 1}`);
    if ('error' in got) {
      problems.push(got.error);
      continue;
    }
    const s = got.source;
    if (!s.enabled || seen.has(s.url)) continue;
    seen.add(s.url);
    indexes.push({ url: s.url, publicKey: s.publicKey, origin: 'user', ...(s.hideUnreviewed === undefined ? {} : { hideUnreviewed: s.hideUnreviewed }), ...(s.label === undefined ? {} : { label: s.label }) });
  }
  return { indexes, problems };
}
