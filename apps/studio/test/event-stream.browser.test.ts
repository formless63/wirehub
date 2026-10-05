/** The browser half of GET /api/events: reconnect, catch-up after a gap, de-duplication. */

import { describe, expect, it } from 'vitest';

import { connectEventStream, type EventSourceLike } from '../src/events.browser.ts';

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

function harness() {
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
      eventSource: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
      setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: () => {},
    },
  );
  return { sources, timers, seen, stop };
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

  it('does nothing without EventSource', () => {
    expect(() => connectEventStream({ onCatalog: () => {}, onLocks: () => {} })()).not.toThrow();
  });
});
