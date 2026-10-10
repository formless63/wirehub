/**
 * The History panel (cs-5k1.4): a record's change history — who, when, the
 * message and what changed — an entry's field-level diff, and Restore, which
 * saves the record's earlier state as a new change (history is never
 * rewritten). The same pieces make the hub-wide page (`routes/HistoryRoute.tsx`).
 *
 * What the hub's history can do comes with every answer (`capabilities`): on
 * the database every save is there; on files, the git log when the catalog
 * is in git; otherwise nothing, and the panel says so instead of offering it.
 */

import { IconArrowBackUp, IconHistory, IconX } from '@tabler/icons-react';
import { Dialog } from 'radix-ui';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { fetchHistoryEntry, fetchRecordHistory, historyTime, restoreRecord } from '../history.browser.ts';
import { fieldDiff, preview, type FieldChange } from './diff.ts';
import { historyTouchLabel } from './labels.ts';
import type { HistoryCapabilities, HistoryEntry, HistoryEntryDetail, RecordDiff, RestoreAnswer } from './types.ts';

const BUTTON =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line2 bg-raised px-2.5 text-xs text-ink hover:bg-hover disabled:cursor-default disabled:opacity-50';
const PRIMARY =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md border-0 bg-accent px-2.5 text-xs font-semibold text-accent-ink disabled:cursor-default disabled:bg-raised disabled:text-faint';

/** One entry's head line: who, when, what it said, and what it touched. */
export function EntrySummary(props: { entry: HistoryEntry; showTouches?: boolean }): JSX.Element {
  const { entry } = props;
  const who = entry.by.email === undefined ? entry.by.name : `${entry.by.name} <${entry.by.email}>`;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-1.5 text-xs">
        <span className="font-medium text-ink" title={who}>
          {entry.by.name}
        </span>
        <span className="text-faint" title={entry.at}>
          {historyTime(entry.at)}
        </span>
        {entry.source !== 'studio' && entry.source !== 'git' ? <span className="rounded bg-raised px-1 font-mono text-2xs uppercase text-dim">{entry.source}</span> : null}
        {entry.version === undefined ? null : <span className="font-mono text-2xs text-faint">v{entry.version}</span>}
      </div>
      <div className="truncate text-xs text-dim" title={entry.body === undefined ? entry.message : `${entry.message}\n\n${entry.body}`}>
        {entry.message}
      </div>
      {props.showTouches === false || entry.touches.length === 0 ? null : (
        <ul className="m-0 mt-0.5 flex list-none flex-wrap gap-1 p-0" data-testid="history-touches">
          {entry.touches.map((t, i) => (
            <li key={`${t.subject}:${t.part ?? ''}:${i}`} className="rounded border border-line px-1 text-2xs text-dim" title={t.fields === undefined ? t.label : `${t.label}: ${t.fields.join(', ')}`}>
              {t.op === 'delete' ? '− ' : ''}
              {historyTouchLabel(t)}
              {t.fields === undefined || t.fields.length === 0 ? '' : ` · ${t.fields.join(', ')}`}
            </li>
          ))}
          {entry.more === undefined ? null : <li className="text-2xs text-faint">+{entry.more} more</li>}
        </ul>
      )}
    </div>
  );
}

function changeClass(change: FieldChange): string {
  return change.op === 'added' ? 'text-ok' : change.op === 'removed' ? 'text-err' : 'text-warn';
}

/** The field-level diff of one part of one record. */
export function RecordDiffView(props: { diff: RecordDiff }): JSX.Element {
  const { diff } = props;
  const changes = useMemo(
    () => (diff.before.known && diff.after.known ? fieldDiff(diff.before.value, diff.after.value) : []),
    [diff],
  );
  let body: JSX.Element;
  if (diff.op === 'binary') body = <p className="m-0 text-xs text-faint">A file changed; there are no fields to compare.</p>;
  else if (!diff.before.known && diff.after.known) body = <p className="m-0 text-xs text-faint">Its earlier state was not recorded, so there is nothing to compare against.</p>;
  else if (!diff.after.known) body = <p className="m-0 text-xs text-faint">This state was not recorded.</p>;
  else if (changes.length === 0) body = <p className="m-0 text-xs text-faint">No differences.</p>;
  else {
    body = (
      <ul className="m-0 max-h-[320px] list-none overflow-y-auto p-0 font-mono text-2xs leading-[17px]" data-testid="history-diff">
        {changes.map((c, i) => (
          <li key={`${c.path}:${i}`} className={`px-1 ${changeClass(c)}`}>
            <span className="text-ink">{c.path}</span>{' '}
            {c.op === 'changed' ? (
              <>
                <span className="text-err line-through decoration-1">{preview(c.before, 80)}</span> → <span className="text-ok">{preview(c.after, 80)}</span>
              </>
            ) : c.op === 'added' ? (
              <>+ {preview(c.after)}</>
            ) : c.op === 'removed' ? (
              <>− {preview(c.before)}</>
            ) : (
              <span className="text-dim">reordered</span>
            )}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="rounded border border-line bg-bg px-2 py-1" data-subject={diff.subject} data-part={diff.part}>
      <div className="mb-0.5 flex items-center gap-1.5 text-xs">
        <span className="font-medium text-ink">{diff.label}</span>
        <span className="font-mono text-2xs uppercase text-dim">{diff.op === 'binary' ? 'changed' : diff.op}</span>
      </div>
      {body}
    </div>
  );
}

/**
 * One entry, opened: every record it changed with its diff — or, for one
 * subject, that record's parts and Restore.
 */
export function EntryDetail(props: {
  id: string;
  subject?: string;
  subjectLabel?: string;
  /** set: why this record cannot be restored right now (unsaved edits in this tab) */
  restoreBlocked?: string;
  onRestored?: (answer: RestoreAnswer) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<HistoryEntryDetail>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const out = await fetchHistoryEntry(props.id, props.subject);
    if (out.ok) {
      setDetail(out.value);
      setError(undefined);
    } else setError(`${out.error}${out.hint === undefined ? '' : ` ${out.hint}`}`);
  }, [props.id, props.subject]);
  useEffect(() => {
    void load();
  }, [load]);

  async function onRestore(): Promise<void> {
    if (props.subject === undefined || detail?.current === undefined) return;
    setBusy(true);
    const out = await restoreRecord(props.subject, props.id, detail.current);
    setBusy(false);
    setConfirming(false);
    if (!out.ok) {
      toast.error('Not restored', { description: `${out.error}${out.hint === undefined ? '' : ` ${out.hint}`}` });
      // the record may have moved on: show its current version
      await load();
      return;
    }
    toast.success(out.value.restored.parts.length === 0 ? 'Already in that state — nothing to restore' : `Restored ${props.subjectLabel ?? props.subject}`, {
      description: [out.value.restored.parts.length === 0 ? undefined : 'Saved as a new change; the history keeps every earlier one.', ...(out.value.skipped ?? [])].filter((line) => line !== undefined).join(' ') || undefined,
    });
    props.onRestored?.(out.value);
  }

  if (error !== undefined) return <p className="m-0 text-xs text-err">{error}</p>;
  if (detail === undefined) return <p className="m-0 text-xs text-faint">Loading…</p>;
  const canRestore = props.subject !== undefined && detail.capabilities.restore && detail.current !== undefined;
  return (
    <div className="space-y-1.5" data-testid="history-entry">
      {detail.entry.body === undefined ? null : <pre className="m-0 max-h-[120px] overflow-auto whitespace-pre-wrap text-2xs text-dim">{detail.entry.body}</pre>}
      {detail.records.length === 0 ? <p className="m-0 text-xs text-faint">{props.subject === undefined ? 'Nothing to compare in this change.' : 'This change did not change this record.'}</p> : null}
      {detail.records.map((r, i) => (
        <RecordDiffView key={`${r.subject}:${r.part}:${i}`} diff={r} />
      ))}
      {canRestore ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded border border-warn bg-bg px-2 py-1.5 text-xs">
            <span className="min-w-0 flex-1">Restore {props.subjectLabel ?? props.subject} to its state right after this change? It is saved as a new change.</span>
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => void onRestore()} data-testid="history-restore-confirm">
              Restore
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={BUTTON}
            disabled={props.restoreBlocked !== undefined}
            title={props.restoreBlocked ?? 'Bring this record back to its state right after this change, as a new change'}
            onClick={() => setConfirming(true)}
            data-testid="history-restore"
          >
            <IconArrowBackUp size={14} /> Restore this state
          </button>
        )
      ) : null}
    </div>
  );
}

/** A record's entries, newest first, each opening its detail. */
export function RecordHistory(props: { subject: string; label: string; restoreBlocked?: string; onRestored?: (answer: RestoreAnswer) => void }): JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [capabilities, setCapabilities] = useState<HistoryCapabilities>();
  const [next, setNext] = useState<string>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      const out = await fetchRecordHistory(props.subject, before);
      setLoading(false);
      if (!out.ok) {
        setError(`${out.error}${out.hint === undefined ? '' : ` ${out.hint}`}`);
        return;
      }
      setError(undefined);
      setCapabilities(out.value.capabilities);
      setEntries((prev) => (before === undefined ? out.value.entries : [...prev, ...out.value.entries]));
      setNext(out.value.next);
    },
    [props.subject],
  );
  useEffect(() => {
    setOpen(undefined);
    void load();
  }, [load]);

  return (
    <div className="space-y-1" data-testid="record-history">
      {error !== undefined ? <p className="m-0 text-xs text-err">{error}</p> : null}
      {capabilities === undefined ? null : (
        <p className="m-0 text-2xs text-faint" data-testid="history-capabilities" data-backend={capabilities.backend}>
          {capabilities.note}
        </p>
      )}
      {!loading && error === undefined && entries.length === 0 && capabilities?.backend !== 'none' ? <p className="m-0 text-xs text-faint">No changes recorded for this record.</p> : null}
      <ol className="m-0 list-none space-y-1 p-0">
        {entries.map((entry) => (
          <li key={entry.id} className={`rounded border px-2 py-1 ${open === entry.id ? 'border-accent' : 'border-line'} bg-bg`} data-entry={entry.id}>
            <button type="button" className="block w-full min-w-0 border-0 bg-transparent p-0 text-left" onClick={() => setOpen(open === entry.id ? undefined : entry.id)} aria-expanded={open === entry.id}>
              <EntrySummary entry={entry} />
            </button>
            {open === entry.id ? (
              <div className="mt-1 border-t border-line pt-1">
                <EntryDetail
                  id={entry.id}
                  subject={props.subject}
                  subjectLabel={props.label}
                  {...(props.restoreBlocked === undefined ? {} : { restoreBlocked: props.restoreBlocked })}
                  onRestored={(answer) => {
                    props.onRestored?.(answer);
                    setOpen(undefined);
                    void load();
                  }}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {next === undefined ? null : (
        <button type="button" className={BUTTON} disabled={loading} onClick={() => void load(next)}>
          Older…
        </button>
      )}
    </div>
  );
}

/** The drawer around a record's history. */
export function HistoryDrawer(props: { subject: string; label: string; open: boolean; onOpenChange: (open: boolean) => void; restoreBlocked?: string; onRestored?: (answer: RestoreAnswer) => void }): JSX.Element {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-full flex-col border-l border-line2 bg-panel text-ink shadow-[var(--shadow)]" aria-describedby={undefined}>
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
            <IconHistory size={16} className="text-dim" />
            <Dialog.Title className="m-0 text-sm font-semibold">History</Dialog.Title>
            <span className="min-w-0 truncate text-xs text-faint" title={props.subject}>
              {props.label}
            </span>
            <span className="grow" />
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent text-dim hover:text-ink">
                <IconX size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {props.open ? (
              <RecordHistory
                subject={props.subject}
                label={props.label}
                {...(props.restoreBlocked === undefined ? {} : { restoreBlocked: props.restoreBlocked })}
                {...(props.onRestored === undefined ? {} : { onRestored: props.onRestored })}
              />
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A History button that opens the drawer for one record. */
export function HistoryButton(props: { subject: string; label: string; restoreBlocked?: string; onRestored?: (answer: RestoreAnswer) => void; compact?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`History of ${props.label}: who changed what, and restore`}
        aria-label={`History of ${props.label}`}
        data-testid="history-button"
        className={
          props.compact === true
            ? 'flex h-6 w-6 shrink-0 items-center justify-center rounded border-0 bg-transparent text-dim hover:text-ink'
            : 'cs-small flex items-center gap-1'
        }
      >
        <IconHistory size={14} />
        {props.compact === true ? null : 'History'}
      </button>
      {open ? (
        <HistoryDrawer
          subject={props.subject}
          label={props.label}
          open={open}
          onOpenChange={setOpen}
          {...(props.restoreBlocked === undefined ? {} : { restoreBlocked: props.restoreBlocked })}
          {...(props.onRestored === undefined ? {} : { onRestored: props.onRestored })}
        />
      ) : null}
    </>
  );
}
