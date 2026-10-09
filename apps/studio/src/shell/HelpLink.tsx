/** The `(?)` in the top bar: the docs for the page you are on (`help.ts`). */

import { IconHelp } from '@tabler/icons-react';
import type { JSX } from 'react';

import { helpForPath } from '../help.ts';
import { useDocsBase } from '../hooks/useDocsBase.ts';

export function HelpLink({ pathname }: { pathname: string }): JSX.Element {
  const { url } = helpForPath(pathname, useDocsBase());
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title="Help for this page"
      aria-label="Help for this page"
      data-testid="help-link"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-dim hover:text-ink"
    >
      <IconHelp size={15} />
    </a>
  );
}
