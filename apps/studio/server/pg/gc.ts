/**
 * Blob GC and the backup watch (`specs/postgres-backend.md` §5.4, §8.4;
 * task C4) — worker jobs on the database backend.
 *
 * **Backups are made by the `backup` profile** (`backup-dump`: `pg_dump` as
 * `studio_ro`; `backup-mirror`: the bucket; Backrest: the snapshot). The
 * worker's `backup` job only *watches* them: it reads the backups volume
 * (mounted read-only, `WIREHUB_BACKUP_DIR`), marks the record blobs a
 * completed backup holds (`blob.backed_up_at`), and alerts when the newest
 * dump is older than 30 hours.
 *
 * A backup counts as **completed** when Backrest has snapshotted it: its
 * post-snapshot hook touches `<backups>/.last-snapshot`. Without that
 * marker no orphan record blob is ever deleted — the safe default.
 *
 * **GC** (daily, after the backup):
 * - a record blob no live row names becomes an orphan; one named again is
 *   stored again;
 * - an orphan is deleted (object, then row) after 30 days, and only if a
 *   backup completed after it became one;
 * - a derived blob no live model key names at the current converter version
 *   is expired after 7 days; its object goes with its last row;
 * - an object no row names, older than 24 hours, is deleted (an upload whose
 *   commit rolled back, a job's scratch file).
 */

import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { sql } from 'kysely';

import type { BlobStore } from '../blobs.ts';
import type { Notify } from '../jobs/notify.ts';
import type { JobContext, JobOutcome } from '../jobs/types.ts';
import { CONVERTER_VERSION } from '../models/cache.ts';
import { inOrg, type Db } from './db.ts';

export interface BackupState {
  /** the backups volume is mounted and has a dump directory */
  configured: boolean;
  /** the newest completed dump (its row-count file written) */
  dumpAt?: Date;
  dump?: string;
  /** Backrest's last successful snapshot (`.last-snapshot`) */
  snapshotAt?: Date;
}

/** What the backups volume says. */
export function readBackupState(dir: string | undefined): BackupState {
  if (dir === undefined || dir === '' || !existsSync(join(dir, 'postgres'))) return { configured: false };
  const state: BackupState = { configured: true };
  const latest = join(dir, 'postgres', 'latest.dump');
  try {
    if (lstatSync(latest).isSymbolicLink()) {
      const target = join(dirname(latest), readlinkSync(latest));
      if (existsSync(target) && existsSync(`${target}.counts`)) {
        state.dumpAt = statSync(`${target}.counts`).mtime;
        state.dump = target.slice(target.lastIndexOf('/') + 1);
      }
    }
  } catch {
    // no dump yet
  }
  const marker = join(dir, '.last-snapshot');
  if (existsSync(marker)) state.snapshotAt = statSync(marker).mtime;
  return state;
}

export interface BackupJobOptions {
  db: Db;
  orgId: string;
  dir?: string;
  notify?: Notify;
  now?: () => Date;
  /** a dump older than this is stale (§8.6), hours */
  staleHours?: number;
}

export async function runBackupJob(context: JobContext, options: BackupJobOptions): Promise<JobOutcome> {
  const state = readBackupState(options.dir);
  if (!state.configured) return { result: { configured: false } };
  const now = (options.now ?? (() => new Date()))();
  let marked = 0;
  if (state.snapshotAt !== undefined) {
    const at = state.snapshotAt.toISOString();
    marked = await inOrg(options.db, options.orgId, async (tx) =>
      Number(
        (
          await sql`
            UPDATE studio.blob SET backed_up_at = ${at}::timestamptz
             WHERE class = 'record' AND created_at <= ${at}::timestamptz AND (backed_up_at IS NULL OR backed_up_at < ${at}::timestamptz)`.execute(tx)
        ).numAffectedRows ?? 0,
      ),
    );
  }
  const staleMs = (options.staleHours ?? 30) * 3600_000;
  const stale = state.dumpAt === undefined || now.getTime() - state.dumpAt.getTime() > staleMs;
  if (stale) {
    await options.notify?.({
      event: 'backup-stale',
      severity: 'default',
      message: state.dumpAt === undefined ? 'No completed database dump in the backups volume yet.' : `The newest database dump is from ${state.dumpAt.toISOString()}, more than ${options.staleHours ?? 30} hours ago.`,
    });
  }
  await context.step(`dump ${state.dump ?? 'none'}; snapshot ${state.snapshotAt?.toISOString() ?? 'none'}; ${marked} blob(s) marked backed up`);
  return {
    result: {
      configured: true,
      dump: state.dump ?? null,
      dumpAt: state.dumpAt?.toISOString() ?? null,
      snapshotAt: state.snapshotAt?.toISOString() ?? null,
      marked,
      stale,
    },
  };
}

export interface GcOptions {
  db: Db;
  orgId: string;
  blobs?: BlobStore;
  backupDir?: string;
  /** days an orphan record blob waits (30) */
  orphanDays?: number;
  /** days an expired derived blob waits (7) */
  derivedDays?: number;
  /** hours before an object no row names is deleted (24) */
  rowlessHours?: number;
  /** hours a new, unreferenced record blob gets before it counts as an orphan (24) */
  graceHours?: number;
  builderVersion?: string;
  notify?: Notify;
}

const LIVE_RECORD_BLOBS = sql`
  SELECT sha256 FROM studio.asset
  UNION SELECT asset_sha256 FROM studio.drawing_photo
  UNION SELECT sha256 FROM studio.depiction_file
  UNION SELECT sha256 FROM studio.design_artwork
  UNION SELECT sha256 FROM studio.catalog_file
  UNION SELECT f.sha256 FROM studio.job_file f JOIN studio.job_run j ON j.id = f.job_id WHERE f.sha256 IS NOT NULL AND j.created_at > now() - interval '7 days'`;

export async function runBlobGcJob(context: JobContext, options: GcOptions): Promise<JobOutcome> {
  const { db, orgId } = options;
  const days = (n: number): ReturnType<typeof sql> => sql`(${n}::double precision * interval '1 day')`;
  const hours = (n: number): ReturnType<typeof sql> => sql`(${n}::double precision * interval '1 hour')`;
  const builder = options.builderVersion ?? CONVERTER_VERSION;
  const backup = readBackupState(options.backupDir);
  const completedAt = backup.snapshotAt?.toISOString() ?? null;

  // 1–2. orphan marking, both ways
  const marking = await inOrg(db, orgId, async (tx) => {
    const orphaned = Number(
      (
        await sql`
          UPDATE studio.blob SET state = 'orphan', orphaned_at = now()
           WHERE class = 'record' AND state <> 'orphan' AND created_at < now() - ${hours(options.graceHours ?? 24)}
             AND sha256 NOT IN (${LIVE_RECORD_BLOBS})`.execute(tx)
      ).numAffectedRows ?? 0,
    );
    const revived = Number(
      (await sql`UPDATE studio.blob SET state = 'stored', orphaned_at = NULL WHERE state = 'orphan' AND sha256 IN (${LIVE_RECORD_BLOBS})`.execute(tx)).numAffectedRows ?? 0,
    );
    return { orphaned, revived };
  });

  // 3. orphans past their wait, captured by a backup completed after they became orphans
  const doomed =
    completedAt === null
      ? []
      : await inOrg(db, orgId, async (tx) =>
          (
            await sql<{ sha256: string; object_key: string }>`
              SELECT sha256, object_key FROM studio.blob
               WHERE class = 'record' AND state = 'orphan' AND orphaned_at < now() - ${days(options.orphanDays ?? 30)}
                 AND orphaned_at < ${completedAt}::timestamptz`.execute(tx)
          ).rows,
        );
  let deletedRecord = 0;
  for (const b of doomed) if (await deleteBlob(options, b)) deletedRecord += 1;

  // 4. derived blobs no live key names, at this converter version
  const expired = await inOrg(db, orgId, async (tx) => {
    const rows = (
      await sql<{ sha256: string }>`
        DELETE FROM studio.derived_blob d
         WHERE d.built_at < now() - ${days(options.derivedDays ?? 7)}
           AND (d.builder_version <> ${builder}
                OR (d.cache = 'model' AND d.key NOT IN (SELECT asset_key FROM studio.model_link WHERE imported AND asset_key IS NOT NULL)))
        RETURNING d.sha256`.execute(tx)
    ).rows;
    return rows.length;
  });
  const unreferencedDerived = await inOrg(db, orgId, async (tx) =>
    (
      await sql<{ sha256: string; object_key: string }>`
        SELECT b.sha256, b.object_key FROM studio.blob b
         WHERE b.class = 'derived' AND NOT EXISTS (SELECT 1 FROM studio.derived_blob d WHERE d.sha256 = b.sha256)`.execute(tx)
    ).rows,
  );
  let deletedDerived = 0;
  for (const b of unreferencedDerived) if (await deleteBlob(options, b)) deletedDerived += 1;

  // 5. objects no row names
  let deletedObjects = 0;
  let listed = 0;
  if (options.blobs?.list !== undefined) {
    const known = new Set(
      await inOrg(db, orgId, async (tx) => (await sql<{ object_key: string }>`SELECT object_key FROM studio.blob`.execute(tx)).rows.map((r) => r.object_key)),
    );
    const cutoff = Date.now() - (options.rowlessHours ?? 24) * 3600_000;
    const objects = await options.blobs.list(`${orgId}/`);
    listed = objects.length;
    for (const o of objects) {
      if (known.has(o.key) || o.modified.getTime() > cutoff) continue;
      await options.blobs.delete(o.key);
      deletedObjects += 1;
    }
  }
  const result = { ...marking, completedBackup: completedAt, deletedRecord, expiredDerived: expired, deletedDerived, listed, deletedObjects };
  await context.step(`orphaned ${marking.orphaned}, revived ${marking.revived}, deleted ${deletedRecord} record + ${deletedDerived} derived blob(s) and ${deletedObjects} stray object(s)`);
  return { result };
}

/**
 * The row, then the object: a row something still references (a FK) stays
 * with its object; an object whose delete fails after its row is gone is a
 * stray, which the next sweep removes.
 */
async function deleteBlob(options: GcOptions, blob: { sha256: string; object_key: string }): Promise<boolean> {
  try {
    await inOrg(options.db, options.orgId, async (tx) => {
      await sql`DELETE FROM studio.blob WHERE sha256 = ${blob.sha256}`.execute(tx);
    });
    await options.blobs?.delete(blob.object_key);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === '23503') return false;
    await options.notify?.({ event: 'gc-error', severity: 'default', message: `GC could not delete blob ${blob.sha256}: ${error instanceof Error ? error.message : String(error)}` });
    return false;
  }
}
