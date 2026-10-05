// @vitest-environment jsdom
/**
 * The lifecycle controls, as a person meets them.
 *
 * The rules in `lifecycle.ts` are tested headlessly next door; this checks the
 * things only the rendered form can get wrong — that Save is dead until there
 * is something to save, that a refusal appears on screen as sentences rather
 * than a payload, that the delete dialog names what it is about to destroy, and
 * that the id suggestion follows the name the user is typing.
 */

import type { CableDesign, Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditorContext } from '../src/context.ts';
import { DesignActions } from '../src/panels/DesignActions.tsx';
import { blankDesign } from '../src/persistence.ts';
import type { EditorAction } from '../src/store.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';
import { memoryPersistence } from './memory-persistence.ts';

const db: Db = loadDbFromDisk();
const REAL: CableDesign = loadDesignFromDisk('de9-terminal-board');

afterEach(cleanup);

function harness(children: (dispatch: ReturnType<typeof vi.fn>) => ReactNode): {
  dispatch: ReturnType<typeof vi.fn>;
  ui: ReactNode;
} {
  const dispatch = vi.fn<(action: EditorAction) => void>();
  return {
    dispatch,
    ui: (
      <EditorContext.Provider value={{ dispatch, selection: undefined, openPicker: vi.fn(), partLabelsVisible: false }}>
        {children(dispatch)}
      </EditorContext.Provider>
    ),
  };
}

function setup(
  options: {
    draft?: CableDesign;
    onChange?: (change: unknown) => void;
    /** hand the library in and Save starts checking for warnings first */
    withDb?: boolean;
  } = {},
): {
  adapter: ReturnType<typeof memoryPersistence>;
  dispatch: ReturnType<typeof vi.fn>;
} {
  const adapter = memoryPersistence(db, [REAL, blankDesign('scratch-one', 'Scratch one', 'note')]);
  const { dispatch, ui } = harness(() => (
    <DesignActions
      design={options.draft ?? structuredClone(REAL)}
      baseline={REAL}
      persistence={adapter}
      designs={[{ id: REAL.id, label: REAL.label }, { id: 'scratch-one', label: 'Scratch one' }]}
      onCatalogChange={options.onChange}
      {...(options.withDb === true ? { db } : {})}
    />
  ));
  render(ui);
  return { adapter, dispatch };
}

/**
 * The real design with one destination-end joint cut away, which leaves a
 * conductor soldered at one end and floating at the other — the validator's
 * `floating-conductor-end` warning, and a legitimate state for a cable that is
 * still being built up.
 */
function draftWithWarnings(): CableDesign {
  const draft = structuredClone(REAL);
  const at = draft.joints.findIndex(
    (joint) =>
      (joint.a.terminal === 'core-red.center' && joint.a.end === 'b') ||
      (joint.b.terminal === 'core-red.center' && joint.b.end === 'b'),
  );
  draft.joints.splice(at, 1);
  return draft;
}

describe('Save', () => {
  it('is dead until the draft says something the stored design does not', () => {
    setup();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    setup({ draft: { ...structuredClone(REAL), label: 'edited' } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('writes the draft and tells the host what changed', async () => {
    const onChange = vi.fn();
    const { adapter } = setup({ draft: { ...structuredClone(REAL), label: 'edited' }, onChange });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    expect(adapter.stored.get(REAL.id)?.label).toBe('edited');
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({ kind: 'saved' });
  });

  it('shows a refusal as sentences, never as a payload', async () => {
    const broken = structuredClone(REAL);
    broken.instances.connectors.push({ id: 'j99', def: 'no-such-connector' });
    setup({ draft: broken });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toContain('no-such-connector');
    expect(alert.textContent).toContain('untouched');
    expect(alert.textContent).not.toContain('unknown-def');
    expect(alert.textContent).not.toContain('{');
  });
});

describe('Revert', () => {
  it('asks the store to load the design as it is saved', () => {
    const { dispatch } = setup({ draft: { ...structuredClone(REAL), label: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'load-design', design: REAL });
  });

  it('is dead when there is nothing to go back from', () => {
    setup();
    expect((screen.getByRole('button', { name: 'Revert' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('New', () => {
  it('suggests an id from the name, and stops once the user writes their own', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'New…' }));

    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    const id = screen.getByLabelText(/^Id/) as HTMLInputElement;

    fireEvent.change(name, { target: { value: 'Mixer (Main) → Stage' } });
    expect(id.value).toBe('mixer-main-stage');

    fireEvent.change(id, { target: { value: 'my-own-name' } });
    fireEvent.change(name, { target: { value: 'Something else entirely' } });
    expect(id.value).toBe('my-own-name');
  });

  it('asks where the information comes from, and will not create without it', async () => {
    const { adapter } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'New…' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Fresh cable' } });
    fireEvent.click(screen.getByRole('button', { name: 'New design' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('where its information comes from');
    expect(adapter.stored.has('fresh-cable')).toBe(false);

    fireEvent.change(screen.getByLabelText(/come from/), {
      target: { value: 'bench measurement' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New design' }));
    await waitFor(() => expect(adapter.stored.has('fresh-cable')).toBe(true));
  });
});

describe('Duplicate', () => {
  it('warns that it copies the saved version when there are unsaved changes', () => {
    setup({ draft: { ...structuredClone(REAL), label: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate…' }));
    expect(screen.getByText(/not saved yet/)).toBeTruthy();
  });

  it('copies under the suggested free id', async () => {
    const { adapter } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save a copy' }));

    await waitFor(() => expect(adapter.stored.size).toBe(3));
    const copied = [...adapter.stored.keys()].find((id) => id.includes('copy'));
    expect(copied).toBeDefined();
  });
});

describe('Delete', () => {
  it('names the design it is about to remove, and only deletes when confirmed', async () => {
    const { adapter } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(REAL.label);
    expect(dialog.textContent).toContain(REAL.id);

    // backing out changes nothing
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(adapter.stored.has(REAL.id)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(screen.getByRole('button', { name: `Delete ${REAL.id}` }));
    await waitFor(() => expect(adapter.stored.has(REAL.id)).toBe(false));
    expect(adapter.calls).toContain(`remove:${REAL.id}`);
  });
});

describe('Save with warnings', () => {

  it('saves straight through when there is nothing to look at', async () => {
    const clean = { ...structuredClone(REAL), label: 'edited' };
    const { adapter } = setup({ draft: clean, withDb: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(adapter.calls).toContain(`save:${REAL.id}`));
    expect(screen.queryByRole('dialog', { name: 'Save with warnings' })).toBeNull();
  });
});

describe('New', () => {
  it('opens the guided wizard when the host hands the library in', () => {
    setup({ withDb: true });
    fireEvent.click(screen.getByRole('button', { name: 'New…' }));
    const heading = screen.getByRole('heading', { name: 'New cable' });
    expect(heading).toBeTruthy();
    // the wizard's intro sentence moved into the heading's tooltip (// no narrative copy on the page itself)
    expect(heading.title).toContain('already wired');
  });

  it('still offers the blank design for anyone who wants one', () => {
    setup({ withDb: true });
    fireEvent.click(screen.getByRole('button', { name: 'New…' }));
    fireEvent.click(screen.getByRole('button', { name: /blank cable instead/ }));
    expect(screen.getByRole('heading', { name: 'New design' })).toBeTruthy();
  });

  it('falls back to the blank dialog for a host with no library', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'New…' }));
    expect(screen.getByRole('heading', { name: 'New design' })).toBeTruthy();
  });
});
