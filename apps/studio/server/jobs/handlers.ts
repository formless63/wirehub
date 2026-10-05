/**
 * The handlers every backend runs (`types.ts`): an import, a model build
 * sweep, an upload's conversion. The database backend adds its own
 * housekeeping (`pg/jobs.ts` `pgHousekeepingHandlers`: derive repair, blob
 * GC, the backup watch).
 */

import type { WorkbenchDeps } from '../api.ts';
import type { BlobStore } from '../blobs.ts';
import { runConvertJob } from './convert.ts';
import { runImportJob } from './import.ts';
import { parseWindow, runModelCacheJob, sourcesFromEnv, type ModelCacheJobOptions } from './model-cache.ts';
import type { Notifier } from '../notify.ts';
import type { JobHandlers } from './types.ts';

export interface BaseHandlerOptions {
  deps: WorkbenchDeps;
  blobs?: BlobStore;
  /** the org the bytes are kept under (pg); with `blobs`, the `convert` job runs */
  orgId?: string;
  env?: Record<string, string | undefined>;
  /** the live settings' environment (`runtime-settings.ts`), read at each run; wins over `env` */
  liveEnv?: () => Readonly<Record<string, string | undefined>>;
  notify?: Notifier;
  /** a model build's cache write with its provenance (pg) */
  putModel?: ModelCacheJobOptions['put'];
}

export function baseJobHandlers(options: BaseHandlerOptions): JobHandlers {
  const envNow = (): Readonly<Record<string, string | undefined>> => options.liveEnv?.() ?? options.env ?? process.env;
  const handlers: JobHandlers = {
    import: (context) => runImportJob(context, { deps: options.deps, ...(options.blobs === undefined ? {} : { blobs: options.blobs }) }),
    'model-cache': async (context) => {
      const env = envNow();
      // the build window may be changed in Settings at any time: read at each run
      const window = parseWindow(env.WIREHUB_CONVERT_WINDOW);
      const outcome = await runModelCacheJob(context, {
        deps: options.deps,
        sources: sourcesFromEnv(options.deps, { ...env }),
        ...(window === undefined ? {} : { window }),
        ...(options.putModel === undefined ? {} : { put: options.putModel }),
      });
      const failed = (outcome.result['failed'] as unknown[] | undefined) ?? [];
      if (failed.length > 0) {
        await options.notify?.notify({ event: 'model-cache-failures', severity: 'default', title: 'Models not built', message: `${failed.length} model(s) could not be built in the last sweep.`, data: { failed } });
      }
      return outcome;
    },
  };
  if (options.blobs !== undefined && options.orgId !== undefined) {
    const { blobs, orgId } = options;
    handlers.convert = (context) => runConvertJob(context, { blobs, orgId });
  }
  return handlers;
}
