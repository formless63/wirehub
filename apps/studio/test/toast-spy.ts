/**
 * A stand-in for `sonner` that records toasts, so a DOM test can assert on what a
 * flow reported: `vi.mock('sonner', async () => (await import('./toast-spy.ts')).sonnerMock)`.
 */
import { vi } from 'vitest';

export interface RecordedToast {
  kind: 'success' | 'error' | 'message';
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export const toasts: RecordedToast[] = [];
const record = (kind: RecordedToast['kind']) => (title: unknown, options?: { description?: string; action?: { label: string; onClick: () => void } }): string => {
  toasts.push({ kind, title: String(title), ...(options?.description === undefined ? {} : { description: options.description }), ...(options?.action === undefined ? {} : { action: options.action }) });
  return String(toasts.length);
};

export const sonnerMock = {
  toast: Object.assign(vi.fn(record('message')), { success: record('success'), error: record('error'), message: record('message'), warning: record('error'), info: record('message'), dismiss: () => undefined }),
  Toaster: () => null,
};
