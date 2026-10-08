// @vitest-environment jsdom
/**
 * The studio shell — the host half of the lifecycle, now driven by the
 * router instead of the removed `<select>` picker.
 *
 * `App.tsx` owns three things the editor deliberately does not: which design
 * is open, the per-design unsaved buffers, and the reaction to every
 * `CatalogChange`. All of that lived in `App.tsx` itself before the router;
 * it now lives in `studio-context.tsx`, reached from route components. This
 * suite drives it exactly as a person would — clicking the cables list, the
 * breadcrumb, the view switch — and reads back through the same stub-editor
 * seam the pre-router version used.
 *
 * The transport is real: `fetch` is replaced by a call straight into
 * `handleWorkbenchRequest`, exactly as `persistence.server.test.ts` does, so
 * the shell is driven by the same refusals and the same payloads the dev
 * server would send it. Routing itself (deep links, `view`, unknown ids, back
 * and forward) is covered in `routing.dom.test.tsx`; this file is the
 * lifecycle wiring underneath it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeConnectors, withPcbaPads } from '@wirehub/model';
import type { CableDesign, Db, MechanicalDefinition, PcbaDefinition, PcbaPadTable } from '@wirehub/model';
import type { PersistenceAdapter } from '@wirehub/editor-react';
import { QueryClient } from '@tanstack/react-query';
import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { clearOfflineCache } from '../src/offline-cache.browser.ts';

/**
 * A fresh cache per mount, exactly as `<App>`'s own lazy `useState` gives it —
 * but with retries off. The library's default (retry a failed query 3 times
 * with exponential backoff, up to 30s total) is the right call for a real
 * page against a real, sometimes-flaky network; here `fetch` is a direct,
 * synchronous-under-the-hood call into `handleWorkbenchRequest`; a query that
 * fails here is a real bug this suite should surface at once, not something
 * to paper over with up to 30s of silent retries that would masquerade as a
 * hang under a loaded CI box.
 */
function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

/** What the stub editor saw, shared with the mock factory. */
const seen = vi.hoisted(() => ({
  mounts: 0,
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@wirehub/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/editor-react')>();
  const react = await import('react');
  return {
    ...actual,
    CableEditor(props: Record<string, unknown>) {
      seen.props = props;
      react.useEffect(() => {
        seen.mounts += 1;
      }, []);
      const design = props['design'] as CableDesign;
      return react.createElement(
        'div',
        { 'data-testid': 'editor' },
        react.createElement('span', { 'data-testid': 'open-id' }, design.id),
        react.createElement('span', { 'data-testid': 'open-label' }, design.label),
        react.createElement('span', { 'data-testid': 'mounts' }, String(seen.mounts)),
      );
    },
  };
});

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

/**
 * The catalog, read straight off disk.
 *
 * `@wirehub/catalog` resolves its data directory from `import.meta.url`,
 * which under a browser-like test environment is a dev-server URL and not a
 * file path — the same reason `editor-react/test/fixture.ts` exists. These are
 * the same committed bytes either way.
 */
const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');

function read<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(DATA, ...parts), 'utf8')) as T;
}

function loadDbFromDisk(): Db {
  return createCatalog(fsCatalogSource(DATA, 'the catalog')).loadDb();
}

const loadDesign = (id: string): CableDesign => read<CableDesign>('designs', `${id}.json`);

const IDS = ['de9-terminal-board', 'dc-led-lead'];

const db: Db = loadDbFromDisk();
const realFetch = globalThis.fetch;
let files: Map<string, string>;
/** set to make every request fail the way a dead dev server does */
let offline = false;
/** set to make one design's GET answer 503 (a blip), the rest of the API up */
let failDesignGet: string | undefined;

function serve(): void {
  const store: DesignStore = {
    list: () =>
      [...files.keys()].sort().map((id) => ({
        id,
        label: (JSON.parse(files.get(id) as string) as CableDesign).label,
      })),
    has: (id) => files.has(id),
    read: (id) => {
      const text = files.get(id);
      return text === undefined ? undefined : (JSON.parse(text) as CableDesign);
    },
    write: (id, design) => {
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
  const deps: WorkbenchDeps = { designs: store, loadDb: () => db };

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (offline) throw new TypeError('Failed to fetch');
    if (failDesignGet !== undefined && String(input) === `/api/designs/${failDesignGet}` && (init?.method ?? 'GET') === 'GET') {
      return new Response('{"error":"blip"}', { status: 503, headers: { 'content-type': 'application/json' } });
    }
    const requestHeaders = new Headers(init?.headers);
    const ifMatch = requestHeaders.get('if-match');
    const response = await handleWorkbenchRequest(
      {
        method: init?.method ?? 'GET',
        path: String(input),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
        ...(ifMatch === null ? {} : { headers: { 'if-match': ifMatch } }),
      },
      deps,
    );
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
}

/** Two real designs is enough to switch between and to delete one of. */
function seed(): void {
  files = new Map(IDS.map((id) => [id, formatDesignJson(loadDesign(id))]));
}

beforeEach(() => {
  clearOfflineCache();
  seen.mounts = 0;
  seen.props = undefined;
  offline = false;
  failDesignGet = undefined;
  seed();
  serve();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const openId = (): string => screen.getByTestId('open-id').textContent ?? '';

/** The callback the real editor would call, as the shell handed it down. */
function editorProp<T>(name: string): T {
  return seen.props?.[name] as T;
}

function backToCables(): void {
  const breadcrumb = screen.getByRole('navigation', { name: 'breadcrumb' });
  fireEvent.click(within(breadcrumb).getByRole('link', { name: 'Designs' }));
}

function buildRouter(initialPath: string): ReturnType<typeof createStudioRouter> {
  return createStudioRouter(createMemoryHistory({ initialEntries: [initialPath] }));
}

/** cables-list rows, excluding the rail's plain `/cables` link and the New hub strip's */
function cableLinks(): HTMLAnchorElement[] {
  return screen
    .getAllByRole('link')
    .filter((link): link is HTMLAnchorElement => link instanceof HTMLAnchorElement)
    .filter((link) => link.closest('[data-testid="new-hub-strip"]') === null)
    .filter((link) => /^\/cables\/[^/]+$/.test(link.getAttribute('href') ?? ''));
}

async function readyOnList(): Promise<ReturnType<typeof createStudioRouter>> {
  const testRouter = buildRouter('/cables');
  render(<App router={testRouter} queryClient={testQueryClient()} />);
  await waitFor(() => expect(cableLinks().length).toBe(2));
  return testRouter;
}

async function readyOnCable(id: string): Promise<ReturnType<typeof createStudioRouter>> {
  const testRouter = buildRouter(`/cables/${id}`);
  render(<App router={testRouter} queryClient={testQueryClient()} />);
  await waitFor(() => expect(openId()).toBe(id));
  return testRouter;
}

describe('the cables list', () => {
  it('shows the full working assembly labels instead of only their connector source names', async () => {
    await readyOnList();
    for (const id of IDS) {
      const row = cableLinks().find((link) => link.getAttribute('href') === `/cables/${id}`)!;
      expect(row.textContent).toContain(loadDesign(id).label);
    }
    expect(screen.getByText('DESIGN')).toBeTruthy();
  });

  it('keeps assembly labels visible in the phone cards too', async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ matches: true, media, addEventListener() {}, removeEventListener() {} }) });
    try {
      await readyOnList();
      for (const id of IDS) {
        const row = cableLinks().find((link) => link.getAttribute('href') === `/cables/${id}`)!;
        expect(row.textContent).toContain(loadDesign(id).label);
      }
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
    }
  });

  it('opens a cable when its row is clicked', async () => {
    await readyOnList();
    fireEvent.click(cableLinks()[0] as HTMLAnchorElement);
    await waitFor(() => expect(openId()).not.toBe(''));
    expect(files.has(openId())).toBe(true);
  });
});

describe('switching cables', () => {
  it('opens the other one via the breadcrumb back to the list', async () => {
    const first = IDS[0] as string;
    const other = IDS[1] as string;
    await readyOnCable(first);

    backToCables();
    await waitFor(() => expect(cableLinks().length).toBe(2));
    const otherLink = cableLinks().find((link) => link.getAttribute('href') === `/cables/${other}`);
    fireEvent.click(otherLink as HTMLAnchorElement);

    await waitFor(() => expect(openId()).toBe(other));
    expect(screen.getByTestId('open-label').textContent).toBe(loadDesign(other).label);
  });
});


describe('the unsaved buffers', () => {
  it('marks the design with a dot, and keeps the edit across a trip away and back', async () => {
    const first = IDS[0] as string;
    const other = IDS[1] as string;
    await readyOnCable(first);

    const edited = { ...(editorProp<CableDesign>('design') as CableDesign), label: 'edited here' };
    editorProp<(design: CableDesign) => void>('onDesignChange')(edited);

    backToCables();
    await waitFor(() => expect(cableLinks().length).toBe(2));
    const dirtyRow = cableLinks().find((link) => link.getAttribute('href') === `/cables/${first}`);
    expect(dirtyRow?.querySelector('[title="Unsaved changes"]')).not.toBeNull();

    const otherLink = cableLinks().find((link) => link.getAttribute('href') === `/cables/${other}`);
    fireEvent.click(otherLink as HTMLAnchorElement);
    await waitFor(() => expect(openId()).toBe(other));

    backToCables();
    await waitFor(() => expect(cableLinks().length).toBe(2));
    const backToFirst = cableLinks().find((link) => link.getAttribute('href') === `/cables/${first}`);
    fireEvent.click(backToFirst as HTMLAnchorElement);
    await waitFor(() => expect(screen.getByTestId('open-label').textContent).toBe('edited here'));
  });

  /**
   * `readyOnCable` mounts the whole shell (router + Query + the stub editor)
   * in jsdom, twice-over risk for this file: it, and every other `waitFor` in
   * it, share vitest's default 5s *per-test* budget with the mount itself.
   * Reproduced this exact test's failure mode (`Error: Test timed out in
   * 5000ms`, not a wrong-value assertion — the retry-free `testQueryClient`
   * above rules out a mutation/refetch race) by running the whole
   * `apps/studio` suite three times over concurrently on this 4-core box: a
   * *different* test in this file (a heavier list mount) missed the 5s
   * budget at ~5.1s. Every test here does the same `readyOnCable` mount, so
   * the same margin problem reaches this one under worse — but plausible —
   * contention ("flaky … under full parallel load").
   * 15s leaves headroom without hiding a real hang.
   */
  it('a save clears the buffer without remounting the editor', async () => {
    const first = IDS[0] as string;
    await readyOnCable(first);
    const mountsBefore = seen.mounts;

    const edited = { ...(editorProp<CableDesign>('design') as CableDesign), label: 'saved label' };
    editorProp<(design: CableDesign) => void>('onDesignChange')(edited);

    // what DesignActions reports after a successful write
    editorProp<(change: unknown) => void>('onCatalogChange')({ kind: 'saved', design: edited });

    await waitFor(() => expect((editorProp<CableDesign>('savedDesign') as CableDesign).label).toBe('saved label'));
    // the undo history of the work just saved has to survive
    expect(seen.mounts).toBe(mountsBefore);
  }, 15_000);
});

describe('the catalog changes', () => {
  it('a rename reopens the design under its new id', async () => {
    const from = IDS[0] as string;
    await readyOnCable(from);
    const renamed: CableDesign = {
      ...loadDesign(from),
      id: 'renamed-cable',
      label: 'Renamed cable',
    };
    files.delete(from);
    files.set(renamed.id, formatDesignJson(renamed));

    editorProp<(change: unknown) => void>('onCatalogChange')({
      kind: 'renamed',
      design: renamed,
      from,
    });

    await waitFor(() => expect(openId()).toBe('renamed-cable'));
  });

  it('a delete opens something else rather than leaving an empty screen', async () => {
    const gone = IDS[0] as string;
    await readyOnCable(gone);
    files.delete(gone);

    editorProp<(change: unknown) => void>('onCatalogChange')({ kind: 'deleted', id: gone });

    await waitFor(() => expect(openId()).not.toBe(gone));
    expect(openId()).not.toBe('');
    expect(files.has(openId())).toBe(true);
  });

  it('a new design is opened as soon as it exists', async () => {
    const first = IDS[0] as string;
    await readyOnCable(first);
    const created: CableDesign = {
      ...loadDesign('de9-terminal-board'),
      id: 'fresh-cable',
      label: 'Fresh cable',
    };
    files.set(created.id, formatDesignJson(created));

    editorProp<(change: unknown) => void>('onCatalogChange')({ kind: 'created', design: created });
    await waitFor(() => expect(openId()).toBe('fresh-cable'));
  });
});

/** Visit the list once with the workbench up, so this browser has a last-fetched copy. */
async function primeOfflineCopy(path = '/cables'): Promise<void> {
  render(<App router={buildRouter(path)} queryClient={testQueryClient()} />);
  if (path === '/cables') await waitFor(() => expect(cableLinks().length).toBe(2));
  else await waitFor(() => expect(openId()).toBe(path.slice('/cables/'.length)));
  cleanup();
}

describe('when the workbench is not there', () => {
  it('says so once, compactly — no banner paragraph — and still draws the designs this browser last fetched', async () => {
    await primeOfflineCopy();
    offline = true;
    render(<App router={buildRouter('/cables')} queryClient={testQueryClient()} />);

    // the compact indicator, not a paragraph: short text, the detail in a title
    const indicator = await waitFor(() => {
      const found = screen.getAllByRole('status').find((el) => el.textContent === 'Offline');
      if (found === undefined) throw new Error('no Offline indicator yet');
      return found;
    });
    expect(indicator.getAttribute('title')).toContain('could not reach the server');
    // the list says what it is showing: the last-fetched copy, read only
    expect((await screen.findByTestId('offline-banner')).textContent).toMatch(/offline copy from .* — read only/);

    // and a toast, once, for the same transition
    await screen.findByText('Server unreachable');

    // the last copy is the fallback (the bundle carries no catalog data,
    //): the two designs the workbench last listed
    await waitFor(() => expect(cableLinks().length).toBe(2));
  });

  it('with no copy fetched yet, the list is empty rather than stale', async () => {
    offline = true;
    render(<App router={buildRouter('/cables')} queryClient={testQueryClient()} />);
    expect((await screen.findByTestId('offline-banner')).textContent).toMatch(/offline copy from .* — read only/);
    expect(cableLinks()).toHaveLength(0);
  });

  it('clears the indicator once the workbench answers again', async () => {
    await primeOfflineCopy();
    offline = true;
    const testRouter = buildRouter('/cables');
    render(<App router={testRouter} queryClient={testQueryClient()} />);
    await screen.findAllByRole('status');

    offline = false;
    await waitFor(() => expect(cableLinks().length).toBe(2));
    const seeded = cableLinks().find((link) => link.getAttribute('href') === `/cables/${IDS[1]}`);
    fireEvent.click(seeded as HTMLAnchorElement);
    await waitFor(() => expect(openId()).toBe(IDS[1]));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a failed design load never becomes an editable copy: read-only under a banner, no save, then Retry (review Bug 1)', async () => {
    // this browser fetched the design once; since then the server has a newer
    // label, and now one GET blips
    await primeOfflineCopy(`/cables/${IDS[0]}`);
    const newer = { ...loadDesign(IDS[0] as string), label: '[SERVER EDIT]' };
    files.set(IDS[0] as string, formatDesignJson(newer));
    failDesignGet = IDS[0];
    render(<App router={buildRouter(`/cables/${IDS[0]}`)} queryClient={testQueryClient()} />);

    const banner = await screen.findByTestId('offline-banner');
    expect(banner.textContent).toMatch(/Offline copy from .* — read only/);
    await waitFor(() => expect(openId()).toBe(IDS[0]));
    // the last-fetched copy, handed down read-only and with nothing to save through
    expect(editorProp<boolean>('readOnly')).toBe(true);
    expect(editorProp<unknown>('persistence')).toBeUndefined();
    expect(editorProp<unknown>('drawings')).toBeUndefined();

    // the workbench answers again: Retry opens the server's copy, editable
    failDesignGet = undefined;
    fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('open-label').textContent).toBe('[SERVER EDIT]'));
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    expect(editorProp<unknown>('persistence')).toBeDefined();
    expect(editorProp<boolean | undefined>('readOnly')).toBeUndefined();
  });
});

/**
 * The TanStack Query data layer: the wrapped
 * `persistence` adapter handed to the editor is the actual mutation, not a
 * stand-in — calling it here exercises the same cache invalidation and
 * toasts a real `DesignActions` save/duplicate/rename/delete would trigger.
 * `onCatalogChange` is still invoked by hand afterwards, exactly as
 * `DesignActions.tsx`'s `run()` calls it once the adapter's outcome comes
 * back `ok`.
 */
describe('the query-backed persistence adapter', () => {
  it('a save invalidates the designs list and toasts, and the dot clears', async () => {
    const first = IDS[0] as string;
    await readyOnCable(first);

    const edited = { ...(editorProp<CableDesign>('design') as CableDesign), label: 'saved via mutation' };
    editorProp<(design: CableDesign) => void>('onDesignChange')(edited);

    const persistence = editorProp<PersistenceAdapter>('persistence');
    const outcome = await persistence.save(edited);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      editorProp<(change: unknown) => void>('onCatalogChange')({ kind: 'saved', design: outcome.value });
    }

    await screen.findByText('Saved saved via mutation');

    backToCables();
    // the list query was invalidated by the save, not left to a stale copy
    await waitFor(() => expect(screen.getByText('saved via mutation')).toBeDefined());
    const row = cableLinks().find((link) => link.getAttribute('href') === `/cables/${first}`);
    expect(row?.querySelector('[title="Unsaved changes"]')).toBeNull();
  });

  it('a rejected save toasts the first issue and leaves the draft dirty', async () => {
    const first = IDS[0] as string;
    await readyOnCable(first);

    const draft = editorProp<CableDesign>('design') as CableDesign;
    const broken: CableDesign = structuredClone(draft);
    broken.instances.pcbas.push({ id: 'bad-u9', def: 'no-such-board' });
    editorProp<(design: CableDesign) => void>('onDesignChange')(broken);

    const persistence = editorProp<PersistenceAdapter>('persistence');
    const outcome = await persistence.save(broken);
    expect(outcome.ok).toBe(false);

    await screen.findByText('Save rejected');
    await screen.findByText(/unknown PCBA definition/);

    // nothing was written, and the draft is still there to fix
    expect(files.get(first)).not.toContain('bad-u9');
    backToCables();
    await waitFor(() => expect(cableLinks().length).toBe(2));
    const row = cableLinks().find((link) => link.getAttribute('href') === `/cables/${first}`);
    expect(row?.querySelector('[title="Unsaved changes"]')).not.toBeNull();
  });
});

describe('opening a cable while the workbench is down', () => {
  it('falls back to the last-fetched copy instead of a not-found screen', async () => {
    const id = IDS[1] as string;
    await primeOfflineCopy(`/cables/${id}`);
    offline = true;
    render(<App router={buildRouter(`/cables/${id}`)} queryClient={testQueryClient()} />);
    await waitFor(() => expect(openId()).toBe(id));
    expect(screen.queryByText(/No design/)).toBeNull();
    expect((await screen.findByTestId('offline-banner')).textContent).toMatch(/Offline copy from .* — read only/);
    expect(editorProp<boolean>('readOnly')).toBe(true);
  });

  it('says it could not load a cable this browser never fetched', async () => {
    offline = true;
    render(<App router={buildRouter(`/cables/${IDS[0]}`)} queryClient={testQueryClient()} />);
    expect((await screen.findByTestId('offline-banner')).textContent).toMatch(/Could not load/);
  });
});

/**
 * The stale-write guard's toast ( absorbing):
 * opening a cable loads it — the real adapter, via
 * the real query — which remembers the version answered on `GET`. When that
 * version has moved on disk by the time Save runs, the save is refused 409
 * and the studio has to say so without losing the work in progress.
 */
describe('the stale-write guard', () => {
  it('toasts "Changed on disk" and keeps the draft when someone else saved first', async () => {
    const first = IDS[0] as string;
    await readyOnCable(first);

    const draftBeforeSave = { ...(editorProp<CableDesign>('design') as CableDesign), label: 'my in-progress edit' };
    editorProp<(design: CableDesign) => void>('onDesignChange')(draftBeforeSave);

    // another tab (or the other owner) saves the same design first — a plain
    // file write, bypassing this adapter, exactly like a concurrent tab would
    files.set(first, formatDesignJson({ ...loadDesign(first), label: 'saved by someone else' }));

    const persistence = editorProp<PersistenceAdapter>('persistence');
    const outcome = await persistence.save(draftBeforeSave);
    expect(outcome.ok).toBe(false);

    await screen.findByText('Changed on disk');
    await screen.findByText(/reload to see the new version/);

    // nothing was written over the other save
    expect((JSON.parse(files.get(first) as string) as CableDesign).label).toBe('saved by someone else');

    // the draft is exactly as it was — this failure never touched it
    expect(editorProp<CableDesign>('design')?.label).toBe('my in-progress edit');
    expect(openId()).toBe(first); // still on the same open cable

    // the stored baseline was invalidated by the failure, so the next GET
    // (a manual reload, in the real app) picks up the new version rather than
    // silently keeping the stale one cached
    backToCables();
    await waitFor(() => expect(cableLinks().length).toBe(2));
    await waitFor(() => expect(screen.getByText('saved by someone else')).toBeDefined());
  });
});
