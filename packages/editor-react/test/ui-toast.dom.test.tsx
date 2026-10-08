// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { notify } from '../src/ui/index.ts';

beforeEach(() => vi.clearAllMocks());

describe('the toast preset over sonner', () => {
  it('maps the four tones, with an optional description and action', () => {
    const act = vi.fn();
    notify.success('Saved');
    notify.info('Imported', { description: '12 parts' });
    notify.warn('Check pinout', { action: { label: 'Open', onClick: act } });
    expect(toast.success).toHaveBeenCalledWith('Saved', {});
    expect(toast.info).toHaveBeenCalledWith('Imported', { description: '12 parts' });
    expect(toast.warning).toHaveBeenCalledWith('Check pinout', { action: { label: 'Open', onClick: act } });
  });

  it('errors stay until dismissed', () => {
    notify.error('Could not save');
    expect(toast.error).toHaveBeenCalledWith('Could not save', { duration: Infinity });
  });

  it('undoable carries an Undo action that runs the callback, with 8 s to press it', () => {
    const undo = vi.fn();
    notify.undoable('Deleted 3 wires', undo);
    const [message, opts] = toast.mock.calls[0] as [string, { duration: number; action: { label: string; onClick: () => void } }];
    expect(message).toBe('Deleted 3 wires');
    expect(opts.duration).toBe(8000);
    expect(opts.action.label).toBe('Undo');
    opts.action.onClick();
    expect(undo).toHaveBeenCalled();
  });
});
