/**
 * The studio's shared state, as a context every route reads through.
 *
 * This is what used to be `App.tsx` before the router: which cable is open,
 * its unsaved draft buffer, the parts library, and the adapters that reach the
 * workbench API. The router now decides *which* cable id is asked for — the
 * URL is the source of truth for that — but the rest of the deal is
 * unchanged:
 *
 * - **The unsaved buffers.** A buffer exists exactly while the draft says
 *   something the stored design does not: `commitSaved` clears it (what was
 *   saved becomes the new baseline) and so does re-opening the same id with
 *   nothing changed. That is why a dirty dot anywhere in the shell — the
 *   breadcrumb, the cables list, the status bar — can never disagree; all of
 *   them read `dirtyIds`.
 * - **Where designs live.** The workbench API, through `workbenchPersistence`,
 *   reached only from here and from `LibraryRoute`'s definitions adapter — now
 *   wrapped in TanStack Query mutations so a save/create/duplicate/rename/
 *   delete invalidates exactly the queries it affects instead of this file
 *   hand-rolling `refreshList`/`fetchDb` calls after each one.
 *
 * Route components call `openCable(id)` when their `$id` param changes and
 * read `cableId` / `design` / `stored` back to know when it has landed (or
 * not: `notFoundId` is how a route tells an unknown id apart from "still
 * loading", without crashing — see `CableRoute.tsx`).
 *
 * **Why `design` (the draft) is never derived from the query cache.** A save
 * writes the *stored* baseline (`designKey(id)`'s query data) but must never
 * touch the draft the editor is showing — replacing that object would look
 * like a fresh document to the editor and throw away the undo history of the
 * work that was just saved (`DesignActions.tsx` in editor-react makes the
 * same promise on its side). So `design` stays a plain `useState`, seeded
 * from the draft buffer or the freshly-loaded stored design exactly once per
 * `openCable`, and never overwritten by a background refetch of the same id.
 */

import {
  isDirty,
  problemOf,
  useUnsavedChangesGuard,
  type DefinitionsAdapter,
  type DesignSummary,
  type EditorStatus,
  type Outcome,
  type PersistenceAdapter,
  type PartNumberData,
} from '@wirehub/editor-react';
import type { CableDesign, Db } from '@wirehub/model';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';

import { EMPTY_DB, type DesignId } from './catalog.browser.ts';
import { loadPartNumberData, partNumbersKey } from './part-numbers.browser.ts';
import { loadMe, meKey, type StudioUser } from './me.browser.ts';
import { browserDepictions, depictionDefsOf } from './depictions.browser.ts';
import type { DepictionSource } from '@wirehub/editor-react';
import { workbenchArtwork } from './artwork.browser.ts';
import { workbenchDefinitions } from './definitions.browser.ts';
import { workbenchVocab } from './vocab.browser.ts';
import { localLayoutStore } from './layout.browser.ts';
import { workbenchAssets, workbenchDrawings, workbenchPersistence } from './persistence.browser.ts';
import { cableListKey, dbKey, designKey, designsKey, loadDb, loadDesign, loadDesigns } from './queries.ts';
import { applyTheme, initialTheme, persistTheme, watchSystemTheme, type Theme } from './theme.ts';

export interface StudioApi {
  theme: Theme;
  toggleTheme: () => void;

  /** the parts library every view reads through */
  db: Db;
  /**
   * `db` has been answered by the workbench (or it could not be
   * reached and it is this browser's last copy) — an editor waits for this
   * rather than starting from the empty first-paint placeholders
   */
  dbReady: boolean;
  /** the part-number data (scheme, drawings, designs) — live; undefined while loading */
  partNumbers: PartNumberData | undefined;
  /** who is signed in (or the local user), for records that say who — `GET /api/me` */
  user: string;
  me: StudioUser | undefined;
  /** the board artwork loaded so far — a new identity whenever more lands (udy.9) */
  depictions: DepictionSource;
  /** fetch the artwork a design's parts need; resolves once it is in `depictions` */
  loadDepictionsFor: (design: CableDesign) => Promise<void>;
  persistence: PersistenceAdapter;
  drawings: ReturnType<typeof workbenchDrawings>;
  /** the shared, reusable image library */
  assets: ReturnType<typeof workbenchAssets>;
  artwork: ReturnType<typeof workbenchArtwork>;
  definitions: ReturnType<typeof workbenchDefinitions>;
  /** the controlled lists and the tag side table (data model v2 §5) */
  vocab: ReturnType<typeof workbenchVocab>;
  layout: ReturnType<typeof localLayoutStore>;
  onDefinitionsChange: () => void;

  designs: DesignSummary[];
  /** the workbench API could not be reached — the list above is the bundled fallback */
  apiOffline: boolean;
  /** design ids with an unsaved draft */
  dirtyIds: string[];

  /** the id `openCable` most recently resolved, found or not */
  cableId: string | undefined;
  /** set when `cableId` was looked up and does not exist anywhere */
  notFoundId: string | undefined;
  /**
   * Set when `cableId` could not be loaded from the workbench (unreachable,
   * 5xx). `design`/`stored` stay undefined: the editor never starts from a
   * copy it cannot save against. `offlineCopy` is the build-time copy, for a
   * read-only view.
   */
  loadError: string | undefined;
  offlineCopy: CableDesign | undefined;
  /** ask the workbench for `cableId` again */
  retryOpen: () => void;
  /** the open cable's draft (what the editor shows) */
  design: CableDesign | undefined;
  /** the open cable as stored — the Save baseline and the Documents label */
  stored: CableDesign | undefined;
  openCable: (id: DesignId) => void;
  onDesignChange: (design: CableDesign) => void;
  /** a design was saved: it is now the baseline, and its draft is spent */
  commitSaved: (design: CableDesign) => void;
  /** a design's draft no longer applies (renamed away from, deleted, …) */
  dropDraft: (id: string) => void;
  /**
   * The server replaced the working copy (a new version from an old revision,
   * a restored draft —): make it the baseline *and* the
   * draft the editor shows, dropping any unsaved buffer.
   */
  reloadCable: (design: CableDesign) => void;

  editorStatus: EditorStatus | undefined;
  setEditorStatus: (status: EditorStatus) => void;

  /** the New cable wizard — shared so both the cables list's own button and
   * the quick-open "New cable" command (`commands/AppCommands.tsx`, runnable
   * from anywhere) open the same modal, hosted once at the shell
   * (`shell/NewCableWizardHost.tsx`) rather than per-route */
  newCableOpen: boolean;
  openNewCableWizard: () => void;
  closeNewCableWizard: () => void;
}

const StudioContext = createContext<StudioApi | undefined>(undefined);

export function useStudio(): StudioApi {
  const value = useContext(StudioContext);
  if (value === undefined) throw new Error('useStudio() must be used inside <StudioProvider>');
  return value;
}

/** The server's first blocking-issue line, for a compact toast — the rest stays in the in-canvas Problem panel. */
function firstIssueLine(outcome: Extract<Outcome<unknown>, { ok: false }>): string {
  const problem = problemOf(outcome);
  return problem.details[0] ?? problem.hint ?? problem.message;
}

/**
 * The stale-write guard's marker: the workbench's 409
 * carries `issues[0].code === 'stale-write'` — set by `server/etag.ts`, sent
 * unchanged through `persistence.browser.ts` / `definitions.browser.ts` — so
 * this is told apart from a validator refusal (422) or any other failure
 * without reading English out of `message`.
 */
function isStaleWrite(outcome: Extract<Outcome<unknown>, { ok: false }>): boolean {
  return (outcome.issues ?? []).some((issue) => issue.code === 'stale-write');
}

const STALE_WRITE_DESCRIPTION =
  'Someone else saved this (or it changed on disk) while you had it open. Your changes are still here — reload to see the new version, then reapply them.';

export function StudioProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient();

  /**
   * `designsKey` (pickers, taken-id checks) and `cableListKey` (`/cables`'
   * table — richer rows over the same `GET /api/designs`, see
   * `cable-list.ts`) both answer "what designs exist"; every mutation and
   * navigation that invalidates one invalidates the other, so the table is
   * never left showing a design that was just renamed away or deleted.
   */
  const invalidateDesignLists = useCallback(
    (): Promise<unknown> =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: designsKey }),
        queryClient.invalidateQueries({ queryKey: cableListKey }),
      ]),
    [queryClient],
  );

  const lazyDepictions = useMemo(() => browserDepictions(), []);
  const depictions = useSyncExternalStore(lazyDepictions.subscribe, lazyDepictions.current);
  const loadDepictionsFor = useCallback((d: CableDesign) => lazyDepictions.load(depictionDefsOf(d)), [lazyDepictions]);
  const rawPersistence = useMemo(() => workbenchPersistence(), []);
  const drawings = useMemo(() => workbenchDrawings(), []);
  const assets = useMemo(() => workbenchAssets(), []);
  const artwork = useMemo(() => workbenchArtwork(), []);
  const rawDefinitions = useMemo(() => workbenchDefinitions(), []);
  const vocab = useMemo(() => workbenchVocab(), []);
  /**
   * `save` wrapped for the stale-write guard's toast:
   * `Library` (`editor-react`) already keeps the draft on any failed save (its
   * own Revert button is the only thing that discards it), so this only has to
   * notice the 409 and say so — everything else passes through unchanged.
   */
  const definitions = useMemo<DefinitionsAdapter>(
    () => ({
      ...rawDefinitions,
      save: async (kind, record) => {
        const outcome = await rawDefinitions.save(kind, record);
        if (!outcome.ok && isStaleWrite(outcome)) {
          toast.error('Changed on disk', { description: STALE_WRITE_DESCRIPTION });
        }
        return outcome;
      },
    }),
    [rawDefinitions],
  );
  /** where this browser remembers the arrangement and the pane sizes */
  const layout = useMemo(() => localLayoutStore(), []);

  /** Light/dark. `main.tsx` already applied the initial value before this
   * component ever rendered, so this state starts in sync with the DOM. */
  const [theme, setTheme] = useState<Theme>(() => initialTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => watchSystemTheme(setTheme), []);
  const toggleTheme = useCallback((): void => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      persistTheme(next);
      return next;
    });
  }, []);

  /* ------------------------------------------------------------------ *
   * The designs list and the definitions db — plain queries, each with a
   * bundled fallback baked into the query function so a dead dev server
   * degrades to "read-only, built-time data" instead of a blank screen.
   * ------------------------------------------------------------------ */

  // no bundled first paint: the list is the workbench's (or, when it cannot
  // be reached, the build-time copy flagged `offline`)
  const designsQuery = useQuery({
    queryKey: designsKey,
    queryFn: () => loadDesigns(rawPersistence),
  });
  const designs = useMemo(() => designsQuery.data?.designs ?? [], [designsQuery.data]);
  const apiOffline = designsQuery.data?.offline ?? false;

  const dbQuery = useQuery({
    queryKey: dbKey,
    queryFn: () => loadDb(),
    // the shell paints from an empty library (the bundle carries no catalog
    // data); it is marked stale at once, and editors
    // wait for `dbReady` (the workbench's answer)
    initialData: () => ({ db: EMPTY_DB, live: false }),
    initialDataUpdatedAt: 0,
  });
  const db = dbQuery.data.db;
  const dbReady = dbQuery.isFetched;

  const partNumbersQuery = useQuery({ queryKey: partNumbersKey, queryFn: () => loadPartNumberData() });
  const partNumbers = partNumbersQuery.data?.data;

  /** surface "the workbench is unreachable" once per transition, compactly — no banner paragraph */
  const wasOffline = useRef(false);
  useEffect(() => {
    if (apiOffline && !wasOffline.current) {
      toast.warning('Workbench unreachable', {
        description: 'Showing the last copy this browser fetched.',
      });
    }
    wasOffline.current = apiOffline;
  }, [apiOffline]);

  const onDefinitionsChange = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: dbKey });
    void queryClient.invalidateQueries({ queryKey: partNumbersKey });
  }, [queryClient]);

  /* ------------------------------------------------------------------ *
   * Design lifecycle mutations. `editor-react` calls these adapter methods
   * directly (`DesignActions.tsx`) and never learns they are queries — the
   * adapter shape (`PersistenceAdapter`) is exactly what it was, only the
   * implementation behind `save`/`create`/`duplicate`/`rename`/`remove` now
   * updates the query cache and toasts instead of leaving that to whoever
   * reacts to `onCatalogChange`.
   * ------------------------------------------------------------------ */

  const saveMutation = useMutation({
    mutationFn: (design: CableDesign) => rawPersistence.save(design),
    onSuccess: (outcome, design) => {
      if (outcome.ok) {
        queryClient.setQueryData(designKey(outcome.value.id), { design: outcome.value });
        void invalidateDesignLists();
        void queryClient.invalidateQueries({ queryKey: partNumbersKey });
        // the release chip's "unreleased changes" follows the stored working copy
        void queryClient.invalidateQueries({ queryKey: ['studio', 'versions', outcome.value.id] });
        toast.success(`Saved ${outcome.value.label}`);
      } else if (isStaleWrite(outcome)) {
        // the draft is deliberately left exactly as it was — only the stored
        // baseline is invalidated, so a refetch (or reopening the cable)
        // picks up the version that was saved elsewhere
        toast.error('Changed on disk', { description: STALE_WRITE_DESCRIPTION });
        void queryClient.invalidateQueries({ queryKey: designKey(design.id) });
      } else {
        toast.error('Save rejected', { description: firstIssueLine(outcome) });
      }
    },
  });

  const createMutation = useMutation({
    mutationFn: (design: CableDesign) => rawPersistence.create(design),
    onSuccess: (outcome) => {
      if (!outcome.ok) return;
      queryClient.setQueryData(designKey(outcome.value.id), { design: outcome.value });
      void invalidateDesignLists();
      toast.success(`Created ${outcome.value.label}`);
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (args: { id: string; newId: string; newLabel: string }) =>
      rawPersistence.duplicate(args.id, args.newId, args.newLabel),
    onSuccess: (outcome) => {
      if (!outcome.ok) return;
      queryClient.setQueryData(designKey(outcome.value.id), { design: outcome.value });
      void invalidateDesignLists();
      toast.success(`Duplicated as ${outcome.value.label}`);
    },
  });

  const renameMutation = useMutation({
    mutationFn: (args: { id: string; newId: string; newLabel: string }) =>
      rawPersistence.rename(args.id, args.newId, args.newLabel),
    onSuccess: (outcome, variables) => {
      if (!outcome.ok) return;
      if (variables.id !== outcome.value.id) {
        queryClient.removeQueries({ queryKey: designKey(variables.id) });
      }
      queryClient.setQueryData(designKey(outcome.value.id), { design: outcome.value });
      void invalidateDesignLists();
      toast.success(`Renamed to ${outcome.value.label}`);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (args: { id: string; confirm: string }): Promise<Outcome<{ id: string }>> => {
      const outcome = await rawPersistence.remove(args.id, args.confirm);
      if (outcome.ok) {
        queryClient.removeQueries({ queryKey: designKey(args.id) });
        // awaited so a caller reading the cache right after (CableRoute's
        // delete handler, picking what to open next) sees the fresh list
        await invalidateDesignLists();
      }
      return outcome;
    },
    onSuccess: (outcome, variables) => {
      if (outcome.ok) toast.success(`Deleted ${variables.id}`);
    },
  });

  /** the adapter handed to `<CableEditor persistence={…} />` — same shape, Query-backed */
  const persistence = useMemo<PersistenceAdapter>(
    () => ({
      list: rawPersistence.list,
      load: rawPersistence.load,
      save: (design) => saveMutation.mutateAsync(design),
      create: (design) => createMutation.mutateAsync(design),
      duplicate: (id, newId, newLabel) => duplicateMutation.mutateAsync({ id, newId, newLabel }),
      rename: (id, newId, newLabel) => renameMutation.mutateAsync({ id, newId, newLabel }),
      remove: (id, confirm) => removeMutation.mutateAsync({ id, confirm }),
    }),
    [
      rawPersistence,
      saveMutation.mutateAsync,
      createMutation.mutateAsync,
      duplicateMutation.mutateAsync,
      renameMutation.mutateAsync,
      removeMutation.mutateAsync,
    ],
  );

  /* ------------------------------------------------------------------ *
   * The open cable: which id, its stored document (query-backed) and its
   * draft (plain state — see the file header for why it stays that way).
   * ------------------------------------------------------------------ */

  const [requestedId, setRequestedId] = useState<string | undefined>(undefined);
  const [cableId, setCableId] = useState<string | undefined>(undefined);
  const [notFoundId, setNotFoundId] = useState<string | undefined>(undefined);
  const [design, setDesign] = useState<CableDesign | undefined>(undefined);
  /** unsaved buffers, per design id; a design is in here only while it differs */
  const drafts = useRef(new Map<string, CableDesign>());
  const [dirtyIds, setDirtyIds] = useState<string[]>([]);
  // an unsaved draft of any cable (open or not) makes a reload ask first
  useUnsavedChangesGuard(dirtyIds.length > 0);
  /** which id's draft has already been seeded for the *current* open — guards
   * a background refetch of the same id from clobbering an in-progress edit */
  const openedFor = useRef<string | undefined>(undefined);

  const [editorStatus, setEditorStatus] = useState<EditorStatus | undefined>(undefined);

  const designQuery = useQuery({
    queryKey: designKey(requestedId ?? ''),
    queryFn: () => loadDesign(rawPersistence, requestedId as string),
    enabled: requestedId !== undefined,
  });
  // keyed by `requestedId`, not `cableId`: while a new id is still loading,
  // `cableId` deliberately has not advanced yet (see the effect below) and
  // every reader of `stored` gates on `cableId === id` first, so this window
  // is never shown — it only has to not throw.
  const stored = requestedId === undefined ? undefined : designQuery.data?.design;

  const openCable = useCallback((next: DesignId): void => {
    setEditorStatus(undefined);
    setRequestedId(next);
    // a navigation is also a good moment to notice the workbench came back
    // (or went away) — recovering from offline should not require a manual retry
    void invalidateDesignLists();
  }, [invalidateDesignLists]);

  useEffect(() => {
    if (requestedId === undefined) return;
    if (designQuery.isPending) return; // still loading this id
    if (openedFor.current === requestedId) return; // already initialised this open
    openedFor.current = requestedId;
    setCableId(requestedId);
    const storedNow = designQuery.data?.design;
    const failed = designQuery.data?.loadError !== undefined;
    // a failed load is not "initialised": a retry that succeeds seeds the draft
    if (failed) openedFor.current = undefined;
    setNotFoundId(storedNow === undefined && !failed ? requestedId : undefined);
    setDesign(storedNow === undefined ? undefined : (drafts.current.get(requestedId) ?? storedNow));
  }, [requestedId, designQuery.isPending, designQuery.data]);

  const loadError = requestedId === undefined ? undefined : designQuery.data?.loadError;
  const offlineCopy = requestedId === undefined ? undefined : designQuery.data?.offlineCopy;
  const refetchDesign = designQuery.refetch;
  const retryOpen = useCallback((): void => {
    void refetchDesign();
    void invalidateDesignLists();
  }, [refetchDesign, invalidateDesignLists]);

  /** every accepted edit; the buffer exists only while it says something new */
  const onDesignChange = useCallback(
    (next: CableDesign): void => {
      const id = cableId;
      if (id === undefined || stored === undefined) return;
      setDesign(next);
      if (isDirty(next, stored)) drafts.current.set(id, next);
      else drafts.current.delete(id);
      setDirtyIds([...drafts.current.keys()]);
    },
    [cableId, stored],
  );

  const commitSaved = useCallback(
    (next: CableDesign): void => {
      // `design` (the draft) is deliberately left alone: replacing it would
      // look like a fresh document to the editor and throw away the undo
      // history of the work that was just saved. Only the stored baseline
      // moves — via the query cache, so it is what the next read sees too.
      queryClient.setQueryData(designKey(next.id), { design: next });
      drafts.current.delete(next.id);
      setDirtyIds([...drafts.current.keys()]);
    },
    [queryClient],
  );

  const dropDraft = useCallback((id: string): void => {
    drafts.current.delete(id);
    setDirtyIds([...drafts.current.keys()]);
  }, []);

  const reloadCable = useCallback(
    (next: CableDesign): void => {
      drafts.current.delete(next.id);
      setDirtyIds([...drafts.current.keys()]);
      // the open effect re-seeds the draft from the new stored design
      openedFor.current = undefined;
      queryClient.setQueryData(designKey(next.id), { design: next });
      void invalidateDesignLists();
    },
    [queryClient, invalidateDesignLists],
  );

  const meQuery = useQuery({ queryKey: meKey, queryFn: () => loadMe(), staleTime: Infinity });
  const me = meQuery.data;
  const user = me?.name ?? 'local';
  const [newCableOpen, setNewCableOpen] = useState(false);
  const openNewCableWizard = useCallback((): void => setNewCableOpen(true), []);
  const closeNewCableWizard = useCallback((): void => setNewCableOpen(false), []);

  const value = useMemo<StudioApi>(
    () => ({
      theme,
      toggleTheme,
      db,
      dbReady,
      partNumbers,
      user,
      me,
      depictions,
      loadDepictionsFor,
      persistence,
      drawings,
      assets,
      artwork,
      definitions,
      vocab,
      layout,
      onDefinitionsChange,
      designs,
      apiOffline,
      dirtyIds,
      cableId,
      notFoundId,
      loadError,
      offlineCopy,
      retryOpen,
      design,
      stored,
      openCable,
      onDesignChange,
      commitSaved,
      dropDraft,
      reloadCable,
      editorStatus,
      setEditorStatus,
      newCableOpen,
      openNewCableWizard,
      closeNewCableWizard,
    }),
    [
      theme,
      toggleTheme,
      db,
      dbReady,
      partNumbers,
      user,
      me,
      depictions,
      loadDepictionsFor,
      persistence,
      drawings,
      assets,
      artwork,
      definitions,
      vocab,
      layout,
      onDefinitionsChange,
      designs,
      apiOffline,
      dirtyIds,
      cableId,
      notFoundId,
      loadError,
      offlineCopy,
      retryOpen,
      design,
      stored,
      openCable,
      onDesignChange,
      commitSaved,
      dropDraft,
      reloadCable,
      editorStatus,
      newCableOpen,
      openNewCableWizard,
      closeNewCableWizard,
    ],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}
