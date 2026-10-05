/**
 * Webhook subscriptions (`data/settings/webhooks.json`): where each event goes. The
 * document names the URL and the events; the signing secret is never in it — it is
 * kept encrypted in the settings secrets store (`settings-secrets.ts`) under
 * `webhook.wh<id>`, write-only, so neither the catalog, its history, the
 * export nor the git mirror can carry one. The document is owner-only like the
 * other settings that name outside systems.
 */

import { randomBytes } from 'node:crypto';

import type { RuntimeSettings } from '../runtime-settings.ts';
import type { DocStore } from '../storage/doc-store.ts';
import { ALL_EVENTS, WEBHOOK_EVENT_TYPES } from './events.ts';

export const WEBHOOKS_PATH = 'data/settings/webhooks.json';
export const WEBHOOKS_SRC = 'Hub settings (entered in the app)';
export const MAX_SUBSCRIPTIONS = 20;

export interface WebhookSubscription {
  /** `wh-` and eight hex digits, made by the server */
  id: string;
  label?: string;
  url: string;
  /** event types, or `*` for all */
  events: string[];
  enabled: boolean;
  createdAt?: string;
}

export interface WebhooksDoc {
  subscriptions: WebhookSubscription[];
  src: string;
}

/** the secrets table allows `<area>.<name>` of letters and digits only: `webhook.wh1a2b3c4d` for subscription `wh-1a2b3c4d` */
export const secretName = (id: string): string => `webhook.${id.replace('-', '')}`;
export const isSubscriptionId = (id: unknown): id is string => typeof id === 'string' && /^wh-[0-9a-f]{8}$/.test(id);

export async function readSubscriptions(docs: DocStore | undefined): Promise<WebhookSubscription[]> {
  const doc = (await docs?.read(WEBHOOKS_PATH)) as WebhooksDoc | undefined;
  return Array.isArray(doc?.subscriptions) ? doc.subscriptions : [];
}

/** A URL a delivery may go to: http or https, no credentials in it, a host, not too long. */
export function urlProblem(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.trim() === '') return 'the URL is required';
  if (url.length > 2000) return 'the URL is longer than 2000 characters';
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'the URL is not a web address';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'the URL must start with https:// (or http:// on a private network)';
  if (parsed.username !== '' || parsed.password !== '') return 'put credentials in the secret or a header-less token path, not as user:password in the URL';
  return undefined;
}

export interface SubscriptionInput {
  id?: unknown;
  label?: unknown;
  url?: unknown;
  events?: unknown;
  enabled?: unknown;
}

/** The subscriptions a PUT sends, checked; ids already stored are kept, new ones get one (`makeId`). */
export function readSubscriptionInputs(input: unknown, stored: readonly WebhookSubscription[], makeId: () => string, now: string): { ok: true; subscriptions: WebhookSubscription[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'Send { "subscriptions": [ … ] }.' };
  if (input.length > MAX_SUBSCRIPTIONS) return { ok: false, error: `At most ${MAX_SUBSCRIPTIONS} subscriptions.` };
  const known = new Map(stored.map((s) => [s.id, s]));
  const out: WebhookSubscription[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of input.entries()) {
    const where = `Subscription ${i + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: `${where} is not an object.` };
    const s = raw as SubscriptionInput;
    const problem = urlProblem(s.url);
    if (problem !== undefined) return { ok: false, error: `${where}: ${problem}.` };
    if (!Array.isArray(s.events) || s.events.length === 0) return { ok: false, error: `${where}: choose at least one event.` };
    const events = [...new Set(s.events.map(String))].sort();
    const bad = events.find((e) => e !== ALL_EVENTS && !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(e));
    if (bad !== undefined) return { ok: false, error: `${where}: '${bad}' is not an event (${WEBHOOK_EVENT_TYPES.join(', ')}, or *).` };
    if (s.label !== undefined && (typeof s.label !== 'string' || s.label.length > 80)) return { ok: false, error: `${where}: the label is text, up to 80 characters.` };
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') return { ok: false, error: `${where}: enabled is true or false.` };
    let id: string;
    if (s.id === undefined) id = makeId();
    else if (isSubscriptionId(s.id) && known.has(s.id)) id = s.id;
    else return { ok: false, error: `${where}: '${String(s.id)}' is not one of this hub's subscriptions. Leave the id out to add one.` };
    if (seen.has(id)) return { ok: false, error: `${where}: the same subscription is listed twice.` };
    seen.add(id);
    out.push({
      id,
      ...(typeof s.label === 'string' && s.label.trim() !== '' ? { label: s.label.trim() } : {}),
      url: (s.url as string).trim(),
      events,
      enabled: s.enabled !== false,
      createdAt: known.get(id)?.createdAt ?? now,
    });
  }
  return { ok: true, subscriptions: out };
}

export const newSubscriptionId = (): string => `wh-${randomBytes(4).toString('hex')}`;
export const newSecretValue = (): string => `whsec_${randomBytes(32).toString('base64url')}`;

/* ------------------------------------------------------------------ *
 * The secrets
 * ------------------------------------------------------------------ */

/** Whether this server can keep and read secrets (an install key, a store). */
export function secretsAvailable(settings: RuntimeSettings | undefined): boolean {
  return settings !== undefined && settings.cipher !== undefined && settings.options.secrets() !== undefined;
}

/** The ids of the subscriptions that have a secret stored (no decryption). */
export async function subscriptionsWithSecret(settings: RuntimeSettings | undefined): Promise<Set<string>> {
  const store = settings?.options.secrets();
  const names = store === undefined ? [] : Object.keys(await store.all());
  return new Set(names.flatMap((n) => {
    const m = /^webhook\.wh([0-9a-f]{8})$/.exec(n);
    return m === null ? [] : [`wh-${m[1] as string}`];
  }));
}

export async function readSecret(settings: RuntimeSettings | undefined, id: string): Promise<string | undefined> {
  const store = settings?.options.secrets();
  const cipher = settings?.cipher;
  if (store === undefined || cipher === undefined || settings === undefined) return undefined;
  const text = (await store.all())[secretName(id)];
  return text === undefined ? undefined : cipher.decrypt(settings.options.org(), secretName(id), text);
}

export async function putSecret(settings: RuntimeSettings, id: string, value: string): Promise<void> {
  const store = settings.options.secrets();
  const cipher = settings.cipher;
  if (store === undefined || cipher === undefined) throw new Error('no secret store');
  await store.put(secretName(id), cipher.encrypt(settings.options.org(), secretName(id), value));
}

export async function removeSecret(settings: RuntimeSettings | undefined, id: string): Promise<void> {
  await settings?.options.secrets()?.remove(secretName(id));
}
