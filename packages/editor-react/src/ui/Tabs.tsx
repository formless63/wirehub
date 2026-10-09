import { Tabs as RTabs } from 'radix-ui';
import type { ComponentPropsWithoutRef, JSX } from 'react';

import { cx } from './cx.ts';

/** The one tab style: underline, copper under the current tab. Compose `Tabs > TabList > Tab` and `TabPanel`. */
export function Tabs(props: ComponentPropsWithoutRef<typeof RTabs.Root>): JSX.Element {
  return <RTabs.Root {...props} />;
}
export function TabList({ className, ...props }: ComponentPropsWithoutRef<typeof RTabs.List>): JSX.Element {
  return <RTabs.List {...props} className={cx('cs-ui-tablist', className)} />;
}
export function Tab({ className, ...props }: ComponentPropsWithoutRef<typeof RTabs.Trigger>): JSX.Element {
  // a tab with no TabPanel (the page below it is the panel) must not point at a panel that is not there
  return <RTabs.Trigger {...props} className={cx('cs-ui-tab', className)} />;
}
export function TabPanel({ className, ...props }: ComponentPropsWithoutRef<typeof RTabs.Content>): JSX.Element {
  return <RTabs.Content {...props} className={cx('cs-ui-tabpanel', className)} />;
}
