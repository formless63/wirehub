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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState, type JSX } from 'react';
import { setCommitHook } from '@wirehub/editor-react';
import type { ModuleRegistry } from '@wirehub/modules';
import { Toaster } from 'sonner';

import { CommandRegistryProvider } from './commands/registry.tsx';
import { router as defaultRouter, type StudioRouter } from './router.tsx';
import { ModulesContext } from './modules/ModulesContext.tsx';
import { registry as buildRegistry } from './modules.browser.ts';
import { StudioProvider } from './studio-context.tsx';
import { LockClientContext } from './locks/lock-context.tsx';
import type { LockClient } from './locks/lock-client.ts';

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
  const modules = providedModules ?? buildRegistry;
  // the editor's commit hook: at most one module sets it (`docs/modules.md`)
  useEffect(() => {
    setCommitHook(modules.commitHook());
    return () => setCommitHook(undefined);
  }, [modules]);
  return (
    <ModulesContext.Provider value={modules}>
    <QueryClientProvider client={queryClient}>
      <LockClientContext.Provider value={locks}>
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
              'flex items-start gap-2 rounded-md border border-line bg-panel px-3 py-2.5 text-[12px] text-ink shadow-lg',
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
