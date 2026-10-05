/**
 * Monitoring webhook (`specs/postgres-backend.md` §8.6): `WIREHUB_NOTIFY_URL`
 * (optional) receives one POST per event, and every event is also logged.
 * Delivery never throws and never waits longer than the timeout: an alert
 * that cannot be sent must not break the request or the job that raised it.
 *
 * `WIREHUB_NOTIFY_FORMAT` shapes the POST for the receiver:
 *
 * - `json` (default): `{ event, severity, title, message, at, env, version, data }`;
 * - `ntfy`: the message as a text body with `Title`, `Priority` and `Tags` headers
 *   (ntfy accepts this on its topic URL; Gotify's `/message` takes the `json` form
 *   with its own fields through a proxy, so use a small adapter for that);
 * - `slack`: `{ text }`, which Slack, Mattermost and most chat webhooks take.
 *
 * A token (`cst_…`) is replaced by `[token]` anywhere in the payload.
 */

export type Severity = 'default' | 'high' | 'urgent';
export type NotifyFormat = 'json' | 'ntfy' | 'slack';

export interface NotifyEvent {
  /** a stable kebab id: `backup-failed`, `token-created`, `blob-canary-failing`… */
  event: string;
  severity: Severity;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface Notifier {
  readonly enabled: boolean;
  notify(event: NotifyEvent): Promise<void>;
}

export interface NotifierOptions {
  url?: string;
  /** sent as `Authorization: Bearer …` (an ntfy access token) */
  token?: string;
  format?: NotifyFormat;
  fetch?: typeof fetch;
  /** the instance, added to every payload */
  env?: string;
  version?: string;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** injectable for tests; the server's clock */
  now?: () => Date;
}

const TOKEN_LIKE = /cst_(?:dev|prod)_[0-9a-f]{12}_[a-z2-7]{20,}/g;
export const scrubTokens = (text: string): string => text.replace(TOKEN_LIKE, '[token]');

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubTokens(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v)]));
  return value;
}

export function notifyFormatOf(value: string | undefined): NotifyFormat {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'json') return 'json';
  if (v === 'ntfy' || v === 'slack') return v;
  throw new Error(`WIREHUB_NOTIFY_FORMAT must be json, ntfy or slack; got '${value}'.`);
}

const NTFY_PRIORITY: Record<Severity, string> = { urgent: '5', high: '4', default: '3' };
const NTFY_TAGS: Record<Severity, string> = { urgent: 'rotating_light', high: 'warning', default: 'information_source' };

export function createNotifier(options: NotifierOptions = {}): Notifier {
  const url = (options.url ?? '').trim();
  const format = options.format ?? 'json';
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  return {
    enabled: url !== '',
    async notify(raw) {
      const event = scrubValue(raw) as NotifyEvent;
      log(`[notify] ${event.severity} ${event.event}: ${event.message}`);
      if (url === '') return;
      const at = now().toISOString();
      const headers: Record<string, string> = {};
      if ((options.token ?? '').trim() !== '') headers.authorization = `Bearer ${(options.token as string).trim()}`;
      let body: string;
      if (format === 'ntfy') {
        headers['content-type'] = 'text/plain; charset=utf-8';
        // header values are latin-1: keep the title plain
        headers.title = event.title.replace(/[^\x20-\x7e]/g, '?');
        headers.priority = NTFY_PRIORITY[event.severity];
        headers.tags = NTFY_TAGS[event.severity];
        body = event.message;
      } else if (format === 'slack') {
        headers['content-type'] = 'application/json';
        body = JSON.stringify({ text: `*${event.title}* (${event.severity})\n${event.message}` });
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify({ ...event, at, ...(options.env === undefined ? {} : { env: options.env }), ...(options.version === undefined ? {} : { version: options.version }) });
      }
      try {
        const res = await doFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
        if (!res.ok) log(`[notify] ${event.event}: the webhook answered ${res.status}`);
      } catch (error) {
        log(`[notify] ${event.event}: the webhook was not reached (${error instanceof Error ? error.message : String(error)})`);
      }
    },
  };
}

/** The notifier the environment asks for: `WIREHUB_NOTIFY_URL`, `WIREHUB_NOTIFY_FORMAT`, `WIREHUB_NOTIFY_TOKEN`. */
export function notifierFromEnv(env: Readonly<Record<string, string | undefined>>, extra: Pick<NotifierOptions, 'fetch' | 'log' | 'now'> = {}): Notifier {
  const url = (env.WIREHUB_NOTIFY_URL ?? '').trim();
  if (url !== '' && !/^https?:\/\//.test(url)) throw new Error('WIREHUB_NOTIFY_URL must be an http(s) URL.');
  const token = (env.WIREHUB_NOTIFY_TOKEN ?? '').trim();
  return createNotifier({
    ...extra,
    url,
    ...(token === '' ? {} : { token }),
    format: notifyFormatOf(env.WIREHUB_NOTIFY_FORMAT),
    ...(env.WIREHUB_ENV === undefined || env.WIREHUB_ENV === '' ? {} : { env: env.WIREHUB_ENV }),
    ...(env.WIREHUB_VERSION === undefined || env.WIREHUB_VERSION === '' ? {} : { version: env.WIREHUB_VERSION }),
  });
}

/** Every call is logged and dropped. */
export const NO_NOTIFIER: Notifier = createNotifier();

/**
 * The notifier the live settings ask for (`runtime-settings.ts`): rebuilt when
 * the webhook, its format or its token change in Settings — no restart. A value
 * the server would refuse (it cannot be saved in Settings, but the environment
 * may hold one) logs once and sends nothing.
 */
export function liveNotifier(env: () => Readonly<Record<string, string | undefined>>, extra: Pick<NotifierOptions, 'fetch' | 'log' | 'now'> = {}): Notifier {
  let key: string | undefined;
  let current: Notifier = NO_NOTIFIER;
  const now = (): Notifier => {
    const e = env();
    const next = JSON.stringify([e.WIREHUB_NOTIFY_URL, e.WIREHUB_NOTIFY_FORMAT, e.WIREHUB_NOTIFY_TOKEN, e.WIREHUB_ENV, e.WIREHUB_VERSION]);
    if (next !== key) {
      key = next;
      try {
        current = notifierFromEnv(e, extra);
      } catch (error) {
        (extra.log ?? ((line: string) => console.warn(line)))(`[notify] ${error instanceof Error ? error.message : String(error)} Alerts are logged only.`);
        current = createNotifier({ ...extra });
      }
    }
    return current;
  };
  return {
    get enabled() {
      return now().enabled;
    },
    notify: (event) => now().notify(event),
  };
}

/** Send an event at most once per `ms` per key (a monitor that polls must not repeat itself). */
export function throttled(notifier: Notifier, ms: number, clock: () => number = Date.now): Notifier {
  const last = new Map<string, number>();
  return {
    get enabled() {
      return notifier.enabled;
    },
    async notify(event) {
      const key = event.event;
      const at = clock();
      if ((last.get(key) ?? -Infinity) > at - ms) return;
      last.set(key, at);
      await notifier.notify(event);
    },
  };
}
