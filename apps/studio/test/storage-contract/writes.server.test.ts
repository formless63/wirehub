/**
 * The write contract on the in-memory commit tree: the stores the Postgres
 * commit applies a change set through, with no database underneath. The
 * file backend and Postgres run the same session (`writes-files.server.test.ts`,
 * `test/pg/writes.server.test.ts`) and must answer it identically.
 */

import { describe, expect, it } from 'vitest';

import { batchScenario } from './batch.ts';
import { memoryWriteBackend, writeScenario } from './writes.ts';

describe('storage contract (writes): memory commit tree', () => {
  it('answers the session and ends with a consistent catalog', async () => {
    const { log, exported } = await writeScenario(memoryWriteBackend());
    expect(log.length).toBeGreaterThan(30);
    expect(Object.keys(exported.files)).toContain('data/designs/dc-led-lead-renamed.json');
    expect(Object.keys(exported.files)).not.toContain('data/designs/de9-crossover-copy.json');
    expect(exported.files['data/designs/_versions/de9-crossover/drafts/1.json']).toBeDefined();
  });

  it('runs the batch and dry-run session', async () => {
    const log = await batchScenario(memoryWriteBackend().deps);
    expect(log.length).toBeGreaterThan(10);
  });
});
