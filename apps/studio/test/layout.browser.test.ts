/**
 * The studio's layout store.
 *
 * It is the one place the workbench writes to `localStorage`, and everything
 * that can go wrong there is a thing a user cannot see: a quota error, a
 * half-written record, a key hand-edited in devtools. None of them may take the
 * workbench down or move a part somewhere absurd — an unreadable record must
 * read as "nothing remembered", which the editor already knows how to handle.
 *
 * No jsdom: the module reaches for exactly `window.localStorage`, so a fake one
 * is the whole environment it needs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localLayoutStore } from '../src/layout.browser.ts';

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const store = new Map<string, string>();
let refuseWrites = false;

const fake: FakeStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => {
    if (refuseWrites) throw new Error('QuotaExceededError');
    store.set(key, value);
  },
};

const globals = globalThis as unknown as Record<string, unknown>;
const hadWindow = 'window' in globals;
const previous = globals['window'];

beforeEach(() => {
  store.clear();
  refuseWrites = false;
  globals['window'] = { localStorage: fake };
});

afterEach(() => {
  if (hadWindow) globals['window'] = previous;
  else delete globals['window'];
});

describe('arrangements', () => {
  it('round-trips one design without touching another', () => {
    const layout = localLayoutStore();
    expect(layout.positions('rs485-de9-terminal-board')).toBeUndefined();

    layout.savePositions('rs485-de9-terminal-board', { j1: { x: 10, y: -20 } });
    expect(layout.positions('rs485-de9-terminal-board')).toEqual({ j1: { x: 10, y: -20 } });
    expect(layout.positions('no-such-design')).toBeUndefined();
  });

  it('reads a hand-mangled record as nothing remembered', () => {
    const layout = localLayoutStore();
    const key = 'cable-studio/layout/1/positions/rs485-de9-terminal-board';
    for (const junk of [
      'not json',
      '[]',
      '{"j1":{"x":"10","y":0}}',
      '{"j1":{"x":null,"y":0}}',
      '{"j1":42}',
      '{}',
    ]) {
      store.set(key, junk);
      expect(layout.positions('rs485-de9-terminal-board')).toBeUndefined();
    }
  });
});

describe('pane sizes', () => {
  it('round-trip, and anything that is not three numbers does not', () => {
    const layout = localLayoutStore();
    expect(layout.panes()).toBeUndefined();
    layout.savePanes({ palette: 200, side: 300, dock: 400 });
    expect(layout.panes()).toEqual({ palette: 200, side: 300, dock: 400 });

    store.set('cable-studio/layout/1/panes', '{"palette":200,"side":300}');
    expect(layout.panes()).toBeUndefined();
  });
});

describe('storage that says no', () => {
  it('is not an error the user ever sees', () => {
    const layout = localLayoutStore();
    refuseWrites = true;
    expect(() => layout.savePositions('rs485-de9-terminal-board', { j1: { x: 1, y: 2 } })).not.toThrow();
    expect(() => layout.savePanes({ palette: 200, side: 300, dock: 400 })).not.toThrow();
    expect(layout.positions('rs485-de9-terminal-board')).toBeUndefined();
  });
});
