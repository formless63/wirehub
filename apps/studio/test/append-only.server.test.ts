/** Commissioning records are append-only at every commit, whatever route staged the change. */

import { describe, expect, it } from 'vitest';

import { refuseAppendOnlyRewrites } from '../server/storage/append-only.ts';
import type { RecordChange } from '../server/storage/change-set.ts';

const key = 'data/firmware/commissions/synthetic-project.json';
const older = { id: 'c1', result: 'ok' };
const newer = { id: 'c2', result: 'ok', corrects: 'c1' };
const docs = (value: unknown) => ({ docs: { read: async () => value } }) as unknown as Parameters<typeof refuseAppendOnlyRewrites>[0];
const put = (value: unknown): RecordChange => ({ kind: 'doc', key, op: 'put', value });

describe('append-only commissioning records', () => {
  it('lets a record be added and refuses any rewrite or removal', async () => {
    await expect(refuseAppendOnlyRewrites(docs(undefined), [put([older])])).resolves.toBeUndefined();
    await expect(refuseAppendOnlyRewrites(docs([older]), [put([newer, older])])).resolves.toBeUndefined();
    for (const change of [put([]), put([{ ...older, result: 'failed' }]), put([older, newer]), { kind: 'doc', key, op: 'delete' } as RecordChange]) {
      await expect(refuseAppendOnlyRewrites(docs([older]), [change])).rejects.toMatchObject({ status: 403 });
    }
    // other documents are not its business
    await expect(refuseAppendOnlyRewrites(docs([older]), [{ kind: 'doc', key: 'data/firmware/other.json', op: 'delete' }])).resolves.toBeUndefined();
  });
});
