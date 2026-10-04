/** The storage contract's read cases on Postgres: the starter catalog imported into a fresh database. */

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';

import { openPg } from '../../server/pg/db.ts';
import { pgWorkbenchDeps } from '../../server/pg/deps.ts';
import { importCatalog } from '../../server/pg/import.ts';
import { SnapshotCache } from '../../server/pg/snapshot.ts';
import { describeStorageContract } from '../storage-contract/contract.ts';
import { describePg, freshDatabase } from './harness.ts';

describeStorageContract(
  'pg',
  async () => {
    const database = await freshDatabase();
    const handle = openPg(database.appUrl, { max: 2 });
    const report = await importCatalog(handle.db, { org: { slug: 'starter', create: true }, files: readCatalogTree(dataPath('..')) });
    return {
      deps: pgWorkbenchDeps({ cache: new SnapshotCache(handle.db, report.orgId) }),
      close: async () => {
        await handle.close();
        await database.drop();
      },
    };
  },
  describePg,
);
