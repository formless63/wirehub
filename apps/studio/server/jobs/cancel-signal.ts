/** The cancel signal the native tool-pack job runners share (moved from `tool-stages.ts`). */

import type { JobContext } from './types.ts';

/**
 * An abort signal that fires when the job is cancelled (polled through `JobContext.cancelled`):
 * hand it to the runner, which kills the container. Call `done` when the op is over.
 */
export function cancelSignal(context: JobContext, pollMs = 1000): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const poll = setInterval(() => {
    void context.cancelled?.().then((yes) => {
      if (yes) controller.abort();
    }).catch(() => undefined);
  }, pollMs);
  poll.unref?.();
  return { signal: controller.signal, done: () => clearInterval(poll) };
}
