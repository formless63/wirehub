/**
 * The worker, as a function (`worker.ts` is the process around it): open the
 * database, wait for an organisation, work every queue, schedule the
 * housekeeping, beat the heartbeat, run the boot sweep. Tests start it in
 * process with their own modules.
 */

import { closeSync, openSync, utimesSync } from 'node:fs';
import { hostname } from 'node:os';

import { sql } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { isLiveRegistry, type ModuleRegistry, type WireHubModule } from '@wirehub/modules';

import { blobStoreFromEnv, type BlobStore } from './blobs.ts';
import { memoryEventHub } from './events.ts';
import { liveNotifier } from './notify.ts';
import { pgSecretStore } from './pg/settings-secrets.ts';
import { createRuntimeSettings, type RuntimeSettings } from './runtime-settings.ts';
import { settingsCipherFromEnv } from './settings-secrets.ts';
import { createJobService, executeJob } from './jobs/service.ts';
import { createWebhookEmitter } from './webhooks/emitter.ts';
import { moduleJobKinds, moduleSchedules } from './jobs/module-queues.ts';
import type { JobKind, JobService } from './jobs/types.ts';
import { pgAppConfigFromEnv, redactUrl } from './pg/config.ts';
import { openPg, resolveOrgId, type PgHandle } from './pg/db.ts';
import { checkDatabase, pgWorkbenchDeps } from './pg/deps.ts';
import { beat, bossJobRunner, bossQueueName, BOSS_SCHEMA, lastBeat, pgJobHandlers, pgJobStore, startBoss, type BossPayload } from './pg/jobs.ts';
import { SnapshotCache } from './pg/snapshot.ts';
import { describeMirror, gitMirrorConfigFromEnv } from './history/mirror.ts';
import { attachCodeModules } from './code-modules/index.ts';
import type { CodeModuleHost } from './code-modules/host.ts';
import { builtinModules, registry } from './modules.ts';

export interface WorkerOptions {
  env?: Record<string, string | undefined>;
  /** the deployment's modules (default: `modules.config.ts`) */
  modules?: ModuleRegistry;
  blobs?: BlobStore;
  log?: (line: string) => void;
  /** retries while the database or the blob store is still starting (default 30, 2 s apart) */
  attempts?: number;
  /** the image's built-in modules, when `modules` is a live registry of a test's own (default `modules.config.ts`) */
  builtins?: readonly WireHubModule[];
  /** the studio asked for a restart (`NOTIFY studio_control`): the caller drains and exits (`worker.ts`) */
  onRestart?: () => void;
  /** the module cache directory for runtime code modules (default `WIREHUB_MODULE_CACHE_DIR`) */
  moduleCacheDir?: string;
}

export interface RunningWorker {
  orgId: string;
  kinds: readonly JobKind[];
  jobs: JobService;
  handle: PgHandle;
  /** the live settings the worker reads (the webhook, the git mirror, the build window, the backup age) */
  settings: RuntimeSettings;
  /** the schedules in force, by kind (they move when the settings do) */
  schedules(): Readonly<Record<string, string>>;
  /** the runtime code modules this worker loaded (absent with a fixed registry of a test's own) */
  codeModules?: CodeModuleHost;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Start the worker; resolves once it works its queues (after first-run setup, if the hub is in it). `undefined` when stopped while waiting. */
export async function startWorker(options: WorkerOptions = {}, stopping: () => boolean = () => false): Promise<RunningWorker | undefined> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(`[worker] ${line}`));
  const attempts = options.attempts ?? 30;
  const beatFile = env.WIREHUB_WORKER_BEAT_FILE ?? '/tmp/wirehub-worker.beat';
  const touchBeat = (): void => {
    try {
      const now = new Date();
      closeSync(openSync(beatFile, 'a'));
      utimesSync(beatFile, now, now);
    } catch {
      // a read-only /tmp only costs the container health check
    }
  };

  const blobs = options.blobs ?? blobStoreFromEnv(env);
  if (blobs !== undefined && 'ensureBucket' in blobs && typeof blobs.ensureBucket === 'function') {
    const ensure = blobs.ensureBucket as () => Promise<void>;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await ensure();
        break;
      } catch (error) {
        if (attempt >= attempts) throw new Error(`${blobs.describe}: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(2000);
      }
    }
  }

  const config = pgAppConfigFromEnv(env);
  const handle = openPg(config.url, { max: 4, applicationName: 'wirehub-worker' });
  let boss: PgBoss | undefined;
  let beatTimer: ReturnType<typeof setInterval> | undefined;
  let cache: SnapshotCache | undefined;
  let unfollow: (() => void) | undefined;
  const stop = async (): Promise<void> => {
    if (beatTimer !== undefined) clearInterval(beatTimer);
    unfollow?.();
    await boss?.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
    await cache?.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
  };
  try {
    // the schema is current (migrate ran first), and there is an organisation to work for
    for (let attempt = 1; ; attempt += 1) {
      try {
        await checkDatabase(handle.db, undefined);
        break;
      } catch (error) {
        if (attempt >= attempts) throw error;
        await sleep(2000);
      }
    }
    let orgId = await resolveOrgId(handle.db, config.org);
    if (orgId === undefined) log(`${redactUrl(config.url)} has no organisation yet: waiting for first-run setup (/setup)`);
    while (orgId === undefined && !stopping()) {
      touchBeat();
      await sleep(5000);
      orgId = await resolveOrgId(handle.db, config.org);
    }
    if (orgId === undefined) {
      await stop();
      return undefined;
    }
    await checkDatabase(handle.db, orgId);
    const org = orgId;

    cache = new SnapshotCache(handle.db, org);
    const deps = pgWorkbenchDeps({ cache, db: handle.db, ...(blobs === undefined ? {} : { blobs }), ...(options.modules === undefined ? {} : { modules: options.modules }) });
    // the runtime settings (specs/runtime-settings.md): the environment wins, else what was saved in Settings
    const cipher = settingsCipherFromEnv(env);
    const settings = createRuntimeSettings({ env, docs: () => deps.docs, secrets: () => pgSecretStore(handle.db, org), org: () => org, ...(cipher === undefined ? {} : { cipher }), log: (line) => log(line) });
    await settings.refresh();
    // a save in the studio reaches the worker through the catalog's NOTIFY (and the heartbeat, below, as a fallback)
    const events = memoryEventHub();
    await cache.listen(config.url, events).catch((error: unknown) => log(`LISTEN unavailable (${error instanceof Error ? error.message : String(error)}); settings follow the heartbeat`));
    unfollow = settings.follow(events);
    // runtime code modules (specs/runtime-modules.md): the same set the studio runs, loaded before the queues are
    // bound, and following the same notification; a restart request from Settings arrives on studio_control
    const live = options.modules === undefined ? registry : isLiveRegistry(options.modules) ? options.modules : undefined;
    let codeModules: CodeModuleHost | undefined;
    if (live !== undefined) {
      const attached = attachCodeModules(deps, { builtins: options.builtins ?? builtinModules, live, log: (line) => log(`[modules] ${line}`), ...(options.moduleCacheDir === undefined ? {} : { cacheDir: options.moduleCacheDir }) });
      codeModules = attached.host;
      const stopFollowing = events.subscribe((event) => {
        if (event.type === 'catalog') void attached.host.sync();
      });
      const previous = unfollow;
      unfollow = () => {
        previous?.();
        stopFollowing();
        attached.stop();
      };
      await attached.host.sync();
      attached.host.markBooted();
    }
    const stopControl = events.subscribe((event) => {
      if (event.type === 'control' && event.action === 'restart') {
        log('restart requested by the studio (Settings, Restart WireHub)');
        options.onRestart?.();
      }
    });
    const followed = unfollow;
    unfollow = () => {
      followed?.();
      stopControl();
    };
    const liveEnv = (): Record<string, string | undefined> => ({ ...settings.env() });
    const store = pgJobStore(handle.db, org);
    const notify = liveNotifier(() => settings.env());
    // the worker delivers the webhooks and announces its jobs finishing: it reads the subscriptions and the secrets itself
    deps.runtimeSettings = settings;
    deps.webhooks = createWebhookEmitter({ docs: () => deps.docs, jobs: () => deps.jobs, env: () => settings.env() });
    const handlers = pgJobHandlers({ deps, db: handle.db, orgId: org, cache, ...(blobs === undefined ? {} : { blobs }), env, liveEnv, notify });
    const kinds = Object.keys(handlers) as JobKind[];

    // pg_dump runs as studio_ro: it must read the queue tables this role creates (0016)
    await sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${BOSS_SCHEMA} GRANT SELECT ON TABLES TO studio_ro`).execute(handle.db);
    await sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${BOSS_SCHEMA} GRANT SELECT ON SEQUENCES TO studio_ro`).execute(handle.db);
    boss = await startBoss(config.url, 'worker', log, moduleJobKinds(deps.modules));
    await sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA ${BOSS_SCHEMA} TO studio_ro`).execute(handle.db);
    await sql.raw(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${BOSS_SCHEMA} TO studio_ro`).execute(handle.db);
    const boundBoss = boss;
    const jobs = createJobService({ store, runner: bossJobRunner(async () => boundBoss, () => org), kinds, worker: () => lastBeat(handle.db, org) });
    deps.jobs = jobs;

    const afterJob = (line: string): void => log(`${line} (worker rss ${Math.round(process.memoryUsage().rss / 1048576)} MiB)`);
    for (const kind of kinds) {
      await boss.work<BossPayload>(bossQueueName(kind), { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: kind === 'convert' || kind === 'import' || kind === 'webhook' ? 1 : 5 }, async ([job]) => {
        if (job === undefined) return;
        const payload = job.data;
        if (payload.org !== org) {
          log(`skipped a ${kind} job for another organisation (${payload.org})`);
          return;
        }
        // a scheduled run has no row yet
        const id = payload.id ?? (await store.create(kind, { reason: 'schedule' })).id;
        await executeJob(store, handlers, id, afterJob, (finished) => deps.webhooks?.jobFinished(finished));
      });
    }

    // schedules (container time; TZ sets it). The build window and the git mirror come from the
    // live settings: set, changed or turned off in Settings, they are rescheduled here, no restart
    const tz = env.TZ ?? 'UTC';
    const fixed: { kind: JobKind; cron: string }[] = [
      { kind: 'backup', cron: env.WIREHUB_BACKUP_WATCH_CRON ?? '15 * * * *' },
      { kind: 'derive', cron: env.WIREHUB_DERIVE_CRON ?? '0 4 * * *' },
      { kind: 'blob-gc', cron: env.WIREHUB_GC_CRON ?? '30 4 * * *' },
      // a module queue's own schedule
      ...moduleSchedules(deps.modules),
    ];
    const mirrorOf = (current: Readonly<Record<string, string | undefined>>): ReturnType<typeof gitMirrorConfigFromEnv> => {
      try {
        return gitMirrorConfigFromEnv(current);
      } catch (error) {
        log(`git mirror not scheduled: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };
    const liveSchedules = (current: Readonly<Record<string, string | undefined>>): { kind: JobKind; cron?: string }[] => {
      const window = /^\s*(\d{1,2}):(\d{2})\s*-/.exec(current.WIREHUB_CONVERT_WINDOW ?? '');
      const mirror = mirrorOf(current);
      return [
        { kind: 'model-cache', ...(window === null ? {} : { cron: `${Number(window[2])} ${Number(window[1])} * * *` }) },
        // the git mirror, when configured: every change set as a commit (cs-5k1.4)
        { kind: 'git-mirror', ...(mirror === undefined ? {} : { cron: mirror.cron }) },
      ];
    };
    const inForce: Record<string, string> = {};
    const payload: BossPayload = { org, scheduled: true };
    for (const s of fixed) {
      if (!kinds.includes(s.kind)) continue;
      await boss.schedule(bossQueueName(s.kind), s.cron, payload as unknown as object, { tz });
      inForce[s.kind] = s.cron;
    }
    let lastMirror = '';
    const applySchedules = async (current: Readonly<Record<string, string | undefined>>): Promise<void> => {
      for (const s of liveSchedules(current)) {
        if (!kinds.includes(s.kind) || inForce[s.kind] === s.cron) continue;
        if (s.cron === undefined) {
          await started.unschedule(bossQueueName(s.kind));
          delete inForce[s.kind];
          log(`${s.kind}: not scheduled`);
        } else {
          await started.schedule(bossQueueName(s.kind), s.cron, payload as unknown as object, { tz });
          inForce[s.kind] = s.cron;
          log(`${s.kind}: scheduled "${s.cron}" (${tz})`);
        }
      }
      const mirror = mirrorOf(current);
      const described = mirror === undefined ? '' : describeMirror(mirror);
      if (described !== lastMirror && described !== '') log(`git mirror to ${described}`);
      lastMirror = described;
    };
    let applying: Promise<void> = Promise.resolve();
    const reschedule = (current: Readonly<Record<string, string | undefined>>): void => {
      applying = applying.then(() => applySchedules(current)).catch((error: unknown) => log(`rescheduling failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    const started = boss;
    await applySchedules(settings.env());
    settings.onChange(reschedule);

    // the heartbeat
    const me = { worker: hostname(), version: env.WIREHUB_VERSION ?? 'dev', startedAt: new Date().toISOString(), queues: kinds };
    const doBeat = async (): Promise<void> => {
      touchBeat();
      await beat(handle.db, org, me).catch((error: unknown) => log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`));
      // the settings, once a minute, in case a notification was missed
      await settings.refresh().catch((error: unknown) => log(`settings refresh failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    await doBeat();
    beatTimer = setInterval(() => void doBeat(), 60_000);
    beatTimer.unref?.();

    // the boot sweep: every live model key built, the derived records sound, the backups looked at
    for (const kind of ['model-cache', 'derive', 'backup', 'git-mirror'] as const) {
      if (kind === 'git-mirror' && inForce['git-mirror'] === undefined) continue;
      if (kinds.includes(kind)) await jobs.enqueue(kind, { reason: 'boot' });
    }
    log(`working ${kinds.join(', ')} for org ${org}; blobs ${blobs?.describe ?? 'none'}; schedules ${Object.entries(inForce).map(([kind, cron]) => `${kind} "${cron}"`).join(', ')} (${tz})`);
    return {
      orgId: org,
      kinds,
      jobs,
      handle,
      settings,
      schedules: () => ({ ...inForce }),
      ...(codeModules === undefined ? {} : { codeModules }),
      stop: async () => {
        await applying;
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
