// @vitest-environment jsdom
/**
 * Sub-assemblies in the editor: the host's adapter supplies the placed
 * designs, a placed one draws as a block with its ports, the palette places
 * another, and the inspector opens it and pins it to a saved version.
 */

import './reactflow-jsdom.ts';

import { createVersion, type AssemblyLibrary, type Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import type { AssembliesAdapter } from '../src/assemblies.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const Y = loadDesignFromDisk('dc-y-from-leads');
const LEAD = loadDesignFromDisk('dc-pigtail-lead');
const CROSSOVER = loadDesignFromDisk('de9-crossover');
const rev1 = createVersion({ design: LEAD, db, rev: 1, at: '2026-10-05T00:00:00.000Z', by: 'tester', note: 'first' });

/** The host's adapter over a fixed set of designs, recording what it was asked for. */
function adapter(): AssembliesAdapter & { asked: string[][] } {
  const designs = [LEAD, Y, CROSSOVER];
  const asked: string[][] = [];
  return {
    asked,
    load: async (ids) => {
      asked.push([...ids]);
      const library: AssemblyLibrary = {
        working: designs.filter((d) => ids.includes(d.id)),
        versions: ids.includes(LEAD.id) ? [{ designId: LEAD.id, rev: 1, released: true, design: rev1.design, definitions: rev1.definitions }] : [],
      };
      return { ok: true, value: library };
    },
  };
}

afterEach(cleanup);

describe('a sub-assembly on the canvas', () => {
  it('loads the placed design through the adapter and draws its ports', async () => {
    const assemblies = adapter();
    const { container } = render(<CableEditor design={Y} db={db} assemblies={assemblies} />);
    await waitFor(() => expect(container.querySelector('[data-terminal="lead-1:j1:1"]')).not.toBeNull());
    expect(container.querySelectorAll('.cs-node-subassembly')).toHaveLength(2);
    expect(assemblies.asked[0]).toEqual(['dc-pigtail-lead']);
    const block = container.querySelector('.cs-node-subassembly')!;
    expect(block.textContent).toContain('JST XH 2-pin housing');
    expect(block.querySelector('[data-terminal="lead-1:w1@b:red"]')).not.toBeNull();
    expect(block.querySelector('[data-terminal="lead-1:j1:1"]')).not.toBeNull();
  });

  it('places another design from the palette, fetching its ports first', async () => {
    const assemblies = adapter();
    const onDesignChange = vi.fn();
    const { container } = render(
      <CableEditor design={Y} db={db} assemblies={assemblies} designs={[{ id: CROSSOVER.id, label: CROSSOVER.label }, { id: Y.id, label: Y.label }]} onDesignChange={onDesignChange} />,
    );
    await waitFor(() => expect(container.querySelector('[data-terminal="lead-1:j1:1"]')).not.toBeNull());
    // the design itself is never offered
    expect(screen.queryByTitle('dc-y-from-leads — drag onto the canvas')).toBeNull();
    const item = screen.getByTitle('de9-crossover — drag onto the canvas');
    fireEvent.click(item.querySelector('.cs-add')!);
    await waitFor(() => expect(container.querySelectorAll('.cs-node-subassembly')).toHaveLength(3));
    expect(assemblies.asked).toContainEqual(['de9-crossover']);
    const placed = onDesignChange.mock.calls.at(-1)![0];
    expect(placed.instances.subassemblies.map((s: { def: string }) => s.def)).toEqual(['dc-pigtail-lead', 'dc-pigtail-lead', 'de9-crossover']);
  });

  it('opens the placed design and pins it to a saved version from the inspector', async () => {
    const assemblies = adapter();
    const onOpenDesign = vi.fn();
    const onDesignChange = vi.fn();
    const { container } = render(<CableEditor design={Y} db={db} assemblies={assemblies} onOpenDesign={onOpenDesign} onDesignChange={onDesignChange} />);
    await waitFor(() => expect(container.querySelector('[data-terminal="lead-1:j1:1"]')).not.toBeNull());
    fireEvent.click(container.querySelector('.cs-node-subassembly .cs-node-head')!);
    await waitFor(() => expect(screen.getByLabelText('pinned version')).toBeTruthy());
    fireEvent.click(screen.getByText('open dc-pigtail-lead in its own editor'));
    expect(onOpenDesign).toHaveBeenCalledWith('dc-pigtail-lead');
    fireEvent.change(screen.getByLabelText('pinned version'), { target: { value: '1' } });
    await waitFor(() => expect(onDesignChange).toHaveBeenCalled());
    const pinned = onDesignChange.mock.calls.at(-1)![0];
    expect(pinned.instances.subassemblies[0]).toMatchObject({ id: 'lead-1', rev: 1 });
    // double-clicking the block opens it too
    fireEvent.doubleClick(container.querySelector('.cs-node-subassembly')!);
    expect(onOpenDesign).toHaveBeenCalledTimes(2);
  });
});
