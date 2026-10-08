/**
 * The git backup indicator in the top bar: one
 * compact line — "Backed up 2 min ago", "3 changes waiting to back up",
 * "Backup blocked — needs attention" — and, on click, the details
 * (`GET /api/backup`). Polls every 15 s.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Popover } from 'radix-ui';
import { useState, type JSX, type ReactNode } from 'react';

import { ago, backupKey, backupLabel, loadBackup, retryBackup, type BackupStatus, type BackupTone } from '../backup.browser.ts';

const DOT: Record<BackupTone, string> = {
  ok: 'bg-ok',
  pending: 'bg-warn',
  error: 'bg-err',
  off: 'bg-line2',
};

function Row(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-faint">{props.label}</dt>
      <dd className="m-0 min-w-0 break-words text-ink">{props.children}</dd>
    </>
  );
}

export function BackupDetails({ status, now }: { status: BackupStatus; now: Date }): JSX.Element {
  const client = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const retry = async (): Promise<void> => {
    setRetrying(true);
    const next = await retryBackup();
    if (next !== undefined) client.setQueryData(backupKey, next);
    setRetrying(false);
    void client.invalidateQueries({ queryKey: backupKey });
  };
  return (
    <div className="flex flex-col gap-2">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {status.state === 'database' ? <Row label="Saved in">the database — every save is a change set</Row> : null}
        {status.state === 'database' && status.lastChangeSet !== undefined && status.lastChangeSet !== null ? (
          <Row label="Last save">
            version {status.lastChangeSet.version} · {status.lastChangeSet.by} · {ago(status.lastChangeSet.at, now)}
          </Row>
        ) : null}
        {status.enabled ? null : <Row label="State">off — switched on by the server</Row>}
        {status.enabled && status.state !== 'database' ? <Row label="State">{status.state}</Row> : null}
        {status.enabled && status.state !== 'database' ? (
          <Row label="Remote">
            <span className="font-mono">
              {status.remote}/{status.branch}
            </span>
          </Row>
        ) : null}
        {status.enabled && status.state !== 'database' ? <Row label="Waiting">{status.pendingCommits} commit{status.pendingCommits === 1 ? '' : 's'}</Row> : null}
        {status.lastPush === null ? null : (
          <Row label="Backed up">
            {ago(status.lastPush.at, now)} · <span className="font-mono">{status.lastPush.sha.slice(0, 8)}</span>
          </Row>
        )}
        {status.lastCommit === null ? null : (
          <Row label="Last save">
            <span className="block">{status.lastCommit.subject.replace(/^studio: /, '')}</span>
            <span className="block text-dim">
              {status.lastCommit.author} · {ago(status.lastCommit.at, now)} · <span className="font-mono">{status.lastCommit.sha.slice(0, 8)}</span>
            </span>
          </Row>
        )}
        {status.nextAttemptAt === null ? null : <Row label="Next try">{new Date(status.nextAttemptAt).toLocaleTimeString()}</Row>}
      </dl>
      {status.message === '' || !status.enabled ? null : (
        <p data-testid="backup-message" className={`m-0 ${status.state === 'blocked' ? 'text-err' : 'text-dim'}`}>
          {status.message}
        </p>
      )}
      {status.enabled && (status.state === 'blocked' || status.state === 'offline') ? (
        <button
          type="button"
          disabled={retrying}
          onClick={() => void retry()}
          className="h-7 self-start rounded-md border border-line2 bg-raised px-2.5 text-[12px] font-medium text-ink hover:bg-hover disabled:opacity-50"
        >
          {retrying ? 'Retrying…' : 'Retry now'}
        </button>
      ) : null}
    </div>
  );
}

export function BackupIndicator(props: { now?: () => Date; compact?: boolean }): JSX.Element | null {
  const query = useQuery({ queryKey: backupKey, queryFn: () => loadBackup(), refetchInterval: 15_000 });
  const status = query.data;
  if (status === undefined) return null;
  const now = (props.now ?? (() => new Date()))();
  const { text, tone } = backupLabel(status, now);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="backup-indicator"
          data-tone={tone}
          title={text}
          aria-label={text}
          className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-[11.5px] hover:text-ink ${
            tone === 'error' ? 'font-medium text-err' : tone === 'off' ? 'text-faint' : 'text-dim'
          }`}
        >
          <span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${DOT[tone]}`} />
          {/* a cable's title needs the room first */}
          <span className={props.compact === true ? 'hidden' : 'max-lg:hidden'}>{text}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          aria-label="Backup details"
          className="z-50 w-80 max-w-[calc(100vw-32px)] rounded-md border border-line2 bg-panel p-3 text-[12px] text-ink shadow-[var(--shadow)]"
        >
          <BackupDetails status={status} now={now} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
