/**
 * The studio's `ModelsAdapter`: `/api/models` for the
 * links, `/api/assets/:id` for the bytes — the viewer never loads a model
 * from anywhere else. Like the definition adapter, it remembers each link's
 * ETag and quotes it as If-Match on the next write; the lock client's fetch
 * wrapper adds the record's edit-lock token (`locks/records.ts` maps
 * `/api/models/:kind/:id` to `definition:<kind>:<id>`).
 */

import type { ModelLinkView, ModelsAdapter, ModelUploadStats, Outcome, StoredModel } from '@wirehub/editor-react';

import { request } from './persistence.browser.ts';

/** ArrayBuffer → base64, in chunks (a 20 MB STEP would overflow one `apply`). */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * A write, retried once on 423. Opening the attach form asks the lock scope
 * for the record's lease; a write sent in the instant before that lease
 * lands carries no token yet and meets this tab's own fresh lease. By the
 * retry the lock client holds the token and its fetch wrapper adds it; a
 * lease someone else holds refuses the retry too, with their name.
 */
async function write<T>(send: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  const first = await send();
  if (first.ok || first.status !== 423) return first;
  await new Promise((resolve) => setTimeout(resolve, 900));
  return send();
}

export function workbenchModels(base = '/api'): ModelsAdapter {
  const versions = new Map<string, string>();
  const key = (kind: string, id: string): string => `${kind}/${id}`;
  const url = (kind: string, id: string, action?: string): string =>
    `${base}/models/${encodeURIComponent(kind)}/${encodeURIComponent(id)}${action === undefined ? '' : `/${action}`}`;
  const remember = (k: string) => (response: Response): void => {
    const etag = response.headers.get('etag');
    if (etag !== null) versions.set(k, etag);
  };
  // no version seen → no header, and the server's 428 says to reload (never a blind `*`)
  const ifMatch = (k: string): Record<string, string> => {
    const etag = versions.get(k);
    return etag === undefined ? {} : { 'if-match': etag };
  };

  return {
    async get(kind, id) {
      const result = await request<{ link: ModelLinkView | null; built?: boolean }>(url(kind, id), { method: 'GET' }, remember(key(kind, id)));
      if (!result.ok) return result;
      const { link, built } = result.value;
      return { ok: true, value: link === null ? null : { ...link, ...(built === undefined ? {} : { built }) } };
    },
    list: () => request<{ links: ModelLinkView[]; models: StoredModel[] }>(`${base}/models`),
    async attach(kind, id, asset) {
      const k = key(kind, id);
      const result = await write(() => request<{ link: ModelLinkView }>(url(kind, id), { method: 'PUT', body: { asset }, headers: ifMatch(k) }, remember(k)));
      return result.ok ? { ok: true, value: result.value.link } : result;
    },
    async upload(kind, id, file, sourceKind) {
      const k = key(kind, id);
      const data = toBase64(file.bytes);
      return write(() =>
        request<{ link: ModelLinkView; stats?: ModelUploadStats }>(
          url(kind, id, 'upload'),
          { method: 'POST', body: { name: file.name, data, sourceKind }, headers: ifMatch(k) },
          remember(k),
        ),
      );
    },
    async detach(kind, id) {
      const k = key(kind, id);
      const result = await write(() => request<unknown>(url(kind, id), { method: 'DELETE', headers: ifMatch(k) }, remember(k)));
      return result.ok ? { ok: true, value: null } : result;
    },
    async fetchModel(asset): Promise<Outcome<{ bytes: ArrayBuffer; mime: string }>> {
      if (!/^[0-9a-f]{64}$/.test(asset)) return { ok: false, message: 'That is not a stored model id.' };
      try {
        const response = await fetch(`${base}/assets/${asset}`);
        if (!response.ok) {
          // an imported model not built on this box answers in words (`state: 'not-built'`)
          const body = (await response.json().catch(() => ({}))) as { error?: string; hint?: string };
          return {
            ok: false,
            message: body.error ?? `The stored model could not be loaded (HTTP ${response.status}).`,
            ...(body.hint === undefined ? {} : { hint: body.hint }),
            status: response.status,
          };
        }
        const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
        if (!mime.startsWith('model/')) return { ok: false, message: 'That stored file is not a 3D model.' };
        return { ok: true, value: { bytes: await response.arrayBuffer(), mime } };
      } catch (error) {
        return { ok: false, message: `The stored model could not be loaded (${(error as Error).message}).` };
      }
    },
  };
}
