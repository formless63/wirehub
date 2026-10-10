/**
 * Edit locks — the browser half.
 *
 * One client per page load. It knows who this tab is (a per-page `tabId`, a
 * per-browser `clientId`, and a display name), which leases this tab holds,
 * and every live lease the server knows (polled — small list, internal
 * tool). It renews held leases every `HEARTBEAT_MS`, gives them back on
 * `pagehide` with `navigator.sendBeacon`, and — through `installFetch` —
 * adds the held token to every write the studio sends to a held record, so
 * no adapter has to know locks exist (`recordsOfWrite`, shared with the
 * server's gate, decides which writes those are).
 *
 * Nothing here throws; a server without `/api/locks` (an old host, a test
 * transport) simply never grants or reports a lock, and the UI stays as it
 * was — the If-Match check still stands behind every save.
 */

import { HEARTBEAT_MS, LOCK_HEADER, recordsOfWrite, type LockView } from './records.ts';

/** a lock-list poll while the page is visible — how a viewer notices a record freeing up */
export const POLL_MS = 5_000;
/** with the event stream open the list is still refreshed now and then, as a safety net */
export const LIVE_POLL_MS = 60_000;
export const DEFAULT_NAME = 'This browser';

const CLIENT_KEY = 'wirehub/locks/1/client-id';
const NAME_KEY = 'wirehub/locks/1/name';

export interface LockTransportResponse {
  status: number;
  body: unknown;
}
export type LockTransport = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<LockTransportResponse>;

/** The displaced holder's note: who took it, and when. */
export interface LostLock {
  by: string | undefined;
  at: string;
}

export interface LockSnapshot {
  /** every live lease, by record */
  locks: ReadonlyMap<string, LockView>;
  /** the records this tab holds */
  held: ReadonlySet<string>;
  /** records this tab held until someone took them over */
  lost: ReadonlyMap<string, LostLock>;
  /** records this tab asked for with Request edit */
  requested: ReadonlySet<string>;
  /** the list has been answered at least once */
  ready: boolean;
  /** this tab's own identity */
  me: { tabId: string; clientId: string; name: string; nameSet: boolean };
}

export type TakeOverOutcome = 'ok' | 'confirm' | 'failed';

export interface LockClient {
  snapshot(): LockSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  /** take `record`; `false` when someone else has it (or locks are unavailable) */
  acquire(record: string): Promise<boolean>;
  release(record: string): Promise<void>;
  heartbeat(): Promise<void>;
  request(record: string): Promise<void>;
  /** the holder's Keep */
  decline(record: string): Promise<void>;
  takeOver(record: string, force: boolean): Promise<TakeOverOutcome>;
  /** forget a lost-lock note (the person dismissed it, or re-acquired) */
  forgetLost(record: string): void;
  setName(name: string): void;
  /** the `x-edit-lock` value for a write, when this tab holds any record it touches */
  headerFor(method: string, path: string, body?: unknown): string | undefined;
  /** a 423 came back: the record's lease is someone else's — refresh the list */
  noteRefused(): void;
  /** the server's event stream is open: lease changes arrive as events, so the list is polled far less often */
  setLive(live: boolean): void;
  /** start the heartbeat and poll timers, and the pagehide release; returns stop */
  start(): () => void;
  /** wrap `window.fetch` so held tokens ride along on writes; returns the uninstall */
  installFetch(target?: { fetch: typeof fetch }): () => void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LockClientOptions {
  transport?: LockTransport;
  storage?: StorageLike | undefined;
  /** `navigator.sendBeacon`, or a stand-in; absent → a plain `transport` POST */
  beacon?: ((url: string, body: string) => boolean) | undefined;
  newId?: () => string;
  base?: string;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function safeStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function fetchTransport(base: string): LockTransport {
  return async (method, path, body) => {
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      let parsed: unknown = undefined;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
      return { status: response.status, body: parsed };
    } catch {
      return { status: 0, body: undefined };
    }
  };
}

const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

export function createLockClient(options: LockClientOptions = {}): LockClient {
  const base = options.base ?? '/api';
  const transport = options.transport ?? fetchTransport(base);
  const storage = options.storage === undefined && !('storage' in options) ? safeStorage() : options.storage;
  const newId = options.newId ?? randomId;
  const beacon =
    'beacon' in options
      ? options.beacon
      : typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? (url: string, body: string) => navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
        : undefined;

  const read = (key: string): string | null => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string): void => {
    try {
      storage?.setItem(key, value);
    } catch {
      // storage denied: the name lasts for this page only
    }
  };

  let clientId = read(CLIENT_KEY);
  if (clientId === null || clientId === '') {
    clientId = newId();
    write(CLIENT_KEY, clientId);
  }
  const storedName = read(NAME_KEY)?.trim() ?? '';
  let me = { tabId: newId(), clientId, name: storedName === '' ? DEFAULT_NAME : storedName, nameSet: storedName !== '' };

  let locks = new Map<string, LockView>();
  const tokens = new Map<string, string>();
  let lost = new Map<string, LostLock>();
  let requested = new Set<string>();
  let ready = false;
  // GET responses must not overwrite newer list requests or mutations acknowledged by the server.
  let refreshSequence = 0;
  let lockMutation = 0;
  let live = false;
  let snap: LockSnapshot | undefined;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    snap = undefined;
    for (const listener of listeners) listener();
  };
  const holder = (): { tabId: string; clientId: string; name: string } => ({ tabId: me.tabId, clientId: me.clientId, name: me.name });
  const setLock = (view: unknown): void => {
    const lock = obj(view) as unknown as LockView;
    if (typeof lock.record !== 'string') return;
    lockMutation += 1;
    locks = new Map(locks);
    locks.set(lock.record, lock);
  };
  const dropLock = (record: string): void => {
    if (!locks.has(record)) return;
    lockMutation += 1;
    locks = new Map(locks);
    locks.delete(record);
  };
  const grant = (record: string, body: unknown): void => {
    lockMutation += 1;
    const b = obj(body);
    if (typeof b['token'] === 'string') tokens.set(record, b['token']);
    setLock(b['lock']);
    if (lost.has(record)) {
      lost = new Map(lost);
      lost.delete(record);
    }
    if (requested.has(record)) {
      requested = new Set(requested);
      requested.delete(record);
    }
  };

  const client: LockClient = {
    snapshot() {
      snap ??= { locks, held: new Set(tokens.keys()), lost, requested, ready, me: { ...me } };
      return snap;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async refresh() {
      const sequence = ++refreshSequence;
      const mutationAtStart = lockMutation;
      const heldAtStart = new Map(tokens);
      const r = await transport('GET', '/locks');
      if (sequence !== refreshSequence || mutationAtStart !== lockMutation) return;
      if (r.status !== 200) return;
      const list = obj(r.body)['locks'];
      if (!Array.isArray(list)) return;
      const next = new Map<string, LockView>();
      for (const lock of list as LockView[]) if (typeof lock?.record === 'string') next.set(lock.record, lock);
      // A locks event is enough to discover a takeover. Waiting for a save
      // or heartbeat leaves a displaced editor looking writable meanwhile.
      for (const [record, token] of heldAtStart) {
        const replacement = next.get(record);
        if (tokens.get(record) !== token || replacement === undefined || replacement.holder.tabId === me.tabId) continue;
        tokens.delete(record);
        lost = new Map(lost);
        lost.set(record, { by: replacement.holder.name, at: replacement.since });
      }
      // a lease this tab holds that the server no longer lists (a restart):
      // keep the token — the next heartbeat takes it again
      locks = next;
      ready = true;
      emit();
    },

    async acquire(record) {
      if (tokens.has(record)) return true;
      const r = await transport('POST', '/locks/acquire', { record, holder: holder() });
      if (r.status === 200) {
        grant(record, r.body);
        emit();
        return true;
      }
      if (r.status === 423) {
        setLock(obj(r.body)['lock']);
        emit();
      }
      return false;
    },

    async release(record) {
      const token = tokens.get(record);
      if (token === undefined) return;
      tokens.delete(record);
      lockMutation += 1;
      dropLock(record);
      emit();
      await transport('POST', '/locks/release', { record, token });
    },

    async heartbeat() {
      const held = [...tokens.entries()];
      if (held.length === 0) return;
      await Promise.all(
        held.map(async ([record, token]) => {
          const r = await transport('POST', '/locks/heartbeat', { record, token, holder: holder() });
          if (tokens.get(record) !== token) return; // released meanwhile
          if (r.status === 200) {
            grant(record, r.body);
            return;
          }
          if (r.status === 409 && obj(r.body)['lost'] === true) {
            lockMutation += 1;
            tokens.delete(record);
            const b = obj(r.body);
            const lock = obj(b['lock']) as unknown as LockView;
            if (typeof lock.record === 'string') setLock(lock);
            else dropLock(record);
            lost = new Map(lost);
            lost.set(record, {
              by: lock.holder?.name,
              at: typeof b['takenOverAt'] === 'string' ? b['takenOverAt'] : new Date().toISOString(),
            });
          }
          // anything else (offline, 5xx): keep the token and try again next beat
        }),
      );
      emit();
    },

    async request(record) {
      requested = new Set(requested);
      requested.add(record);
      emit();
      const r = await transport('POST', '/locks/request', { record, holder: holder() });
      if (r.status === 200) {
        const lock = obj(r.body)['lock'];
        if (lock === undefined) dropLock(record);
        else setLock(lock);
        emit();
      }
    },

    async decline(record) {
      const token = tokens.get(record);
      if (token === undefined) return;
      const r = await transport('POST', '/locks/decline', { record, token });
      if (r.status === 200 && obj(r.body)['lock'] !== undefined) {
        setLock(obj(r.body)['lock']);
        emit();
      }
    },

    async takeOver(record, force) {
      const r = await transport('POST', '/locks/takeover', { record, holder: holder(), force });
      if (r.status === 200) {
        grant(record, r.body);
        emit();
        return 'ok';
      }
      if (r.status === 409 && obj(r.body)['needsConfirm'] === true) {
        setLock(obj(r.body)['lock']);
        emit();
        return 'confirm';
      }
      return 'failed';
    },

    forgetLost(record) {
      if (!lost.has(record)) return;
      lost = new Map(lost);
      lost.delete(record);
      emit();
    },

    setName(name) {
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
      write(NAME_KEY, clean);
      me = { ...me, name: clean === '' ? DEFAULT_NAME : clean, nameSet: clean !== '' };
      emit();
    },

    headerFor(method, path, body) {
      if (tokens.size === 0) return undefined;
      const held = recordsOfWrite(method, path, body).flatMap((record) => {
        const token = tokens.get(record);
        return token === undefined ? [] : [token];
      });
      return held.length === 0 ? undefined : [...new Set(held)].join(', ');
    },

    noteRefused() {
      void client.refresh();
    },

    setLive(value) {
      live = value;
    },

    start() {
      const beat = setInterval(() => void client.heartbeat(), HEARTBEAT_MS);
      let sincePoll = 0;
      const poll = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        sincePoll += POLL_MS;
        if (live && sincePoll < LIVE_POLL_MS) return;
        sincePoll = 0;
        void client.refresh();
      }, POLL_MS);
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') {
          void client.heartbeat();
          void client.refresh();
        }
      };
      const onPageHide = (): void => {
        for (const [record, token] of tokens) {
          const payload = JSON.stringify({ record, token });
          if (beacon === undefined || !beacon(`${base}/locks/release`, payload)) void transport('POST', '/locks/release', { record, token });
        }
        tokens.clear();
      };
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', onPageHide);
        document.addEventListener('visibilitychange', onVisible);
      }
      void client.refresh();
      return () => {
        clearInterval(beat);
        clearInterval(poll);
        if (typeof window !== 'undefined') {
          window.removeEventListener('pagehide', onPageHide);
          document.removeEventListener('visibilitychange', onVisible);
        }
      };
    },

    installFetch(target = globalThis as unknown as { fetch: typeof fetch }) {
      const original = target.fetch;
      const wrapped: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
        let path = url;
        try {
          path = new URL(url, typeof location === 'undefined' ? 'http://localhost/' : location.href).pathname;
        } catch {
          // keep the raw string
        }
        let body: unknown;
        if (typeof init?.body === 'string' && (path.startsWith(`${base}/lineup`) || path.startsWith(`${base}/products`))) {
          try {
            body = JSON.parse(init.body);
          } catch {
            body = undefined;
          }
        }
        const header = client.headerFor(method, path, body);
        let nextInit = init;
        if (header !== undefined) {
          const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
          headers.set(LOCK_HEADER, header);
          nextInit = { ...init, headers };
        }
        const response = await original(input, nextInit);
        if (response.status === 423) client.noteRefused();
        return response;
      };
      target.fetch = wrapped;
      return () => {
        if (target.fetch === wrapped) target.fetch = original;
      };
    },
  };
  return client;
}

let browserClient: LockClient | undefined;

/** The page's one client — `main.tsx` starts it and installs its fetch wrapper. */
export function browserLockClient(): LockClient {
  browserClient ??= createLockClient();
  return browserClient;
}
