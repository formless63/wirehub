import { IconX } from '@tabler/icons-react';
import { Dialog as RDialog, DropdownMenu as RMenu, Popover as RPopover } from 'radix-ui';
import type { JSX, ReactElement, ReactNode } from 'react';

import { IconButton } from './Button.tsx';
import { cx } from './cx.ts';
import { Kbd } from './Kbd.tsx';
import { usePortalContainer } from './portal.ts';

export interface PopoverProps {
  /** the element that opens it (a Button); it gets `aria-expanded` and `aria-controls` */
  trigger: ReactElement;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** names the panel for assistive tech */
  'aria-label'?: string;
  className?: string;
}

/** Small anchored panel with interactive content (a filter, a date). Escape or an outside click closes it and returns focus to the trigger. */
export function Popover({ trigger, children, align = 'start', side = 'bottom', open, onOpenChange, className, ...rest }: PopoverProps): JSX.Element {
  const container = usePortalContainer();
  return (
    <RPopover.Root {...(open === undefined ? {} : { open })} {...(onOpenChange === undefined ? {} : { onOpenChange })}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal container={container}>
        <RPopover.Content className={cx('cs-ui-pop', className)} align={align} side={side} sideOffset={4} {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })}>
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

export type MenuEntry =
  | { type?: 'item'; label: string; onSelect: () => void; icon?: ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean }
  | { type: 'separator' };

export interface MenuProps {
  trigger: ReactElement;
  items: readonly MenuEntry[];
  align?: 'start' | 'center' | 'end';
  'aria-label'?: string;
}

/** An action menu. Open with Enter, Space or Down; arrows move, type-ahead jumps, Enter runs, Escape closes. */
export function Menu({ trigger, items, align = 'end', ...rest }: MenuProps): JSX.Element {
  const container = usePortalContainer();
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal container={container}>
        <RMenu.Content className="cs-menu" align={align} sideOffset={4} {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })}>
          {items.map((it, i) =>
            it.type === 'separator' ? (
              <RMenu.Separator key={`sep-${i}`} className="cs-menu-sep" />
            ) : (
              <RMenu.Item key={it.label} className="cs-menu-item" disabled={it.disabled} data-danger={it.danger || undefined} onSelect={it.onSelect}>
                {it.icon}
                {it.label}
                {it.shortcut === undefined ? null : <Kbd>{it.shortcut}</Kbd>}
              </RMenu.Item>
            ),
          )}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** one line under the title; leave out when the title says it */
  description?: ReactNode;
  children?: ReactNode;
  /** buttons, right-aligned */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  testId?: string;
}

/** A modal dialog: focus moves in, is trapped, Escape closes, focus returns to what opened it. Use `ConfirmDialog` for yes/no. */
export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'sm', testId }: DialogProps): JSX.Element {
  const container = usePortalContainer();
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal container={container}>
        <RDialog.Overlay className="cs-ui-overlay" />
        <RDialog.Content
          className="cs-ui-dialog"
          data-size={size}
          data-testid={testId}
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          onOpenAutoFocus={(e) => {
            // land on the first field or action, not on the Close button (whose tooltip would open and eat Escape)
            const root = e.currentTarget as HTMLElement;
            const first = root.querySelector<HTMLElement>('.cs-ui-dialog-content :is(input, textarea, button, [tabindex]):not([tabindex="-1"]):not(:disabled), .cs-ui-actions :is(button):not(:disabled)');
            if (first) {
              e.preventDefault();
              first.focus();
            }
          }}
        >
          <div className="cs-ui-dialog-head">
            <RDialog.Title className="cs-ui-title">{title}</RDialog.Title>
            <RDialog.Close asChild>
              <IconButton label="Close" size="xs" icon={<IconX size={14} aria-hidden />} />
            </RDialog.Close>
          </div>
          {description === undefined ? null : <RDialog.Description className="cs-ui-body">{description}</RDialog.Description>}
          {children === undefined ? null : <div className="cs-ui-dialog-content">{children}</div>}
          {footer === undefined ? null : <div className="cs-ui-actions">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
