// @vitest-environment jsdom
/**
 * The signal-tag journey in the connector form, over the starter catalog:
 * open a pin's signal picker, filter it, pick a signal — a pin with no words
 * of its own takes the signal's label — then clear it back to untagged. The
 * record the form describes carries what the picker set.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { connectorDraftOf, connectorOf, type ConnectorDraft } from '../src/library.ts';
import { ConnectorEditor } from '../src/panels/ConnectorEditor.tsx';
import { VocabContext } from '../src/vocab.ts';
import { loadDbFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

let latest: ConnectorDraft | undefined;

function Harness(props: { initial: ConnectorDraft }): JSX.Element {
  const [draft, setDraft] = useState(props.initial);
  latest = draft;
  return (
    <VocabContext.Provider value={{ vocab: db.vocab }}>
      <ConnectorEditor draft={draft} onChange={setDraft} idLocked />
    </VocabContext.Provider>
  );
}

function draftOf(id: string): ConnectorDraft {
  const connector = db.connectors.find((c) => c.id === id);
  if (connector === undefined) throw new Error(`no ${id}`);
  return connectorDraftOf(connector, db.tags);
}

async function pickOption(trigger: HTMLElement, filter: string, optionName: RegExp): Promise<void> {
  fireEvent.click(trigger);
  const box = await screen.findByRole('combobox', { name: /^filter/ });
  fireEvent.change(box, { target: { value: filter } });
  const list = await screen.findByRole('listbox');
  fireEvent.click(within(list).getByText(optionName, { selector: '.cs-pick-label' }));
}

describe('tagging a pin with a signal', () => {
  it('starts untagged: the numbered pins of a DE-9 carry the placeholder any until someone says what they carry', () => {
    render(<Harness initial={draftOf('de9-female')} />);
    const trigger = screen.getByRole('button', { name: 'pin 1 signal' });
    expect(trigger.textContent).not.toMatch(/\+5 V/);
    expect(latest?.pins.filter((pin) => /^\d+$/.test(pin.id)).every((pin) => pin.signal === 'any')).toBe(true);
  });

  it('picks a signal by typing, fills the blank label from it, and saves it on the record', async () => {
    const draft = draftOf('de9-female');
    draft.pins[0]!.label = '';
    render(<Harness initial={draft} />);
    await pickOption(screen.getByRole('button', { name: 'pin 1 signal' }), '5v', /\+5 V/);

    expect(latest?.pins[0]?.signal).toBe('pwr-5v');
    expect(screen.getByRole('button', { name: 'pin 1 signal' }).textContent).toContain('+5 V');
    // a pin with no words of its own reads as its signal; one that has words keeps them
    expect(latest?.pins[0]?.label).toBe('+5 V');
    expect(connectorOf(latest!).pins[0]?.signal).toBe('pwr-5v');
    // the other pins are untouched
    expect(latest?.pins.slice(1).filter((pin) => /^\d+$/.test(pin.id)).every((pin) => pin.signal === 'any')).toBe(true);
  });

  it('finds a signal by one of its aliases', async () => {
    render(<Harness initial={draftOf('de9-female')} />);
    await pickOption(screen.getByRole('button', { name: 'pin 2 signal' }), 'vbus', /\+5 V/);
    expect(latest?.pins[1]?.signal).toBe('pwr-5v');
    // a pin that already has words keeps them
    expect(latest?.pins[1]?.label).toBe('2');
  });

  it('clears a tag back to untagged', async () => {
    const draft = draftOf('de9-female');
    draft.pins[0]!.signal = 'gnd';
    render(<Harness initial={draft} />);
    const trigger = screen.getByRole('button', { name: 'pin 1 signal' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText('untagged', { selector: '.cs-pick-label' }));
    expect(latest?.pins[0]?.signal).toBe('');
    expect(connectorOf(latest!).pins[0]?.signal).toBeUndefined();
  });
});
