/**
 * The storage contract's read cases on the file backend and on the codec's
 * in-memory snapshot (the stores the pg backend uses, over rows that never
 * touched a database). Postgres runs the same cases in `test/pg/`.
 */

import { dataPath } from '@wirehub/catalog';
import { explode } from '@wirehub/catalog/src/codec/index.ts';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';

import { defaultWorkbenchDeps } from '../../server/default-deps.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { snapshotOf } from '../../server/pg/snapshot.ts';
import { describeStorageContract } from './contract.ts';

describeStorageContract('files', async () => ({ deps: defaultWorkbenchDeps() }));

describeStorageContract('memory (codec snapshot)', async () => {
  const snapshot = snapshotOf('1', explode(readCatalogTree(dataPath('..'))).rows);
  return { deps: pgWorkbenchDeps({ cache: { orgId: 'memory', get: async () => snapshot, version: async () => '1' } }) };
});
