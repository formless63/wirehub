/**
 * The "New hub" strip on the designs list: one line, a few first steps, a close button.
 * Dismissing it is the hub's (`hub-settings.browser.ts`), so nobody sees it again.
 */

import { IconX } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { JSX } from 'react';

import { helpUrl } from '../help.ts';
import { useDocsBase } from '../hooks/useDocsBase.ts';
import { dismissWelcome, fetchHub, hubKey, type HubSettings } from '../hub-settings.browser.ts';

const STEP = 'text-ink underline decoration-line-field underline-offset-2 hover:decoration-accent';

export function NewHubStrip({ firstDesign, onNewDesign }: { firstDesign: string | undefined; onNewDesign: () => void }): JSX.Element | null {
  const client = useQueryClient();
  const docsBase = useDocsBase();
  const hub = useQuery({ queryKey: hubKey, queryFn: () => fetchHub(), retry: false, staleTime: Infinity });
  if (hub.data === undefined || hub.data.welcomeDismissed) return null;
  return (
    <div role="region" aria-label="New hub" data-testid="new-hub-strip" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent-soft px-4 py-1.5 text-sm">
      <strong className="font-semibold text-ink">New hub</strong>
      <span className="text-dim">Start with</span>
      {firstDesign === undefined ? null : (
        <Link to="/cables/$id" params={{ id: firstDesign }} className={STEP}>
          open an example
        </Link>
      )}
      <button type="button" className={`min-h-0! border-0! bg-transparent! p-0! text-sm ${STEP}`} onClick={onNewDesign}>
        make a design
      </button>
      <Link to="/library" className={STEP}>
        browse the library
      </Link>
      <Link to="/part-numbers" className={STEP}>
        set up part numbers
      </Link>
      <Link to="/modules" className={STEP}>
        add a module
      </Link>
      <a href={helpUrl('designs', docsBase)} target="_blank" rel="noreferrer" className="text-dim underline">
        Docs
      </a>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss for everyone on this hub"
        className="ml-auto flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent text-dim hover:text-ink"
        onClick={() => {
          client.setQueryData(hubKey, (old: HubSettings | undefined) => ({ ...old, welcomeDismissed: true }));
          void dismissWelcome();
        }}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}
