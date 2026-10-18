import type { Outcome } from '@wirehub/editor-react';
import { request } from './definitions.browser.ts';
import type { CoverChoice, RepresentationView } from './representations.ts';

export interface CoverView extends RepresentationView { etag: string }
export class CoverAccessDenied extends Error {}
export const coverKey = (id: string): readonly string[] => ['representations', 'pcbas', id];

export async function readCover(id: string): Promise<CoverView> {
  let etag = '';
  let denied = false;
  const out = await request<RepresentationView>(`/api/representations/pcbas/${encodeURIComponent(id)}`, { method: 'GET' }, (r) => {
    etag = r.headers.get('etag') ?? '';
    denied = r.status === 401 || r.status === 403;
  });
  if (denied) throw new CoverAccessDenied('Access to this preview was denied.');
  if (!out.ok) throw new Error(out.message);
  return { ...out.value, etag };
}

export async function saveCover(id: string, choice: CoverChoice | null, etag: string): Promise<Outcome<CoverView>> {
  let next = '';
  const out = await request<RepresentationView>(`/api/representations/pcbas/${encodeURIComponent(id)}`, {
    method: 'PUT', body: { choice }, headers: { 'if-match': etag },
  }, (r) => { next = r.headers.get('etag') ?? ''; });
  return out.ok ? { ok: true, value: { ...out.value, etag: next } } : out;
}
