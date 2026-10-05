/**
 * Outbound event webhooks: the events, and the versioned JSON payload one carries.
 *
 * Integrations (an ERP, a PLM, a chat bot) subscribe to events instead of being code
 * modules: the payload names what happened with ids, links, the actor and a diff summary,
 * and the receiver fetches whatever it needs through the API with a token
 * (`docs/webhooks.md`). The payload schema is versioned (`schema`): a new field is added
 * to `wirehub.event/1`; a change that could break a receiver becomes `wirehub.event/2`.
 */

import type { StudioUser } from '../me.ts';

export const PAYLOAD_SCHEMA = 'wirehub.event/1';

export const WEBHOOK_EVENTS = [
  { type: 'design.saved', label: 'Cable saved', description: 'A cable design was created, saved, duplicated or renamed (the working copy).' },
  { type: 'design.deleted', label: 'Cable deleted', description: 'A cable design was deleted.' },
  { type: 'version.saved', label: 'Version saved', description: 'A revision of a cable was saved and locked.' },
  { type: 'version.submitted', label: 'Version submitted', description: 'A saved version was submitted for release approval.' },
  { type: 'version.approved', label: 'Version approved', description: 'A submitted version was approved.' },
  { type: 'version.rejected', label: 'Version rejected', description: 'A submitted version was rejected.' },
  { type: 'version.released', label: 'Version released', description: 'A version became the released revision: when it is saved (approvals off) or approved (approvals on).' },
  { type: 'product.changed', label: 'Product changed', description: 'A product family was created, changed, merged, split or removed.' },
  { type: 'part-number.assigned', label: 'Part number assigned', description: 'A part number was set or changed on a cable, a drawing or a library part.' },
  { type: 'pack.installed', label: 'Pack installed', description: 'A catalog pack was installed, updated or disabled.' },
  { type: 'job.finished', label: 'Job finished', description: 'A background job (an import, a model build, a backup watch …) finished or failed.' },
  { type: 'catalog.changed', label: 'Catalog changed', description: 'Any committed change to the catalog: the records it touched.' },
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]['type'];
export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = WEBHOOK_EVENTS.map((e) => e.type);

/** A subscription listing `*` receives every event. */
export const ALL_EVENTS = '*';

export interface EventSubject {
  /** `design`, `connectors` … (a library kind), `pack`, `job`, `catalog` */
  kind: string;
  id: string;
  label?: string;
  rev?: number;
}

/** What a handler knows when something happens; the emitter adds who, when, the links. */
export interface DomainEvent {
  type: WebhookEventType;
  subject: EventSubject;
  /** a diff summary: lines, counts, records touched — small, never the full data */
  summary?: Record<string, unknown>;
}

export interface EventContext {
  id: string;
  /** ISO time */
  at: string;
  user?: StudioUser;
  /** the address people open (`WIREHUB_PUBLIC_URL`); absent: links are paths */
  baseUrl?: string;
  env?: string;
  version?: string;
}

export interface WebhookPayload {
  schema: typeof PAYLOAD_SCHEMA;
  id: string;
  type: WebhookEventType | 'webhook.test';
  occurredAt: string;
  hub: { url?: string; env?: string; version?: string };
  actor: { name: string; email?: string; via: 'session' | 'token' | 'local' | 'system' };
  subject: EventSubject;
  summary: Record<string, unknown>;
  links: { ui?: string; api?: string };
  /** where the receiver gets the full data: GET these with `Authorization: Bearer <API token>` */
  fetch: Record<string, unknown>;
}

const enc = encodeURIComponent;

function fetchLinksOf(subject: EventSubject, type: string): { ui?: string; api?: string; fetch: Record<string, unknown> } {
  switch (subject.kind) {
    case 'design': {
      const base = `/api/designs/${enc(subject.id)}`;
      const rev = subject.rev === undefined ? '' : `?rev=${subject.rev}`;
      const exports = Object.fromEntries(['bom.csv', 'wire-list.csv', 'cut-list.csv', 'production.xlsx', 'continuity.json'].map((f) => [f, `${base}/exports/${f}${rev}`]));
      return {
        ui: `/cables/${enc(subject.id)}`,
        api: base,
        fetch: { design: base, versions: `${base}/versions`, ...(subject.rev === undefined ? {} : { version: `${base}/versions/${subject.rev}` }), exports, ...(type.startsWith('version.') ? { released: `${base}/exports/bom.csv?rev=released` } : {}) },
      };
    }
    case 'pack':
      return { ui: '/library', api: '/api/packs', fetch: { packs: '/api/packs' } };
    case 'product':
      return { ui: `/products/${enc(subject.id)}`, api: `/api/products/${enc(subject.id)}`, fetch: { product: `/api/products/${enc(subject.id)}`, lineup: '/api/lineup', 'lineup.csv': '/api/lineup.csv' } };
    case 'job':
      return { ui: '/jobs', api: `/api/jobs/${enc(subject.id)}`, fetch: { job: `/api/jobs/${enc(subject.id)}` } };
    case 'catalog':
      return { ui: '/history', api: '/api/history', fetch: { history: '/api/history', db: '/api/db', export: '/api/export' } };
    default:
      // a library kind (connectors, wires, components …)
      return { ui: `/library/${enc(subject.kind)}/${enc(subject.id)}`, api: `/api/definitions/${enc(subject.kind)}/${enc(subject.id)}`, fetch: { record: `/api/definitions/${enc(subject.kind)}/${enc(subject.id)}` } };
  }
}

function absolute(baseUrl: string | undefined, value: string): string {
  return baseUrl === undefined ? value : `${baseUrl.replace(/\/+$/, '')}${value}`;
}

function mapFetch(value: unknown, baseUrl: string | undefined): unknown {
  if (typeof value === 'string') return absolute(baseUrl, value);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapFetch(v, baseUrl)]));
  return value;
}

export function actorOf(user: StudioUser | undefined): WebhookPayload['actor'] {
  if (user === undefined) return { name: 'WireHub', via: 'system' };
  return { name: user.name, ...(user.email === undefined ? {} : { email: user.email }), via: user.apiTokenId !== undefined ? 'token' : user.source === 'session' ? 'session' : 'local' };
}

export function eventPayload(event: Omit<DomainEvent, 'type'> & { type: WebhookPayload['type'] }, ctx: EventContext): WebhookPayload {
  const links = fetchLinksOf(event.subject, event.type);
  return {
    schema: PAYLOAD_SCHEMA,
    id: ctx.id,
    type: event.type,
    occurredAt: ctx.at,
    hub: { ...(ctx.baseUrl === undefined ? {} : { url: ctx.baseUrl }), ...(ctx.env === undefined ? {} : { env: ctx.env }), ...(ctx.version === undefined ? {} : { version: ctx.version }) },
    actor: actorOf(ctx.user),
    subject: event.subject,
    summary: event.summary ?? {},
    links: { ...(links.ui === undefined ? {} : { ui: absolute(ctx.baseUrl, links.ui) }), ...(links.api === undefined ? {} : { api: absolute(ctx.baseUrl, links.api) }) },
    fetch: { auth: 'GET these with the header "Authorization: Bearer <API token>" (Settings, API tokens)', ...(mapFetch(links.fetch, ctx.baseUrl) as Record<string, unknown>) },
  };
}
