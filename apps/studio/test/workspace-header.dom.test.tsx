// @vitest-environment jsdom
/**
 * The workspace header: the Save button and Ctrl+S,
 * the undo/redo icons' tooltips, a cable-menu action (Rename…), and a
 * rejected edit surfacing as a toast — all driven through
 * `shell/editor-chrome.tsx`'s bridge to `CableEditor`'s `chrome="host"` ref
 * and `onChromeStateChange`/`onEditRejected` callbacks.
 *
 * The real editor is stubbed, as every other shell dom test does
 * (`shell.dom.test.tsx`'s header explains why) — but as a `forwardRef` that
 * exposes a spy `EditorHandle`, since that ref is exactly what this suite is
 * testing the header calls into. The dialogs the real `CableEditor` would
 * open for `openLifecycle` are `DesignLifecycleDialogs`'s job and are covered
 * in `packages/editor-react/test/host-chrome.dom.test.tsx` instead — this
 * file only has to prove the header calls the right thing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeConnectors } from '@wirehub/model';
import type { CableDesign, Db, MechanicalDefinition, PcbaDefinition } from '@wirehub/model';
import type { EditorChromeState, EditorHandle } from '@wirehub/editor-react';
import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';

const handle: EditorHandle = {
  save: vi.fn(),
  revert: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  autoArrange: vi.fn(),
  fitView: vi.fn(),
  setTool: vi.fn(),
  showIssues: vi.fn(),
  openLifecycle: vi.fn(),
  openPicker: vi.fn(),
  findPin: vi.fn(),
};

const seen = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@wirehub/editor-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirehub/editor-react')>();
  const react = await import('react');
  const CableEditor = react.forwardRef(function StubCableEditor(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
    seen.props = props;
    // a stable deps array: `EditorChromeProvider` resets its state to
    // defaults on every `ref(null)`, and an unstable factory would detach
    // and reattach (calling `ref(null)` then `ref(handle)`) on every render
    react.useImperativeHandle(ref, () => handle, []);
    const design = props['design'] as CableDesign;
    return react.createElement(
      'div',
      { 'data-testid': 'editor' },
      react.createElement('span', { 'data-testid': 'open-id' }, design.id),
    );
  });
  return { ...actual, CableEditor };
});

const { App } = await import('../src/App.tsx');
const { createStudioRouter } = await import('../src/router.tsx');

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');

function read<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(DATA, ...parts), 'utf8')) as T;
}

function loadDbFromDisk(): Db {
  return createCatalog(fsCatalogSource(DATA, 'the catalog')).loadDb();
}

const loadDesign = (id: string): CableDesign => read<CableDesign>('designs', `${id}.json`);

const ID = 'de9-terminal-board';
const db: Db = loadDbFromDisk();
const realFetch = globalThis.fetch;
let files: Map<string, string>;

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
    const response = await handleWorkbenchRequest(
      {
        method: init?.method ?? 'GET',
        path: String(input),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      },
      deps,
    );
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  seen.props = undefined;
  vi.clearAllMocks();
  files = new Map([[ID, formatDesignJson(loadDesign(ID))]]);
  serve();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function editorProp<T>(name: string): T {
  return seen.props?.[name] as T;
}

/** Report a chrome state from the stubbed editor, as the real one would via `onChromeStateChange`. */
function reportState(patch: Partial<EditorChromeState>): void {
  const base: EditorChromeState = {
    dirty: false,
    saving: false,
    canUndo: false,
    undoLabel: undefined,
    canRedo: false,
    redoLabel: undefined,
    statusMessage: undefined,
    tool: 'select',
  };
  act(() => {
    editorProp<(state: EditorChromeState) => void>('onChromeStateChange')({ ...base, ...patch });
  });
}

async function readyOnCable(): Promise<void> {
  const testRouter = createStudioRouter(createMemoryHistory({ initialEntries: [`/cables/${ID}`] }));
  render(<App router={testRouter} />);
  await waitFor(() => expect(screen.getByTestId('open-id').textContent).toBe(ID));
  // the header only enables once the ref has landed — every test starts from there
  await waitFor(() => expect(editorProp<unknown>('onChromeStateChange')).toBeDefined());
}

describe('Save', () => {
  it('is disabled until the header hears the draft is dirty, then saves on click', async () => {
    await readyOnCable();
    const save = screen.getByRole('button', { name: /^Save/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    reportState({ dirty: true });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(save);
    expect(handle.save).toHaveBeenCalledTimes(1);
  });

  it('saves on Ctrl+S once the draft is dirty', async () => {
    await readyOnCable();
    reportState({ dirty: true });
    await waitFor(() => expect((screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(handle.save).toHaveBeenCalledTimes(1);
  });

  it('does nothing on Ctrl+S while clean', async () => {
    await readyOnCable();
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(handle.save).not.toHaveBeenCalled();
  });
});

describe('undo / redo', () => {
  it('carry the edit description and the shortcut in their tooltip', async () => {
    await readyOnCable();
    reportState({ canUndo: true, undoLabel: 'add connector rca-male as j2' });
    await waitFor(() =>
      expect(screen.getByTitle(/Undo: add connector rca-male as j2/)).toBeTruthy(),
    );
    const undo = screen.getByTitle(/Undo: add connector rca-male as j2/);
    expect(undo.getAttribute('title')).toContain('Ctrl Z');

    fireEvent.click(undo);
    expect(handle.undo).toHaveBeenCalledTimes(1);

    reportState({ canRedo: true, redoLabel: 'add connector rca-male as j2' });
    const redo = await screen.findByTitle(/Redo: add connector rca-male as j2/);
    expect(redo.getAttribute('title')).toContain('Ctrl Shift Z');
    fireEvent.click(redo);
    expect(handle.redo).toHaveBeenCalledTimes(1);
  });

  it('are disabled with a plain "nothing to …" tooltip when there is nothing to do', async () => {
    await readyOnCable();
    const undo = screen.getByTitle('Nothing to undo');
    const redo = screen.getByTitle('Nothing to redo');
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    expect((redo as HTMLButtonElement).disabled).toBe(true);
  });
});

// Radix's `DropdownMenu.Trigger` opens on `pointerdown` (mouse button 0),
// not `click` — see `@radix-ui/react-dropdown-menu`'s `DropdownMenuTrigger`.
// A menu *item*'s own click still fires `onSelect` normally once open.
function openMenu(name: string): void {
  fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false });
}

describe('the cable menu', () => {
  it('opens the rename dialog through the editor handle', async () => {
    await readyOnCable();
    openMenu('Cable menu');
    fireEvent.click(await screen.findByText('Rename…'));
    expect(handle.openLifecycle).toHaveBeenCalledWith('rename');
  });

  it("revert is disabled while the draft isn't dirty", async () => {
    await readyOnCable();
    openMenu('Cable menu');
    const revert = await screen.findByText('Revert');
    expect(revert.closest('[data-disabled]')).not.toBeNull();
  });
});

describe('a rejected edit', () => {
  it('shows as a toast, not an in-canvas alert', async () => {
    await readyOnCable();
    editorProp<(message: string) => void>('onEditRejected')(
      "joint rejected — 'j1.pin-1' and 'j2.pin-1' are already jointed",
    );
    await screen.findByText('Edit rejected');
    await screen.findByText(/already jointed/);
  });
});
