/**
 * Outbound event webhooks, end to end over one backend: subscriptions in Settings, the signing
 * secret in the encrypted store, deliveries as jobs (signed, retried with backoff, logged,
 * redelivered), and the events a save, a version, a number and a finished job raise.
 * The file backend's commit tree and Postgres run the same script (`webhooks.server.test.ts`,
 * `pg/webhooks.server.test.ts`).
 */

import { expect } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner } from '../server/jobs/service.ts';
import type { JobRun, JobStore } from '../server/jobs/types.ts';
import type { StudioUser } from '../server/me.ts';
import { createRuntimeSettings } from '../server/runtime-settings.ts';
import { settingsCipher, type SecretStore } from '../server/settings-secrets.ts';
import { createWebhookEmitter } from '../server/webhooks/emitter.ts';
import { verifySignature } from '../server/webhooks/signature.ts';

export const KEY = 'k'.repeat(43);
export const OWNER: StudioUser = { name: 'Olive Owner', email: 'olive@example.com', source: 'session', role: 'owner' };
export const EDITOR: StudioUser = { name: 'Ed Editor', email: 'ed@example.com', source: 'session', role: 'editor' };
const OWNER_TOKEN: StudioUser = { ...OWNER, apiTokenId: 'token-1' };

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
  json: any;
}

export interface WebhookBackend {
  deps: WorkbenchDeps;
  secrets: SecretStore;
  jobStore: JobStore;
  org: string;
}

export async function webhooksScenario(backend: WebhookBackend): Promise<void> {
  const { deps, secrets, jobStore } = backend;
  const sent: Sent[] = [];
  /** what the receiver answers to the n-th request (1-based) */
  let answer: (n: number) => number = () => 200;
  deps.webhookFetch = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
    const body = String(init.body);
    sent.push({ url, headers, body, json: JSON.parse(body) });
    return new Response(null, { status: answer(sent.length) });
  }) as typeof fetch;
  const settings = createRuntimeSettings({ env: { WIREHUB_WEBHOOK_BACKOFF: '0,0,0,0,0', WIREHUB_PUBLIC_URL: 'https://hub.example.test' }, docs: () => deps.docs, secrets: () => secrets, org: () => backend.org, cipher: settingsCipher(KEY), log: () => {} });
  deps.runtimeSettings = settings;
  const runner = inlineJobRunner(jobStore, () => baseJobHandlers({ deps, liveEnv: () => settings.env() }), () => {}, (job) => deps.webhooks?.jobFinished(job));
  deps.jobs = createJobService({ store: jobStore, runner, kinds: ['webhook', 'import', 'model-cache'] });
  deps.webhooks = createWebhookEmitter({ docs: () => deps.docs, jobs: () => deps.jobs, env: () => settings.env() });
  deps.afterCommit = async (set) => {
    await deps.webhooks?.catalogChanged(set);
  };
  const settle = async (): Promise<void> => {
    await runner.idle();
    await runner.idle();
  };
  const call = async (method: string, path: string, body?: unknown, user: StudioUser = OWNER, headers: Record<string, string> = {}) =>
    (await handleWorkbenchRequest({ method, path, user, headers, ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any; headers?: Record<string, string> };
  const etagOf = async (): Promise<string> => (await call('GET', '/api/settings/webhooks')).headers?.ETag ?? '';

  // owners only, and not with an API token
  expect((await call('GET', '/api/settings/webhooks', undefined, EDITOR)).status).toBe(403);
  expect((await call('PUT', '/api/settings/webhooks', { subscriptions: [] }, OWNER_TOKEN, { 'if-match': await etagOf() })).status).toBe(403);
  const first = await call('GET', '/api/settings/webhooks');
  expect(first.status).toBe(200);
  expect(first.body.subscriptions).toEqual([]);
  expect(first.body.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['design.saved', 'version.released', 'part-number.assigned', 'pack.installed', 'job.finished', 'catalog.changed']));
  expect(first.body.secrets.available).toBe(true);

  // a subscription: checked, then saved
  const put = (subscriptions: unknown[]) => call('PUT', '/api/settings/webhooks', { subscriptions }, OWNER, { 'if-match': first.headers?.ETag ?? '' });
  expect((await put([{ url: 'ftp://erp.example.test/hook', events: ['design.saved'] }])).status).toBe(400);
  expect((await put([{ url: 'https://erp.example.test/hook', events: ['design.exploded'] }])).status).toBe(400);
  expect((await put([{ url: 'https://u:p@erp.example.test/hook', events: ['design.saved'] }])).status).toBe(400);
  const saved = await put([{ label: 'ERP', url: 'https://erp.example.test/wirehub', events: ['design.saved', 'part-number.assigned', 'version.released', 'catalog.changed', 'job.finished'] }]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const sub = saved.body.subscriptions[0];
  expect(sub.id).toMatch(/^wh-[0-9a-f]{8}$/);
  expect(sub.secret).toBe('unset');
  expect((await put([])).status).toBe(409); // the stale tag

  // nothing is sent unsigned
  expect((await call('POST', `/api/settings/webhooks/${sub.id}/test`)).status).toBe(409);

  // the secret: generated once, never read back
  const made = await call('PUT', `/api/settings/webhooks/${sub.id}/secret`, {});
  expect(made.status).toBe(200);
  const secret: string = made.body.generated;
  expect(secret).toMatch(/^whsec_/);
  const view = await call('GET', '/api/settings/webhooks');
  expect(view.body.subscriptions[0].secret).toBe('set');
  expect(JSON.stringify(view.body)).not.toContain(secret);
  expect((await call('PUT', `/api/settings/webhooks/${sub.id}/secret`, { value: 'short' })).status).toBe(400);
  expect(Object.keys(await secrets.all())).toEqual([`webhook.${sub.id.replace('-', '')}`]);
  expect(JSON.stringify(await secrets.all())).not.toContain(secret);

  // a test delivery: signed with the secret, over the exact body
  expect((await call('POST', `/api/settings/webhooks/${sub.id}/test`)).status).toBe(202);
  await settle();
  expect(sent).toHaveLength(1);
  const test = sent[0] as Sent;
  expect(test.url).toBe('https://erp.example.test/wirehub');
  expect(test.headers['x-wirehub-event']).toBe('webhook.test');
  expect(verifySignature(secret, test.body, test.headers['x-wirehub-signature'], Math.floor(Date.now() / 1000))).toBe(true);
  expect(verifySignature(`${secret}x`, test.body, test.headers['x-wirehub-signature'], Math.floor(Date.now() / 1000))).toBe(false);
  expect(test.json).toMatchObject({ schema: 'wirehub.event/1', type: 'webhook.test', hub: { url: 'https://hub.example.test' } });

  // a save: design.saved with a diff summary, the number assigned, the catalog changed — and links to fetch the data
  sent.length = 0;
  const design = await call('GET', '/api/designs/de9-crossover');
  const edited = await call('PUT', '/api/designs/de9-crossover', { ...design.body, label: `${design.body.label} (webhook)`, productRef: 'CBL-77777' }, OWNER, { 'if-match': design.headers?.ETag ?? '' });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  await settle();
  const types = sent.map((s) => s.json.type).sort();
  expect(types).toEqual(['catalog.changed', 'design.saved', 'part-number.assigned']);
  const saveEvent = sent.find((s) => s.json.type === 'design.saved')?.json;
  expect(saveEvent).toMatchObject({
    subject: { kind: 'design', id: 'de9-crossover' },
    actor: { name: 'Olive Owner', email: 'olive@example.com', via: 'session' },
    summary: { action: 'updated' },
    links: { ui: 'https://hub.example.test/cables/de9-crossover', api: 'https://hub.example.test/api/designs/de9-crossover' },
    fetch: { design: 'https://hub.example.test/api/designs/de9-crossover', exports: { 'bom.csv': 'https://hub.example.test/api/designs/de9-crossover/exports/bom.csv' } },
  });
  expect(saveEvent.summary.changes.lines.length).toBeGreaterThan(0);
  expect(sent.find((s) => s.json.type === 'part-number.assigned')?.json.summary).toMatchObject({ field: 'productRef', partNumber: 'CBL-77777' });
  const catalogEvent = sent.find((s) => s.json.type === 'catalog.changed')?.json;
  expect(catalogEvent.summary.records).toEqual([{ kind: 'design', key: 'de9-crossover', op: 'put' }]);
  for (const s of sent) expect(verifySignature(secret, s.body, s.headers['x-wirehub-signature'], Math.floor(Date.now() / 1000))).toBe(true);

  // a version: saved (not subscribed) and released (approvals are off, so saving releases)
  sent.length = 0;
  const version = await call('POST', '/api/designs/de9-crossover/versions', { note: 'first release' });
  expect(version.status, JSON.stringify(version.body)).toBe(201);
  await settle();
  const versionEvents = sent.map((s) => s.json.type);
  expect(versionEvents).toContain('version.released');
  expect(versionEvents).not.toContain('version.saved');
  const released = sent.find((s) => s.json.type === 'version.released')?.json;
  expect(released.subject.rev).toBe(0);
  expect(released.fetch.exports['bom.csv']).toBe('https://hub.example.test/api/designs/de9-crossover/exports/bom.csv?rev=0');

  // a receiver that fails twice, then answers: retried with backoff, one delivery of three attempts
  sent.length = 0;
  answer = (n) => (n <= 2 ? 503 : 200);
  expect((await call('POST', `/api/settings/webhooks/${sub.id}/test`)).status).toBe(202);
  await settle();
  expect(sent).toHaveLength(3);
  const log = (await call('GET', `/api/settings/webhooks/deliveries?subscription=${sub.id}`)).body.deliveries as { id: string; deliveryId: string; attempt: number; state: string; status?: number }[];
  const latest = log.filter((d) => d.deliveryId === log[0]?.deliveryId).sort((a, b) => a.attempt - b.attempt);
  expect(latest.map((d) => [d.attempt, d.state])).toEqual([[1, 'retrying'], [2, 'retrying'], [3, 'delivered']]);
  expect(latest[0]?.status).toBe(503);
  expect(new Set(sent.map((s) => s.headers['x-wirehub-delivery'])).size).toBe(1);

  // a receiver that never answers well: gives up after six attempts, and the log says so
  sent.length = 0;
  answer = () => 500;
  await call('POST', `/api/settings/webhooks/${sub.id}/test`);
  await settle();
  expect(sent).toHaveLength(6);
  const failed = ((await call('GET', `/api/settings/webhooks/deliveries?subscription=${sub.id}`)).body.deliveries as { id: string; attempt: number; state: string; error?: string }[]).find((d) => d.attempt === 6);
  expect(failed?.state).toBe('failed');
  expect(failed?.error).toMatch(/Gave up after 6 attempts/);

  // an answer that is not retried fails at once
  sent.length = 0;
  answer = () => 404;
  await call('POST', `/api/settings/webhooks/${sub.id}/test`);
  await settle();
  expect(sent).toHaveLength(1);

  // redelivery from the log: a new delivery of the same event
  answer = () => 200;
  sent.length = 0;
  const redo = await call('POST', `/api/settings/webhooks/deliveries/${failed?.id}/redeliver`);
  expect(redo.status).toBe(202);
  await settle();
  expect(sent).toHaveLength(1);
  const after = (await call('GET', `/api/settings/webhooks/deliveries?subscription=${sub.id}`)).body.deliveries as { redeliveredFrom?: string; state: string }[];
  expect(after[0]).toMatchObject({ state: 'delivered' });
  expect(after[0]?.redeliveredFrom).toBeDefined();
  expect((await call('POST', '/api/settings/webhooks/deliveries/00000000-0000-0000-0000-000000000000/redeliver')).status).toBe(404);

  // a finished job is an event, a delivery's own finish is not
  sent.length = 0;
  const jobDone: JobRun = { id: 'job-1', kind: 'import', status: 'done', request: {}, steps: [], result: { files: [1, 2], note: 'x' }, createdAt: '2026-10-05T10:00:00.000Z', startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:00:02.000Z' };
  await deps.webhooks?.jobFinished(jobDone);
  await deps.webhooks?.jobFinished({ ...jobDone, id: 'job-2', kind: 'webhook' });
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.json).toMatchObject({ type: 'job.finished', subject: { kind: 'job', id: 'job-1', label: 'import' }, summary: { job: 'import', status: 'done', durationMs: 2000 }, links: { ui: 'https://hub.example.test/jobs' } });

  // the secret is in no export, no history; the subscriptions' document is the owner's alone
  const ownerExport = await call('GET', '/api/export');
  expect(JSON.stringify(ownerExport.body)).not.toContain(secret);
  expect(ownerExport.body.files['data/settings/webhooks.json']).toBeDefined();
  const editorExport = await call('GET', '/api/export', undefined, EDITOR);
  expect(editorExport.body.files['data/settings/webhooks.json']).toBeUndefined();
  expect((await call('GET', '/api/docs/settings/webhooks.json', undefined, EDITOR)).status).toBe(403);

  // changing only the webhooks announces no catalog change; removing the subscription takes its secret
  sent.length = 0;
  const current = await call('GET', '/api/settings/webhooks');
  const removed = await call('PUT', '/api/settings/webhooks', { subscriptions: [] }, OWNER, { 'if-match': current.headers?.ETag ?? '' });
  expect(removed.status).toBe(200);
  await settle();
  expect(sent).toHaveLength(0);
  expect(await secrets.all()).toEqual({});
  expect((await call('POST', `/api/settings/webhooks/${sub.id}/test`)).status).toBe(404);
}
