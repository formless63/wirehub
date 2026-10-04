/**
 * Server events (`specs/postgres-backend.md` §2, task B6): what changed, for
 * `GET /api/events` (server-sent events). `catalog` — a commit produced a new
 * catalog version; `locks` — a lease changed on a record.
 *
 * On files the studio publishes them itself, after a commit and after a lock
 * change. On Postgres they arrive through `LISTEN studio_catalog` /
 * `studio_locks`, so a change made by any process reaches every process's
 * browsers; local publishing is then a no-op (the NOTIFY does it).
 */

export type StudioEvent = { type: 'catalog'; version: string } | { type: 'locks'; record: string };

export interface EventHub {
  publish(event: StudioEvent): void;
  subscribe(listener: (event: StudioEvent) => void): () => void;
}

export function memoryEventHub(): EventHub & { deliver(event: StudioEvent): void } {
  const listeners = new Set<(event: StudioEvent) => void>();
  const deliver = (event: StudioEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // one broken stream never stops the others
      }
    }
  };
  return {
    deliver,
    publish: deliver,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** A hub fed from elsewhere (LISTEN): subscribers hear deliveries, local publishes are dropped. */
export function deliveredEventHub(): EventHub & { deliver(event: StudioEvent): void } {
  const hub = memoryEventHub();
  return { ...hub, publish: () => {} };
}
