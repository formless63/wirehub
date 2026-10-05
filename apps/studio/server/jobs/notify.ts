/**
 * Alerts (`specs/postgres-backend.md` §8.6): every event is logged, and
 * POSTed as JSON to `WIREHUB_NOTIFY_URL` when it is set (ntfy, Gotify, or a
 * Slack/Matrix webhook through a small adapter). A failed delivery is logged,
 * never thrown: an alert must not take the job down with it.
 */

export type Severity = 'urgent' | 'high' | 'default';

export interface AlertEvent {
  event: string;
  severity: Severity;
  message: string;
  detail?: Record<string, unknown>;
}

export type Notify = (event: AlertEvent) => Promise<void>;

export function notifierFromEnv(env: Record<string, string | undefined> = process.env, options: { fetch?: typeof fetch; log?: (line: string) => void } = {}): Notify {
  const url = (env.WIREHUB_NOTIFY_URL ?? '').trim();
  const log = options.log ?? ((line: string) => console.warn(line));
  const doFetch = options.fetch ?? fetch;
  return async (event) => {
    log(`[alert] ${event.severity} ${event.event}: ${event.message}`);
    if (url === '') return;
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'wirehub', at: new Date().toISOString(), ...event }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) log(`[alert] delivery to WIREHUB_NOTIFY_URL answered ${response.status}`);
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      log(`[alert] delivery to WIREHUB_NOTIFY_URL failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
