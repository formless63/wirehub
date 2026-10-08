/**
 * Webhooks in Settings (owners only, in a signed-in session):
 *
 *   GET    /api/settings/webhooks                          subscriptions (never a secret), the events, the signing scheme
 *   PUT    /api/settings/webhooks                          { subscriptions: [...] } replace the list (If-Match)
 *   PUT    /api/settings/webhooks/:id/secret               { value? } set the signing secret (omit it: the server makes one, shown once)
 *   DELETE /api/settings/webhooks/:id/secret               clear it
 *   POST   /api/settings/webhooks/:id/test                 send a `webhook.test` event now
 *   GET    /api/settings/webhooks/deliveries               the delivery log, newest first (?subscription=&limit=)
 *   POST   /api/settings/webhooks/deliveries/:job/redeliver  send an earlier delivery again
 *
 * The subscriptions are `data/settings/webhooks.json`, written through the unit of work
 * like every setting; the secrets are in the encrypted secrets store, write-only.
 */

import type { ApiResponse, WorkbenchDeps } from '../api.ts';
import { checkIfMatch, contentETag } from '../etag.ts';
import { isDryRun } from '../batch.ts';
import type { StudioUser } from '../me.ts';
import { deliveryOf, readDeliveryRequest, MAX_ATTEMPTS, type DeliveryRecord } from './deliver.ts';
import { PAYLOAD_SCHEMA, WEBHOOK_EVENTS } from './events.ts';
import { SIGNATURE_HEADER } from './signature.ts';
import {
  MAX_SUBSCRIPTIONS,
  WEBHOOKS_PATH,
  WEBHOOKS_SRC,
  isSubscriptionId,
  newSecretValue,
  newSubscriptionId,
  putSecret,
  readSubscriptions,
  readSecret,
  readSubscriptionInputs,
  removeSecret,
  secretName,
  secretsAvailable,
  subscriptionsWithSecret,
  type WebhooksDoc,
} from './subscriptions.ts';

export const WEBHOOK_ROUTES = [
  'GET    /api/settings/webhooks',
  'PUT    /api/settings/webhooks',
  'PUT    /api/settings/webhooks/:id/secret',
  'DELETE /api/settings/webhooks/:id/secret',
  'POST   /api/settings/webhooks/:id/test',
  'GET    /api/settings/webhooks/deliveries',
  'POST   /api/settings/webhooks/deliveries/:job/redeliver',
] as const;

export const isWebhooksPath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'settings' && parts[2] === 'webhooks';

const fail = (status: number, error: string, hint?: string, extra?: object): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });
const isOwner = (user: StudioUser | undefined): boolean => user === undefined || user.role === undefined || user.role === 'owner';

async function view(deps: WorkbenchDeps): Promise<Record<string, unknown>> {
  const subs = await readSubscriptions(deps.docs);
  const have = await subscriptionsWithSecret(deps.runtimeSettings);
  const states = deps.runtimeSettings?.secretStates() ?? {};
  const available = secretsAvailable(deps.runtimeSettings);
  return {
    subscriptions: subs.map((s) => ({ ...s, secret: !have.has(s.id) ? 'unset' : states[secretName(s.id)] === 'unreadable' ? 'unreadable' : 'set' })),
    events: WEBHOOK_EVENTS,
    limits: { subscriptions: MAX_SUBSCRIPTIONS, attempts: MAX_ATTEMPTS },
    signature: { header: SIGNATURE_HEADER, scheme: 't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the secret>', payloadSchema: PAYLOAD_SCHEMA },
    secrets: available
      ? { available: true }
      : { available: false, note: 'This server has no settings key, so a signing secret cannot be kept, and nothing is sent unsigned. The compose stack generates the key.' },
  };
}

export async function handleWebhooksRequest(method: string, parts: string[], rawPath: string, body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined, user: StudioUser | undefined): Promise<ApiResponse> {
  if (!isOwner(user)) return fail(403, 'Webhooks are managed by an owner.', 'Ask an owner of this hub.');
  const write = method !== 'GET';
  if (write && user?.apiTokenId !== undefined) return fail(403, 'Webhooks are changed in a signed-in session, not with an API token.');
  if (deps.docs === undefined) return fail(501, 'This hub does not keep catalog documents by path.', 'Webhook subscriptions are stored with the catalog.');
  const rest = parts.slice(3);
  const query = new URLSearchParams(rawPath.split('?')[1] ?? '');

  if (rest.length === 0) {
    const stored = (await deps.docs.read(WEBHOOKS_PATH)) as WebhooksDoc | undefined;
    const etag = contentETag(stored ?? null);
    if (method === 'GET') return { status: 200, body: await view(deps), headers: { ETag: etag } };
    if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
    const guard = checkIfMatch(ifMatch, etag, 'settings', 'webhooks');
    if (guard !== undefined) return guard;
    const list = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { subscriptions?: unknown }).subscriptions : undefined;
    const before = await readSubscriptions(deps.docs);
    const read = readSubscriptionInputs(list, before, newSubscriptionId, (deps.now ?? (() => new Date().toISOString()))());
    if (!read.ok) return fail(400, read.error, 'Nothing was saved.');
    if (read.subscriptions.length === 0) await deps.docs.remove(WEBHOOKS_PATH);
    else await deps.docs.write(WEBHOOKS_PATH, { subscriptions: read.subscriptions, src: WEBHOOKS_SRC } satisfies WebhooksDoc);
    // a subscription removed here takes its secret with it
    const kept = new Set(read.subscriptions.map((s) => s.id));
    for (const gone of before.filter((s) => !kept.has(s.id))) await removeSecret(deps.runtimeSettings, gone.id);
    const after = read.subscriptions.length === 0 ? undefined : ({ subscriptions: read.subscriptions, src: WEBHOOKS_SRC } satisfies WebhooksDoc);
    return { status: 200, body: await view({ ...deps, docs: { ...deps.docs, read: async () => after, write: deps.docs.write, remove: deps.docs.remove } }), headers: { ETag: contentETag(after ?? null) } };
  }

  if (rest[0] === 'deliveries') {
    if (rest.length === 1) {
      if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
      if (deps.jobs === undefined) return fail(501, 'This hub runs no jobs, so it keeps no delivery log.');
      const limit = Math.min(Math.max(Number(query.get('limit') ?? 100) || 100, 1), 200);
      const subscription = query.get('subscription');
      const all = await deps.jobs.list({ kind: 'webhook', limit: 200 });
      const records = all.flatMap((j) => {
        const d = deliveryOf(j);
        return d === undefined || (subscription !== null && d.subscription !== subscription) ? [] : [d];
      });
      return { status: 200, body: { deliveries: records.slice(0, limit) satisfies DeliveryRecord[] } };
    }
    if (rest.length === 3 && rest[2] === 'redeliver') {
      if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
      if (deps.jobs === undefined || deps.webhooks === undefined) return fail(501, 'This hub runs no jobs, so it cannot deliver.');
      const job = await deps.jobs.get(rest[1] as string);
      const request = job?.kind === 'webhook' ? readDeliveryRequest(job.request) : undefined;
      if (request === undefined) return fail(404, `There is no webhook delivery ${String(rest[1])}.`, 'GET /api/settings/webhooks/deliveries lists them.');
      if (!(await readSubscriptions(deps.docs)).some((s) => s.id === request.subscription)) return fail(409, 'That delivery\'s subscription was removed, so it cannot be sent again.');
      const id = await deps.webhooks.redeliver(request, user === undefined ? {} : { user });
      return { status: 202, body: { job: id } };
    }
    return fail(404, `${parts.join('/')} is not part of the server API.`, `Try ${WEBHOOK_ROUTES.join('; ')}.`);
  }

  const id = rest[0];
  if (!isSubscriptionId(id)) return fail(404, `${parts.join('/')} is not part of the server API.`, `Try ${WEBHOOK_ROUTES.join('; ')}.`);
  if (!(await readSubscriptions(deps.docs)).some((s) => s.id === id)) return fail(404, `There is no webhook subscription ${id}.`);

  if (rest.length === 2 && rest[1] === 'secret') {
    if (method !== 'PUT' && method !== 'DELETE') return fail(405, `${method} is not something this address accepts.`, 'It answers PUT (set) and DELETE (clear); a secret is never read back.');
    if (isDryRun(rawPath)) return fail(400, 'A secret is not part of a dry run.');
    const settings = deps.runtimeSettings;
    if (method === 'DELETE') {
      await removeSecret(settings, id);
      await settings?.refresh();
      return { status: 200, body: { id, set: false } };
    }
    if (settings === undefined || !secretsAvailable(settings)) return fail(409, 'This server has no settings key, so it cannot keep a signing secret.', 'The compose stack generates the key; give the server a settings key otherwise.');
    const given = typeof body === 'object' && body !== null ? (body as { value?: unknown }).value : undefined;
    if (given !== undefined && (typeof given !== 'string' || given.trim().length < 16 || given.length > 256)) return fail(400, 'A signing secret is 16 to 256 characters.', 'Leave "value" out and the server makes one.');
    const value = given === undefined ? newSecretValue() : (given as string).trim();
    await putSecret(settings, id, value);
    await settings.refresh();
    // a generated secret is shown this once; one the owner typed is not echoed
    return { status: 200, body: { id, set: true, ...(given === undefined ? { generated: value } : {}) } };
  }

  if (rest.length === 2 && rest[1] === 'test') {
    if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
    if (deps.webhooks === undefined || deps.jobs === undefined) return fail(501, 'This hub runs no jobs, so it cannot deliver.');
    if ((await readSecret(deps.runtimeSettings, id)) === undefined) return fail(409, 'Set the signing secret first: nothing is sent unsigned.');
    const job = await deps.webhooks.test(id, user === undefined ? {} : { user });
    return { status: 202, body: { job } };
  }
  return fail(404, `${parts.join('/')} is not part of the server API.`, `Try ${WEBHOOK_ROUTES.join('; ')}.`);
}
