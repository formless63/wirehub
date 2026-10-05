/**
 * The emitter: turns what happened into one `webhook` job per matching subscription.
 *
 * `emit` is called after a request's change set committed (`api.ts`), after every
 * commit (`catalog.changed`, from `afterCommit`) and when a job finishes
 * (`job.finished`, from the job runner's hook). It never throws and never waits on a
 * receiver: it reads the subscriptions, builds the payload once per subscription and
 * queues the deliveries. With no job queue there is nothing to deliver on, and the
 * event is dropped (and logged).
 */

import { randomUUID } from 'node:crypto';

import type { StudioUser } from '../me.ts';
import type { JobRun, JobService } from '../jobs/types.ts';
import { isOwnerOnlySettingsPath } from '../runtime-settings.ts';
import type { ChangeSet, RecordChange } from '../storage/change-set.ts';
import type { DocStore } from '../storage/doc-store.ts';
import { newDeliveryId, type DeliveryRequest } from './deliver.ts';
import { ALL_EVENTS, eventPayload, type DomainEvent } from './events.ts';
import { readSubscriptions } from './subscriptions.ts';

export interface WebhookEmitter {
  /** queue deliveries of `events` to every subscription that wants them */
  emit(events: readonly DomainEvent[], context?: { user?: StudioUser }): Promise<void>;
  /** `job.finished` for a job that just finished (not a webhook delivery itself) */
  jobFinished(job: JobRun): Promise<void>;
  /** `catalog.changed` for a committed change set */
  catalogChanged(set: ChangeSet): Promise<void>;
  /** send a `webhook.test` event to one subscription; returns the delivery's job id */
  test(subscriptionId: string, context?: { user?: StudioUser }): Promise<string | undefined>;
  /** queue a delivery again from an earlier attempt's request; returns the new job id */
  redeliver(request: DeliveryRequest, context?: { user?: StudioUser }): Promise<string | undefined>;
}

export interface EmitterOptions {
  docs: () => DocStore | undefined;
  jobs: () => JobService | undefined;
  /** the live environment: the public address, the instance name and version for the payload */
  env: () => Readonly<Record<string, string | undefined>>;
  log?: (line: string) => void;
  now?: () => Date;
}

const MAX_RECORDS = 50;

function recordsOf(changes: readonly RecordChange[]): { kind: string; key: string; op: string }[] {
  return changes
    .filter((c) => !(c.kind === 'doc' && isOwnerOnlySettingsPath(c.key)))
    .slice(0, MAX_RECORDS)
    .map((c) => ({ kind: c.kind, key: c.key, op: c.op }));
}

/** Small JSON-safe digest of a job's result: top-level scalars only. */
function digest(result: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result ?? {}).slice(0, 20)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    else if (Array.isArray(v)) out[k] = `${v.length} item${v.length === 1 ? '' : 's'}`;
  }
  return out;
}

export function createWebhookEmitter(options: EmitterOptions): WebhookEmitter {
  const log = options.log ?? ((line: string) => console.warn(line));
  const now = options.now ?? (() => new Date());

  const context = (user: StudioUser | undefined): { baseUrl?: string; env?: string; version?: string; user?: StudioUser } => {
    const env = options.env();
    const base = (env['WIREHUB_PUBLIC_URL'] ?? env['BETTER_AUTH_URL'] ?? '').trim().replace(/\/+$/, '');
    return {
      ...(base === '' ? {} : { baseUrl: base }),
      ...((env['WIREHUB_ENV'] ?? '') === '' ? {} : { env: env['WIREHUB_ENV'] as string }),
      ...((env['WIREHUB_VERSION'] ?? '') === '' ? {} : { version: env['WIREHUB_VERSION'] as string }),
      ...(user === undefined ? {} : { user }),
    };
  };

  async function queue(subscriptionId: string, event: Parameters<typeof eventPayload>[0], extra: { user?: StudioUser; test?: boolean; redeliveredFrom?: string } = {}): Promise<string | undefined> {
    const jobs = options.jobs();
    if (jobs === undefined || !jobs.kinds.includes('webhook')) {
      log(`[webhooks] ${event.type}: this server has no job queue to deliver on; dropped`);
      return undefined;
    }
    const eventId = randomUUID();
    const payload = eventPayload(event, { id: eventId, at: now().toISOString(), ...context(extra.user) });
    const request: DeliveryRequest = {
      deliveryId: newDeliveryId(),
      subscription: subscriptionId,
      eventId,
      type: event.type,
      payload: payload as unknown as Record<string, unknown>,
      attempt: 1,
      ...(extra.test === true ? { test: true } : {}),
      ...(extra.redeliveredFrom === undefined ? {} : { redeliveredFrom: extra.redeliveredFrom }),
    };
    return (await jobs.enqueue('webhook', request as unknown as Record<string, unknown>)).id;
  }

  const emit: WebhookEmitter['emit'] = async (events, ctx = {}) => {
    if (events.length === 0) return;
    try {
      const subscriptions = (await readSubscriptions(options.docs())).filter((s) => s.enabled);
      if (subscriptions.length === 0) return;
      for (const event of events) {
        for (const s of subscriptions) {
          if (!s.events.includes(event.type) && !s.events.includes(ALL_EVENTS)) continue;
          await queue(s.id, event, ctx);
        }
      }
    } catch (error) {
      log(`[webhooks] could not queue ${events.map((e) => e.type).join(', ')}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    emit,
    async jobFinished(job) {
      // a delivery's own outcome is the delivery log, not an event (it would never end)
      if (job.kind === 'webhook') return;
      const startedAt = job.startedAt === undefined ? undefined : Date.parse(job.startedAt);
      const finishedAt = job.finishedAt === undefined ? undefined : Date.parse(job.finishedAt);
      await emit([
        {
          type: 'job.finished',
          subject: { kind: 'job', id: job.id, label: job.kind },
          summary: {
            job: job.kind,
            status: job.status,
            ...(job.error === undefined ? {} : { error: job.error.slice(0, 300) }),
            ...(startedAt === undefined || finishedAt === undefined ? {} : { durationMs: finishedAt - startedAt }),
            ...(job.publishedVersion === undefined ? {} : { publishedVersion: job.publishedVersion }),
            result: digest(job.result),
          },
        },
      ], job.requestedBy === undefined ? {} : { user: { name: job.requestedBy.name, ...(job.requestedBy.email === undefined ? {} : { email: job.requestedBy.email }), source: 'session' } as StudioUser });
    },
    async catalogChanged(set) {
      const records = recordsOf(set.changes);
      // a save that only touched owner-only settings (the webhooks themselves) is not announced
      if (records.length === 0) return;
      await emit([
        {
          type: 'catalog.changed',
          subject: { kind: 'catalog', id: 'catalog' },
          summary: { total: set.changes.length, records, ...(set.changes.length > records.length ? { truncated: true } : {}), request: `${set.context.method} ${set.context.path.split('?')[0] ?? ''}` },
        },
      ], set.context.user === undefined ? {} : { user: set.context.user });
    },
    async test(subscriptionId, ctx = {}) {
      const sub = (await readSubscriptions(options.docs())).find((s) => s.id === subscriptionId);
      if (sub === undefined) return undefined;
      return queue(sub.id, { type: 'webhook.test', subject: { kind: 'catalog', id: 'catalog', label: 'test' }, summary: { message: 'A test delivery from WireHub. Nothing happened.' } }, { ...ctx, test: true });
    },
    async redeliver(request, ctx = {}) {
      const jobs = options.jobs();
      if (jobs === undefined) return undefined;
      const again: DeliveryRequest = { deliveryId: newDeliveryId(), subscription: request.subscription, eventId: request.eventId, type: request.type, payload: request.payload, attempt: 1, ...(request.test === true ? { test: true } : {}), redeliveredFrom: request.deliveryId };
      return (await jobs.enqueue('webhook', again as unknown as Record<string, unknown>)).id;
    },
  };
}
