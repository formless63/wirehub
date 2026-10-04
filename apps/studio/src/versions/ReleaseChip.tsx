/**
 * The workspace header's release chip: which revision
 * the open cable is at — `Rev 2`, `Rev 2 •` (unreleased changes), `unreleased`
 * (never saved), or `Rev 1 🔒` while an old revision is open — and the door
 * to the version drawer.
 */

import { IconLock, IconLockOpen } from '@tabler/icons-react';
import { useState, type JSX } from 'react';

import { useVersionListing } from './shared.tsx';
import { VersionsPanel } from './VersionsPanel.tsx';

export function ReleaseChip(props: { id: string; rev: string | undefined }): JSX.Element {
  const { listing } = useVersionListing(props.id);
  const [open, setOpen] = useState(false);
  const working = listing?.working;
  const viewing = props.rev === undefined ? undefined : listing?.revisions.find((r) => String(r.rev) === props.rev);

  let label: string;
  let title: string;
  let tone: 'plain' | 'warn' | 'accent';
  if (props.rev !== undefined) {
    label = `Rev ${props.rev}`;
    title = viewing?.locked === false ? `Rev ${props.rev} is unlocked for an edit` : `Viewing saved Rev ${props.rev} (locked) — versions`;
    tone = viewing?.locked === false ? 'warn' : 'accent';
  } else if (working === undefined) {
    label = 'Rev …';
    title = 'Versions';
    tone = 'plain';
  } else if (working.latestRev === undefined) {
    label = 'unreleased';
    title = `Never saved as a version — Save Rev ${working.nextRev} to release it`;
    tone = 'warn';
  } else {
    label = `Rev ${String(working.basedOnRev)}`;
    title = working.unreleased
      ? `Working copy — unreleased changes since Rev ${String(working.basedOnRev)}. Versions…`
      : `Working copy = Rev ${String(working.basedOnRev)} (latest saved: Rev ${working.latestRev}). Versions…`;
    tone = 'plain';
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={title}
        data-testid="release-chip"
        className={`flex h-[18px] shrink-0 items-center gap-1 rounded-sm border px-1 font-mono text-[10.5px] leading-none ${
          tone === 'warn' ? 'border-warn text-warn' : tone === 'accent' ? 'border-accent text-accent' : 'border-line2 text-dim hover:text-ink'
        }`}
      >
        {props.rev === undefined ? null : viewing?.locked === false ? <IconLockOpen size={11} /> : <IconLock size={11} />}
        <span className="max-sm:hidden">{label}</span>
        <span className="hidden max-sm:inline">{label.replace(/^Rev /, 'R').replace('unreleased', 'unrel.')}</span>
        {props.rev === undefined && working?.latestRev !== undefined && working.unreleased ? (
          <span className="h-[5px] w-[5px] rounded-full bg-warn" aria-hidden="true" />
        ) : null}
      </button>
      {open ? <VersionsPanel id={props.id} open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
