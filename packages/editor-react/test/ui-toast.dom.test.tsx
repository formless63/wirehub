// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { notify } from '../src/ui/index.ts';

beforeEach(() => vi.clearAllMocks());

type Opts = { duration: number; action: { label: string; onClick: () => void }; onDismiss: () => void };

describe('deferred: a change that commits when the Undo window closes', () => {
  it('commits after 10 s when nothing was pressed, once', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    notify.deferred('Disabled pack', commit);
    vi.advanceTimersByTime(9_999);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(commit).toHaveBeenCalledTimes(1);
    (toast.mock.calls[0]![1] as Opts).onDismiss();
    expect(commit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('never commits after Undo, and commits at once when the toast is dismissed early', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const onUndo = vi.fn();
    notify.deferred('Cleared key', commit, { onUndo });
    const opts = toast.mock.calls[0]![1] as Opts;
    expect(opts.action.label).toBe('Undo');
    opts.action.onClick();
    opts.onDismiss();
    vi.advanceTimersByTime(60_000);
    expect(commit).not.toHaveBeenCalled();
    expect(onUndo).toHaveBeenCalledTimes(1);
    notify.deferred('Cleared another', commit);
    (toast.mock.calls[1]![1] as Opts).onDismiss();
    expect(commit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

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

  it('undoable carries an Undo action that runs the callback, with 10 s to press it', () => {
    const undo = vi.fn();
    notify.undoable('Deleted 3 wires', undo);
    const [message, opts] = toast.mock.calls[0] as [string, { duration: number; action: { label: string; onClick: () => void } }];
    expect(message).toBe('Deleted 3 wires');
    expect(opts.duration).toBe(10000);
    expect(opts.action.label).toBe('Undo');
    opts.action.onClick();
    expect(undo).toHaveBeenCalled();
  });
});
