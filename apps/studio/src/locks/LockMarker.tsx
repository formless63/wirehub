/**
 * Edit locks — the list marker: a small lock + the
 * holder's initials on a row someone else is editing (the Cables list, the
 * Library lists). Nothing for a free row or one this tab holds.
 */

import type { JSX } from 'react';
import { IconLock } from '@tabler/icons-react';

import { initialsOf } from '../me.browser.ts';
import { clockTime, otherHolder, useLockSnapshot } from './lock-context.tsx';

export function LockMarker({ record, compact = false }: { record: string; compact?: boolean }): JSX.Element | null {
  const snapshot = useLockSnapshot();
  const lock = otherHolder(snapshot, record);
  if (lock === undefined) return null;
  const since = clockTime(lock.since);
  const label = `${lock.holder.name} is editing${since === '' ? '' : ` (since ${since})`}`;
  if (compact) {
    // an 18px avatar with a lock badge — fits the cables list's marker column
    return (
      <span
        data-testid="lock-marker"
        title={label}
        aria-label={label}
        className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-warn bg-raised text-2xs font-semibold leading-none text-warn"
      >
        {initialsOf(lock.holder.name)}
        <IconLock size={8} stroke={2.5} aria-hidden className="absolute -right-[3px] -bottom-[3px] rounded-full bg-raised" />
      </span>
    );
  }
  return (
    <span
      data-testid="lock-marker"
      title={label}
      aria-label={label}
      className="inline-flex h-[16px] shrink-0 items-center gap-0.5 rounded-full border border-warn bg-raised pl-[3px] pr-[5px] align-middle text-2xs font-semibold leading-none text-warn"
      style={{ marginRight: 4 }}
    >
      <IconLock size={9} stroke={2.25} aria-hidden />
      {initialsOf(lock.holder.name)}
    </span>
  );
}
