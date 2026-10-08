/**
 * A right-hand drawer on Radix `Dialog`, non-modal by default so the page it
 * sits beside (a card, a list) stays visible and usable. Header with title and
 * close, scrolling body, optional pinned footer.
 */

import { IconX } from '@tabler/icons-react';
import { Dialog } from 'radix-ui';
import type { JSX, ReactNode } from 'react';

import { IconButton } from './Button.tsx';
import { usePortalContainer } from './portal.ts';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** width in px (default 380) */
  width?: number;
  /** true: dims the page and traps focus (default false, the page stays live) */
  modal?: boolean;
  testId?: string;
}

export function Drawer({ open, title, onClose, children, footer, width = 380, modal = false, testId }: DrawerProps): JSX.Element {
  const container = usePortalContainer();
  return (
    <Dialog.Root open={open} modal={modal} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal container={container}>
        {modal ? <Dialog.Overlay className="cs-ui-overlay" /> : null}
        <Dialog.Content
          className="cs-ui-drawer"
          style={{ width: `min(${width}px, 100vw)` }}
          data-testid={testId}
          aria-describedby={undefined}
          onInteractOutside={(event) => { if (!modal) event.preventDefault(); }}
        >
          <header className="cs-ui-drawer-head">
            <Dialog.Title className="cs-ui-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close" size="xs" icon={<IconX size={15} aria-hidden />} />
            </Dialog.Close>
          </header>
          <div className="cs-ui-drawer-body">{children}</div>
          {footer === undefined ? null : <footer className="cs-ui-drawer-foot">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
