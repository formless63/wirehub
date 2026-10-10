// @vitest-environment jsdom
/**
 * Edit locks in the browser: the read-only banner,
 * "Request edit" → "Hand over", a forced takeover and the displaced
 * holder's note, the other-tab case, the first change taking the lease, and
 * the fetch wrapper quoting the token. Two lock clients (two people, or two
 * tabs) talk to one real lease table through the real `/api/locks` handler.
 */

import { useState, type JSX } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEditLocked, useUnsavedChangesGuard } from '@wirehub/editor-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleLockRequest } from '../server/locks/lock-api.ts';
import { memoryLockStore, type LockStore } from '../server/locks/lock-store.ts';
import { EditLockScope } from '../src/locks/EditLockScope.tsx';
import { LockMarker } from '../src/locks/LockMarker.tsx';
import { LockClientContext } from '../src/locks/lock-context.tsx';
import { createLockClient, type LockClient, type LockTransport } from '../src/locks/lock-client.ts';
import { LOCK_HEADER } from '../src/locks/records.ts';

const RECORD = 'design:de9-terminal-board';

let store: LockStore;
let now: number;

function transport(): LockTransport {
  return async (method, path, body) => {
    const response = await handleLockRequest({ method, path: `/api${path}`, ...(body === undefined ? {} : { body }) }, { locks: store, clock: () => now });
    return { status: response?.status ?? 404, body: response?.body };
  };
}

function memoryStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

let ids = 0;
function person(name: string, storage = memoryStorage()): LockClient {
  const client = createLockClient({ transport: transport(), storage, beacon: undefined, newId: () => `id-${name.toLowerCase()}-${++ids}-xxxxxx` });
  client.setName(name);
  return client;
}

/** A stand-in editor: says whether it is locked, has one control, and can be made dirty. */
function Probe(): JSX.Element {
  const locked = useEditLocked();
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesGuard(dirty);
  return (
    <div>
      <span data-testid="locked">{locked ? 'locked' : 'editable'}</span>
      <fieldset className="cs-lock-fence" disabled={locked}>
        <button type="button" onClick={() => setDirty(true)}>
          Change
        </button>
      </fieldset>
    </div>
  );
}

function mount(client: LockClient): ReturnType<typeof render> {
  return render(
    <LockClientContext.Provider value={client}>
      <LockMarker record={RECORD} />
      <EditLockScope record={RECORD}>
        <Probe />
      </EditLockScope>
    </LockClientContext.Provider>,
  );
}

beforeEach(() => {
  store = memoryLockStore();
  now = new Date('2026-09-26T14:02:00').getTime();
});
afterEach(cleanup);

describe('edit locks in the browser', () => {
  it('the first change takes the lease; opening alone does not', async () => {
    const will = person('Sam');
    mount(will);
    await act(() => will.refresh());
    expect(will.snapshot().held.has(RECORD)).toBe(false);
    expect(screen.getByTestId('locked').textContent).toBe('editable');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(will.snapshot().held.has(RECORD)).toBe(true));
    expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
  });

  it('someone else holding it: read-only, compact banner, controls disabled not hidden, row marker', async () => {
    const alex = person('Alex');
    await alex.acquire(RECORD);
    const will = person('Sam');
    mount(will);
    await act(() => will.refresh());
    const banner = await screen.findByTestId('edit-lock-banner');
    expect(banner.textContent).toContain('Alex is editing (since 14:02)');
    expect(screen.getByTestId('locked').textContent).toBe('locked');
    const change = screen.getByRole('button', { name: 'Change' }) as HTMLButtonElement;
    expect(change).toBeTruthy();
    expect(change.closest('fieldset')?.disabled).toBe(true);
    expect(screen.getByTestId('lock-marker').getAttribute('title')).toBe('Alex is editing (since 14:02)');
  });

  it('Request edit reaches the holder, who hands over; the requester then takes it', async () => {
    const alex = person('Alex');
    await alex.acquire(RECORD);
    const will = person('Sam');
    const viewer = mount(will);
    await act(() => will.refresh());
    fireEvent.click(await screen.findByRole('button', { name: 'Request edit' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Requested' })).toBeTruthy());
    viewer.unmount();

    // Alex's next heartbeat carries the request
    await alex.heartbeat();
    mount(alex);
    const asked = await screen.findByTestId('edit-lock-banner');
    expect(asked.textContent).toContain('Sam wants to edit');
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    await waitFor(() => expect(alex.snapshot().held.has(RECORD)).toBe(false));
    expect(screen.getByTestId('locked').textContent).toBe('locked');
    cleanup();

    // Sam's page sees it free and, having asked, takes it
    mount(will);
    await act(() => will.refresh());
    await waitFor(() => expect(will.snapshot().held.has(RECORD)).toBe(true));
    expect(screen.getByTestId('locked').textContent).toBe('editable');
  });

  it('Keep answers the request; the requester sees it was kept', async () => {
    const alex = person('Alex');
    await alex.acquire(RECORD);
    const will = person('Sam');
    await will.request(RECORD);
    await alex.heartbeat();
    const holder = within(mount(alex).container);
    fireEvent.click(await holder.findByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(holder.queryByTestId('edit-lock-banner')).toBeNull());
    // Alex's page stays open (leaving it would give the record back)
    const viewer = within(mount(will).container);
    await act(() => will.refresh());
    expect((await viewer.findByTestId('edit-lock-banner')).textContent).toContain('kept');
  });

  it('a live lock needs a confirmed takeover; the displaced holder keeps a note and goes read-only', async () => {
    const alex = person('Alex');
    await alex.acquire(RECORD);
    const will = person('Sam');
    const page = within(mount(will).container);
    await act(() => will.refresh());
    fireEvent.click(await page.findByRole('button', { name: 'Take over' }));
    const anyway = await page.findByRole('button', { name: 'Take over anyway' });
    expect(will.snapshot().held.has(RECORD)).toBe(false);
    now += 20_000;
    fireEvent.click(anyway);
    await waitFor(() => expect(will.snapshot().held.has(RECORD)).toBe(true));
    await waitFor(() => expect(page.queryByTestId('edit-lock-banner')).toBeNull());

    // Alex's laptop wakes up: the next heartbeat says it is gone, and to whom
    await alex.heartbeat();
    expect(alex.snapshot().lost.get(RECORD)?.by).toBe('Sam');
    const displaced = within(mount(alex).container);
    const banner = await displaced.findByTestId('edit-lock-banner');
    expect(banner.textContent).toContain('Taken over at 14:02');
    expect(banner.textContent).toContain('Sam is editing');
    expect(displaced.getByTestId('locked').textContent).toBe('locked');
  });

  it('a lapsed lease is taken over without a confirm', async () => {
    const alex = person('Alex');
    await alex.acquire(RECORD);
    const will = person('Sam');
    mount(will);
    await act(() => will.refresh());
    now += 61_000;
    fireEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(will.snapshot().held.has(RECORD)).toBe(true));
  });

  it('a locks refresh immediately notifies a displaced dirty editor and preserves the draft until they resume', async () => {
    const alex = person('Alex');
    mount(alex);
    await act(() => alex.refresh());
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(alex.snapshot().held.has(RECORD)).toBe(true));
    const sam = person('Sam');
    await sam.takeOver(RECORD, true);
    await act(() => alex.refresh());
    expect(alex.snapshot().held.has(RECORD)).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('your changes are kept here, unsaved');
    expect(screen.getByTestId('locked').textContent).toBe('locked');
    expect(alex.headerFor('PUT', '/api/designs/de9-terminal-board')).toBeUndefined();
    await sam.release(RECORD);
    await act(() => alex.refresh());
    expect(screen.getByRole('alert').textContent).toContain('Your unsaved changes are kept in this tab');
    expect(alex.snapshot().held.has(RECORD)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Resume editing' }));
    await waitFor(() => expect(screen.getByTestId('locked').textContent).toBe('editable'));
  });

  it('shows a takeover notice for another tab of this browser', async () => {
    const storage = memoryStorage();
    const first = person('Sam', storage);
    const second = person('Sam', storage);
    await first.acquire(RECORD);
    mount(first);
    await second.takeOver(RECORD, true);
    await act(() => first.refresh());
    expect(screen.getByRole('alert').textContent).toContain('Taken over in another tab');
    expect(screen.getByTestId('locked').textContent).toBe('locked');
  });

  it('two tabs of one browser are two holders: "Open in another tab — Take over here"', async () => {
    const storage = memoryStorage();
    const tab1 = person('Sam', storage);
    const tab2 = person('Sam', storage);
    expect(tab1.snapshot().me.clientId).toBe(tab2.snapshot().me.clientId);
    await tab1.acquire(RECORD);
    mount(tab2);
    await act(() => tab2.refresh());
    expect((await screen.findByTestId('edit-lock-banner')).textContent).toContain('Open in another tab');
    fireEvent.click(screen.getByRole('button', { name: 'Take over here' }));
    await waitFor(() => expect(tab2.snapshot().held.has(RECORD)).toBe(true));
  });

  it('the fetch wrapper quotes a held token on writes to that record only, and refreshes on a 423', async () => {
    const will = person('Sam');
    await will.acquire(RECORD);
    const seen: { url: string; header: string | null }[] = [];
    let status = 200;
    const target = {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), header: new Headers(init?.headers).get(LOCK_HEADER) });
        return new Response('{}', { status });
      }) as typeof fetch,
    };
    const uninstall = will.installFetch(target);
    await target.fetch('/api/designs/de9-terminal-board', { method: 'PUT', headers: { 'if-match': '"x"' }, body: '{}' });
    await target.fetch('/api/drawings/de9-terminal-board/photo', { method: 'PUT', body: '{}' });
    await target.fetch('/api/designs/other', { method: 'PUT', body: '{}' });
    await target.fetch('/api/designs/de9-terminal-board');
    const token = seen[0]?.header;
    expect(token).toMatch(/.+/);
    expect(seen.map((s) => s.header)).toEqual([token, token, null, null]);
    status = 423;
    await target.fetch('/api/designs/other', { method: 'PUT', body: '{}' });
    uninstall();
  });
});
