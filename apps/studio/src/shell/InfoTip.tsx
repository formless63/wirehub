/**
 * The `(?)` that holds an explanation so the page does not have to print it: the text is the
 * tooltip, and with a `topic` the mark is also the link to that page of the docs ("Learn more").
 */

import type { JSX } from 'react';

import { helpUrl, type HelpTopic } from '../help.ts';

export function InfoTip({ text, topic, label = 'More about this' }: { text: string; topic?: HelpTopic; label?: string }): JSX.Element {
  const className = 'ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line align-middle text-2xs font-semibold leading-none text-dim no-underline hover:text-ink';
  const tip = topic === undefined ? text : `${text} Select to learn more.`;
  if (topic === undefined) {
    return (
      <span role="note" tabIndex={0} title={tip} aria-label={`${label}: ${text}`} data-testid="info-tip" className={className}>
        ?
      </span>
    );
  }
  return (
    <a href={helpUrl(topic)} target="_blank" rel="noreferrer" title={tip} aria-label={`${label}: ${text}`} data-testid="info-tip" className={className}>
      ?
    </a>
  );
}
