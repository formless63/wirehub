/**
 * `/cables/$id?view=&sel=` — the cable workspace: `CableEditor`, controlled by
 * the URL. `view` maps onto the editor's own `view` (`build` → `canvas`,
 * `schematic` → `schematic`, `documents` → `documents` —);
 * `sel` rides along for later.
 *
 * The design itself is *not* fetched here — `useStudio().openCable(id)` does
 * that (see `studio-context.tsx`), so the same load survives this route
 * remounting (a `key`-less `CableEditor` would otherwise reset on every
 * render) and so the shell (breadcrumb, status bar) can read the same state
 * without prop-drilling through this component.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CableEditor, type CatalogChange, type DocumentRelease, type DocumentReport, type EditorView } from '@wirehub/editor-react';
import { versionDb } from '@wirehub/model';
import { toast } from 'sonner';

import { cableRoute, type CableSearch, type CableView } from '../router.tsx';
import { useStudio } from '../studio-context.tsx';
import { designsKey, type DesignsQueryData } from '../queries.ts';
import { NotFoundView } from '../shell/NotFoundView.tsx';
import { documentFactsFor, offlineCopyFrom } from '../catalog.browser.ts';
import { PLAIN_BUTTON } from '../versions/shared.tsx';
import { useEditorChrome } from '../shell/editor-chrome.tsx';
import { depictionDefsOf } from '../depictions.browser.ts';
import { getVersion, loadVersionArt } from '../versions.browser.ts';
import { versionDepictionSource } from '../depictions.browser.ts';
import { useVersionListing } from '../versions/shared.tsx';
import { VersionView } from '../versions/VersionView.tsx';
import { EditLockScope } from '../locks/EditLockScope.tsx';
import { designRecord } from '../locks/records.ts';
import { workbenchWireLibrary } from '../wire-library.browser.ts';
import { fetchDesignUse, withAssemblyLibrary, workbenchAssemblies } from '../persistence.browser.ts';
import { useModules } from '../modules/ModulesContext.tsx';
import { editorExtensions } from '../modules/slots.tsx';

function editorViewOf(routeView: CableView): EditorView {
  if (routeView === 'documents') return 'documents';
  if (routeView === 'schematic') return 'schematic';
  return 'canvas';
}

/**
 * "Used in": the designs (and saved versions) that place this cable as a
 * sub-assembly — one line under the header, absent when nothing does.
 */
export function UsedInPanel({ id }: { id: string }): JSX.Element | null {
  const query = useQuery({
    queryKey: ['studio', 'used-in', id],
    queryFn: async () => {
      const out = await fetchDesignUse(id);
      return out.ok ? out.value : undefined;
    },
  });
  const use = query.data;
  if (use === undefined || (use.designs.length === 0 && use.versions.length === 0)) return null;
  return (
    <div
      data-testid="used-in"
      className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-raised px-3 py-1 text-[12px] text-dim"
    >
      <span className="font-medium text-ink">Used in</span>
      {use.designs.map((d) => (
        <Link
          key={d.id}
          to="/cables/$id"
          params={{ id: d.id }}
          search={{ view: 'build' }}
          title={`${d.label} — as ${d.instances.join(', ')}`}
          className="rounded-sm border border-line2 px-1.5 font-mono text-[11px] text-ink no-underline hover:bg-hover"
        >
          {d.id}
        </Link>
      ))}
      {use.versions.map((v) => (
        <Link
          key={`${v.design}@${v.rev}`}
          to="/cables/$id"
          params={{ id: v.design }}
          search={{ view: 'build', rev: String(v.rev) }}
          title={`saved Rev ${v.rev} of ${v.design} — as ${v.instances.join(', ')}${v.pinned === undefined ? '' : `, pinned to Rev ${v.pinned}`}`}
          className="rounded-sm border border-dashed border-line2 px-1.5 font-mono text-[11px] text-dim no-underline hover:bg-hover"
        >
          {v.design} Rev {v.rev}
        </Link>
      ))}
    </div>
  );
}

export function CableRoute(): JSX.Element {
  const { id } = cableRoute.useParams();
  const search = cableRoute.useSearch();
  const navigate = useNavigate();
  const studio = useStudio();
  const queryClient = useQueryClient();
  const chrome = useEditorChrome();
  const modules = useModules();
  const openModuleRoute = useCallback((module: string, path: string): void => { void navigate({ to: '/m/$module/$', params: { module, _splat: path } }); }, [navigate]);
  const extensions = useMemo(() => editorExtensions(modules, openModuleRoute), [modules, openModuleRoute]);
  // sub-assemblies: where the designs a cable places come from, and opening one in its own editor
  const assemblies = useMemo(() => workbenchAssemblies(), []);
  // Documents' saves, copies and exports report as toasts, not as text beside the toolbar
  const onDocumentReport = useCallback((report: DocumentReport): void => {
    if (report.kind === 'success') toast.success(report.message, report.detail === undefined ? {} : { description: report.detail });
    else toast.error(report.message, report.detail === undefined ? {} : { description: report.detail });
  }, []);
  const openDesign = useCallback(
    (target: string): void => {
      void navigate({ to: '/cables/$id', params: { id: target }, search: { view: 'build' } });
    },
    [navigate],
  );

  // "Place in…" from the cable list lands here with `place=<design>`: put it
  // in as a sub-assembly once the editor is up, then drop the parameter so a
  // reload does not place it again
  const placeId = search.place;
  const editorReady = studio.cableId === id && studio.design !== undefined && search.rev === undefined && chrome.handle !== null;
  useEffect(() => {
    if (placeId === undefined || !editorReady) return;
    chrome.handle?.placeSubassembly(placeId);
    void navigate({ to: cableRoute.id, params: { id }, search: (prev: CableSearch) => ({ view: prev.view }), replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId, editorReady]);

  useEffect(() => {
    studio.openCable(id);
    // `openCable` is stable across a given `persistence`; only `id` should
    // re-trigger the load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // the design's board artwork, fetched before the editor mounts so its first
  // auto-layout sees real board sizes; later additions load on use
  const [artReady, setArtReady] = useState<string>();
  const draft = studio.cableId === id ? studio.design : undefined;
  const partsKey = draft === undefined ? '' : depictionDefsOf(draft).join(' ');
  useEffect(() => {
    if (draft === undefined) return;
    let live = true;
    void studio.loadDepictionsFor(draft).then(() => {
      if (live) setArtReady(id);
    });
    return () => {
      live = false;
    };
    // keyed on the parts the design names, not on every edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, partsKey]);

  const onCatalogChange = useCallback(
    (change: CatalogChange): void => {
      void (async () => {
        switch (change.kind) {
          case 'saved':
            // the save mutation (studio-context.tsx) already invalidated the
            // designs list and updated this id's query cache — only the
            // local draft bookkeeping is left to do here
            studio.commitSaved(change.design);
            return;
          case 'created':
          case 'duplicated':
            await navigate({ to: '/cables/$id', params: { id: change.design.id }, search: { view: 'build' } });
            return;
          case 'renamed':
            studio.dropDraft(change.from);
            await navigate({ to: '/cables/$id', params: { id: change.design.id }, search: { view: 'build' } });
            return;
          case 'deleted': {
            studio.dropDraft(change.id);
            // the delete mutation awaited its own list invalidation before
            // resolving, so the cache read here is already fresh
            const listed = queryClient.getQueryData<DesignsQueryData>(designsKey)?.designs ?? [];
            const next = listed.find((summary) => summary.id !== change.id) ?? listed[0];
            if (next !== undefined) {
              await navigate({ to: '/cables/$id', params: { id: next.id }, search: { view: 'build' } });
            } else {
              await navigate({ to: '/cables' });
            }
            return;
          }
        }
      })();
    },
    [studio, navigate, queryClient],
  );

  const onViewChange = useCallback(
    (next: EditorView): void => {
      const nextRouteView: CableView =
        next === 'documents' ? 'documents' : next === 'schematic' ? 'schematic' : 'build';
      void navigate({
        to: cableRoute.id,
        params: { id },
        search: (prev: CableSearch) => ({ ...prev, view: nextRouteView }),
      });
    },
    [navigate, id, search.view],
  );

  // the workspace header's Save/undo-redo/menus drive the editor through this
  // instead of a button row of its own — see shell/editor-chrome.tsx
  const onEditRejected = useCallback((message: string): void => {
    toast.error('Edit rejected', { description: message });
  }, []);

  // saved revisions: Documents print the latest saved
  // one by default; the working copy prints marked UNRELEASED
  const { listing } = useVersionListing(id);
  const db = studio.db;
  // the build sheet's and BOM's title-block short names, by the cable list's rule
  const documentFacts = useMemo(() => documentFactsFor(), []);
  // the bench's strip steps: a segment's 3D view in the Inspector strips by them
  const stripPractice = useMemo(() => workbenchWireLibrary().practice, []);
  const release = useMemo<DocumentRelease | undefined>(
    () =>
      listing === undefined
        ? undefined
        : {
            revisions: listing.revisions.map((r) => r.rev),
            showing: {
              kind: 'working',
              unreleased: listing.working.unreleased,
              ...(listing.working.basedOnRev === undefined ? {} : { basedOnRev: listing.working.basedOnRev }),
            },
            load: async (rev) => {
              const out = await getVersion(id, rev);
              if (!out.ok) return undefined;
              // a saved revision prints with the artwork it was saved with
              const art = await loadVersionArt(id, out.value);
              return {
                design: out.value.design,
                // the designs it places, pinned to their own saved versions
                db: await withAssemblyLibrary(versionDb(out.value.definitions, db), out.value.design),
                depictions: versionDepictionSource(art.own, art.covered, studio.depictions),
              };
            },
          },
    [listing, id, db, studio.depictions],
  );

  if (search.rev !== undefined) {
    return <VersionView key={`${id}@${search.rev}`} id={id} rev={Number(search.rev)} view={editorViewOf(search.view)} onViewChange={onViewChange} />;
  }

  if (studio.notFoundId === id) {
    return <NotFoundView message={`No design “${id}”.`} />;
  }

  // the workbench could not answer: never an editable copy — a retry, and
  // the build-time copy read-only under a banner that says what it is
  if (studio.cableId === id && studio.loadError !== undefined) {
    const copy = studio.offlineCopy;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          role="status"
          data-testid="offline-banner"
          className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-warn bg-raised px-3 py-1 text-[12px]"
        >
          <span className="min-w-0 flex-1 truncate text-warn" title={studio.loadError}>
            {copy === undefined ? `Could not load ${id}` : `Offline copy from ${offlineCopyFrom()} — read only`}
          </span>
          <button type="button" className={PLAIN_BUTTON} onClick={studio.retryOpen}>
            Retry
          </button>
        </div>
        {copy === undefined ? null : (
          <div className="min-h-0 flex-1">
            <CableEditor
              key={`${id}@offline`}
              ref={chrome.setHandle}
              chrome="host"
              onChromeStateChange={chrome.setState}
              design={copy}
              db={studio.db}
              readOnly
              depictionSource={studio.depictions}
              {...(studio.partNumbers === undefined ? {} : { partNumbers: studio.partNumbers })}
              documentFacts={documentFacts}
              {...(extensions === undefined ? {} : { extensions })}
              onDocumentReport={onDocumentReport}
              layout={studio.layout}
              view={editorViewOf(search.view)}
              onViewChange={onViewChange}
            />
          </div>
        )}
      </div>
    );
  }

  if (studio.cableId !== id || studio.design === undefined || studio.stored === undefined || artReady !== id || !studio.dbReady) {
    // still loading — `openCable` above is already in flight
    return <div className="flex h-full items-center justify-center text-[12.5px] text-faint">Loading…</div>;
  }

  // edit locks: the cable, its drawing and its documents are one record
  return (
    <EditLockScope record={designRecord(id)}>
    <div className="flex h-full min-h-0 flex-col">
    <UsedInPanel id={id} />
    <div className="min-h-0 flex-1">
    <CableEditor
      key={id}
      ref={chrome.setHandle}
      chrome="host"
      onChromeStateChange={chrome.setState}
      onEditRejected={onEditRejected}
      design={studio.design}
      db={studio.db}
      // the schematic preview draws the real board artwork, bundled from the
      // catalog's committed tree; the canvas stays abstract on purpose
      depictionSource={studio.depictions}
      savedDesign={studio.stored}
      persistence={studio.persistence}
      drawings={studio.drawings}
      assets={studio.assets}
      // the drawing form's part-number Suggest and the BOM's proposals —
      // live from the workbench
      {...(studio.partNumbers === undefined ? {} : { partNumbers: studio.partNumbers })}
      // the build sheet's and BOM's title block: the cable list's short names
      documentFacts={documentFacts}
      {...(stripPractice === undefined ? {} : { stripPractice })}
      {...(release === undefined ? {} : { release })}
      {...(extensions === undefined ? {} : { extensions })}
      onDocumentReport={onDocumentReport}
      definitions={studio.definitions}
      onDefinitionsChange={studio.onDefinitionsChange}
      // artwork uploaded or re-anchored here is layered over `depictions` by
      // the editor, so the schematic redraws without a page reload
      artwork={studio.artwork}
      designs={studio.designs}
      // sub-assemblies: the designs this cable places, fetched as it places them
      assemblies={assemblies}
      onOpenDesign={openDesign}
      // where this browser remembers the arrangement and the pane sizes
      layout={studio.layout}
      onCatalogChange={onCatalogChange}
      onDesignChange={studio.onDesignChange}
      view={editorViewOf(search.view)}
      onViewChange={onViewChange}
      onStatusChange={studio.setEditorStatus}
    />
    </div>
    </div>
    </EditLockScope>
  );
}
