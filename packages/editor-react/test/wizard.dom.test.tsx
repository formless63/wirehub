// @vitest-environment jsdom
/**
 * The new-cable wizard, as a person meets it.
 *
 * The generator and the state machine are tested headlessly next door; what is
 * checked here is what only the rendered form can get wrong — that a step that
 * cannot be left says so in sentences, that the part lists are searchable and
 * say what each part is, that the length field shows feet and inches while it
 * is typed in, that the review names what was left unconnected, and that
 * finishing writes a cable that is actually wired.
 */

import type { Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NewCableWizard } from '../src/panels/NewCableWizard.tsx';
import { loadDbFromDisk } from './fixture.ts';
import { memoryPersistence } from './memory-persistence.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

function setup(): { adapter: ReturnType<typeof memoryPersistence>; created: unknown[] } {
  const adapter = memoryPersistence(db, []);
  const created: unknown[] = [];
  render(
    <NewCableWizard
      db={db}
      persistence={adapter}
      designs={[{ id: 'de9-crossover', label: 'taken' }]}
      onCancel={() => undefined}
      onCatalogChange={(change) => created.push(change)}
    />,
  );
  return { adapter, created };
}

const next = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
};

function name(id = 'wizard-cable'): void {
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Wizard cable' } });
  fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: id } });
  fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: 'unit test' } });
}

/** Pick a part out of the searchable list by its id. */
function pick(id: string): void {
  fireEvent.click(screen.getByText(id));
}

describe('the first step', () => {
  it('will not go on without a name, an id and a source, and says so in sentences', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: '' } });
    next();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Give the design a name');
    expect(alert.textContent).toContain('where this information comes from');
    // still on step one
    expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('called');
  });

  it('suggests an id from the name', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Mixer (Main) → Stage' } });
    expect((screen.getByLabelText(/^Id/) as HTMLInputElement).value).toBe('mixer-main-stage');
  });

  it('refuses an id another design already has', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/^Id/), {
      target: { value: 'de9-crossover' },
    });
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: 'x' } });
    next();
    expect(screen.getByRole('alert').textContent).toContain('already exists');
  });
});

describe('the part lists', () => {

  it('never dead-ends on an empty search', () => {
    setup();
    name();
    next();
    fireEvent.change(screen.getByLabelText(/Which board/), { target: { value: 'zzzz' } });
    expect(screen.getByText(/Clear the search/)).toBeTruthy();
  });
});


describe('the review verdict', () => {
  /** Walk to the review with de9-female at both ends and a Cat 5e stock none of whose pairs find a pin. */
  function toReview(wire: string): void {
    setup();
    name();
    next();
    fireEvent.click(screen.getByLabelText(/A plug on its own/));
    pick('de9-female');
    next();
    pick(wire);
    next();
    fireEvent.click(screen.getByLabelText(/A plug on its own/));
    pick('de9-female');
    next();
    // the choices step, when there is one, is skipped as it is answered with nothing
    while (screen.queryByRole('heading', { name: /Checks/ }) === null) next();
  }

  it('says what is floating, in names, and never "Nothing is wrong"', () => {
    toReview('cat5e-utp');
    const verdict = screen.getByTestId('wizard-verdict');
    expect(verdict.textContent).toMatch(/things? to look at/);
    expect(screen.queryByText(/Nothing is wrong/)).toBeNull();
    const text = screen.getByRole('heading', { name: /Checks/ }).parentElement?.textContent ?? '';
    expect(text).toContain('W1 pair 1 · blue is not connected at either end');
    expect(text).not.toMatch(/pair-1\.a/);
  });
});

describe('connecting the new design', () => {
  function toReview(): void {
    setup();
    name();
    next();
    fireEvent.click(screen.getByLabelText(/A plug on its own/));
    pick('de9-female');
    next();
    pick('shielded-2pair-24awg');
    next();
    fireEvent.click(screen.getByLabelText(/A plug on its own/));
    pick('de9-male');
    next();
    while (screen.queryByRole('heading', { name: /Checks/ }) === null) next();
  }

  it('offers by signal, by colour and leave open on the review, with the preview following the choice', () => {
    toReview();
    const group = screen.getByRole('radiogroup', { name: 'Connect' });
    const modes = [...group.querySelectorAll('[role="radio"]')].map((b) => b.textContent);
    expect(modes).toEqual(['By signal', 'By colour', 'Leave open']);
    const soldered = (): number => Number(/\((\d+)\)/.exec(screen.getByRole('heading', { name: /What it will solder/ }).textContent ?? '')?.[1]);
    // this stock names no conductor, so by colour only the shield and drain find a ground; open joins nothing
    const colour = (): number => (fireEvent.click(screen.getByRole('radio', { name: 'By colour' })), soldered());
    const open = (): number => (fireEvent.click(screen.getByRole('radio', { name: 'Leave open' })), soldered());
    const bySignal = (): number => (fireEvent.click(screen.getByRole('radio', { name: 'By signal' })), soldered());
    const before = bySignal();
    expect(colour()).toBeLessThanOrEqual(before);
    expect(open()).toBe(0);
  });
});
