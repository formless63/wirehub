/**
 * The route badge: how a cable or a part is sourced (`@wirehub/model` `products.ts`) — `CM` for a
 * contract manufacturer, `BUY` for bought in finished, `MAKE` for in house. Nothing when the
 * record states no route. The maker's name is in the tooltip only.
 */

import { ROUTE_LABELS, type PartRoute } from '@wirehub/model';
import type { JSX } from 'react';

const SHORT: Record<PartRoute, string> = { make: 'make', contract: 'cm', buy: 'buy' };

export function RouteChip(props: { route: PartRoute | undefined; maker?: string | undefined }): JSX.Element | null {
  if (props.route === undefined) return null;
  return (
    <span
      title={`${ROUTE_LABELS[props.route]}${props.maker === undefined ? '' : `: ${props.maker}`}`}
      data-route={props.route}
      className="shrink-0 rounded-sm border border-line2 px-1 font-mono text-2xs leading-[14px] tracking-wide text-dim uppercase"
    >
      {SHORT[props.route]}
    </span>
  );
}
