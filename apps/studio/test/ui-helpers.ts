import { expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

/** Open a `Select` (Radix combobox) by its accessible name and pick an option by its label. */
export async function pickOption(selectName: string | RegExp, optionLabel: string | RegExp): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name: selectName });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyUp(trigger, { key: 'ArrowDown' });
  const list = await screen.findByRole('listbox');
  const option = await within(list).findByRole('option', { name: optionLabel });
  await waitFor(() => expect(document.activeElement).not.toBe(trigger));
  fireEvent.keyDown(option, { key: 'Enter' });
  fireEvent.keyUp(option, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}
