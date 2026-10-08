import { Toaster as Sonner, toast, type ExternalToast } from 'sonner';
import type { JSX } from 'react';

/**
 * The toast preset over sonner (already the app's toast library): success, info, warn, error, an
 * optional action, and `undoable` for a destructive change that can be taken back. Mount
 * `<WireHubToaster />` once at the app root; call `notify.*` from anywhere. Styled with tokens only
 * (`.cs-ui-toast` in ui.css), light and dark.
 */
export function WireHubToaster(): JSX.Element {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        unstyled: true,
        classNames: { toast: 'cs-ui-toast', title: 'cs-ui-toast-title', description: 'cs-ui-toast-desc', actionButton: 'cs-ui-toast-action', cancelButton: 'cs-ui-toast-action' },
      }}
    />
  );
}

export interface NotifyOptions {
  description?: string;
  action?: { label: string; onClick: () => void };
  /** ms; default 4000, errors stay until dismissed */
  duration?: number;
  id?: string | number;
}

function toExternal(o: NotifyOptions | undefined, fallbackDuration?: number): ExternalToast {
  const out: ExternalToast = {};
  if (o?.description !== undefined) out.description = o.description;
  if (o?.action !== undefined) out.action = { label: o.action.label, onClick: o.action.onClick };
  const duration = o?.duration ?? fallbackDuration;
  if (duration !== undefined) out.duration = duration;
  if (o?.id !== undefined) out.id = o.id;
  return out;
}

export const notify = {
  success: (message: string, o?: NotifyOptions) => toast.success(message, toExternal(o)),
  info: (message: string, o?: NotifyOptions) => toast.info(message, toExternal(o)),
  warn: (message: string, o?: NotifyOptions) => toast.warning(message, toExternal(o)),
  error: (message: string, o?: NotifyOptions) => toast.error(message, toExternal(o, Infinity)),
  /** a change already applied, with an Undo that has 8 s to be pressed */
  undoable: (message: string, undo: () => void, o?: Omit<NotifyOptions, 'action'>) => toast(message, toExternal({ ...o, action: { label: 'Undo', onClick: undo } }, 8000)),
};
