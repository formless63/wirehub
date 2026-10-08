/** An empty list says one thing, offers the one thing to do next, and points at the docs. */

import { EmptyState as UiEmptyState } from '@wirehub/editor-react';
import type { JSX, ReactNode } from 'react';

import { helpUrl, type HelpTopic } from '../help.ts';

export function EmptyState({ children, action, topic, href }: { children: ReactNode; action?: ReactNode; topic: HelpTopic; href?: string }): JSX.Element {
  return (
    <UiEmptyState action={action} learnMore={href ?? helpUrl(topic)}>
      {children}
    </UiEmptyState>
  );
}

/** a link or button that reads as the primary button */
export const EMPTY_PRIMARY = 'cs-ui-btn is-primary no-underline';
