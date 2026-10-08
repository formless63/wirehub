/** An empty list says one thing, offers the one thing to do next, and points at the docs. */

import type { JSX, ReactNode } from 'react';

import { helpUrl, type HelpTopic } from '../help.ts';

export function EmptyState({ children, action, topic, href }: { children: ReactNode; action?: ReactNode; topic: HelpTopic; href?: string }): JSX.Element {
  return (
    <div data-testid="empty-state" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-dim">
      <span>{children}</span>
      {action}
      <a href={href ?? helpUrl(topic)} target="_blank" rel="noreferrer" className="text-dim underline hover:text-ink">
        Learn more
      </a>
    </div>
  );
}

export const EMPTY_PRIMARY = 'h-7 rounded-md border-0 bg-accent px-2.5 text-[12.5px] font-semibold text-accent-ink no-underline';
