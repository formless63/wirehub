/**
 * "This record changed outside the panel showing it": a background job made
 * new outputs for a board, an import replaced its art. Panels that read a
 * record's art, model link or job state once (not through a shared query
 * cache) listen and read again; whoever caused the change announces it.
 */

import { useEffect, useState } from 'react';

const EVENT = 'wirehub:record-refresh';

interface Detail {
  kind: string;
  id: string;
}

export function announceRecordChange(kind: string, id: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail: { kind, id } }));
}

/** A counter that moves each time the record is announced as changed. */
export function useRecordRefresh(kind: string, id: string | undefined): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined' || id === undefined) return;
    const on = (e: Event): void => {
      const d = (e as CustomEvent<Detail>).detail;
      if (d?.kind === kind && d.id === id) setTick((n) => n + 1);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [kind, id]);
  return tick;
}
