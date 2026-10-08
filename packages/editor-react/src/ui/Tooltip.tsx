import { Tooltip as RTooltip } from 'radix-ui';
import type { JSX, ReactElement, ReactNode } from 'react';

import { Kbd } from './Kbd.tsx';
import { usePortalContainer } from './portal.ts';

export interface TooltipProps {
  content: ReactNode;
  /** a shortcut shown beside the text */
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** the one trigger element; it keeps its own role and gains `aria-describedby` while open */
  children: ReactElement;
}

/** Hover or keyboard focus shows it; Escape closes it. Carries its own provider, so no app-level setup. */
export function Tooltip({ content, shortcut, side = 'top', children }: TooltipProps): JSX.Element {
  const container = usePortalContainer();
  return (
    <RTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal container={container}>
          <RTooltip.Content className="cs-ui-tooltip" side={side} sideOffset={6}>
            {content}
            {shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}
