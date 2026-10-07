/**
 * Live updates: `GET /api/events` (server-sent events, `server/events.ts`).
 *
 * The server greets with the catalog version (`hello`), then sends `catalog`
 * when a commit made a new version and `locks` when a lease changed — from
 * any process on the database backend, from this one on files. A page uses
 * them to refetch what changed instead of waiting for the next poll.
 *
 * The stream is best-effort. When it cannot be had (a host without events
 * answers 501, a proxy that buffers, a dropped network) the page keeps
 * working on what it polls and fetches on navigation: `onState(false)` says
 * so, and the client reconnects with a growing pause (1 s … 30 s). After a
 * reconnect the greeting's version is compared with the last one seen, so a
 * commit made while the stream was down still triggers a refetch. Navigation
 * suspends the stream on pagehide and restores it on pageshow, including a
 * back/forward cache restore, without retaining a connection for a cached page.
 */

export interface EventStreamHandlers {
  /** a new catalog version exists (also: the stream came back and the version moved) */
  onCatalog(version: string): void;
  /** a lease changed on `record` (also once on every (re)connect: refresh the lease list) */
  onLocks(record: string | undefined): void;
  /** true while the stream is open, false while it is down */
  onState?(live: boolean): void;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
}

/** Page lifecycle only: ordinary tab visibility changes do not suspend the stream. */
export interface EventStreamLifecycle {
  addEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void;
  removeEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void;
}

export interface EventStreamOptions {
  url?: string;
  /** injectable for tests; defaults to window when available */
  lifecycle?: EventStreamLifecycle;
  /** injectable for tests; default the browser's `EventSource` (none: no stream) */
  eventSource?: (url: string) => EventSourceLike;
  /** injectable for tests */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** Open the stream and keep it open; returns the stop function. A no-op without `EventSource`. */
export function connectEventStream(handlers: EventStreamHandlers, options: EventStreamOptions = {}): () => void {
  const make = options.eventSource ?? (typeof EventSource === 'undefined' ? undefined : (url: string): EventSourceLike => new EventSource(url) as unknown as EventSourceLike);
  if (make === undefined) return () => undefined;
  const url = options.url ?? '/api/events';
  const later = options.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let source: EventSourceLike | undefined;
  let timer: unknown;
  let pendingRetry: object | undefined;
  let stopped = false;
  let suspended = false;
  const lifecycle = options.lifecycle ?? (typeof window === 'undefined' ? undefined : window);
  let pause = 1000;
  let lastVersion: string | undefined;
  let live = false;
  const setLive = (value: boolean): void => {
    if (live === value) return;
    live = value;
    handlers.onState?.(value);
  };
  const parse = (data: string | undefined): Record<string, unknown> => {
    try {
      const value = JSON.parse(data ?? '{}') as unknown;
      return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const open = (): void => {
    if (stopped || suspended || source !== undefined) return;
    const next = make(url);
    source = next;
    const current = (): boolean => !stopped && !suspended && source === next;
    next.addEventListener('hello', (event) => {
      if (!current()) return;
      pause = 1000;
      const version = parse(event.data)['version'];
      const seen = typeof version === 'string' && version !== '' ? version : undefined;
      setLive(true);
      // the lease list may have moved while the stream was down
      handlers.onLocks(undefined);
      if (seen !== undefined && lastVersion !== undefined && seen !== lastVersion) handlers.onCatalog(seen);
      if (seen !== undefined) lastVersion = seen;
    });
    next.addEventListener('catalog', (event) => {
      if (!current()) return;
      const version = parse(event.data)['version'];
      if (typeof version !== 'string') return;
      if (version === lastVersion) return;
      lastVersion = version;
      handlers.onCatalog(version);
    });
    next.addEventListener('locks', (event) => {
      if (!current()) return;
      const record = parse(event.data)['record'];
      handlers.onLocks(typeof record === 'string' ? record : undefined);
    });
    next.onerror = () => {
      if (!current()) return;
      // close and reconnect on our own schedule: the browser's own retry is a fixed few seconds, forever
      source = undefined;
      next.close();
      setLive(false);
      if (stopped) return;
      const retry = {};
      pendingRetry = retry;
      timer = later(() => {
        if (pendingRetry !== retry) return;
        pendingRetry = undefined;
        timer = undefined;
        open();
      }, pause);
      pause = Math.min(pause * 2, 30_000);
    };
  };
  const disconnect = (): void => {
    pendingRetry = undefined;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    const previous = source;
    source = undefined;
    previous?.close();
    setLive(false);
  };
  const hide = (): void => {
    if (stopped) return;
    suspended = true;
    disconnect();
  };
  const show = (): void => {
    if (stopped || !suspended) return;
    suspended = false;
    open();
  };
  lifecycle?.addEventListener('pagehide', hide);
  lifecycle?.addEventListener('pageshow', show);
  open();
  return () => {
    if (stopped) return;
    stopped = true;
    lifecycle?.removeEventListener('pagehide', hide);
    lifecycle?.removeEventListener('pageshow', show);
    disconnect();
  };
}
