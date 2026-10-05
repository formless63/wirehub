/**
 * Change history (cs-5k1.4), one scripted session run on every backend that
 * keeps history — the file backend over a git catalog, and Postgres:
 *
 * 1. Alice relabels a design, Bob edits it again, Bob relabels a component.
 * 2. The design's own history lists Bob's and Alice's changes, newest first,
 *    with the fields they touched; an entry's detail has the before and after
 *    of the design and the current version a restore must quote.
 * 3. The hub-wide list filters by person and by kind.
 * 4. Carol restores the design to its state after Alice's change: a new
 *    entry, attributed to Carol, history untouched; a stale restore is
 *    refused and writes nothing; the restore is itself restorable.
 * 5. The component goes back to its state before Bob touched it (an entry
 *    that did not change it: the state is carried from the neighbours).
 *
 * `afterSave` runs after every successful write: the file backend commits
 * there, as the git export would, as the person who saved.
 */

import { expect } from 'vitest';

import { handleWorkbenchRequest, type ApiRequest, type ApiResponse, type WorkbenchDeps } from '../server/api.ts';
import type { StudioUser } from '../server/me.ts';
import type { HistoryEntryDetail, HistoryPage, RestoreAnswer } from '../src/history/types.ts';
import { fieldDiff } from '../src/history/diff.ts';

export const DESIGN = 'dc-led-lead';
export const COMPONENT = 'r-120';

export const alice: StudioUser = { name: 'Alice Example', email: 'alice@example.com', source: 'session' };
export const bob: StudioUser = { name: 'Bob Example', email: 'bob@example.com', source: 'session' };
export const carol: StudioUser = { name: 'Carol Example', email: 'carol@example.com', source: 'session' };

export interface HistoryBackend {
  deps: WorkbenchDeps;
  /** after each successful write (the file backend: a commit by `user`) */
  afterSave?: (user: StudioUser, response: ApiResponse, request: ApiRequest) => Promise<void> | void;
}

export async function historyScenario(backend: HistoryBackend): Promise<{ log: string[] }> {
  const { deps } = backend;
  const log: string[] = [];
  const call = async (request: ApiRequest): Promise<ApiResponse> => {
    const answer = await handleWorkbenchRequest(request, deps);
    if (answer.status < 400 && request.method !== 'GET' && request.user !== undefined) await backend.afterSave?.(request.user, answer, request);
    return answer;
  };
  const get = async <T>(path: string): Promise<T> => {
    const answer = await call({ method: 'GET', path });
    expect(answer.status, `${path}: ${JSON.stringify(answer.body)}`).toBe(200);
    return answer.body as T;
  };
  const read = async (): Promise<{ design: { label: string; notes?: string[] }; etag: string }> => {
    const answer = await call({ method: 'GET', path: `/api/designs/${DESIGN}` });
    return { design: answer.body as { label: string; notes?: string[] }, etag: answer.headers?.ETag as string };
  };

  // 1. three saves by two people
  const original = await read();
  const aliceLabel = `${original.design.label} (Alice)`;
  let saved = await call({ method: 'PUT', path: `/api/designs/${DESIGN}`, body: { ...original.design, label: aliceLabel }, headers: { 'if-match': original.etag }, user: alice });
  expect(saved.status).toBe(200);
  const afterAlice = await read();
  saved = await call({ method: 'PUT', path: `/api/designs/${DESIGN}`, body: { ...afterAlice.design, notes: [...(afterAlice.design.notes ?? []), 'Bob was here'] }, headers: { 'if-match': afterAlice.etag }, user: bob });
  expect(saved.status).toBe(200);
  const component = await call({ method: 'GET', path: `/api/definitions/components/${COMPONENT}` });
  const originalComponent = component.body as { label: string };
  saved = await call({ method: 'PUT', path: `/api/definitions/components/${COMPONENT}`, body: { ...originalComponent, label: 'Resistor 120 Ω (Bob)' }, headers: { 'if-match': component.headers?.ETag as string }, user: bob });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  // 2. the design's own history
  const subject = `design:${DESIGN}`;
  const own = await get<HistoryPage>(`/api/history/records/${encodeURIComponent(subject)}`);
  expect(own.capabilities.perRecord).toBe(true);
  expect(own.entries.map((e) => e.by.name).slice(0, 2)).toEqual([bob.name, alice.name]);
  const aliceEntry = own.entries[1]!;
  const bobEntry = own.entries[0]!;
  expect(aliceEntry.touches.find((t) => t.part === 'design')?.fields).toEqual(['label']);
  expect(bobEntry.touches.find((t) => t.part === 'design')?.fields).toEqual(['notes']);
  log.push(`own: ${own.entries.length} entries`);

  const detail = await get<HistoryEntryDetail>(`/api/history/entries/${aliceEntry.id}?subject=${encodeURIComponent(subject)}`);
  const designDiff = detail.records.find((r) => r.part === 'design');
  expect(designDiff?.op).toBe('changed');
  expect(designDiff?.restorable).toBe(true);
  expect(designDiff?.before.known && (designDiff.before.value as { label: string }).label).toBe(original.design.label);
  expect(designDiff?.after.known && (designDiff.after.value as { label: string }).label).toBe(aliceLabel);
  expect(fieldDiff(designDiff?.before.known ? designDiff.before.value : undefined, designDiff?.after.known ? designDiff.after.value : undefined)).toEqual([
    { path: 'label', op: 'changed', before: original.design.label, after: aliceLabel },
  ]);
  const now = await read();
  expect(detail.current?.design).toBe(now.etag);

  // 3. the hub-wide list, filtered
  const hub = await get<HistoryPage>('/api/history?limit=10');
  expect(hub.entries.length).toBeGreaterThanOrEqual(3);
  expect(hub.entries[0]?.by.name).toBe(bob.name);
  expect(hub.entries[0]?.touches.some((t) => t.subject === `definition:components:${COMPONENT}` || t.subject === 'other:definitions:components')).toBe(true);
  const byAlice = await get<HistoryPage>('/api/history?person=ALICE');
  expect(byAlice.entries.map((e) => e.by.name)).toEqual([alice.name]);
  const library = await get<HistoryPage>(`/api/history?kind=library&person=${encodeURIComponent('bob@example')}`);
  expect(library.entries.length).toBe(1);
  expect(library.entries[0]?.id).toBe(hub.entries[0]?.id);
  const today = new Date().toISOString().slice(0, 10);
  expect((await get<HistoryPage>(`/api/history?from=2000-01-01&to=2000-01-02`)).entries).toEqual([]);
  expect((await get<HistoryPage>(`/api/history?from=${today}&person=alice`)).entries.length).toBe(1);
  const paged = await get<HistoryPage>('/api/history?limit=1');
  expect(paged.entries.length).toBe(1);
  expect(paged.next).toBeDefined();
  const second = await get<HistoryPage>(`/api/history?limit=1&before=${paged.next}`);
  expect(second.entries[0]?.id).not.toBe(paged.entries[0]?.id);
  const hubDetail = await get<HistoryEntryDetail>(`/api/history/entries/${hub.entries[0]!.id}`);
  const componentDiff = hubDetail.records.find((r) => r.subject === `definition:components:${COMPONENT}`);
  expect(componentDiff?.op).toBe('changed');
  log.push(`hub: ${hub.entries.length} entries`);

  // 4. Carol restores the design to its state after Alice's change
  const stale = await call({ method: 'POST', path: `/api/history/records/${encodeURIComponent(subject)}/restore`, body: { entry: aliceEntry.id, current: { design: original.etag } }, user: carol });
  expect(stale.status).toBe(409);
  expect((await read()).etag).toBe(now.etag);
  const unquoted = await call({ method: 'POST', path: `/api/history/records/${encodeURIComponent(subject)}/restore`, body: { entry: aliceEntry.id }, user: carol });
  expect(unquoted.status).toBe(428);
  const restored = await call({ method: 'POST', path: `/api/history/records/${encodeURIComponent(subject)}/restore`, body: { entry: aliceEntry.id, current: detail.current }, user: carol });
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  const answer = restored.body as RestoreAnswer;
  expect(answer.restored.parts).toContain('design');
  const back = await read();
  expect(back.design.label).toBe(aliceLabel);
  expect(back.design.notes ?? []).not.toContain('Bob was here');
  expect(answer.etag).toBe(back.etag);

  const after = await get<HistoryPage>(`/api/history/records/${encodeURIComponent(subject)}`);
  expect(after.entries.map((e) => e.by.name).slice(0, 3)).toEqual([carol.name, bob.name, alice.name]);
  expect(after.entries[0]?.message).toMatch(/restore design dc-led-lead to change/);
  expect(after.entries[1]?.id).toBe(bobEntry.id);

  // the restore is restorable: back to Bob's state
  const carolDetail = await get<HistoryEntryDetail>(`/api/history/entries/${bobEntry.id}?subject=${encodeURIComponent(subject)}`);
  const undo = await call({ method: 'POST', path: `/api/history/records/${encodeURIComponent(subject)}/restore`, body: { entry: bobEntry.id, current: carolDetail.current }, user: carol });
  expect(undo.status, JSON.stringify(undo.body)).toBe(200);
  expect((await read()).design.notes).toContain('Bob was here');

  // 5. the component, back to its state after Alice's change (which did not touch it)
  const componentSubject = `definition:components:${COMPONENT}`;
  const componentDetail = await get<HistoryEntryDetail>(`/api/history/entries/${aliceEntry.id}?subject=${encodeURIComponent(componentSubject)}`);
  expect(componentDetail.records).toEqual([]);
  const undoComponent = await call({ method: 'POST', path: `/api/history/records/${encodeURIComponent(componentSubject)}/restore`, body: { entry: aliceEntry.id, current: componentDetail.current }, user: carol });
  expect(undoComponent.status, JSON.stringify(undoComponent.body)).toBe(200);
  const componentNow = await call({ method: 'GET', path: `/api/definitions/components/${COMPONENT}` });
  expect((componentNow.body as { label: string }).label).toBe(originalComponent.label);
  const componentHistory = await get<HistoryPage>(`/api/history/records/${encodeURIComponent(componentSubject)}`);
  expect(componentHistory.entries.map((e) => e.by.name).slice(0, 2)).toEqual([carol.name, bob.name]);

  // refusals
  expect((await call({ method: 'GET', path: '/api/history/records/nonsense' })).status).toBe(400);
  expect((await call({ method: 'GET', path: '/api/history?kind=everything' })).status).toBe(400);
  expect((await call({ method: 'GET', path: '/api/history?from=yesterday' })).status).toBe(400);
  expect((await call({ method: 'POST', path: `/api/history/records/${encodeURIComponent(subject)}/restore`, body: { entry: '999999', current: {} }, user: carol })).status).toBe(404);
  log.push('restores: ok');
  return { log };
}
