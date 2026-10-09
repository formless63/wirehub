/**
 * The version drawer: the working copy's release state
 * and Save version, every saved revision (open read-only, compare, new
 * version from it, history), a compare-any-two diff, and the working copies
 * a "new version from this" displaced (restore).
 *
 * Compact on purpose — rows, icons and tooltips, no paragraphs.
 */

import { useNavigate } from '@tanstack/react-router';
import { useQueries } from '@tanstack/react-query';
import {
  IconArrowsDiff,
  IconEye,
  IconGitBranch,
  IconHistory,
  IconLock,
  IconLockOpen,
  IconRestore,
  IconX,
} from '@tabler/icons-react';
import { diffLines, diffVersions, freezeDefinitions, type VersionContent, type VersionHistoryEntry } from '@wirehub/model';
import { Select } from '@wirehub/editor-react';
import { Dialog } from 'radix-ui';
import { useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { cableRoute, type CableSearch } from '../router.tsx';
import { useStudio } from '../studio-context.tsx';
import {
  branchVersion,
  getVersion,
  restoreDraft,
  saveVersion,
  shortTime,
  versionKey,
  type VersionListing,
} from '../versions.browser.ts';
import { DiffList, HistoryList, PLAIN_BUTTON, PRIMARY_BUTTON, RowButton, TEXT_INPUT, useVersionFile, useVersionListing } from './shared.tsx';

type Side = 'working' | number;

function sideLabel(side: Side): string {
  return side === 'working' ? 'Working' : `Rev ${side}`;
}

/** Diff two sides; the working side is the editor's current design against the live library. */
function useSideContent(id: string, sides: Side[]): Map<Side, VersionContent | undefined> {
  const studio = useStudio();
  const revs = sides.filter((side): side is number => side !== 'working');
  const files = useQueries({
    queries: revs.map((rev) => ({
      queryKey: versionKey(id, rev),
      queryFn: async () => {
        const out = await getVersion(id, rev);
        if (!out.ok) throw new Error(out.message);
        return out.value;
      },
      staleTime: 30_000,
    })),
  });
  const working = studio.cableId === id ? studio.design : undefined;
  return useMemo(() => {
    const out = new Map<Side, VersionContent | undefined>();
    revs.forEach((rev, index) => {
      const file = files[index]?.data;
      out.set(rev, file === undefined ? undefined : { design: file.design, definitions: file.definitions });
    });
    if (sides.includes('working')) {
      out.set('working', working === undefined ? undefined : { design: working, definitions: freezeDefinitions(working, studio.db) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the loaded data
  }, [files.map((f) => f.dataUpdatedAt).join(','), working, studio.db, sides.join(',')]);
}

function Compare(props: { id: string; listing: VersionListing; from: Side; to: Side; onFrom: (s: Side) => void; onTo: (s: Side) => void }): JSX.Element {
  const content = useSideContent(props.id, [props.from, props.to]);
  const before = content.get(props.from);
  const after = content.get(props.to);
  const lines = useMemo(
    () => (before === undefined || after === undefined ? undefined : diffLines(diffVersions(before, after))),
    [before, after],
  );
  const options: Side[] = [...props.listing.revisions.map((r) => r.rev).reverse(), 'working'];
  const select = (value: Side, on: (s: Side) => void, label: string): JSX.Element => (
    <Select
      aria-label={label}
      value={String(value)}
      onValueChange={(v) => on(v === 'working' ? 'working' : Number(v))}
      options={options.map((option) => ({ value: String(option), label: sideLabel(option) }))}
    />
  );
  return (
    <section className="border-t border-line px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-faint uppercase">
        <IconArrowsDiff size={13} /> Compare
        <span className="grow" />
        {select(props.from, props.onFrom, 'Compare from')}
        <span className="text-faint">→</span>
        {select(props.to, props.onTo, 'Compare to')}
      </div>
      {lines === undefined ? (
        <p className="m-0 text-xs text-faint">loading…</p>
      ) : (
        <DiffList lines={lines} empty={`${sideLabel(props.from)} and ${sideLabel(props.to)} are the same.`} />
      )}
    </section>
  );
}

export function VersionsPanel(props: { id: string; open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const { id } = props;
  const studio = useStudio();
  const navigate = useNavigate();
  const { listing, error, refresh } = useVersionListing(props.open ? id : undefined);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyOf, setHistoryOf] = useState<number>();
  const [confirm, setConfirm] = useState<{ kind: 'branch'; rev: number } | { kind: 'restore'; n: number }>();
  const [compare, setCompare] = useState<{ from: Side; to: Side }>();
  const dirty = studio.dirtyIds.includes(id);
  const working = listing?.working;
  const latest = listing?.revisions[listing.revisions.length - 1];

  const historyFile = useSideHistory(id, historyOf);

  async function onSave(): Promise<void> {
    setBusy(true);
    const out = await saveVersion(id, note);
    setBusy(false);
    if (!out.ok) {
      toast.error('Version not saved', { description: out.issues?.[0]?.message ?? out.hint ?? out.message });
      return;
    }
    setNote('');
    // this save may have just rewritten the drawing sidecar's `revision`
    // (drawing-form bug) — hand the open drawing form's
    // adapter the fresh tag so its next save does not find out as a 409
    if (out.value.drawingTag !== undefined) studio.drawings.noteTag(id, out.value.drawingTag);
    toast.success(`Saved Rev ${out.value.version.rev}`, { description: 'Locked. Documents now use it.' });
    await refresh();
  }

  async function onConfirm(): Promise<void> {
    if (confirm === undefined) return;
    setBusy(true);
    const out = confirm.kind === 'branch' ? await branchVersion(id, confirm.rev) : await restoreDraft(id, confirm.n);
    setBusy(false);
    setConfirm(undefined);
    if (!out.ok) {
      toast.error('Working copy not replaced', { description: out.issues?.[0]?.message ?? out.hint ?? out.message });
      return;
    }
    studio.reloadCable(out.value.design);
    await refresh();
    toast.success(confirm.kind === 'branch' ? `Working copy is now based on Rev ${confirm.rev}` : `Draft ${confirm.n} restored`, {
      ...(out.value.keptDraft === undefined ? {} : { description: `The previous working copy is kept as draft ${out.value.keptDraft}.` }),
    });
    props.onOpenChange(false);
    await navigate({ to: cableRoute.id, params: { id }, search: (prev: CableSearch) => ({ view: prev.view }) });
  }

  const saveTitle = dirty
    ? 'Save your edits first (Ctrl S) — a version is made from the saved working copy'
    : working !== undefined && latest !== undefined && !working.unreleased
      ? `Nothing changed since Rev ${String(working.basedOnRev)}`
      : note.trim() === ''
        ? 'Write a note first — what is this revision?'
        : `Save the working copy as Rev ${String(working?.nextRev)}, locked`;

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        <Dialog.Content
          className="fixed inset-y-0 right-0 z-50 flex w-[400px] max-w-full flex-col border-l border-line2 bg-panel text-ink shadow-[var(--shadow)]"
          aria-describedby={undefined}
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
            <IconHistory size={16} className="text-dim" />
            <Dialog.Title className="m-0 text-sm font-semibold">Versions</Dialog.Title>
            <span className="min-w-0 truncate text-xs text-faint" title={id}>
              {id}
            </span>
            <span className="grow" />
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent text-dim hover:text-ink">
                <IconX size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error !== undefined ? <p className="m-0 px-3 py-3 text-xs text-err">{error}</p> : null}
            {listing === undefined && error === undefined ? <p className="m-0 px-3 py-3 text-xs text-faint">loading…</p> : null}

            {working === undefined ? null : (
              <section className="px-3 py-2.5" data-testid="working-copy">
                <div className="mb-1.5 flex items-center gap-1.5 text-sm">
                  <span className="font-medium">Working copy</span>
                  {working.basedOnRev === undefined ? null : (
                    <span className="text-xs text-faint" title="The saved revision this working copy descends from">
                      from Rev {working.basedOnRev}
                    </span>
                  )}
                  <span className="grow" />
                  {working.unreleased ? (
                    <span
                      className="rounded-sm border border-warn px-1 font-mono text-2xs leading-[14px] tracking-wide text-warn uppercase"
                      title="The working copy differs from its saved revision — printing it marks it UNRELEASED"
                    >
                      unreleased
                    </span>
                  ) : (
                    <span className="rounded-sm border border-line2 px-1 font-mono text-2xs leading-[14px] text-dim uppercase" title="Identical to its saved revision">
                      = Rev {working.basedOnRev}
                    </span>
                  )}
                </div>
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onSave();
                  }}
                >
                  <input
                    aria-label="Version note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={`Rev ${working.nextRev} — what changed?`}
                    className={TEXT_INPUT}
                  />
                  <button
                    type="submit"
                    className={PRIMARY_BUTTON}
                    title={saveTitle}
                    disabled={busy || dirty || note.trim() === '' || (latest !== undefined && !working.unreleased)}
                  >
                    <IconLock size={13} /> Save Rev {working.nextRev}
                  </button>
                </form>
              </section>
            )}

            {listing === undefined || listing.revisions.length === 0 ? null : (
              <section className="border-t border-line py-1" data-testid="version-list">
                {[...listing.revisions].reverse().map((summary) => (
                  <div key={summary.rev} className="px-3 py-1.5 hover:bg-hover/40">
                    <div className="flex items-center gap-1.5">
                      <span className="shrink-0 rounded-sm bg-raised px-1.5 font-mono text-2xs font-semibold leading-[18px] text-ink">
                        Rev {summary.rev}
                      </span>
                      {summary.locked ? (
                        <IconLock size={12} className="shrink-0 text-faint" aria-label="Locked" />
                      ) : (
                        <IconLockOpen size={12} className="shrink-0 text-warn" aria-label="Unlocked" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm" title={summary.note}>
                        {summary.note}
                      </span>
                      {listing.working.approvals !== true ? null : (
                        <span className={`shrink-0 text-2xs ${summary.approval?.state === 'approved' ? 'text-ok' : summary.approval?.state === 'rejected' ? 'text-err' : 'text-warn'}`} title={summary.approval === undefined ? 'Not submitted for approval' : `${summary.approval.by}: ${summary.approval.comment}`}>
                          {summary.approval === undefined ? 'draft' : summary.approval.state === 'approved' ? `approved · ${summary.approval.by}` : summary.approval.state}
                        </span>
                      )}
                      <RowButton
                        title={`Open Rev ${summary.rev} read-only`}
                        onClick={() => {
                          props.onOpenChange(false);
                          void navigate({
                            to: cableRoute.id,
                            params: { id },
                            search: (prev: CableSearch) => ({ view: prev.view, rev: String(summary.rev) }),
                          });
                        }}
                      >
                        <IconEye size={14} />
                      </RowButton>
                      <RowButton title={`Compare Rev ${summary.rev} with the working copy`} onClick={() => setCompare({ from: summary.rev, to: 'working' })}>
                        <IconArrowsDiff size={14} />
                      </RowButton>
                      <RowButton
                        title={
                          dirty
                            ? 'Save or revert your edits first'
                            : `New version from Rev ${summary.rev} — replaces the working copy; the current one is kept as a draft`
                        }
                        disabled={dirty}
                        onClick={() => setConfirm({ kind: 'branch', rev: summary.rev })}
                      >
                        <IconGitBranch size={14} />
                      </RowButton>
                      <RowButton title="History" onClick={() => setHistoryOf(historyOf === summary.rev ? undefined : summary.rev)}>
                        <IconHistory size={14} />
                      </RowButton>
                    </div>
                    <div className="mt-0.5 pl-0.5 text-2xs text-faint">
                      {shortTime(summary.savedAt)} · {summary.savedBy}
                      {summary.edits === 0 ? '' : ` · ${summary.edits} edit${summary.edits === 1 ? '' : 's'} since`}
                    </div>
                    {confirm?.kind === 'branch' && confirm.rev === summary.rev ? (
                      <ConfirmStrip
                        text={`Replace the working copy with Rev ${summary.rev}? The current one is kept as a draft.`}
                        busy={busy}
                        onCancel={() => setConfirm(undefined)}
                        onConfirm={() => void onConfirm()}
                        action="Replace"
                      />
                    ) : null}
                    {historyOf === summary.rev ? (
                      <div className="mt-1">{historyFile === undefined ? <p className="m-0 text-xs text-faint">loading…</p> : <HistoryList history={historyFile} />}</div>
                    ) : null}
                  </div>
                ))}
              </section>
            )}

            {listing === undefined || listing.revisions.length === 0 ? null : (
              <Compare
                id={id}
                listing={listing}
                from={compare?.from ?? latest?.rev ?? 'working'}
                to={compare?.to ?? 'working'}
                onFrom={(from) => setCompare({ from, to: compare?.to ?? 'working' })}
                onTo={(to) => setCompare({ from: compare?.from ?? latest?.rev ?? 'working', to })}
              />
            )}

            {listing === undefined || listing.drafts.length === 0 ? null : (
              <section className="border-t border-line px-3 py-2" data-testid="kept-drafts">
                <div className="mb-1 text-2xs font-semibold tracking-wide text-faint uppercase">Kept drafts</div>
                {[...listing.drafts].reverse().map((draft) => (
                  <div key={draft.n} className="py-1">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="font-mono text-2xs text-dim">#{draft.n}</span>
                      <span className="min-w-0 flex-1 truncate" title={draft.reason}>
                        {draft.basedOnRev === undefined ? 'unreleased' : `from Rev ${draft.basedOnRev}`} · {shortTime(draft.savedAt)} · {draft.savedBy}
                      </span>
                      <RowButton
                        title={dirty ? 'Save or revert your edits first' : 'Restore this draft as the working copy (the current one is kept)'}
                        disabled={dirty}
                        onClick={() => setConfirm({ kind: 'restore', n: draft.n })}
                      >
                        <IconRestore size={14} />
                      </RowButton>
                    </div>
                    {confirm?.kind === 'restore' && confirm.n === draft.n ? (
                      <ConfirmStrip
                        text={`Restore draft #${draft.n} as the working copy?`}
                        busy={busy}
                        onCancel={() => setConfirm(undefined)}
                        onConfirm={() => void onConfirm()}
                        action="Restore"
                      />
                    ) : null}
                  </div>
                ))}
              </section>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function useSideHistory(id: string, rev: number | undefined): VersionHistoryEntry[] | undefined {
  // keyed like the view's own file query, so an unlock/edit refreshes both
  return useVersionFile(id, rev).file?.history;
}

function ConfirmStrip(props: { text: string; action: string; busy: boolean; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-warn/60 bg-bg px-2 py-1.5 text-xs" role="alertdialog">
      <span className="min-w-0 flex-1">{props.text}</span>
      <button type="button" className={PLAIN_BUTTON} onClick={props.onCancel}>
        Cancel
      </button>
      <button type="button" className={PRIMARY_BUTTON} disabled={props.busy} onClick={props.onConfirm}>
        {props.action}
      </button>
    </div>
  );
}
