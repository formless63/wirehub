// @vitest-environment jsdom
/**
 * `chrome="host"`: the old `cs-toolbar` row is gone,
 * a host drives Save/undo/redo/the lifecycle dialogs through the imperative
 * `ref`, hears about it through `onChromeStateChange`, and a rejected edit
 * reaches it as a callback instead of the in-canvas alert. `chrome="full"`
 * (the default) is exercised all over the rest of this package — this file
 * only has to prove the new mode actually differs from it.
 */

import './reactflow-jsdom.ts';

import { terminalKey, type Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import type { EditorChromeState, EditorHandle } from '../src/CableEditor.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';
import { memoryPersistence } from './memory-persistence.ts';

const db: Db = loadDbFromDisk();
const REAL = loadDesignFromDisk('de9-terminal-board');

afterEach(cleanup);

describe('the old toolbar', () => {
  it('is gone in host chrome, and still there by default', () => {
    const { container, rerender } = render(<CableEditor design={REAL} db={db} chrome="host" />);
    expect(container.querySelector('.cs-toolbar')).toBeNull();

    rerender(<CableEditor design={REAL} db={db} chrome="full" />);
    expect(container.querySelector('.cs-toolbar')).not.toBeNull();

    rerender(<CableEditor design={REAL} db={db} />);
    expect(container.querySelector('.cs-toolbar')).not.toBeNull();
  });
});

/**
 * The Build layout in host chrome: no left Parts
 * palette, no bottom schematic/JSON dock — just the canvas and the right
 * inspector, per the mockups. `chrome="full"` keeps both, unchanged.
 */
describe('the Build layout', () => {
  it('has no palette and no dock in host chrome, and both by default', () => {
    const { container, rerender } = render(<CableEditor design={REAL} db={db} chrome="host" />);
    expect(container.querySelector('.cs-palette')).toBeNull();
    expect(container.querySelector('.cs-dock')).toBeNull();
    expect(container.querySelector('.cs-canvas')).not.toBeNull();
    expect(container.querySelector('.cs-side')).not.toBeNull();

    rerender(<CableEditor design={REAL} db={db} chrome="full" />);
    expect(container.querySelector('.cs-palette')).not.toBeNull();
    expect(container.querySelector('.cs-dock')).not.toBeNull();

    rerender(<CableEditor design={REAL} db={db} />);
    expect(container.querySelector('.cs-palette')).not.toBeNull();
    expect(container.querySelector('.cs-dock')).not.toBeNull();
  });
});

describe('EditorHandle', () => {

  it('openLifecycle opens the same dialogs DesignActions would, without the button row', async () => {
    const adapter = memoryPersistence(db, [REAL]);
    const ref = createRef<EditorHandle>();

    render(
      <CableEditor
        ref={ref}
        chrome="host"
        design={REAL}
        db={db}
        savedDesign={REAL}
        persistence={adapter}
        designs={[{ id: REAL.id, label: REAL.label }]}
      />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    ref.current?.openLifecycle('rename');
    expect(await screen.findByRole('heading', { name: 'Rename this design' })).toBeTruthy();

    const id = screen.getByLabelText(/^Id/) as HTMLInputElement;
    fireEvent.change(id, { target: { value: 'renamed-cable' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename this design' }));

    await waitFor(() => expect(adapter.stored.has('renamed-cable')).toBe(true));
  });

  it("openLifecycle('delete') opens the delete confirm", async () => {
    const adapter = memoryPersistence(db, [REAL]);
    const ref = createRef<EditorHandle>();
    render(
      <CableEditor ref={ref} chrome="host" design={REAL} db={db} savedDesign={REAL} persistence={adapter} />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    ref.current?.openLifecycle('delete');
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(REAL.id);
  });
});

describe('a rejected edit in host chrome', () => {
  /**
   * `store.ts`'s `load-design` sets `rejection` when a *newly handed-in*
   * design (a prop change, not the first mount) fails validation — the same
   * path a bad hand-edited JSON re-opened by a host would hit. It is the
   * simplest real rejection to drive from outside the canvas (no React Flow
   * drag-to-connect gesture needed) and exercises exactly the code path
   * `CableEditor`'s `chrome="host"` effect reports through `onEditRejected`.
   */
  it('calls onEditRejected instead of showing the in-canvas alert', async () => {
    const design = loadDesignFromDisk('de9-crossover');
    const broken = structuredClone(design);
    broken.instances.connectors.push({ id: 'j99', def: 'no-such-connector' });

    const onEditRejected = vi.fn();
    const { container, rerender } = render(
      <CableEditor design={design} db={db} chrome="host" onEditRejected={onEditRejected} />,
    );
    rerender(<CableEditor design={broken} db={db} chrome="host" onEditRejected={onEditRejected} />);

    await waitFor(() => expect(onEditRejected).toHaveBeenCalledTimes(1));
    expect(onEditRejected.mock.calls[0]?.[0]).toContain('no-such-connector');
    expect(container.querySelector('.cs-rejection')).toBeNull();
  });

  it('shows the in-canvas alert instead, in full chrome', async () => {
    const design = loadDesignFromDisk('de9-crossover');
    const broken = structuredClone(design);
    broken.instances.connectors.push({ id: 'j99', def: 'no-such-connector' });

    const { container, rerender } = render(<CableEditor design={design} db={db} />);
    rerender(<CableEditor design={broken} db={db} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no-such-connector');
    expect(container.querySelector('.cs-rejection')).not.toBeNull();
  });
});

/**
 * The Connection tab (e5c.5) dispatches `add-joint`/`delete-joint`/`update-joint`
 * — the exact reducer actions `onConnect`/`onEdgesDelete` already use, proven
 * to reject through `commit` (`store.test.ts`) and to reach `onEditRejected`
 * from *any* `state.rejection` in host chrome (the describe block above). What
 * is new here is the panel wiring itself: selecting a part, following one of
 * its connections into the Connection tab, and adding a joint through the
 * pad/conductor comboboxes — which only ever offer real, free terminals, so a
 * commit issued through them cannot itself fail validation (no self-joint, no
 * duplicate, no unresolved pin is reachable that way); this exercises the
 * success path end to end and leaves the rejection path to the tests above,
 * which do not depend on how the edit was triggered.
 */
