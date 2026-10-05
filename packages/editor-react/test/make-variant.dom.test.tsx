// @vitest-environment jsdom
/**
 * "Make variant" (cs-5k1.10): the dialog offers only the stocks the trunk can
 * move to, previews the conductors by colour, and creates a new design with
 * the trunk moved; the original is untouched.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { trunkSegment } from '@wirehub/docs';
import type { CableDesign, Db } from '@wirehub/model';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesignLifecycleDialogs } from '../src/panels/DesignLifecycleDialogs.tsx';
import { useDesignLifecycle } from '../src/panels/useDesignLifecycle.ts';
import { canSwapTrunkStock, swappableStocks, withTrunkStock } from '../src/stock-swap.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';
import { memoryPersistence } from './memory-persistence.ts';

const db: Db = loadDbFromDisk();
const DESIGN: CableDesign = loadDesignFromDisk('de9-terminal-board');
const trunkOf = (d: CableDesign): string => trunkSegment(d, db)!.def;

afterEach(cleanup);

function Host(props: { adapter: ReturnType<typeof memoryPersistence>; onChange: (c: unknown) => void; withDb?: boolean }) {
  const lifecycle = useDesignLifecycle({
    design: DESIGN,
    baseline: DESIGN,
    persistence: props.adapter,
    designs: [{ id: DESIGN.id, label: DESIGN.label }],
    ...(props.withDb === false ? {} : { db }),
    onCatalogChange: props.onChange,
    dispatch: vi.fn(),
  });
  return (
    <>
      <button type="button" onClick={() => lifecycle.openLifecycle('variant')}>
        open variant
      </button>
      <DesignLifecycleDialogs api={lifecycle} design={DESIGN} persistence={props.adapter} {...(props.withDb === false ? {} : { db })} designs={[{ id: DESIGN.id, label: DESIGN.label }]} />
    </>
  );
}

describe('swappableStocks', () => {
  it('lists exactly the stocks canSwapTrunkStock accepts, never the current one', () => {
    const list = swappableStocks(DESIGN, db).map((w) => w.id);
    expect(list).not.toContain(trunkOf(DESIGN));
    expect(list.length).toBeGreaterThan(0);
    for (const w of db.wires) expect(list.includes(w.id)).toBe(canSwapTrunkStock(DESIGN, db, w.id));
  });
});

describe('Make variant dialog', () => {
  it('offers only swappable stocks, previews the move by colour and creates a copy on the new stock', async () => {
    const adapter = memoryPersistence(db, [DESIGN]);
    const onChange = vi.fn();
    render(<Host adapter={adapter} onChange={onChange} />);
    fireEvent.click(screen.getByText('open variant'));
    const dialog = await screen.findByRole('dialog', { name: 'Make a variant' });
    const select = within(dialog).getByLabelText('Wire stock') as HTMLSelectElement;
    const offered = [...select.options].map((o) => o.value);
    expect(offered).toEqual(swappableStocks(DESIGN, db).map((w) => w.id));
    // the preview shows a row per conductor colour of the current stock
    expect(within(dialog).getAllByRole('row').length).toBeGreaterThan(1);
    // choose a stock whose move succeeds without errors
    const target = offered.find((id) => adapterAccepts(id)) ?? offered[0]!;
    fireEvent.change(select, { target: { value: target } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make variant' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const change = onChange.mock.calls[0]![0] as { kind: string; from: string; design: CableDesign };
    expect(change.kind).toBe('duplicated');
    expect(change.from).toBe(DESIGN.id);
    expect(change.design.id).not.toBe(DESIGN.id);
    expect(trunkOf(change.design)).toBe(target);
    expect(change.design.productRef).toBeUndefined();
    // the original is exactly as it was
    expect(trunkOf(adapter.stored.get(DESIGN.id)!)).toBe(trunkOf(DESIGN));
    expect(adapter.stored.has(change.design.id)).toBe(true);
    expect(JSON.stringify(change.design.instances.segments)).toBe(JSON.stringify(withTrunkStock(DESIGN, db, target).design.instances.segments));
  });

  it('does nothing without the library (nothing to choose from)', () => {
    const adapter = memoryPersistence(db, [DESIGN]);
    render(<Host adapter={adapter} onChange={vi.fn()} withDb={false} />);
    fireEvent.click(screen.getByText('open variant'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

function adapterAccepts(id: string): boolean {
  const out = withTrunkStock(DESIGN, db, id);
  return out.lost.length === 0;
}
