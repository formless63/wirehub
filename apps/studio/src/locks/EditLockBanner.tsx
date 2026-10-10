/**
 * Edit locks — the one-line banner over a record
 * someone else is editing, and over a record someone wants from you. Its own
 * component so the top bar and recipe bar stay untouched. Compact: one row,
 * the facts and the buttons, no explanation paragraph.
 */

import { useState, type JSX } from 'react';
import { IconLock, IconUserExclamation } from '@tabler/icons-react';

import { PLAIN_BUTTON } from '../versions/shared.tsx';
import { clockTime } from './lock-context.tsx';
import type { LostLock } from './lock-client.ts';
import type { LockView } from './records.ts';

const BAR = 'flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-raised px-3 py-1 text-xs';

export type EditLockBannerState =
  /** someone else holds it: read-only here */
  | { kind: 'other'; lock: LockView; sameBrowser: boolean; requested: boolean; declined: boolean; lost?: LostLock }
  /** this tab holds it and someone asked for it */
  | { kind: 'asked'; lock: LockView }
  /** a takeover remains visible even after the new holder leaves */
  | { kind: 'lost'; lost: LostLock }
  /** this tab handed it over and is waiting for the other side */
  | { kind: 'handed-over' };

export interface EditLockBannerProps {
  state: EditLockBannerState;
  onRequest: () => void;
  /** `force` once the person confirmed a live takeover */
  onTakeOver: (force: boolean) => Promise<'ok' | 'confirm' | 'failed'>;
  onHandOver: () => void;
  onKeep: () => void;
  onEdit: () => void;
}

export function EditLockBanner(props: EditLockBannerProps): JSX.Element {
  const { state } = props;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state.kind === 'lost') {
    return (
      <div role="alert" data-testid="edit-lock-banner" data-lock="lost" className={`${BAR} border-warn`}>
        <IconLock size={14} className="shrink-0 text-warn" aria-hidden />
        <span className="min-w-0 flex-1 text-ink">Editing was taken over{state.lost.by === undefined ? '' : ` by ${state.lost.by}`}. Your unsaved changes are kept in this tab.</span>
        <button type="button" className={PLAIN_BUTTON} onClick={props.onEdit}>Resume editing</button>
      </div>
    );
  }

  if (state.kind === 'asked') {
    const who = state.lock.request?.name ?? 'Someone';
    return (
      <div role="alert" data-testid="edit-lock-banner" data-lock="asked" className={`${BAR} border-accent`}>
        <IconUserExclamation size={14} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-ink">{who} wants to edit</span>
        <button type="button" className={PLAIN_BUTTON} onClick={props.onHandOver}>
          Hand over
        </button>
        <button type="button" className={PLAIN_BUTTON} onClick={props.onKeep}>
          Keep
        </button>
      </div>
    );
  }

  if (state.kind === 'handed-over') {
    return (
      <div role="status" data-testid="edit-lock-banner" data-lock="handed-over" className={`${BAR} border-line2`}>
        <IconLock size={14} className="shrink-0 text-dim" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-dim">Handed over — read only</span>
        <button type="button" className={PLAIN_BUTTON} onClick={props.onEdit}>
          Edit
        </button>
      </div>
    );
  }

  const { lock } = state;
  const takeOver = async (force: boolean): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await props.onTakeOver(force);
      setConfirming(outcome === 'confirm');
    } finally {
      setBusy(false);
    }
  };

  if (state.sameBrowser) {
    return (
      <div role={state.lost === undefined ? 'status' : 'alert'} data-testid="edit-lock-banner" data-lock="other-tab" className={`${BAR} border-warn`}>
        <IconLock size={14} className="shrink-0 text-warn" aria-hidden />
        <span className="min-w-0 flex-1 text-ink">{state.lost === undefined ? 'Open in another tab' : 'Taken over in another tab — your unsaved changes are kept here'}</span>
        <button type="button" className={PLAIN_BUTTON} disabled={busy} onClick={() => void takeOver(true)}>
          Take over here
        </button>
      </div>
    );
  }

  const since = clockTime(lock.since);
  return (
    <div role={state.lost === undefined ? 'status' : 'alert'} data-testid="edit-lock-banner" data-lock="other" className={`${BAR} border-warn`}>
      <IconLock size={14} className="shrink-0 text-warn" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-ink" title={`Read only while ${lock.holder.name} edits`}>
        {state.lost === undefined ? null : (
          <span className="text-warn">{`Taken over at ${clockTime(state.lost.at)} — your changes are kept here, unsaved · `}</span>
        )}
        {`${lock.holder.name} is editing${since === '' ? '' : ` (since ${since})`}`}
        {state.declined ? <span className="text-dim"> · kept</span> : null}
      </span>
      {confirming ? (
        <>
          <span className="text-dim">Their lock is live.</span>
          <button type="button" className={PLAIN_BUTTON} disabled={busy} onClick={() => void takeOver(true)}>
            Take over anyway
          </button>
          <button type="button" className={PLAIN_BUTTON} disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button type="button" className={PLAIN_BUTTON} disabled={state.requested} onClick={props.onRequest}>
            {state.requested ? 'Requested' : 'Request edit'}
          </button>
          <button type="button" className={PLAIN_BUTTON} disabled={busy} onClick={() => void takeOver(false)}>
            Take over
          </button>
        </>
      )}
    </div>
  );
}
