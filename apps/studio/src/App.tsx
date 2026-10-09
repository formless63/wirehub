/**
 * The studio's entry component: `<QueryClientProvider>` (the server-state
 * cache every query and mutation in `studio-context.tsx` reads and writes)
 * around `<StudioProvider>` (which design is open, the unsaved draft
 * buffers, the adapters) around `<CommandRegistryProvider>` (the quick-open
 * command/shortcut registry — `commands/registry.tsx`,)
 * around `<RouterProvider>` (the shell chrome and the routes — see
 * `router.tsx`), plus `<Toaster>` for the save/create/… confirmations
 * `studio-context.tsx` raises.
 *
 * `StudioProvider` sits *outside* the router on purpose: the routes need it
 * (every route reads `useStudio()`), but the provider itself never navigates
 * — it exposes primitives (`openCable`, `commitSaved`, `dropDraft`, …) and
 * leaves the actual `navigate()` calls to the route components, which are the
 * only things with router context to call it from. `CommandRegistryProvider`
 * sits between it and the router for the same reason: `Shell.tsx`'s
 * `AppCommands`/`CommandPalette` (registered/rendered once, inside the
 * router) both need `useNavigate()` *and* the registry.
 *
 * The `QueryClient` is built once per `<App>` instance (`useState`'s lazy
 * initializer), not as a module-level singleton — a real page only ever
 * mounts one `<App>`, but a test suite mounts many in a row and each has to
 * start with an empty cache, exactly as a fresh `useState` would.
 *
 * A `router` prop lets tests drive the shell with a memory history instead of
 * the real address bar (`createStudioRouter(createMemoryHistory(…))`), without
 * duplicating this wiring.
 *
 * A `queryClient` prop does the same for the query cache: a real page wants
 * the library's own defaults (retry a flaky fetch a few times before giving
 * up), but a test's `fetch` is a direct, synchronous-under-the-hood call into
 * the workbench router — a real failure there is a real bug the test should
 * fail on immediately, not paper over with three retries and exponential
 * backoff (1s, 2s, 4s) that only make a slow CI box look hung. Tests pass
 * their own `retry: false` client; a real page gets the default.
 */

import { QueryClient, QueryClientProvider, QueryObserver, useQueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState, useSyncExternalStore, type JSX } from 'react';
import { registerBodyLayouts, setCommitHook } from '@wirehub/editor-react';
import { registerDrawingArt } from '@wirehub/docs';
import { installBranding, installModuleArt } from '../module-art.ts';
import { brandingQuery } from './settings.browser.ts';
import { browserDepictions } from './depictions.browser.ts';
import type { ModuleRegistry } from '@wirehub/modules';
import { Toaster, toast } from 'sonner';

import { CommandRegistryProvider } from './commands/registry.tsx';
import { router as defaultRouter, type StudioRouter } from './router.tsx';
import { connectEventStream } from './events.browser.ts';
import { cableListKey, dbKey, designsKey } from './queries.ts';
import { partNumbersKey } from './part-numbers.browser.ts';
import { ModulesContext } from './modules/ModulesContext.tsx';
import { builtinModules, registry as buildRegistry } from './modules.browser.ts';
import { createRuntimeLoader, shareHostModules, type RuntimeLoadResult } from './code-modules.browser.ts';
import { StudioProvider } from './studio-context.tsx';
import { LockClientContext } from './locks/lock-context.tsx';
import type { LockClient } from './locks/lock-client.ts';

/**
 * Live catalog and lease updates (`GET /api/events`): a commit anywhere
 * refetches the lists, the library and the part-number data (an open cable is
 * left alone: its save's If-Match is what catches a stale copy, and an
 * unsaved edit is never replaced); a lease change refreshes the lock list.
 * While the stream is up the lock list is polled only as a safety net.
 */
export function ServerEvents({ locks, onCatalog }: { locks?: LockClient | undefined; onCatalog?: () => void }): null {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      connectEventStream({
        onCatalog: () => {
          void browserDepictions().refresh();
          for (const queryKey of [designsKey, cableListKey, dbKey, partNumbersKey, ['studio', 'versions']]) void queryClient.invalidateQueries({ queryKey });
          onCatalog?.();
        },
        onLocks: () => void locks?.refresh(),
        onState: (live) => locks?.setLive(live),
      }),
    [queryClient, locks, onCatalog],
  );
  return null;
}

/** The page's loader of runtime code modules (`code-modules.browser.ts`): one per page, over the build's live registry. */
let pageLoader: ReturnType<typeof createRuntimeLoader> | undefined;
function runtimeLoader(): ReturnType<typeof createRuntimeLoader> {
  if (pageLoader === undefined) {
    shareHostModules();
    pageLoader = createRuntimeLoader({ live: buildRegistry, builtins: builtinModules });
  }
  return pageLoader;
}

/** Say what a sync of the runtime modules means for the person: what did not load, and when a refresh is needed. */
function reportRuntime(result: RuntimeLoadResult): void {
  for (const failure of result.failed) toast.error(`The module ${failure.id} could not be loaded in this page.`, { description: failure.error });
  if (result.needsRefresh.length > 0) {
    toast.message(`Module ${result.needsRefresh.join(', ')} changed. Refresh the page to finish unloading the old code.`, {
      duration: Infinity,
      action: { label: 'Refresh', onClick: () => window.location.reload() },
    });
  }
}
const syncRuntimeModules = (): void => void runtimeLoader().sync().then(reportRuntime, () => undefined);

export function App({
  router = defaultRouter,
  queryClient: providedQueryClient,
  locks,
  modules: providedModules,
}: {
  /** the module registry; absent → the build's own (`modules.browser.ts`) */
  modules?: ModuleRegistry;
  router?: StudioRouter;
  queryClient?: QueryClient;
  /** the page's edit-lock client; absent → no locks (the shell tests) */
  locks?: LockClient;
} = {}): JSX.Element {
  const [ownQueryClient] = useState(() => new QueryClient());
  const queryClient = providedQueryClient ?? ownQueryClient;
  // the build's registry is live: runtime code modules come and go without a reload (a test's own registry is fixed)
  const current = useSyncExternalStore(buildRegistry.subscribe, () => buildRegistry.current(), () => buildRegistry.current());
  const modules = providedModules ?? current;
  useEffect(() => {
    if (providedModules === undefined) syncRuntimeModules();
  }, [providedModules]);
  // the editor's commit hook: at most one module sets it (`docs/modules.md`)
  useEffect(() => {
    setCommitHook(modules.commitHook());
    return () => setCommitHook(undefined);
  }, [modules]);
  // the drawings the modules carry: connector faces, body layouts, sheet art
  useEffect(() => installModuleArt(modules, registerBodyLayouts), [modules]);
  // the hub's own identity (Hub settings) as drawing art — registered after the modules' art, which therefore still wins
  useEffect(() => {
    let off = (): void => {};
    const observer = new QueryObserver(queryClient, brandingQuery);
    const stop = observer.subscribe((result) => {
      off();
      off = installBranding(result.data);
    });
    return () => {
      stop();
      off();
    };
  }, [queryClient, modules]);
  // the drawing sheet reads connector faces and cutaways from the same depiction tree as the schematic
  useEffect(() => {
    const live = browserDepictions();
    return registerDrawingArt({ depictions: { meta: (id) => live.current().meta(id), artwork: (id, view) => live.current().artwork(id, view) } });
  }, []);
  return (
    <ModulesContext.Provider value={modules}>
    <QueryClientProvider client={queryClient}>
      <LockClientContext.Provider value={locks}>
      <ServerEvents locks={locks} {...(providedModules === undefined ? { onCatalog: syncRuntimeModules } : {})} />
      <StudioProvider>
        <CommandRegistryProvider>
          <RouterProvider router={router} />
        </CommandRegistryProvider>
      </StudioProvider>
      </LockClientContext.Provider>
      <Toaster
        position="bottom-right"
        toastOptions={{
          unstyled: true,
          classNames: {
            toast:
              'flex items-start gap-2 rounded-md border border-line bg-panel px-3 py-2.5 text-xs text-ink shadow-lg',
            title: 'font-medium leading-snug',
            description: 'text-dim leading-snug',
            success: 'border-l-2 border-l-ok',
            error: 'border-l-2 border-l-err',
            warning: 'border-l-2 border-l-warn',
            closeButton: 'border-line2 bg-raised text-dim',
          },
        }}
      />
    </QueryClientProvider>
    </ModulesContext.Provider>
  );
}
