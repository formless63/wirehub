/**
 * Edit locks — one record's edit session: wrap the
 * editor of a record in this and it
 *
 * - takes the record's lease at the **first change** (the first
 *   unsaved-changes guard under it that turns dirty — `edit-session.ts` in
 *   editor-react), not on open: opening a cable or a part to look at it must
 *   never block a colleague who wants to change it, and in this app there is
 *   no separate "edit mode" — every open record is editable. A draft carried
 *   over from earlier (reopened with unsaved changes) counts as a change, so
 *   it takes the lease as soon as it is back on screen;
 * - shows the record read-only (controls disabled, not hidden) with the
 *   banner while anyone else — another person, or this browser's other tab —
 *   holds it;
 * - gives the lease back on leaving the record (unmount), after five idle
 *   minutes with nothing unsaved, on Hand over, and on tab close (the client's
 *   `pagehide` beacon).
 *
 * Without a lock client in context it renders its children and nothing else.
 */

import { EditSessionContext, type EditSession } from '@cable-studio/editor-react';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';

import { EditLockBanner, type EditLockBannerState } from './EditLockBanner.tsx';
import { otherHolder, useLockClient, useLockSnapshot } from './lock-context.tsx';
import type { LockClient } from './lock-client.ts';

/** a held, clean record is given back after this long without a change */
export const IDLE_RELEASE_MS = 5 * 60_000;

export interface EditLockScopeProps {
  /** the record being edited; `undefined` (nothing selected, a new record) locks nothing */
  record: string | undefined;
  children: ReactNode;
  /** laid out as a column (banner, then the editor filling the rest) — the default; `false` for flow content */
  fill?: boolean;
}

export function EditLockScope(props: EditLockScopeProps): JSX.Element {
  const client = useLockClient();
  if (client === undefined) return <>{props.children}</>;
  // not keyed by record: switching records must not remount the editor under
  // it (the Library keeps its list and panes); per-record state resets below
  return <Scope {...props} client={client} />;
}

function Scope({ record: maybeRecord, children, fill = true, client }: EditLockScopeProps & { client: LockClient }): JSX.Element {
  const snapshot = useLockSnapshot();
  const record = maybeRecord ?? '';
  const active = maybeRecord !== undefined;
  const held = active && (snapshot?.held.has(record) ?? false);
  const lock = active ? snapshot?.locks.get(record) : undefined;
  const other = active ? otherHolder(snapshot, record) : undefined;
  const requested = active && (snapshot?.requested.has(record) ?? false);
  const lost = active ? snapshot?.lost.get(record) : undefined;
  const [handedOver, setHandedOver] = useState(false);
  // a different record is a new session: nothing carries over
  const [sessionOf, setSessionOf] = useState(record);
  const wasBlocked = useRef(false);
  if (sessionOf !== record) {
    setSessionOf(record);
    setHandedOver(false);
    wasBlocked.current = false;
  }

  // how many editors under this scope have unsaved changes
  const dirtyCount = useRef(0);
  const [dirty, setDirty] = useState(false);
  const onDirtyChange = useCallback((next: boolean): void => {
    dirtyCount.current = Math.max(0, dirtyCount.current + (next ? 1 : -1));
    setDirty(dirtyCount.current > 0);
  }, []);

  const locked = other !== undefined || (handedOver && !held);
  const session = useMemo<EditSession>(() => ({ locked, onDirtyChange }), [locked, onDirtyChange]);

  // take the lease: at the first change, when a request is answered by the
  // record freeing up, or when a record this tab was blocked from frees up
  // while it still has unsaved changes (a displaced holder's draft)
  if (other !== undefined) wasBlocked.current = true;
  const inFlight = useRef(false);
  const wasDirty = useRef(false);
  useEffect(() => {
    const firstChange = dirty && !wasDirty.current;
    wasDirty.current = dirty;
    if (!active || held || other !== undefined || handedOver || inFlight.current) return;
    if (!(firstChange || requested || (dirty && wasBlocked.current))) return;
    inFlight.current = true;
    void client.acquire(record).then((ok) => {
      inFlight.current = false;
      if (ok) {
        wasBlocked.current = false;
        client.forgetLost(record);
      }
    });
  }, [client, record, active, dirty, held, other, requested, handedOver]);

  // idle and clean: let it go, so a lease never outlives the work
  useEffect(() => {
    if (!active || !held || dirty) return;
    const timer = setTimeout(() => void client.release(record), IDLE_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [client, record, active, held, dirty]);

  // leaving the record gives it back
  useEffect(() => (active ? () => void client.release(record) : undefined), [client, record, active]);

  // once the other side has it, "handed over" is just "someone else is editing"
  useEffect(() => {
    if (handedOver && other !== undefined) setHandedOver(false);
  }, [handedOver, other]);

  let banner: EditLockBannerState | undefined;
  if (other !== undefined && snapshot !== undefined) {
    banner = {
      kind: 'other',
      lock: other,
      sameBrowser: other.holder.clientId === snapshot.me.clientId,
      requested: requested || other.request?.tabId === snapshot.me.tabId,
      declined: other.declined?.tabId === snapshot.me.tabId,
      ...(lost === undefined ? {} : { lost }),
    };
  } else if (held && lock?.request !== undefined) {
    banner = { kind: 'asked', lock };
  } else if (handedOver && !held) {
    banner = { kind: 'handed-over' };
  }

  const view = (
    <>
      {banner === undefined ? null : (
        <EditLockBanner
          state={banner}
          onRequest={() => void client.request(record)}
          onTakeOver={async (force) => {
            const outcome = await client.takeOver(record, force);
            if (outcome === 'ok') {
              wasBlocked.current = false;
              setHandedOver(false);
            }
            return outcome;
          }}
          onHandOver={() => {
            setHandedOver(true);
            void client.release(record);
          }}
          onKeep={() => void client.decline(record)}
          onEdit={() => {
            setHandedOver(false);
            void client.acquire(record);
          }}
        />
      )}
      <EditSessionContext.Provider value={session}>
        {fill ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : children}
      </EditSessionContext.Provider>
    </>
  );
  return fill ? (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-edit-lock={locked ? 'locked' : held ? 'held' : 'free'}>
      {view}
    </div>
  ) : (
    <div data-edit-lock={locked ? 'locked' : held ? 'held' : 'free'}>{view}</div>
  );
}
