/**
 * The route table — see `specs/ui-redesign.md` "Information architecture".
 *
 * Code-based routes (no file-based codegen): `/` redirects to `/cables`;
 * `/cables` is the placeholder list (the real table is kcf.5); `/cables/$id`
 * is the workspace, with `view` and `sel` living in the URL so a reload or a
 * shared link opens the same place; `/library` and `/library/$kind/$id` render
 * the existing Library view (deep-linking to one definition is future work —
 * `Library` does not yet take an initial selection, see `LibraryRoute.tsx`).
 *
 * `createStudioRouter` takes an optional history so tests can drive the router
 * with `createMemoryHistory` instead of the real address bar.
 */

import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  parseSearchWith,
  redirect,
  type AnyRouter,
  type RouterHistory,
} from '@tanstack/react-router';

import { Shell } from './shell/Shell.tsx';
import { NotFoundView } from './shell/NotFoundView.tsx';
import { CablesRoute } from './routes/CablesRoute.tsx';
import { CableRoute } from './routes/CableRoute.tsx';
import { SetupRoute } from './routes/SetupRoute.tsx';
import { ModuleRoute } from './routes/ModuleRoute.tsx';
import { ExtensionsRoute } from './routes/ExtensionsRoute.tsx';
import { JobsRoute } from './routes/JobsRoute.tsx';
import { settingsSection, type SettingsSection } from './settings-sections.ts';
import { AccountRoute } from './routes/AccountRoute.tsx';
import { SettingsRoute } from './routes/SettingsRoute.tsx';
import { PartNumbersRoute } from './routes/PartNumbersRoute.tsx';
import { HistoryRoute } from './routes/HistoryRoute.tsx';
import { ResolverRoute } from './routes/ResolverRoute.tsx';
import { ProductRoute, ProductsRoute } from './routes/ProductsRoute.tsx';
import { setupNeeded } from './setup.browser.ts';
import { setSetupMode } from './setup-mode.ts';
// the Library page loads on first visit, not with the main chunk
const LibraryRoute = lazyRouteComponent(() => import('./routes/LibraryRoute.tsx'), 'LibraryRoute');

/** The workspace content a cable's URL can ask for; `build` is the default. */
export type CableView = 'build' | 'schematic' | 'documents';

export interface CableSearch {
  view: CableView;
  /** a selection to restore — not read by anything yet (kcf.3 scope) */
  sel?: string;
  /** a saved revision to open read-only; absent = the working copy */
  rev?: string;
  /** a design to place in this cable as a sub-assembly on arrival ("Place in…" in the cable list) */
  place?: string;
}

function isCableView(value: unknown): value is CableView {
  return value === 'build' || value === 'schematic' || value === 'documents';
}

/** `/cables`' sortable columns — see `CablesRoute.tsx`. */
export type CableListSort = 'partNumber' | 'product' | 'source' | 'destination' | 'wire' | 'notes' | 'boards';

const CABLE_LIST_SORTS: readonly CableListSort[] = ['partNumber', 'product', 'source', 'destination', 'wire', 'notes', 'boards'];

function isCableListSort(value: unknown): value is CableListSort {
  return typeof value === 'string' && (CABLE_LIST_SORTS as readonly string[]).includes(value);
}

/** the text filter, sort and chip-filter state `CablesRoute.tsx` reads and writes — the URL is the source of truth, per `specs/ui-redesign.md`. */
export interface CablesSearch {
  q?: string;
  sort?: CableListSort;
  dir?: 'asc' | 'desc';
  /** destination chip (matches an entry's `destinationShort`) */
  dest?: string[];
  /** wire chip (matches any of an entry's trunk `wires` — construction, never the manufacturer) */
  wire?: string[];
  /** board chip (matches any of an entry's `boardLabels`) */
  board?: string[];
  /** source chip (matches an entry's `source`) */
  source?: string[];
  /** status chip (matches an entry's `status`: active / development / legacy) */
  status?: string[];
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item !== '');
  return strings.length === 0 ? undefined : strings;
}

export const rootRoute = createRootRoute({
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
});

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // a fresh hub (the server asks for it: WIREHUB_SETUP_PROMPT) opens on first-run setup
  beforeLoad: async () => {
    if (await setupNeeded()) throw redirect({ to: '/setup' });
    throw redirect({ to: '/cables' });
  },
});

export const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupRoute,
});

export const cablesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cables',
  validateSearch: (search: Record<string, unknown>): CablesSearch => ({
    ...(typeof search['q'] === 'string' && search['q'] !== '' ? { q: search['q'] } : {}),
    ...(isCableListSort(search['sort']) ? { sort: search['sort'] } : {}),
    ...(search['dir'] === 'asc' || search['dir'] === 'desc' ? { dir: search['dir'] } : {}),
    ...(stringArray(search['dest']) !== undefined ? { dest: stringArray(search['dest']) } : {}),
    ...(stringArray(search['wire']) !== undefined ? { wire: stringArray(search['wire']) } : {}),
    ...(stringArray(search['board']) !== undefined ? { board: stringArray(search['board']) } : {}),
    ...(stringArray(search['source']) !== undefined ? { source: stringArray(search['source']) } : {}),
    ...(stringArray(search['status']) !== undefined ? { status: stringArray(search['status']) } : {}),
  }),
  component: CablesRoute,
});

export const cableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cables/$id',
  validateSearch: (search: Record<string, unknown>): CableSearch => ({
    view: isCableView(search['view']) ? search['view'] : 'build',
    ...(typeof search['sel'] === 'string' && search['sel'] !== '' ? { sel: search['sel'] } : {}),
    ...(typeof search['place'] === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(search['place']) ? { place: search['place'] } : {}),
    ...((typeof search['rev'] === 'string' && /^\d{1,6}$/.test(search['rev'])) || (typeof search['rev'] === 'number' && Number.isInteger(search['rev']) && search['rev'] >= 0)
      ? { rev: String(search['rev']) }
      : {}),
  }),
  component: CableRoute,
});

function librarySearch(search: Record<string, unknown>): { pack?: string } {
  return typeof search['pack'] === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(search['pack'])
    ? { pack: search['pack'] } : {};
}

export const libraryIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  // `/library` is not a real place to land — the section always shows one
  // kind's list, so this redirects to the first kind (connectors) exactly as
  // `indexRoute` redirects `/` to `/cables`.
  validateSearch: librarySearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/library/$kind', params: { kind: 'connectors' }, search });
  },
});

/** `/library/store` moved to Extensions › Browse; `q` and `pack` (the editor's node creator links here) carry over */
export const libraryStoreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/store',
  validateSearch: (search: Record<string, unknown>): { q?: string; pack?: string } => ({
    ...(typeof search['q'] === 'string' && search['q'] !== '' ? { q: search['q'] } : {}),
    ...(typeof search['pack'] === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(search['pack']) ? { pack: search['pack'] } : {}),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/extensions', search: { tab: 'browse', ...(search.q === undefined ? {} : { q: search.q }), ...(search.pack === undefined ? {} : { pack: search.pack }) } });
  },
});

export type ExtensionsSearch = { tab?: 'browse' | 'installed' | 'sources'; q?: string; pack?: string };
/** `/extensions`: Browse, Installed and Sources — Store, Modules, Code modules and Catalog stores in one place */
export const extensionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/extensions',
  validateSearch: (search: Record<string, unknown>): ExtensionsSearch => ({
    ...(search['tab'] === 'browse' || search['tab'] === 'installed' || search['tab'] === 'sources' ? { tab: search['tab'] } : {}),
    ...(typeof search['q'] === 'string' && search['q'] !== '' ? { q: search['q'] } : {}),
    ...(typeof search['pack'] === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(search['pack']) ? { pack: search['pack'] } : {}),
  }),
  component: ExtensionsRoute,
});

export const libraryKindRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/$kind',
  validateSearch: librarySearch,
  component: LibraryRoute,
});

export const libraryItemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/$kind/$id',
  validateSearch: librarySearch,
  component: LibraryRoute,
});

/** `/m/<module>/<path>`: a page a module contributes (`docs/modules.md`) */
export const moduleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/m/$module/$',
  component: ModuleRoute,
});

/** `/modules` is now Extensions › Installed */
export const modulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/modules',
  beforeLoad: () => {
    throw redirect({ to: '/extensions', search: { tab: 'installed' } });
  },
});

/** `/jobs`: recent jobs (imports to review and publish, model builds) and the worker's heartbeat */
export const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  component: JobsRoute,
});

/** `/settings`: the hub's organisation name, logo and rights line on its documents */
export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (search: Record<string, unknown>): { section?: SettingsSection | 'stores' | 'modules' } => {
    // Catalog stores and Code modules moved to Extensions; their old addresses redirect (below)
    if (search['section'] === 'stores' || search['section'] === 'modules') return { section: search['section'] };
    const section = settingsSection(search['section']);
    return section === undefined ? {} : { section };
  },
  beforeLoad: ({ search }) => {
    if (search.section === 'stores') throw redirect({ to: '/extensions', search: { tab: 'sources' } });
    if (search.section === 'modules') throw redirect({ to: '/extensions', search: { tab: 'installed' } });
  },
  component: SettingsRoute,
});

/** `/part-numbers`: duplicates, unnumbered parts and cables, and disagreements between a cable's numbers */
export const partNumbersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/part-numbers',
  component: PartNumbersRoute,
});

/** `/history`: the hub's change history — who changed what, when; filters by person, date and kind */
export const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: HistoryRoute,
});

/** `/resolver`: "Which cable do I need?" — devices in, ranked options out, a design made from one (docs/resolver.md) */
export const resolverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/resolver',
  component: ResolverRoute,
});

/** `/products`: product families and the lineup (docs/products.md) */
export const productsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/products',
  component: ProductsRoute,
});

/** `/products/$id`: one product family, its variants, merge and split */
export const productRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/products/$id',
  component: ProductRoute,
});

/** Session-gated account and people controls, with the same app navigation. */
export const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search['error'] === 'string' && /^[A-Z0-9_]{1,60}$/i.test(search['error']) ? { error: search['error'] } : {},
  component: AccountRoute,
});
/** People moved under Settings; the old address redirects */
export const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/people',
  beforeLoad: () => {
    throw redirect({ to: '/settings', search: { section: 'people' } });
  },
});
export const tokensRoute = createRoute({ getParentRoute: () => rootRoute, path: '/account/tokens', component: AccountRoute });

/**
 * `/dev/ui`: the primitives gallery. Registered only when `import.meta.env.DEV`; Vite replaces it
 * with `false` in a production build, so the route, its lazy chunk and the gallery code are all
 * dropped from the bundle (a test checks the built output).
 */
const devRoutes = import.meta.env.DEV
  ? [createRoute({ getParentRoute: () => rootRoute, path: '/dev/ui', component: lazyRouteComponent(() => import('./routes/dev/UiGallery.tsx'), 'UiGallery') })]
  : [];

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  accountRoute,
  peopleRoute,
  tokensRoute,
  cablesRoute,
  cableRoute,
  libraryIndexRoute,
  libraryStoreRoute,
  extensionsRoute,
  libraryKindRoute,
  libraryItemRoute,
  moduleRoute,
  modulesRoute,
  jobsRoute,
  settingsRoute,
  partNumbersRoute,
  historyRoute,
  resolverRoute,
  productsRoute,
  productRoute,
  ...devRoutes,
]);

/**
 * One search value, parsed as TanStack's default parser would (JSON), except
 * that a bare number stays the text that was typed. No studio search param is
 * numeric, and some look like one: a hand-typed `?q=1E-5` is valid JSON
 * scientific notation, which the default parser turns into `0` before any
 * `validateSearch` sees it. Throwing leaves the raw string in place.
 */
export function parseSearchValue(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (typeof value === 'number') throw new Error('keep the typed text');
  return value;
}

/** The router's `parseSearch` (`parseSearchValue` per value); the default `stringifySearch` round-trips with it. */
export const parseStudioSearch = parseSearchWith(parseSearchValue);

export function createStudioRouter(history?: RouterHistory): ReturnType<typeof createRouter> {
  const router = createRouter({
    routeTree,
    parseSearch: parseStudioSearch,
    ...(history === undefined ? {} : { history }),
    defaultNotFoundComponent: () => (
      <NotFoundView message="That page does not exist." backTo="/cables" backLabel="Back to Designs" />
    ),
  });
  // first-run setup stands alone (`setup-mode.ts`): follow the location, including a redirect into it
  setSetupMode(router.state.location.pathname === '/setup');
  router.subscribe('onBeforeLoad', (event) => setSetupMode(event.toLocation.pathname === '/setup'));
  return router as unknown as ReturnType<typeof createRouter>;
}

/** the singleton the real app boots with; tests build their own with a memory history */
export const router = createStudioRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export type StudioRouter = AnyRouter;
