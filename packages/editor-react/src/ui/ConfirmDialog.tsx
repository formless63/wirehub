/**
 * A small confirmation dialog on Radix `AlertDialog`: the in-app replacement for
 * `window.confirm`, which is blocked or a no-op in some hosts and cannot be styled,
 * tested or themed. Controlled: the caller owns `open` and gets one of `onConfirm`
 * or `onCancel`. Focus starts on Cancel unless the action is not destructive.
 */

import { AlertDialog } from 'radix-ui';
import type { JSX, ReactNode } from 'react';

import { Button } from './Button.tsx';
import { usePortalContainer } from './portal.ts';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** one line of consequence; keep it short */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** a destructive action is styled as one and focuses Cancel first */
  destructive?: boolean;
  /** the confirm button is disabled and says so while the action runs */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  const container = usePortalContainer();
  const { open, title, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive = false, busy = false } = props;
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) props.onCancel(); }}>
      <AlertDialog.Portal container={container}>
        <AlertDialog.Overlay className="cs-ui-overlay" />
        <AlertDialog.Content className="cs-ui-dialog" data-testid="confirm-dialog">
          <AlertDialog.Title className="cs-ui-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="cs-ui-body" asChild>
            <div>{children}</div>
          </AlertDialog.Description>
          <div className="cs-ui-actions">
            <AlertDialog.Cancel asChild>
              <Button disabled={busy}>{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <Button variant={destructive ? 'danger' : 'primary'} loading={busy} onClick={props.onConfirm} data-testid="confirm-dialog-ok">
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
