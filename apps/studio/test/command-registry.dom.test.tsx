// @vitest-environment jsdom
/**
 * The command/shortcut registry itself (
 * `commands/registry.tsx`): a registered shortcut runs from anywhere but a
 * text input, is ignored while one has focus, and Ctrl+K is the one
 * exception — exercised directly against the public registry API (no
 * router/query wiring needed) so it stands on its own regardless of which
 * commands the app currently ships. `command-palette.dom.test.tsx` covers
 * the palette UI that sits on top of this.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandRegistryProvider, useRegisterCommands, type AppCommand } from '../src/commands/registry.tsx';

function Harness({ commands }: { commands: AppCommand[] }): JSX.Element {
  useRegisterCommands(commands);
  return (
    <div>
      <input aria-label="a text field" />
      <div aria-label="not typing" tabIndex={-1} />
    </div>
  );
}

afterEach(cleanup);

describe('a registered shortcut', () => {
  it('runs when the keydown target is not a text input', () => {
    const run = vi.fn();
    render(
      <CommandRegistryProvider>
        <Harness commands={[{ id: 'test.save', title: 'Save', shortcut: 'Ctrl+S', run }]} />
      </CommandRegistryProvider>,
    );

    fireEvent.keyDown(screen.getByLabelText('not typing'), { key: 's', ctrlKey: true });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is ignored while a text input has focus', () => {
    const run = vi.fn();
    render(
      <CommandRegistryProvider>
        <Harness commands={[{ id: 'test.save', title: 'Save', shortcut: 'Ctrl+S', run }]} />
      </CommandRegistryProvider>,
    );

    const input = screen.getByLabelText('a text field');
    input.focus();
    fireEvent.keyDown(input, { key: 's', ctrlKey: true });

    expect(run).not.toHaveBeenCalled();
  });

  it('Ctrl+K is the one shortcut that still runs while typing', () => {
    const run = vi.fn();
    render(
      <CommandRegistryProvider>
        <Harness commands={[{ id: 'quick-open', title: 'Quick open', shortcut: 'Ctrl+K', run }]} />
      </CommandRegistryProvider>,
    );

    const input = screen.getByLabelText('a text field');
    input.focus();
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not run when disabled', () => {
    const run = vi.fn();
    render(
      <CommandRegistryProvider>
        <Harness commands={[{ id: 'test.save', title: 'Save', shortcut: 'Ctrl+S', run, enabled: () => false }]} />
      </CommandRegistryProvider>,
    );

    fireEvent.keyDown(screen.getByLabelText('not typing'), { key: 's', ctrlKey: true });

    expect(run).not.toHaveBeenCalled();
  });
});
