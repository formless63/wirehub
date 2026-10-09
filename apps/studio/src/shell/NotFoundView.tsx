/**
 * A compact "this does not exist" state — for an unknown cable id, an unknown
 * route, or (later) an unknown library definition. Never a crash: a bad id in
 * the URL is routine (a stale bookmark, a typo, a deleted design) and the
 * screen says so in one line with a way back, per the studio-workbench UX
 * rule ("nothing dead-ends").
 */

import { Link } from '@tanstack/react-router';
import type { JSX } from 'react';

export interface NotFoundViewProps {
  message: string;
  backTo?: string;
  backLabel?: string;
}

export function NotFoundView({
  message,
  backTo = '/cables',
  backLabel = 'Back to Designs',
}: NotFoundViewProps): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-dim">
      <h1 className="m-0 text-sm font-normal">{message}</h1>
      <Link to={backTo} className="text-xs text-accent no-underline hover:underline">
        {backLabel}
      </Link>
    </div>
  );
}
