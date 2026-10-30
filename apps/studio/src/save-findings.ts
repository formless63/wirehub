/**
 * The server answers a save that kept advisory findings with `X-WireHub-Findings: 2 problems,
 * 1 warning to look at` (`server/api.ts`, `server/definitions.ts`, `server/wire-library.ts`): the
 * save went through, and these are what the server's checks (modules included) want looked at.
 * The adapters read the header here and the save toast shows it.
 */

import type { Outcome } from '@wirehub/editor-react';

export const FINDINGS_HEADER = 'x-wirehub-findings';

/** a successful outcome carrying the server's findings line, when it sent one */
export type WithFindings<T> = Outcome<T> & { findings?: string };

export function findingsOf(outcome: Outcome<unknown>): string | undefined {
  const line = (outcome as { findings?: unknown }).findings;
  return outcome.ok && typeof line === 'string' && line !== '' ? line : undefined;
}

/** run a request whose `onResponse` also records the findings header, and attach it to the outcome */
export async function withFindings<T>(run: (onResponse: (response: Response) => void) => Promise<Outcome<T>>, also?: (response: Response) => void): Promise<WithFindings<T>> {
  let line: string | null = null;
  const outcome = await run((response) => {
    also?.(response);
    line = response.headers.get(FINDINGS_HEADER);
  });
  return outcome.ok && line !== null && line !== '' ? { ...outcome, findings: line } : outcome;
}

/** the save toast's options: the findings line as its description */
export function findingsToast(outcome: Outcome<unknown>): { description?: string } {
  const line = findingsOf(outcome);
  return line === undefined ? {} : { description: `Saved with ${line}.` };
}
