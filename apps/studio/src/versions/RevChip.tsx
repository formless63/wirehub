/**
 * The cable list's release chip: the saved
 * revision the working copy is based on, amber with a dot when it has
 * unreleased changes. Nothing when no version is saved (or the host keeps none).
 */

import type { JSX } from 'react';

export function RevChip(props: { rev: number | undefined; unreleased: boolean | undefined }): JSX.Element | null {
  if (props.unreleased === undefined) return null;
  // never released: nothing — the list stays quiet; the workspace header says "unreleased"
  if (props.rev === undefined) return null;
  return (
    <span
      title={props.unreleased ? `Rev ${props.rev} saved — the working copy has unreleased changes` : `Rev ${props.rev} — the working copy matches it`}
      data-testid="rev-chip"
      className={`flex shrink-0 items-center gap-0.5 rounded-sm border px-1 font-mono text-2xs leading-[14px] ${
        props.unreleased ? 'border-warn text-warn' : 'border-line2 text-dim'
      }`}
    >
      R{props.rev}
      {props.unreleased ? <span className="h-[4px] w-[4px] rounded-full bg-warn" aria-label="unreleased changes" /> : null}
    </span>
  );
}
