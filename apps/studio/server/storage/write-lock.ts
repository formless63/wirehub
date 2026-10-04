/**
 * One writer at a time (storage seams).
 *
 * The handlers used to be synchronous, so a mutating request ran start to
 * finish before the next one began — which is what made "read the version on
 * disk, compare If-Match, write" safe. Now that they await their stores, two
 * mutating requests could interleave between the check and the write; this
 * lock puts them back in single file. Reads never wait for it.
 *
 * Per process, in memory: the file backend's writes all come from this
 * process. A backend shared by several processes (Postgres) gets the same
 * guarantee from the change set's `expect` preconditions inside its own
 * transaction.
 */

let tail: Promise<void> = Promise.resolve();

export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
