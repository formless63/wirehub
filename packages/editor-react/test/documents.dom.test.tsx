// @vitest-environment jsdom
/**
 * The Documents pane and the Canvas/Documents switch, lightly — the derivation
 * itself is tested in `documents.test.ts`, so this only defends the wiring:
 * that the pane derives the *draft* design, that it does so once the typing
 * stops rather than per keystroke, that the srcdoc it hands the iframe is the
 * document, and that opening the tab is what starts any of it.
 */

import './reactflow-jsdom.ts';

import type { CableDesign, Db, Issue } from '@wirehub/model';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import {
  DocumentsPane,
  keepFramePlace,
  printDocumentFrame,
  type DocumentsProps,
} from '../src/panels/Documents.tsx';
import type { DocumentKind, DrawingAdapter } from '../src/documents.ts';
import type { DrawingMeta } from '@wirehub/docs';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const design: CableDesign = loadDesignFromDisk('de9-terminal-board');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Derive = NonNullable<DocumentsProps['render']>;

/** A derivation stand-in, so the debounce can be watched without a build sheet. */
function spyRender(): ReturnType<typeof vi.fn<Derive>> {
  return vi.fn<Derive>((kind: DocumentKind) => ({ html: `<!doctype html><p>${kind}</p>` }));
}

describe('<DocumentsPane>', () => {
  it('derives nothing until the edits stop, then derives once', () => {
    vi.useFakeTimers();
    const derive = spyRender();
    const { rerender } = render(
      <DocumentsPane design={design} db={db} saved={design} debounceMs={200} render={derive} />,
    );

    expect(derive).not.toHaveBeenCalled();
    expect(screen.getByText('updating…')).toBeDefined();

    // two quick edits inside the window collapse into one derivation
    act(() => void vi.advanceTimersByTime(120));
    rerender(
      <DocumentsPane
        design={{ ...design, label: 'first edit' }}
        db={db}
        saved={design}
        debounceMs={200}
        render={derive}
      />,
    );
    act(() => void vi.advanceTimersByTime(120));
    rerender(
      <DocumentsPane
        design={{ ...design, label: 'second edit' }}
        db={db}
        saved={design}
        debounceMs={200}
        render={derive}
      />,
    );
    expect(derive).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(200));
    expect(derive).toHaveBeenCalledTimes(1);
    // and it derived from the draft in the editor, not the design on file
    expect(derive.mock.calls[0]?.[1]).toMatchObject({ label: 'second edit' });
    expect(screen.queryByText('updating…')).toBeNull();
  });

  it('puts the document in the frame and prints that frame, per sub-view', () => {
    vi.useFakeTimers();
    const derive = spyRender();
    const { container } = render(
      <DocumentsPane design={design} db={db} saved={design} debounceMs={10} render={derive} />,
    );

    // nothing to print before the first document exists
    const print = screen.getByRole('button', { name: /Print/ }) as HTMLButtonElement;
    expect(print.disabled).toBe(true);

    act(() => void vi.advanceTimersByTime(10));
    expect(derive.mock.calls[0]?.[0]).toBe('build-sheet');
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<p>build-sheet</p>');
    expect((screen.getByRole('button', { name: /Print/ }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Continuity spec' }));
    act(() => void vi.advanceTimersByTime(10));
    expect(derive.mock.calls[1]?.[0]).toBe('test-spec');
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<p>test-spec</p>');
  });

  it('hands the print job to the document’s own window, not the editor’s', () => {
    const print = vi.fn();
    const focus = vi.fn();
    const frame = { contentWindow: { print, focus } } as unknown as HTMLIFrameElement;
    expect(printDocumentFrame(frame)).toBe(true);
    expect(print).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);

    // a frame that is not there yet, or a browser that will not print, says so
    expect(printDocumentFrame(null)).toBe(false);
    expect(printDocumentFrame({ contentWindow: {} } as unknown as HTMLIFrameElement)).toBe(false);
  });

  it('labels the documents draft or saved in the user’s words', () => {
    vi.useFakeTimers();
    const derive = spyRender();
    const { rerender } = render(
      <DocumentsPane design={design} db={db} saved={design} debounceMs={10} render={derive} />,
    );
    expect(screen.getByText('As saved')).toBeDefined();

    rerender(
      <DocumentsPane
        design={{ ...design, label: 'edited' }}
        db={db}
        saved={design}
        debounceMs={10}
        render={derive}
      />,
    );
    // the explanation is the chip's tooltip — no narrative paragraph on the page
    expect(screen.getByText('Draft — unsaved changes').closest('[title]')?.getAttribute('title')).toMatch(/not saved yet/);
    expect(screen.queryByText(/not saved yet/)).toBeNull();
  });

  it('says what to do next when there is nothing to document', () => {
    const derive = spyRender();
    const blank: CableDesign = {
      ...design,
      instances: { connectors: [], segments: [], components: [], pcbas: [] },
      joints: [],
    };
    render(<DocumentsPane design={blank} db={db} saved={blank} render={derive} />);
    expect(screen.getByText(/Nothing to document yet/)).toBeDefined();
    expect(derive).not.toHaveBeenCalled();
  });

  it('renders the documents anyway when the design has errors, under a warning', () => {
    vi.useFakeTimers();
    const derive = spyRender();
    const broken = {
      ...design,
      instances: { ...design.instances, connectors: [{ id: 'jX', def: 'invented-connector' }] },
    } as CableDesign;
    const { container } = render(
      <DocumentsPane design={broken} db={db} saved={broken} debounceMs={10} render={derive} />,
    );
    act(() => void vi.advanceTimersByTime(10));

    expect(screen.getByText(/must be fixed/)).toBeDefined();
    // the validator's own words, not an invented sentence
    expect(screen.getByText(/unknown connector definition/)).toBeDefined();
    // and the document is still there to work the fix out from
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('says the document could not be built rather than dead-ending', () => {
    vi.useFakeTimers();
    render(
      <DocumentsPane
        design={design}
        db={db}
        saved={design}
        debounceMs={10}
        render={() => ({ error: 'no such wire definition' })}
      />,
    );
    act(() => void vi.advanceTimersByTime(10));
    expect(screen.getByText(/could not be built — no such wire definition/)).toBeDefined();
    expect(screen.getByText(/other two documents may still work/)).toBeDefined();
  });
});

describe('<CableEditor> — Canvas | Documents', () => {
  it('opens on the canvas and derives no document until the tab is asked for', async () => {
    // lazily by construction: on the canvas view the pane is not mounted (its
    // code is not even loaded — a lazy chunk), so nothing schedules a
    // derivation until the user asks for documents
    const { container } = render(<CableEditor design={design} db={db} />);

    expect(container.querySelector('.cs-canvas')).not.toBeNull();
    expect(container.querySelector('.cs-documents')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    await screen.findByRole('button', { name: 'Build sheet' });
    expect(container.querySelector('.cs-documents')).not.toBeNull();
    // documents get the whole content area — the canvas and its docks are gone
    expect(container.querySelector('.cs-canvas')).toBeNull();
    expect(container.querySelector('.cs-palette')).toBeNull();
    expect(screen.getByRole('button', { name: 'Build sheet' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Canvas' }));
    expect(container.querySelector('.cs-canvas')).not.toBeNull();
    expect(container.querySelector('.cs-documents')).toBeNull();
  });

  it('the JSON tab hosts the design export/import — the old bottom dock’s job, in host chrome without one ()', () => {
    const { container } = render(<CableEditor design={design} db={db} chrome="host" />);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));

    // no bottom dock exists in host chrome to reach it from — this tab is it
    expect(container.querySelector('.cs-dock')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    const textarea = container.querySelector('.cs-json textarea') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toContain(design.id);
    // nothing to print from this tab
    expect((screen.getByRole('button', { name: /Print/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('copies the BOM and the continuity spec as markdown; the other sheets have no Copy', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      render(<DocumentsPane design={design} db={db} saved={design} debounceMs={10} />);
      expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'BOM' }));
      await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Copy/ })));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0]?.[0]).toMatch(/^# Bill of materials — /);
      expect(screen.getByRole('status').textContent).toBe('copied');

      fireEvent.click(screen.getByRole('button', { name: 'Continuity spec' }));
      await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Copy/ })));
      expect(writeText.mock.calls[1]?.[0]).toMatch(/^# Continuity & test spec — /);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('the Export menu downloads the production, tester and label files from the design shown', async () => {
    const blobs: Blob[] = [];
    const names: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', { value: (blob: Blob) => (blobs.push(blob), 'blob:x'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    try {
      render(<DocumentsPane design={design} db={db} saved={design} debounceMs={10} />);
      const menu = screen.getByRole('combobox', { name: 'Export' }) as HTMLSelectElement;
      const ids = Array.from(menu.querySelectorAll('option')).map((o) => o.value).filter((v) => v !== '');
      expect(ids).toEqual(['bom.csv', 'wire-list.csv', 'cut-list.csv', 'production.xlsx', 'continuity.csv', 'continuity.json', 'labels.csv', 'labels.svg']);
      for (const id of ids) fireEvent.change(menu, { target: { value: id } });
      expect(names).toEqual(ids.map((id) => `${design.id}-${id.split('.')[0]}.${id.split('.')[1]}`));
      expect(await blobs[0]!.text()).toMatch(/^section,part_number,description,quantity,unit/);
      expect(blobs[0]!.type).toContain('text/csv');
    } finally {
      click.mockRestore();
    }
  });

  it('the continuity spec takes test parameters, saved in the sidecar', async () => {
    vi.useFakeTimers();
    const derive = spyRender();
    const save = vi.fn(async (_id: string, meta: DrawingMeta) => ({ ok: true as const, value: meta }));
    const drawings: DrawingAdapter = {
      // the server's organisation defaults ride on the sidecar it answers
      load: async () => ({ ok: true, value: { meta: {}, testDefaults: { isolationVolts: 250 } } }),
      save,
      savePhoto: async () => ({ ok: true, value: {} }),
    };
    render(<DocumentsPane design={design} db={db} saved={design} debounceMs={10} render={derive} drawings={drawings} />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(screen.queryByRole('group', { name: 'Test parameters' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Continuity spec' }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    const volts = screen.getByRole('spinbutton', { name: 'Isolation test voltage' }) as HTMLInputElement;
    expect(volts.placeholder).toBe('250');
    fireEvent.change(volts, { target: { value: '500' } });
    act(() => void vi.advanceTimersByTime(10));
    const last = derive.mock.calls[derive.mock.calls.length - 1]!;
    expect(last[0]).toBe('test-spec');
    expect(last[3]).toMatchObject({ testParameters: { isolationVolts: 500 }, testDefaults: { isolationVolts: 250 } });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(save).toHaveBeenCalledWith(design.id, { test: { isolationVolts: 500 } });
  });

  it('sheet options shape the sheets and save into the drawing sidecar', async () => {
    vi.useFakeTimers();
    const derive = spyRender();
    const save = vi.fn(async (_id: string, meta: DrawingMeta) => ({ ok: true as const, value: meta }));
    const drawings: DrawingAdapter = {
      load: async () => ({ ok: true, value: { meta: { partNumber: 'CBL-00101-3X' } } }),
      save,
      savePhoto: async () => ({ ok: true, value: {} }),
    };
    render(<DocumentsPane design={design} db={db} saved={design} debounceMs={10} render={derive} drawings={drawings} />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));

    const number = screen.getByRole('textbox', { name: 'Document number' }) as HTMLInputElement;
    expect(number.placeholder).toBe('CBL-00101-3X');
    fireEvent.change(number, { target: { value: 'DOC-9' } });
    fireEvent.click(screen.getByRole('checkbox'));
    act(() => void vi.advanceTimersByTime(10));
    const last = derive.mock.calls[derive.mock.calls.length - 1]!;
    expect(last[3]).toMatchObject({ document: { number: 'DOC-9' }, generatedAt: expect.stringMatching(/^\d{4}\.\d{2}\.\d{2}$/) });

    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(save).toHaveBeenCalledWith(design.id, { partNumber: 'CBL-00101-3X', sheet: { number: 'DOC-9', stampDate: true } });

    // the drawing sheet has its own title block; no options row there
    fireEvent.click(screen.getByRole('button', { name: 'Drawing sheet' }));
    expect(screen.queryByRole('group', { name: 'Sheet options' })).toBeNull();
  });

  const staleWrite: Issue = { code: 'stale-write', severity: 'error', message: 'changed on disk', where: design.id };

  it('a version save that rewrote the drawing behind this form does not lose the edit — it merges and retries', async () => {
    vi.useFakeTimers();
    const derive = spyRender();
    let saveCalls = 0;
    const save = vi.fn(async (_id: string, meta: DrawingMeta) => {
      saveCalls += 1;
      // the first save lands on the pre-version-save copy this form loaded —
      // refused, exactly like `server/etag.ts`'s stale-write guard
      if (saveCalls === 1) {
        return { ok: false as const, message: "'de9-terminal-board' changed on disk since you opened it.", status: 409, issues: [staleWrite] };
      }
      return { ok: true as const, value: meta };
    });
    let loadCalls = 0;
    const load = vi.fn(async () => {
      loadCalls += 1;
      // the re-fetch after the stale write finds what a version save left:
      // `revision` set, the field this form never touched
      if (loadCalls === 1) return { ok: true as const, value: { meta: { partNumber: 'CBL-00101-3X' } } };
      return { ok: true as const, value: { meta: { partNumber: 'CBL-00101-3X', revision: '0' } } };
    });
    const drawings: DrawingAdapter = { load, save, savePhoto: async () => ({ ok: true, value: {} }) };
    const { container } = render(
      <DocumentsPane design={design} db={db} saved={design} debounceMs={10} render={derive} drawings={drawings} />,
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));

    const number = screen.getByRole('textbox', { name: 'Document number' }) as HTMLInputElement;
    fireEvent.change(number, { target: { value: 'DOC-9' } });
    act(() => void vi.advanceTimersByTime(10));

    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save' })));

    // the field this form typed into is kept; the field the version save
    // touched is picked up — no person had to do anything
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual([design.id, { partNumber: 'CBL-00101-3X', sheet: { number: 'DOC-9' }, revision: '0' }]);
    expect(container.querySelector('.cs-drawing-conflict')).toBeNull();
    expect(screen.getByText(/merged with a change made on disk/)).toBeDefined();
  });

  it('a field changed both here and on disk stops for a person instead of guessing, and Retry save applies the choice', async () => {
    vi.useFakeTimers();
    const derive = spyRender();
    let saveCalls = 0;
    const save = vi.fn(async (_id: string, meta: DrawingMeta) => {
      saveCalls += 1;
      if (saveCalls === 1) return { ok: false as const, message: 'changed on disk', status: 409, issues: [staleWrite] };
      return { ok: true as const, value: meta };
    });
    let loadCalls = 0;
    const load = vi.fn(async () => {
      loadCalls += 1;
      if (loadCalls === 1) return { ok: true as const, value: { meta: { partNumber: 'CBL-00101-3X' } } };
      // someone else set the same document number this form was just edited to something else
      return { ok: true as const, value: { meta: { partNumber: 'CBL-00101-3X', sheet: { number: 'DOC-SERVER' } } } };
    });
    const drawings: DrawingAdapter = { load, save, savePhoto: async () => ({ ok: true, value: {} }) };
    const { container } = render(
      <DocumentsPane design={design} db={db} saved={design} debounceMs={10} render={derive} drawings={drawings} />,
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));

    const number = screen.getByRole('textbox', { name: 'Document number' }) as HTMLInputElement;
    fireEvent.change(number, { target: { value: 'DOC-9' } });
    act(() => void vi.advanceTimersByTime(10));

    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save' })));

    // no silent retry when it genuinely conflicts — nothing was written
    expect(save).toHaveBeenCalledTimes(1);
    const banner = container.querySelector('.cs-drawing-conflict');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Sheet options');
    expect(banner?.textContent).toContain('DOC-9');
    expect(banner?.textContent).toContain('DOC-SERVER');

    // the draft is kept exactly as typed — Retry save applies it against the
    // now-current baseline in one click
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Retry save' })));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual([design.id, { partNumber: 'CBL-00101-3X', sheet: { number: 'DOC-9' } }]);
    expect(container.querySelector('.cs-drawing-conflict')).toBeNull();
  });

  it('"use the disk value" on a conflicting field adopts the server\'s copy and clears the banner', async () => {
    vi.useFakeTimers();
    const derive = spyRender();
    const save = vi.fn(async () => ({ ok: false as const, message: 'changed on disk', status: 409, issues: [staleWrite] }));
    let loadCalls = 0;
    const load = vi.fn(async () => {
      loadCalls += 1;
      if (loadCalls === 1) return { ok: true as const, value: { meta: { partNumber: 'CBL-00101-3X' } } };
      return { ok: true as const, value: { meta: { partNumber: 'CBL-00101-3X', sheet: { number: 'DOC-SERVER' } } } };
    });
    const drawings: DrawingAdapter = { load, save, savePhoto: async () => ({ ok: true, value: {} }) };
    const { container } = render(
      <DocumentsPane design={design} db={db} saved={design} debounceMs={10} render={derive} drawings={drawings} />,
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));

    fireEvent.change(screen.getByRole('textbox', { name: 'Document number' }), { target: { value: 'DOC-9' } });
    act(() => void vi.advanceTimersByTime(10));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(container.querySelector('.cs-drawing-conflict')).not.toBeNull();

    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'use the disk value' })));
    expect((screen.getByRole('textbox', { name: 'Document number' }) as HTMLInputElement).value).toBe('DOC-SERVER');
    expect(container.querySelector('.cs-drawing-conflict')).toBeNull();
  });
});

describe('keeping the reader\'s place', () => {
  it('scrolls a regenerated document back to where the reader was, per document', () => {
    const places = new Map<string, { x: number; y: number }>();
    const fake = () => {
      let onScroll: (() => void) | undefined;
      const view = {
        scrollX: 0,
        scrollY: 0,
        scrollTo: vi.fn((x: number, y: number) => {
          view.scrollX = x;
          view.scrollY = y;
        }),
        addEventListener: (_: string, fn: () => void) => void (onScroll = fn),
        scroll: (y: number) => {
          view.scrollY = y;
          onScroll?.();
        },
      };
      return view;
    };
    const first = fake();
    keepFramePlace(first as never, places, 'd|bom');
    expect(first.scrollTo).not.toHaveBeenCalled();
    first.scroll(640);
    const second = fake();
    keepFramePlace(second as never, places, 'd|bom');
    expect(second.scrollTo).toHaveBeenCalledWith(0, 640);
    const other = fake();
    keepFramePlace(other as never, places, 'd|build-sheet');
    expect(other.scrollTo).not.toHaveBeenCalled();
    keepFramePlace(null, places, 'd|bom');
  });
});
