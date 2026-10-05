// @vitest-environment jsdom
/**
 * The Library, lightly.
 *
 * The mapping and the reducers are tested without a DOM in `library.test.ts`,
 * and the lifecycle without a DOM in `definitions.test.ts`; what is left here is
 * the wiring those two cannot see — that the tab exists, that a list is
 * searchable, that each editor puts the right controls on screen, that a
 * refusal from the host lands where the user is looking, and that the cutaway
 * is handed the definition the form currently describes.
 */

import './reactflow-jsdom.ts';

import type { CableDesign, Db, WireDefinition } from '@wirehub/model';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import { Library } from '../src/panels/Library.tsx';
import {
  Cutaway,
  WireStockEditor,
  type CrossSectionRenderer,
} from '../src/panels/WireStockEditor.tsx';
import { pcbaDraftOf, wireFormOf, type WireDraft } from '../src/library.ts';
import { copperPathGroups } from '../src/panels/PcbaEditor.tsx';
import type { ArtworkAdapter, ArtworkDetail, DepictionMeta } from '../src/artwork.ts';
import { diskDepictions, loadDbFromDisk, loadDepictionMetaFromDisk, loadDesignFromDisk } from './fixture.ts';
import { memoryDefinitions } from './memory-definitions.ts';

const db: Db = loadDbFromDisk();
const design: CableDesign = loadDesignFromDisk('de9-crossover');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function host(): ReturnType<typeof memoryDefinitions> {
  return memoryDefinitions(db, [design]);
}

const wireDraft = (id: string): WireDraft =>
  wireFormOf(db.wires.find((wire) => wire.id === id) as WireDefinition) as WireDraft;

/* ------------------------------------------------------------------ *
 * The view itself
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * One test per editor
 * ------------------------------------------------------------------ */




/* ------------------------------------------------------------------ *
 * The cutaway
 * ------------------------------------------------------------------ */

describe('the live cutaway', () => {
  it('is handed the definition the form currently describes', async () => {
    const wire = db.wires.find((candidate) => candidate.id === 'mini-coax') as WireDefinition;
    const draw = vi.fn<CrossSectionRenderer>(() => '<svg data-test="cutaway"/>');
    render(<Cutaway wire={wire} debounceMs={0} render={draw} />);
    await waitFor(() => expect(draw).toHaveBeenCalled());
    expect(draw.mock.calls[0]?.[0]).toEqual(wire);
    await waitFor(() => expect(document.querySelector('[data-test="cutaway"]')).not.toBeNull());
  });

  it('says so rather than throwing when the renderer cannot draw yet', async () => {
    const wire = db.wires.find((candidate) => candidate.id === 'mini-coax') as WireDefinition;
    render(
      <Cutaway
        wire={wire}
        debounceMs={0}
        render={() => {
          throw new Error('no geometry');
        }}
      />,
    );
    expect((await screen.findByText(/could not be drawn yet/)).textContent).toContain('no geometry');
  });
});

/* ------------------------------------------------------------------ *
 * The tab
 * ------------------------------------------------------------------ */

describe('the Library tab', () => {
  it('sits beside Canvas and Documents, and opens the library', async () => {
    render(<CableEditor design={design} db={db} definitions={host()} />);
    const tab = screen.getByRole('button', { name: 'Library' });
    expect(screen.getByRole('button', { name: 'Canvas' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Documents' })).toBeDefined();

    await act(async () => {
      fireEvent.click(tab);
    });
    expect(await screen.findByLabelText('search Connectors')).toBeDefined();
    expect(tab.getAttribute('aria-pressed')).toBe('true');
  });

  it('is there even with no way to change anything, because browsing is useful', () => {
    render(<CableEditor design={design} db={db} />);
    expect(screen.getByRole('button', { name: 'Library' })).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * Deleting
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The advanced escape hatch
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Controlled kind/selection, and the Artwork tab
 * ------------------------------------------------------------------ */

/** A minimal, always-empty artwork adapter — enough to grow the tab and
 * answer `detail()`, without a real depiction directory behind it. */
function emptyArtworkAdapter(defId: string, kind: 'connector' | 'pcba'): ArtworkAdapter {
  const detail: ArtworkDetail = {
    defId,
    exists: false,
    views: [],
    pinAnchors: {},
    unanchored: [],
    issues: [],
    uploadableViews: ['schematic-symbol', 'mating-face', 'board-top', 'illustration'],
    definition: { kind, id: defId, label: defId, terminals: [] },
  };
  return {
    detail: async () => ({ ok: true, value: detail }),
    upload: async () => ({ ok: false, message: 'not used in this test' }),
    saveAnchors: async () => ({ ok: false, message: 'not used in this test' }),
    artwork: async () => ({ ok: false, message: 'no artwork' }),
  };
}

const GERBER_BOARD = 'PCA-00101-rev6-basic';

/** The real gerber-tier fixture (`packages/catalog/depictions/PCA-00101-rev6-basic`) */
function gerberArtworkAdapter(): ArtworkAdapter {
  const depictions = diskDepictions();
  const meta = loadDepictionMetaFromDisk(GERBER_BOARD) as DepictionMeta;
  const pcba = db.pcbas.find((p) => p.id === GERBER_BOARD);
  const detail: ArtworkDetail = {
    defId: GERBER_BOARD,
    exists: true,
    meta,
    views: Object.keys(meta.views)
      .sort()
      .map((view) => {
        const asset = meta.views[view] as NonNullable<(typeof meta.views)[string]>;
        return { view, ...asset, derived: asset.mirrorOf !== undefined, anchors: meta.pinAnchors };
      }),
    anchorFrame: meta.anchorFrame,
    pinAnchors: meta.pinAnchors,
    unanchored: [],
    issues: [],
    uploadableViews: ['board-top'],
    definition: {
      kind: 'pcba',
      id: GERBER_BOARD,
      label: pcba?.label ?? GERBER_BOARD,
      terminals: (pcba?.terminals ?? []).map((t) => ({
        id: t.id,
        ...(t.label === undefined ? {} : { label: t.label }),
      })),
    },
  };
  return {
    detail: async () => ({ ok: true, value: detail }),
    upload: async () => ({ ok: false, message: 'gerber boards are not hand-editable' }),
    saveAnchors: async () => ({ ok: false, message: 'gerber boards are not hand-editable' }),
    artwork: async (defId, view) => {
      const art = depictions.artwork(defId, view);
      return art === undefined ? { ok: false, message: 'no artwork' } : { ok: true, value: art };
    },
  };
}


describe('the list pane', () => {
  afterEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // storage may be unavailable
    }
  });

  it('folds away with its button or Ctrl+B, and remembers that for this viewer', async () => {
    render(<Library db={db} definitions={host()} kind="connectors" />);
    await screen.findByLabelText('search Connectors');
    fireEvent.click(screen.getByRole('button', { name: 'Hide the list' }));
    // hidden, not unmounted — a phone-width layout still shows it (CSS)
    const listOf = (): Element | null => screen.getByLabelText('search Connectors').closest('.cs-library-list');
    expect(listOf()?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByRole('button', { name: 'Show the list' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(listOf()?.hasAttribute('hidden')).toBe(false);
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => expect(window.localStorage.getItem('cs.library.list-pane')).toContain('"collapsed":true'));

    cleanup();
    render(<Library db={db} definitions={host()} kind="connectors" />);
    expect(screen.getByRole('button', { name: 'Show the list' })).toBeTruthy();
  });

  it('has a drag strip that resizes the list from the keyboard too', async () => {
    const { container } = render(<Library db={db} definitions={host()} kind="connectors" />);
    const strip = await screen.findByRole('separator', { name: 'Drag to resize the list' });
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    const root = container.querySelector('.cs-library') as HTMLElement;
    expect(root.style.getPropertyValue('--cs-library-list')).not.toBe('320px');
  });
});

/* ------------------------------------------------------------------ *
 * A board's copper paths
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The connector journey end to end, kits and "In kits"
 * ------------------------------------------------------------------ */

async function pickOption(name: string, text: string): Promise<void> {
  const trigger = screen.getByRole('button', { name });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const filter = await screen.findByRole('combobox', { name: /^filter/ });
  fireEvent.change(filter, { target: { value: text } });
  fireEvent.keyDown(filter, { key: 'Enter' });
}

