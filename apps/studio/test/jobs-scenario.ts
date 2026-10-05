/**
 * The import job, end to end, through the API (Postgres plan task C2's
 * gate): start an example module importer, wait for its plan, read it,
 * publish it, read the catalog back. Run on the file backend and on
 * Postgres (in this process, and through the worker); the logs and the
 * exported catalogs must be equal.
 */

import { expect } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { CatalogExport } from '../server/pg/export.ts';
import type { StudioUser } from '../server/me.ts';
import { EXAMPLE_IMPORT_PATH, exampleBody } from './fixtures/example-importer.ts';

const USER: StudioUser = { name: 'Importer Person', email: 'importer@example.com', source: 'session' };

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

export interface ImportScenarioResult {
  log: string[];
  jobId: string;
  exported: CatalogExport;
}

export async function importScenario(deps: WorkbenchDeps, options: { timeoutMs?: number } = {}): Promise<ImportScenarioResult> {
  const log: string[] = [];
  const started = await handleWorkbenchRequest({ method: 'POST', path: EXAMPLE_IMPORT_PATH, body: exampleBody(), user: USER }, deps);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const jobId = (started.body as { job: { id: string; status: string } }).job.id;
  log.push(`start: ${started.status} ${(started.body as { job: { status: string } }).job.status}`);
  const done = await deps.jobs!.wait(jobId, options.timeoutMs ?? 60_000);
  log.push(`run: ${done.status}${done.error === undefined ? '' : ` ${done.error}`}`);
  const got = await handleWorkbenchRequest({ method: 'GET', path: `/api/jobs/${jobId}`, user: USER }, deps);
  const body = got.body as { job: { status: string; result: Record<string, unknown>; requestedBy?: { name: string } }; files: { path: string; status: string; content?: string }[] };
  log.push(`job: ${got.status} ${body.job.status} by ${body.job.requestedBy?.name ?? '?'}`);
  log.push(`result: proposed ${String(body.job.result['proposed'])}, changes ${String(body.job.result['changes'])}, requests ${JSON.stringify(body.job.result['requests'])}, notes ${JSON.stringify(body.job.result['notes'])}`);
  // a job's result is jsonb on Postgres (key order not kept): compared with sorted keys
  log.push(`proposal: ${sortedJson(body.job.result['proposal'])}`);
  for (const f of body.files) log.push(`plan: ${f.status} ${f.path} ${f.content?.length ?? 0}`);
  const published = await handleWorkbenchRequest({ method: 'POST', path: `/api/jobs/${jobId}/publish`, user: USER }, deps);
  log.push(`publish: ${published.status} applied ${String((published.body as { applied?: number }).applied)}`);
  const again = await handleWorkbenchRequest({ method: 'POST', path: `/api/jobs/${jobId}/publish`, user: USER }, deps);
  log.push(`publish again: ${again.status}`);
  const list = await handleWorkbenchRequest({ method: 'GET', path: '/api/definitions/mechanicals' }, deps);
  log.push(`mechanicals: ${JSON.stringify((list.body as { records?: { id: string; label: string }[] }).records?.map((r) => `${r.id}=${r.label}`) ?? list.body)}`);
  return { log, jobId, exported: await deps.exportCatalog!() };
}
