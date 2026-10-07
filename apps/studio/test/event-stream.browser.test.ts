/** The browser half of GET /api/events: reconnect, catch-up after a gap, de-duplication. */

import { describe, expect, it } from 'vitest';

import { connectEventStream, type EventSourceLike, type EventStreamLifecycle } from '../src/events.browser.ts';

class FakeSource implements EventSourceLike {
  listeners = new Map<string, (event: { data?: string }) => void>();
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

class FakeLifecycle implements EventStreamLifecycle {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: 'pagehide' | 'pageshow'): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function harness() {
  const lifecycle = new FakeLifecycle();
  const canceled: unknown[] = [];
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const seen: string[] = [];
  const stop = connectEventStream(
    {
      onCatalog: (v) => seen.push(`catalog ${v}`),
      onLocks: (r) => seen.push(`locks ${r ?? '*'}`),
      onState: (live) => seen.push(live ? 'live' : 'down'),
    },
    {
      lifecycle,
      eventSource: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
      setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: (handle) => { canceled.push(handle); },
    },
  );
  return { sources, timers, seen, stop, lifecycle, canceled };
}

describe('connectEventStream', () => {
  it('goes live on hello, refetches on a new version, and ignores a repeat', () => {
    const { sources, seen } = harness();
    sources[0]!.emit('hello', { version: '4' });
    sources[0]!.emit('catalog', { type: 'catalog', version: '5' });
    sources[0]!.emit('catalog', { type: 'catalog', version: '5' });
    sources[0]!.emit('locks', { type: 'locks', record: 'design:x' });
    expect(seen).toEqual(['live', 'locks *', 'catalog 5', 'locks design:x']);
  });

  it('reconnects with a growing pause, and catches up on a version that moved while down', () => {
    const { sources, timers, seen } = harness();
    sources[0]!.emit('hello', { version: '4' });
    sources[0]!.onerror?.({});
    expect(sources[0]!.closed).toBe(true);
    expect(timers[0]!.ms).toBe(1000);
    timers[0]!.fn();
    sources[1]!.onerror?.({});
    expect(timers[1]!.ms).toBe(2000);
    timers[1]!.fn();
    seen.length = 0;
    sources[2]!.emit('hello', { version: '7' });
    expect(seen).toEqual(['live', 'locks *', 'catalog 7']);
  });

  it('stops for good', () => {
    const { sources, timers, stop } = harness();
    sources[0]!.onerror?.({});
    stop();
    timers[0]!.fn();
    expect(sources).toHaveLength(1);
  });

  it('closes on navigation and reconnects once on restore, catching up across the gap', () => {
    const { sources, seen, lifecycle } = harness();
    sources[0]!.emit('hello', { version: '4' });
    lifecycle.emit('pagehide');
    lifecycle.emit('pagehide');
    expect(sources[0]!.closed).toBe(true);
    expect(seen).toEqual(['live', 'locks *', 'down']);
    lifecycle.emit('pageshow');
    lifecycle.emit('pageshow');
    expect(sources).toHaveLength(2);
    sources[1]!.emit('hello', { version: '7' });
    expect(seen).toEqual(['live', 'locks *', 'down', 'live', 'locks *', 'catalog 7']);
    lifecycle.emit('pagehide');
    lifecycle.emit('pageshow');
    expect(sources[1]!.closed).toBe(true);
    expect(sources).toHaveLength(3);
    sources[2]!.emit('hello', { version: '7' });
    expect(seen.filter((value) => value.startsWith('catalog'))).toEqual(['catalog 7']);
  });

  it('cancels pending retries and ignores their callbacks after navigation', () => {
    const { sources, timers, lifecycle, canceled } = harness();
    sources[0]!.onerror?.({});
    lifecycle.emit('pagehide');
    expect(canceled).toEqual([1]);
    timers[0]!.fn();
    expect(sources).toHaveLength(1);
    lifecycle.emit('pageshow');
    sources[1]!.onerror?.({});
    timers[0]!.fn(); // an already queued old retry must not consume the current retry
    expect(sources).toHaveLength(2);
    timers[1]!.fn();
    expect(sources).toHaveLength(3);
  });

  it('ignores late events from a closed source, including errors after a new connection', () => {
    const { sources, timers, seen, lifecycle } = harness();
    sources[0]!.emit('hello', { version: '4' });
    lifecycle.emit('pagehide');
    sources[0]!.emit('hello', { version: '5' });
    sources[0]!.emit('catalog', { version: '5' });
    sources[0]!.emit('locks', { record: 'design:x' });
    sources[0]!.onerror?.({});
    lifecycle.emit('pageshow');
    sources[1]!.emit('hello', { version: '4' });
    sources[0]!.onerror?.({});
    expect(timers).toHaveLength(0);
    expect(sources[1]!.closed).toBe(false);
    expect(seen).toEqual(['live', 'locks *', 'down', 'live', 'locks *']);
  });

  it('stops idempotently while suspended and removes lifecycle listeners', () => {
    const { sources, lifecycle, seen, stop } = harness();
    sources[0]!.emit('hello', { version: '4' });
    lifecycle.emit('pagehide');
    stop();
    stop();
    lifecycle.emit('pageshow');
    lifecycle.emit('pagehide');
    sources[0]!.emit('catalog', { version: '5' });
    expect(sources).toHaveLength(1);
    expect(seen).toEqual(['live', 'locks *', 'down']);
    expect([...lifecycle.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('does nothing without EventSource', () => {
    expect(() => connectEventStream({ onCatalog: () => {}, onLocks: () => {} })()).not.toThrow();
  });
});
