/**
 * Delivering one webhook: the `webhook` job handler, the retry schedule and the
 * delivery log helpers.
 *
 * One delivery attempt is one job (`kind: webhook`), so it is recorded, listed under
 * Jobs and run by the worker like any other. A request is
 * `{ deliveryId, subscription, eventId, type, payload, attempt }`:
 *
 * - 2xx: done (`result.state = delivered`);
 * - a network error, a timeout, 408, 425, 429 or a 5xx: the next attempt is queued
 *   with a backoff (`result.state = retrying`) until `MAX_ATTEMPTS`, then the job
 *   fails (`failed`);
 * - any other answer (a 4xx the receiver means, a redirect): the job fails at once;
 * - a subscription with no secret never sends unsigned: the job fails.
 *
 * Redirects are not followed (a receiver cannot bounce a delivery to another address).
 */

import { randomUUID } from 'node:crypto';

import type { JobContext, JobOutcome, JobRun, JobService } from '../jobs/types.ts';
import type { RuntimeSettings } from '../runtime-settings.ts';
import type { DocStore } from '../storage/doc-store.ts';
import { SIGNATURE_HEADER, signBody } from './signature.ts';
import { readSecret, readSubscriptions } from './subscriptions.ts';

export const MAX_ATTEMPTS = 6;
/** the wait before attempt 2, 3 … (seconds): 30 s, 2 min, 10 min, 1 h, 6 h */
export const DEFAULT_BACKOFF_SECONDS = [30, 120, 600, 3600, 21600] as const;
const TIMEOUT_MS = 10_000;
/** a payload larger than this is not sent (a summary is small by construction) */
export const MAX_BODY_BYTES = 256 * 1024;

export interface DeliveryRequest {
  deliveryId: string;
  subscription: string;
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
  attempt: number;
  test?: boolean;
  redeliveredFrom?: string;
  /** ISO time a delayed attempt is due */
  notBefore?: string;
}

export interface DeliverOptions {
  docs: () => DocStore | undefined;
  settings: () => RuntimeSettings | undefined;
  jobs: () => JobService | undefined;
  fetch?: typeof fetch;
  /** the retry waits in seconds; default `DEFAULT_BACKOFF_SECONDS`, or `WIREHUB_WEBHOOK_BACKOFF` */
  backoffSeconds?: () => readonly number[];
  now?: () => Date;
}

/** `WIREHUB_WEBHOOK_BACKOFF` (comma-separated seconds, at most five) for a deployment that wants another schedule; unset: the default. */
export function backoffFromEnv(env: Readonly<Record<string, string | undefined>>): readonly number[] {
  const text = (env['WIREHUB_WEBHOOK_BACKOFF'] ?? '').trim();
  if (text === '') return DEFAULT_BACKOFF_SECONDS;
  const list = text.split(',').map((s) => Number(s.trim()));
  return list.length <= MAX_ATTEMPTS - 1 && list.every((n) => Number.isFinite(n) && n >= 0) ? list : DEFAULT_BACKOFF_SECONDS;
}

const RETRYABLE = new Set([408, 425, 429]);
const retryable = (status: number): boolean => RETRYABLE.has(status) || status >= 500;

export function readDeliveryRequest(request: Record<string, unknown>): DeliveryRequest | undefined {
  const r = request as Partial<DeliveryRequest>;
  if (typeof r.deliveryId !== 'string' || typeof r.subscription !== 'string' || typeof r.eventId !== 'string' || typeof r.type !== 'string' || typeof r.payload !== 'object' || r.payload === null || typeof r.attempt !== 'number') return undefined;
  return r as DeliveryRequest;
}

export async function runWebhookJob(context: JobContext, options: DeliverOptions): Promise<JobOutcome> {
  const req = readDeliveryRequest(context.job.request);
  if (req === undefined) throw new Error('This is not a webhook delivery request.');
  const subscription = (await readSubscriptions(options.docs())).find((s) => s.id === req.subscription);
  if (subscription === undefined) return { result: { state: 'skipped', reason: 'The subscription was removed.', attempt: req.attempt } };
  if (!subscription.enabled && req.test !== true) return { result: { state: 'skipped', reason: 'The subscription is turned off.', attempt: req.attempt } };
  const secret = await readSecret(options.settings(), subscription.id);
  if (secret === undefined) throw new Error('This subscription has no signing secret (or it cannot be read with this server\'s settings key), so nothing is sent unsigned. Set the secret in Settings, Webhooks.');
  const body = JSON.stringify(req.payload);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error(`The payload is larger than ${MAX_BODY_BYTES / 1024} KiB, so it was not sent.`);

  const now = options.now ?? (() => new Date());
  const doFetch = options.fetch ?? fetch;
  const started = Date.now();
  let status: number | undefined;
  let failure: string | undefined;
  try {
    const response = await doFetch(subscription.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'WireHub-Webhook/1',
        'x-wirehub-event': req.type,
        'x-wirehub-event-id': req.eventId,
        'x-wirehub-delivery': req.deliveryId,
        [SIGNATURE_HEADER]: signBody(secret, body, Math.floor(now().getTime() / 1000)),
      },
      body,
    });
    status = response.status;
    // drain, so the connection is released
    await response.arrayBuffer().catch(() => undefined);
    if (response.status < 200 || response.status >= 300) failure = `The receiver answered ${response.status}.`;
  } catch (error) {
    failure = `The receiver was not reached (${error instanceof Error ? error.message : String(error)}).`;
  }
  const ms = Date.now() - started;
  if (failure === undefined) {
    await context.step(`delivered, ${status} in ${ms} ms`);
    return { result: { state: 'delivered', status, attempt: req.attempt, ms, subscription: subscription.id, type: req.type } };
  }
  const canRetry = status === undefined || retryable(status);
  if (!canRetry || req.attempt >= MAX_ATTEMPTS) {
    throw new Error(`${failure} ${canRetry ? `Gave up after ${req.attempt} attempts.` : 'That is not an answer that is retried.'}`);
  }
  const waits = options.backoffSeconds?.() ?? DEFAULT_BACKOFF_SECONDS;
  const waitSeconds = waits[Math.min(req.attempt - 1, waits.length - 1)] ?? 30;
  const retryAt = new Date(now().getTime() + waitSeconds * 1000).toISOString();
  const next: DeliveryRequest = { ...req, attempt: req.attempt + 1, notBefore: retryAt };
  const jobs = options.jobs();
  if (jobs === undefined) throw new Error(`${failure} There is no job queue to retry on.`);
  await jobs.enqueue('webhook', next as unknown as Record<string, unknown>, undefined, { delayMs: waitSeconds * 1000 });
  await context.step(`${failure} Retrying in ${waitSeconds} s (attempt ${next.attempt} of ${MAX_ATTEMPTS}).`);
  return { result: { state: 'retrying', status: status ?? null, error: failure, attempt: req.attempt, retryAt, ms, subscription: subscription.id, type: req.type } };
}

/* ------------------------------------------------------------------ *
 * The delivery log
 * ------------------------------------------------------------------ */

export type DeliveryState = 'queued' | 'running' | 'delivered' | 'retrying' | 'failed' | 'skipped';

export interface DeliveryRecord {
  /** the job id of this attempt: what redelivery takes */
  id: string;
  deliveryId: string;
  subscription: string;
  type: string;
  eventId: string;
  attempt: number;
  state: DeliveryState;
  status?: number;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  retryAt?: string;
  redeliveredFrom?: string;
  test?: boolean;
}

export function deliveryOf(job: JobRun): DeliveryRecord | undefined {
  const req = readDeliveryRequest(job.request);
  if (req === undefined) return undefined;
  const result = job.result ?? {};
  let state: DeliveryState;
  if (job.status === 'queued') state = 'queued';
  else if (job.status === 'running') state = 'running';
  else if (job.status === 'failed' || job.status === 'cancelled') state = 'failed';
  else state = (result['state'] as DeliveryState | undefined) ?? 'delivered';
  return {
    id: job.id,
    deliveryId: req.deliveryId,
    subscription: req.subscription,
    type: req.type,
    eventId: req.eventId,
    attempt: req.attempt,
    state,
    ...(typeof result['status'] === 'number' ? { status: result['status'] } : {}),
    ...(job.error !== undefined ? { error: job.error } : typeof result['error'] === 'string' ? { error: result['error'] } : {}),
    createdAt: job.createdAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(typeof result['retryAt'] === 'string' ? { retryAt: result['retryAt'] } : req.notBefore !== undefined && state === 'queued' ? { retryAt: req.notBefore } : {}),
    ...(req.redeliveredFrom === undefined ? {} : { redeliveredFrom: req.redeliveredFrom }),
    ...(req.test === true ? { test: true } : {}),
  };
}

export const newDeliveryId = (): string => randomUUID();
