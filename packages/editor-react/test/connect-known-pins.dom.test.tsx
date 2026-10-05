// @vitest-environment jsdom
/**
 * "Connect known pins" through the editor (cs-5k1.8): on a starter design with
 * joints removed the dialog proposes exactly the removed unambiguous joints and
 * lists the ambiguous ones without a box; Apply adds them as one undo step.
 */

import './reactflow-jsdom.ts';

import type { CableDesign, Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import type { EditorChromeState, EditorHandle } from '../src/CableEditor.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
afterEach(cleanup);

function cut(design: CableDesign, instances: string[]): { cut: CableDesign; removed: number } {
  const keep = design.joints.filter((j) => ![j.a, j.b].some((r) => instances.includes(r.instance)));
  return { cut: { ...design, joints: keep }, removed: design.joints.length - keep.length };
}

describe('Connect known pins', () => {
  it('proposes the removed joints, adds the ticked ones as one undo step, and undoes in one', async () => {
    const lead = loadDesignFromDisk('dc-led-lead');
    const { cut: partly, removed } = cut(lead, ['j2']);
    const ref = createRef<EditorHandle>();
    const states: EditorChromeState[] = [];
    render(<CableEditor ref={ref} chrome="host" design={partly} db={db} onChromeStateChange={(s) => states.push(s)} />);
    await waitFor(() => expect(ref.current).not.toBeNull());

    ref.current!.connectKnownPins();
    const dialog = await screen.findByRole('dialog', { name: 'Connect known pins' });
    const rows = within(dialog).getAllByRole('checkbox');
    expect(rows).toHaveLength(removed);
    expect(within(dialog).queryByLabelText('Ambiguous landings')).toBeNull();

    // clear one, apply the rest
    fireEvent.click(rows[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: /Add 1 joint/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect known pins' })).toBeNull());
    await waitFor(() => expect(states.at(-1)?.undoLabel).toMatch(/connected 1 known pin/));
    expect(states.at(-1)?.dirty).toBe(true);

    // a second run proposes only what is left
    ref.current!.connectKnownPins();
    const again = await screen.findByRole('dialog', { name: 'Connect known pins' });
    expect(within(again).getAllByRole('checkbox')).toHaveLength(removed - 1);
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));

    // one undo step takes the whole batch back
    ref.current!.undo();
    await waitFor(() => expect(states.at(-1)?.undoLabel).toBeUndefined());
    ref.current!.connectKnownPins();
    const reopened = await screen.findByRole('dialog', { name: 'Connect known pins' });
    expect(within(reopened).getAllByRole('checkbox')).toHaveLength(removed);
  });

  it('lists the landings it will not guess, with no box to tick', async () => {
    const splitter = loadDesignFromDisk('dc-y-splitter');
    const { cut: partly } = cut(splitter, ['j2', 'j3']);
    const ref = createRef<EditorHandle>();
    render(<CableEditor ref={ref} chrome="host" design={partly} db={db} onChromeStateChange={vi.fn()} />);
    await waitFor(() => expect(ref.current).not.toBeNull());
    ref.current!.connectKnownPins();
    const dialog = await screen.findByRole('dialog', { name: 'Connect known pins' });
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(dialog).getByTestId('connect-none')).toBeTruthy();
    expect(within(within(dialog).getByLabelText('Ambiguous landings')).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect((within(dialog).getByRole('button', { name: 'Add joints' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
