/**
 * `/cables/$id?rev=N` — a saved revision, read-only:
 * the same canvas / schematic / documents as the working copy, resolved
 * against the definitions frozen when it was saved, under a banner that says
 * which revision it is, when, who and why.
 *
 * Unlock asks for a reason and makes it editable; Save & lock writes the edit
 * (recorded in the version's history with that reason) and locks it again.
 * "New version from this" replaces the working copy with this revision.
 */

import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { IconArrowLeft, IconGitBranch, IconLock, IconLockOpen, IconPhotoExclamation } from '@tabler/icons-react';
import { CableEditor, type DocumentRelease, type DocumentReport, type EditorView } from '@wirehub/editor-react';
import { versionDb, type CableDesign } from '@wirehub/model';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { documentFactsFor } from '../catalog.browser.ts';
import { editorExtensions } from '../modules/slots.tsx';
import { useModules } from '../modules/ModulesContext.tsx';
import { cableRoute, type CableSearch } from '../router.tsx';
import { useEditorChrome } from '../shell/editor-chrome.tsx';
import { useStudio } from '../studio-context.tsx';
import { approvalStep, branchVersion, editVersion, getVersion, loadVersionArt, lockVersion, revisionRow, shortTime, unlockVersion, type ApprovalStep, type VersionArt } from '../versions.browser.ts';
import { versionDepictionSource } from '../depictions.browser.ts';
import { withAssemblyLibrary, workbenchAssemblies } from '../persistence.browser.ts';
import { PLAIN_BUTTON, PRIMARY_BUTTON, TEXT_INPUT, useVersionFile, useVersionListing } from './shared.tsx';

type Mode = { kind: 'idle' } | { kind: 'unlock'; reason: string } | { kind: 'branch' } | { kind: 'approval'; step: ApprovalStep; comment: string };

export function VersionView(props: {
  id: string;
  rev: number;
  view: EditorView;
  onViewChange: (view: EditorView) => void;
}): JSX.Element {
  const { id, rev } = props;
  const studio = useStudio();
  const modules = useModules();
  // the modules' panels and exporters, over the revision's own design and frozen definitions (read-only while it is locked)
  const navigate = useNavigate();
  const openModuleRoute = useCallback((module: string, path: string): void => { void navigate({ to: '/m/$module/$', params: { module, _splat: path } }); }, [navigate]);
  const extensions = useMemo(() => editorExtensions(modules, openModuleRoute), [modules, openModuleRoute]);
  const onDocumentReport = useCallback((report: DocumentReport): void => {
    if (report.kind === 'success') toast.success(report.message, report.detail === undefined ? {} : { description: report.detail });
    else toast.error(report.message, report.detail === undefined ? {} : { description: report.detail });
  }, []);
  const chrome = useEditorChrome();
  const queryClient = useQueryClient();
  const { listing, refresh } = useVersionListing(id);
  const { file, error } = useVersionFile(id, rev);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [edited, setEdited] = useState<CableDesign>();
  const [busy, setBusy] = useState(false);
  const [artReady, setArtReady] = useState<string>();

  const db = useMemo(() => (file === undefined ? undefined : versionDb(file.definitions, studio.db)), [file, studio.db]);
  // the designs the revision places (pinned to their saved versions), fetched by the editor
  const assemblies = useMemo(() => workbenchAssemblies(), []);
  const documentFacts = useMemo(() => documentFactsFor(), []);
  const locked = file?.unlocked === undefined;
  const editorKey = file === undefined ? '' : `${id}@${rev}#${file.history.length}`;

  useEffect(() => setEdited(undefined), [editorKey]);
  const [art, setArt] = useState<VersionArt>();
  useEffect(() => {
    if (file === undefined) return;
    let live = true;
    // the revision's own copied artwork; today's tree only for parts it does not cover
    void Promise.all([loadVersionArt(id, file), studio.loadDepictionsFor(file.design)]).then(([own]) => {
      if (!live) return;
      setArt(own);
      setArtReady(editorKey);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per loaded version
  }, [editorKey]);

  const depictions = useMemo(
    () => (art === undefined ? studio.depictions : versionDepictionSource(art.own, art.covered, studio.depictions)),
    [art, studio.depictions],
  );

  const release = useMemo<DocumentRelease>(
    () => ({
      revisions: (listing?.revisions ?? []).map((r) => r.rev),
      rows: (listing?.revisions ?? []).map(revisionRow),
      showing: { kind: 'rev', rev },
      load: async (other) => {
        const out = await getVersion(id, other);
        if (!out.ok) return undefined;
        const otherArt = await loadVersionArt(id, out.value);
        return {
          design: out.value.design,
          // the designs it places, pinned to their own saved versions
          db: await withAssemblyLibrary(versionDb(out.value.definitions, studio.db), out.value.design),
          depictions: versionDepictionSource(otherArt.own, otherArt.covered, studio.depictions),
        };
      },
    }),
    [listing, rev, id, studio.db, studio.depictions],
  );

  const after = useCallback(async (): Promise<void> => {
    await refresh();
    await queryClient.invalidateQueries({ queryKey: ['studio', 'version', id, rev] });
  }, [refresh, queryClient, id, rev]);

  async function onUnlock(reason: string): Promise<void> {
    setBusy(true);
    const out = await unlockVersion(id, rev, reason);
    setBusy(false);
    if (!out.ok) {
      toast.error('Not unlocked', { description: out.hint ?? out.message });
      return;
    }
    setMode({ kind: 'idle' });
    toast.warning(`Rev ${rev} unlocked`, { description: 'Edits are recorded in its history. Save & lock when done.' });
    await after();
  }

  async function onSaveLock(): Promise<void> {
    setBusy(true);
    const out = edited === undefined ? await lockVersion(id, rev) : await editVersion(id, rev, edited);
    setBusy(false);
    if (!out.ok) {
      toast.error(`Rev ${rev} not saved`, { description: out.issues?.[0]?.message ?? out.hint ?? out.message });
      return;
    }
    toast.success(edited === undefined ? `Rev ${rev} locked` : `Rev ${rev} saved and locked`);
    await after();
  }

  async function onApproval(step: ApprovalStep, comment: string): Promise<void> {
    setBusy(true);
    const out = await approvalStep(id, rev, step, comment);
    setBusy(false);
    if (!out.ok) {
      toast.error(`Rev ${rev}: not ${step === 'submit' ? 'submitted' : step === 'approve' ? 'approved' : 'rejected'}`, { description: out.hint ?? out.message });
      return;
    }
    setMode({ kind: 'idle' });
    toast.success(step === 'submit' ? `Rev ${rev} submitted for approval` : step === 'approve' ? `Rev ${rev} approved` : `Rev ${rev} rejected`);
    await after();
  }

  async function onBranch(): Promise<void> {
    setBusy(true);
    const out = await branchVersion(id, rev);
    setBusy(false);
    setMode({ kind: 'idle' });
    if (!out.ok) {
      toast.error('Working copy not replaced', { description: out.issues?.[0]?.message ?? out.hint ?? out.message });
      return;
    }
    studio.reloadCable(out.value.design);
    await refresh();
    toast.success(`Working copy is now based on Rev ${rev}`, {
      ...(out.value.keptDraft === undefined ? {} : { description: `The previous working copy is kept as draft #${out.value.keptDraft}.` }),
    });
    await navigate({ to: cableRoute.id, params: { id }, search: (prev: CableSearch) => ({ view: prev.view }) });
  }

  const toWorking = (): void =>
    void navigate({ to: cableRoute.id, params: { id }, search: (prev: CableSearch) => ({ view: prev.view }) });

  if (error !== undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[12.5px] text-dim">
        <span>{error}</span>
        <button type="button" className={PLAIN_BUTTON} onClick={toWorking}>
          <IconArrowLeft size={13} /> Working copy
        </button>
      </div>
    );
  }
  if (file === undefined || db === undefined || artReady !== editorKey) {
    return <div className="flex h-full items-center justify-center text-[12.5px] text-faint">Loading Rev {rev}…</div>;
  }

  const dirtyStudio = studio.dirtyIds.includes(id);
  const artChanged = file.artworkChanged ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        data-testid="version-banner"
        className={`flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1 text-[12px] ${
          locked ? 'border-line bg-accent-soft' : 'border-warn bg-raised'
        }`}
      >
        {locked ? <IconLock size={14} className="shrink-0 text-accent" /> : <IconLockOpen size={14} className="shrink-0 text-warn" />}
        <span className="shrink-0 font-mono text-[12px] font-semibold">Rev {rev}</span>
        {locked ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-dim">
            <span className="shrink-0">{shortTime(file.savedAt)}</span>
            <span className="shrink-0">· {file.savedBy}</span>
            <span className="min-w-0 truncate text-ink" title={file.note}>
              · {file.note}
            </span>
            {listing?.working.approvals !== true ? null : (
              <span
                data-testid="approval-badge"
                className={`shrink-0 rounded-sm px-1.5 text-[11px] font-semibold ${file.approval?.state === 'approved' ? 'bg-accent-soft text-ok' : file.approval?.state === 'rejected' ? 'text-err' : 'text-warn'}`}
                title={file.approval === undefined ? 'Not submitted for approval' : `${file.approval.state} by ${file.approval.by}: ${file.approval.comment}`}
              >
                {file.approval === undefined ? 'draft' : file.approval.state === 'approved' ? `approved by ${file.approval.by}` : file.approval.state}
              </span>
            )}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-warn" title={file.unlocked?.reason}>
            Unlocked by {file.unlocked?.by}: {file.unlocked?.reason}
          </span>
        )}
        {artChanged.length === 0 ? null : (
          <span
            className="flex shrink-0 items-center gap-1 text-[11px] text-warn"
            title={`The Library's artwork changed since Rev ${rev} was saved: ${artChanged.join(', ')} — this revision draws its own saved copy`}
          >
            <IconPhotoExclamation size={13} /> artwork changed since
          </span>
        )}
        {art === undefined || art.missing.length === 0 ? null : (
          <span
            className="flex shrink-0 items-center gap-1 text-[11px] text-err"
            title={`The saved artwork of ${art.missing.join(', ')} could not be read back — those parts draw today's artwork`}
          >
            <IconPhotoExclamation size={13} /> saved artwork missing
          </span>
        )}

        {mode.kind === 'unlock' ? (
          <form
            className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:min-w-[320px]"
            onSubmit={(event) => {
              event.preventDefault();
              void onUnlock(mode.reason);
            }}
          >
            <input
              autoFocus
              aria-label="Why unlock"
              value={mode.reason}
              onChange={(event) => setMode({ kind: 'unlock', reason: event.target.value })}
              placeholder="Why does a saved revision have to change?"
              className={TEXT_INPUT}
            />
            <button type="button" className={PLAIN_BUTTON} onClick={() => setMode({ kind: 'idle' })}>
              Cancel
            </button>
            <button type="submit" className={PRIMARY_BUTTON} disabled={busy || mode.reason.trim() === ''} title="The reason is kept in the version's history">
              Unlock
            </button>
          </form>
        ) : mode.kind === 'approval' ? (
          <form
            className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:min-w-[320px]"
            onSubmit={(event) => {
              event.preventDefault();
              void onApproval(mode.step, mode.comment);
            }}
          >
            <input
              autoFocus
              aria-label={`Comment to ${mode.step}`}
              value={mode.comment}
              onChange={(event) => setMode({ kind: 'approval', step: mode.step, comment: event.target.value })}
              placeholder={mode.step === 'submit' ? 'What should the reviewer look at?' : 'Why? It is printed with the approval.'}
              className={TEXT_INPUT}
            />
            <button type="button" className={PLAIN_BUTTON} onClick={() => setMode({ kind: 'idle' })}>
              Cancel
            </button>
            <button type="submit" className={PRIMARY_BUTTON} disabled={busy || mode.comment.trim() === ''}>
              {mode.step === 'submit' ? 'Submit' : mode.step === 'approve' ? 'Approve' : 'Reject'}
            </button>
          </form>
        ) : mode.kind === 'branch' ? (
          <span className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
            <span className="text-[12px]">Replace the working copy with Rev {rev}?</span>
            <button type="button" className={PLAIN_BUTTON} onClick={() => setMode({ kind: 'idle' })}>
              Cancel
            </button>
            <button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={() => void onBranch()} title="The current working copy is kept as a draft you can restore">
              Replace
            </button>
          </span>
        ) : locked ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <button type="button" className={PLAIN_BUTTON} onClick={toWorking} title="Back to the working copy">
              <IconArrowLeft size={13} /> <span className="max-sm:hidden">Working</span>
            </button>
            <button
              type="button"
              className={PLAIN_BUTTON}
              disabled={dirtyStudio}
              onClick={() => setMode({ kind: 'branch' })}
              title={dirtyStudio ? 'The working copy has unsaved edits — save or revert them first' : `New version from Rev ${rev}: it becomes the working copy`}
            >
              <IconGitBranch size={13} /> <span className="max-sm:hidden">New version from this</span>
            </button>
            {listing?.working.approvals !== true ? null : file.approval?.state === 'submitted' ? (
              <>
                <button type="button" className={PLAIN_BUTTON} onClick={() => setMode({ kind: 'approval', step: 'approve', comment: '' })} title="Approve this revision as the release">
                  Approve…
                </button>
                <button type="button" className={PLAIN_BUTTON} onClick={() => setMode({ kind: 'approval', step: 'reject', comment: '' })} title="Reject this revision">
                  Reject…
                </button>
              </>
            ) : file.approval?.state === 'approved' ? null : (
              <button type="button" className={PLAIN_BUTTON} onClick={() => setMode({ kind: 'approval', step: 'submit', comment: '' })} title="Ask for release approval">
                Submit for approval…
              </button>
            )}
            <button type="button" className={PLAIN_BUTTON} onClick={() => setMode({ kind: 'unlock', reason: '' })} title="Unlock to correct this revision — needs a reason">
              <IconLockOpen size={13} /> <span className="max-sm:hidden">Unlock…</span>
            </button>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5">
            {edited === undefined ? <span className="text-[11px] text-faint">no edits</span> : <span className="text-[11px] text-warn">edited</span>}
            <button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={() => void onSaveLock()} title={edited === undefined ? 'Lock again without changes' : 'Save the edit to this revision and lock it again'}>
              <IconLock size={13} /> {edited === undefined ? 'Lock' : 'Save & lock'}
            </button>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <CableEditor
          key={editorKey}
          ref={chrome.setHandle}
          chrome="host"
          onChromeStateChange={chrome.setState}
          design={file.design}
          db={db}
          readOnly={locked}
          depictionSource={depictions}
          drawings={studio.drawings}
          {...(studio.partNumbers === undefined ? {} : { partNumbers: studio.partNumbers })}
          documentFacts={documentFacts}
          layout={studio.layout}
          release={release}
          assemblies={assemblies}
          {...(extensions === undefined ? {} : { extensions })}
          onDocumentReport={onDocumentReport}
          view={props.view}
          onViewChange={props.onViewChange}
          onStatusChange={studio.setEditorStatus}
          onDesignChange={(next) => {
            if (!locked) setEdited(next);
          }}
        />
      </div>
    </div>
  );
}
