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
import { crossSectionLayout } from '@wirehub/render-svg';
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

it.each(['cat5e-utp', 'shielded-2pair-24awg'])('draws nested stock %s while keeping its unsupported form read-only', async (id) => {
  const stock = db.wires.find((wire) => wire.id === id)!;
  expect(wireFormOf(stock)).toBeUndefined();
  const { container } = render(<Library db={db} kind="wires" selectedId={stock.id} definitions={host()} />);
  await screen.findByText('The structured form cannot edit this stock.');
  await waitFor(() => expect(container.querySelector('.cs-cutaway-draw svg')).not.toBeNull());
  expect(screen.getByRole('list', { name: 'cross-section key' }).textContent).toMatch(/pair/i);
  expect(screen.getByText('Advanced: the record as JSON')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
});

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

  it.each(['dc-2core-24awg', 'cat5e-utp', 'shielded-2pair-24awg'])('keeps the full diameter annotation inside the cropped %s preview', async (id) => {
    const wire = db.wires.find((candidate) => candidate.id === id)!;
    const cs = crossSectionLayout(wire)!;
    const { container } = render(<Cutaway wire={wire} debounceMs={0} />);
    await waitFor(() => expect(container.querySelector('.cs-cutaway-draw svg')).not.toBeNull());
    const svg = container.querySelector('.cs-cutaway-draw svg')!;
    const [x, , width] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    expect(svg.querySelector('.xs-dim-text')!.textContent).toBe(cs.dimension.label);
    expect(cs.dimension.label).toMatch(/^Ø /);
    // At the drawing's 2.9 mm font this label spans at least 35 mm;
    // its centered prefix extended beyond the old jacket-only crop.
    expect(x!).toBeLessThan(cs.dimension.labelX - 17.5);
    expect(x! + width!).toBeGreaterThan(cs.dimension.labelX + 17.5);
    expect(svg.querySelector('.xs-rule-text')!.textContent).toMatch(/ mm$/);
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

it('exposes the board depiction editor through the journey artwork step', async () => {
  const board = db.pcbas[0]!;
  const adapter = emptyArtworkAdapter(board.id, 'pcba');
  render(<Library db={db} kind="pcbas" selectedId={board.id} definitions={host()} artworkAdapter={adapter} boardJourney={{}} />);
  const step = await screen.findByRole('button', { name: /Artwork & guides/ });
  fireEvent.click(step);
  await screen.findByText('Uploaded artwork');
  expect(screen.getByText(/Upload a picture above/)).toBeTruthy();
  expect(document.querySelector('input[type="file"]')).not.toBeNull();
});

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


/* ------------------------------------------------------------------ *
 * Records from a pack
 * ------------------------------------------------------------------ */

describe('a record from an installed pack', () => {
  const target = db.components[0] as { id: string; label: string };

  it('is read-only, says which pack it came from, and forks to a copy of your own', async () => {
    const inner = host();
    const fork = vi.fn(async (kind: 'components', id: string, newId: string) => {
      const source = inner.stored.get(kind)?.find((record) => record.id === id) as { id: string };
      const copy = { ...source, id: newId, derivedFrom: { pack: 'demo', id, version: '1.0.0' } };
      inner.stored.set(kind, [...(inner.stored.get(kind) ?? []), copy as never]);
      return { ok: true as const, value: copy as never };
    });
    const adapter = {
      ...inner,
      list: async (kind: Parameters<typeof inner.list>[0]) => {
        const out = await inner.list(kind);
        return out.ok && kind === 'components' ? { ok: true as const, value: { ...out.value, packs: { [target.id]: { pack: 'demo', version: '1.0.0' } } } } : out;
      },
      fork,
    };
    const selected: (string | undefined)[] = [];
    render(<Library db={db} definitions={adapter} kind="components" selectedId={target.id} onSelectId={(id) => selected.push(id)} />);
    await screen.findByText(/From pack demo 1\.0\.0 — read-only/);
    // the form is disabled
    expect(document.querySelector('fieldset[disabled]')).not.toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Fork to edit' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Id for your copy' }), { target: { value: `${target.id}-mine` } });
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    await waitFor(() => expect(fork).toHaveBeenCalledWith('components', target.id, `${target.id}-mine`));
    await waitFor(() => expect(selected).toContain(`${target.id}-mine`));
  });
});

it('an empty list says so once, offers New, and links to the docs when the host gives a link', async () => {
  const empty: Db = { ...db, kits: [] };
  render(<Library db={empty} kind="kits" definitions={memoryDefinitions(empty, [design])} emptyHelp={(kind) => `https://docs.example/${kind}`} />);
  const line = await screen.findByText(/No kits yet\./);
  expect(within(line).getByRole('button', { name: /New/ })).toBeTruthy();
  expect(within(line).getByRole('link', { name: 'Learn more' }).getAttribute('href')).toBe('https://docs.example/kits');
});
