/**
 * Revisions of library records over the API, one flow for both backends (`revisions.server.test.ts`,
 * `pg/revisions.server.test.ts`): save a revision, refuse an unchanged one, see a saved design
 * version built with it, change the record, save the next one under a new variant number, read one
 * in full, import a history, and list a module source's revisions beside the hub's.
 */

import { expect } from 'vitest';

import type { StudioUser } from '../server/me.ts';

export const OWNER: StudioUser = { name: 'Olive Owner', source: 'session', role: 'owner' };

export interface RevisionsFlowHooks {
  call: (method: string, path: string, body?: unknown, user?: StudioUser, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers?: Record<string, string> }>;
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
const PATH = '/api/revisions/connectors/de9-female';

export async function runRevisionsFlow({ call }: RevisionsFlowHooks): Promise<void> {
  const none = await call('GET', PATH, undefined, OWNER);
  expect(none.status, JSON.stringify(none.body)).toBe(200);
  expect(none.body.revisions).toEqual([]);
  expect(none.body.current.rev).toBeUndefined();
  expect(none.body.whereUsed.unrecorded.map((u: any) => u.design)).toContain('de9-crossover');
  expect((await call('GET', '/api/revisions/designs/x', undefined, OWNER)).status).toBe(400);
  expect((await call('GET', '/api/revisions/connectors/no-such', undefined, OWNER)).status).toBe(404);

  // the first revision, with its art
  const first = await call('POST', PATH, { note: 'as first drawn', art: { view: 'mating-face', svg: SVG } }, OWNER);
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body.revisions.map((r: any) => [r.rev, r.note, r.savedBy, r.hasArt])).toEqual([[1, 'as first drawn', 'Olive Owner', true]]);
  expect(first.body.current.rev).toBe(1);
  expect((await call('POST', PATH, { note: 'again' }, OWNER)).status).toBe(409);
  expect((await call('POST', PATH, { note: 'bad art', art: { view: 'x', svg: 'not svg' } }, OWNER)).status).toBe(400);

  // a saved version of a design that uses it is built with revision 1
  const version = await call('POST', '/api/designs/de9-crossover/versions', { note: 'first release' }, OWNER);
  expect(version.status, JSON.stringify(version.body)).toBeLessThan(300);
  const used = await call('GET', PATH, undefined, OWNER);
  expect(used.body.whereUsed.byRev['1'].some((u: any) => u.design === 'de9-crossover' && typeof u.version === 'number')).toBe(true);

  // the record changes: it is no longer revision 1, the version still is
  const record = await call('GET', '/api/definitions/connectors/de9-female', undefined, OWNER);
  const relabelled = await call('PUT', '/api/definitions/connectors/de9-female', { ...record.body, label: `${record.body.label} (rev 2)` }, OWNER, { 'if-match': record.headers?.ETag ?? '' });
  expect(relabelled.status, JSON.stringify(relabelled.body)).toBe(200);
  const changed = await call('GET', PATH, undefined, OWNER);
  expect(changed.body.current.changedSince).toBe(1);
  expect(changed.body.whereUsed.unrecorded.some((u: any) => u.design === 'de9-crossover' && u.version === undefined)).toBe(true);
  expect(changed.body.whereUsed.byRev['1'].some((u: any) => u.design === 'de9-crossover')).toBe(true);

  // the next revision under the scheme's next variant number
  const next = await call('GET', `${PATH}/next-number`, undefined, OWNER);
  expect(next.status, JSON.stringify(next.body)).toBe(200);
  const second = await call('POST', PATH, { note: 'relabelled', renumber: true }, OWNER);
  expect(second.status, JSON.stringify(second.body)).toBe(201);
  expect(second.body.revisions.map((r: any) => r.rev)).toEqual([1, 2]);
  expect(second.body.revisions[1].partNumber).toBe(next.body.suggestion.pn);
  const stored = await call('GET', '/api/definitions/connectors/de9-female', undefined, OWNER);
  expect(stored.body.partNumber).toBe(next.body.suggestion.pn);

  // one revision in full
  const full = await call('GET', `${PATH}/1`, undefined, OWNER);
  expect(full.status).toBe(200);
  expect(full.body.record.id).toBe('de9-female');
  expect(full.body.art.svg).toBe(SVG);
  expect((await call('GET', `${PATH}/9`, undefined, OWNER)).status).toBe(404);

  // a history imported from another system replaces the hub's (If-Match), checked first
  const tag = second.headers?.ETag ?? '';
  const imported = {
    kind: 'connectors',
    id: 'de9-female',
    revisions: [...[1, 2].map((rev) => ({ ...(full.body as object), rev, note: `imported ${rev}` }))],
  };
  expect((await call('PUT', PATH, imported, OWNER)).status).toBe(428);
  expect((await call('PUT', PATH, { ...imported, revisions: [{ ...imported.revisions[0], rev: 0 }] }, OWNER, { 'if-match': tag })).status).toBe(422);
  const put = await call('PUT', PATH, imported, OWNER, { 'if-match': tag });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  expect(put.body.revisions.map((r: any) => r.note)).toEqual(['imported 1', 'imported 2']);
}
