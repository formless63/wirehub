/**
 * "Release to this hub" (`docs/catalog-store.md` §3), one flow for both backends
 * (`pack-release.server.test.ts`, `pg/pack-release.server.test.ts`): a pack installed from an
 * upload ships a part, a design with its drawing facts, a vocabulary entry and a drawing photo; its
 * records are read-only (the refusal names the pack and the release), an editor may not release it,
 * the preview counts what becomes the hub's own, and after the release the part and the design accept
 * PUT (and the part DELETE) like any record of the hub's own, the photo is still served, the pack is
 * listed as released, and installing or updating it again is refused. All synthetic.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

import type { StudioUser } from '../server/me.ts';
import { photoBundle } from './pack-photo-fixture.ts';

const SRC = 'synthetic example: release pack';
export const PACK = 'release-pack';
export const OWNER: StudioUser = { name: 'owner-a', source: 'session', role: 'owner' };
const EDITOR: StudioUser = { name: 'editor-b', source: 'session', role: 'editor' };
const STARTER_DESIGN = fileURLToPath(new URL('../../../packages/catalog/data/designs/dc-pigtail-lead.json', import.meta.url));

/** The pack as a JSON bundle: a resistor, a design (a starter design under a new id) with its drawing facts, a signal, a drawing photo. */
export function releaseBundle(version = '1.0.0'): { bundle: { format: number; manifest: object; files: Record<string, unknown> }; photoSha: string; photoDesign: string } {
  const photo = photoBundle(version, 3, 'de9-crossover', PACK);
  const { productRef: _number, ...design } = JSON.parse(readFileSync(STARTER_DESIGN, 'utf8')) as Record<string, unknown>;
  return {
    photoSha: photo.sha,
    photoDesign: photo.design,
    bundle: {
      format: 1,
      manifest: { format: 1, id: PACK, name: 'Release pack', version, license: 'CC0-1.0' },
      files: {
        ...photo.bundle.files,
        'components.json': [{ id: 'rel-r', label: '47 Ω resistor', kind: 'resistor', value: '47 Ω', terminals: [{ id: 'a' }, { id: 'b' }], src: SRC }],
        'vocab/signals.json': { id: 'signals', label: 'Signals', src: SRC, entries: [{ id: 'rel-sense', label: 'Release sense', kind: 'data', src: SRC }] },
        'designs/rel-lead.json': { ...design, id: 'rel-lead', label: 'Release lead', src: SRC },
        'drawings/rel-lead.json': { title: 'Release lead drawing', revision: 'A' },
      },
    },
  };
}

type Call = (method: string, path: string, body?: unknown, extra?: { user?: StudioUser; headers?: Record<string, string> }) => Promise<{ status: number; body: any; headers?: Record<string, string> }>;

export interface ReleaseHooks {
  call: Call;
  /** after the release: the pack's layer is gone (files) — nothing to check on Postgres */
  layerGone?: () => boolean;
}

export async function runReleaseFlow(h: ReleaseHooks): Promise<void> {
  const { bundle, photoSha, photoDesign } = releaseBundle();
  const installed = await h.call('POST', '/api/packs/install', { bundle, apply: true });
  expect(installed.status, JSON.stringify(installed.body)).toBe(200);

  // read-only while installed: the refusal names the pack and the way out
  const part = await h.call('GET', '/api/definitions/components/rel-r');
  expect(part.headers?.['X-WireHub-Pack']).toBe(`${PACK}@1.0.0`);
  const refused = await h.call('PUT', '/api/definitions/components/rel-r', { ...structuredClone(part.body), value: '48 Ω' }, { headers: { 'if-match': part.headers?.['ETag'] ?? '' } });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain(`comes from the ${PACK} pack`);
  expect(refused.body.hint).toMatch(/release the release-pack pack to this hub/);

  // owners only
  const byEditor = await h.call('POST', `/api/packs/${PACK}/release`, { apply: true }, { user: EDITOR });
  expect(byEditor.status).toBe(403);

  // the preview: what becomes the hub's own, and nothing written
  const preview = await h.call('POST', `/api/packs/${PACK}/release`, {}, { user: OWNER });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body).toMatchObject({ preview: true, applicable: true });
  expect(preview.body.plan.counts).toEqual({ components: 1, design: 1, signals: 1 });
  expect(preview.body.plan.files).toEqual(expect.arrayContaining(['drawings/rel-lead.json', `assets/${photoSha}.png`]));
  expect((await h.call('GET', '/api/definitions/components')).body.packs).toHaveProperty('rel-r');

  const done = await h.call('POST', `/api/packs/${PACK}/release`, { apply: true }, { user: OWNER });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body).toMatchObject({ released: true, id: PACK, version: '1.0.0', records: 3 });
  if (h.layerGone !== undefined) expect(h.layerGone()).toBe(true);

  // listed as released, with who and when; no longer guarded
  const list = (await h.call('GET', '/api/packs')).body.packs as { id: string; released?: { by?: string } }[];
  expect(list.find((p) => p.id === PACK)).toMatchObject({ version: '1.0.0', records: 3, released: { by: 'owner-a' } });
  expect((await h.call('GET', '/api/definitions/components')).body.packs).toEqual({});

  // the part: same id and content, now editable in place
  const after = await h.call('GET', '/api/definitions/components/rel-r');
  expect(after.status).toBe(200);
  expect(after.headers?.['X-WireHub-Pack']).toBeUndefined();
  expect(after.body).toEqual(part.body);
  const edited = await h.call('PUT', '/api/definitions/components/rel-r', { ...after.body, value: '48 Ω' }, { headers: { 'if-match': after.headers?.['ETag'] ?? '' } });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  expect((await h.call('GET', '/api/definitions/components/rel-r')).body.value).toBe('48 Ω');

  // the design too
  const design = await h.call('GET', '/api/designs/rel-lead');
  expect(design.status, JSON.stringify(design.body)).toBe(200);
  const shown = (design.body.design ?? design.body) as Record<string, unknown>;
  const saved = await h.call('PUT', '/api/designs/rel-lead', { ...shown, label: 'Release lead, edited' }, { headers: { 'if-match': design.headers?.['ETag'] ?? '' } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const reread = await h.call('GET', '/api/designs/rel-lead');
  expect((reread.body.design ?? reread.body).label).toBe('Release lead, edited');

  // the vocabulary entry is the hub's own as well, and the auxiliary files stayed
  expect(((await h.call('GET', '/api/vocab/signals')).body.entries as { id: string }[]).some((e) => e.id === 'rel-sense')).toBe(true);
  expect((await h.call('GET', `/api/drawings/${photoDesign}`)).body.photo).toMatch(/^data:image\/png;base64,/);
  expect((await h.call('GET', `/api/assets/${photoSha}`)).status).toBe(200);

  // a released record can go, like any record of the hub's own
  const fresh = await h.call('GET', '/api/definitions/components/rel-r');
  const removed = await h.call('DELETE', '/api/definitions/components/rel-r', { confirm: 'rel-r' }, { headers: { 'if-match': fresh.headers?.['ETag'] ?? '' } });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect((await h.call('GET', '/api/definitions/components/rel-r')).status).toBe(404);

  // installing or updating the same pack id again is refused: a pack never overwrites the hub's own records
  const again = await h.call('POST', '/api/packs/install', { bundle: releaseBundle('1.1.0').bundle });
  expect(again.status).toBe(409);
  expect(again.body.error).toMatch(/was released to this hub/);
  expect(again.body.released).toMatchObject({ id: PACK, version: '1.0.0' });
  expect((await h.call('POST', `/api/packs/${PACK}/update`)).status).toBe(409);
  expect((await h.call('POST', `/api/packs/${PACK}/release`, { apply: true }, { user: OWNER })).status).toBe(409);
  expect((await h.call('GET', '/api/designs/rel-lead')).status).toBe(200);
}
