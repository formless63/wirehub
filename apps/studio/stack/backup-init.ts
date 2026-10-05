/**
 * `backup-init` — the one-shot of the `backup` profile (`compose.yaml`).
 * Backups then work with nothing configured by hand:
 *
 * - copies the staging scripts (`docker/backup/pg-dump.sh`, `blob-mirror.sh`)
 *   from the image into the secrets volume, where `backup-dump` and
 *   `backup-mirror` (stock Postgres and rclone images) run them — so the
 *   stack needs no file from a clone of the repository;
 * - keeps the restic repository password in the volume (`restic_password`:
 *   `BACKUP_REPOSITORY_PASSWORD` when set, else generated once);
 * - on first run only, writes Backrest's configuration: one repository
 *   (`BACKUP_REPOSITORY`, else a local repository in the `restic_repo` volume)
 *   and one plan — `/sources`, on `BACKUP_SCHEDULE` (cron, default daily at
 *   03:00), keeping 7 daily, 4 weekly and 12 monthly snapshots, with a weekly
 *   prune and check, and a post-snapshot hook that touches the marker
 *   (`/marker/.last-snapshot`, read by the app and the worker). After that Backrest's UI owns its configuration, and this
 *   never touches it again.
 *
 *   node --experimental-strip-types stack/backup-init.ts
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { base64url, ensureSecret, explicitValue, prepareDir, secretsDir, type Env } from './secrets.ts';

/** The repository used when `BACKUP_REPOSITORY` is unset: a volume on this machine. */
export const LOCAL_REPOSITORY = '/repos/wirehub';
export const DEFAULT_SCHEDULE = '0 3 * * *';

/** A five-field cron expression, or a sentence saying why not. */
export function checkCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => /^[0-9*,/\-A-Za-z]+$/.test(f))) {
    throw new Error(`BACKUP_SCHEDULE must be a five-field cron expression (minute hour day month weekday), e.g. "0 3 * * *"; got "${expression}".`);
  }
  return fields.join(' ');
}

/** Where the post-snapshot hook touches its marker, in Backrest's container (the `backup_marker` volume). */
export const MARKER_FILE = '/marker/.last-snapshot';
export const FAILURE_FILE = '/marker/.last-failure';

/** Backrest's configuration for a first start. */
export function backrestConfig(options: { repository: string; password: string; schedule: string; env?: Record<string, string> }): unknown {
  const env = Object.entries(options.env ?? {}).map(([name, value]) => `${name}=${value}`);
  return {
    modno: 1,
    version: 6,
    instance: 'wirehub',
    repos: [
      {
        id: 'wirehub',
        uri: options.repository,
        password: options.password,
        ...(env.length === 0 ? {} : { env }),
        // a new repository is created on first use; an existing one needs its password (BACKUP_REPOSITORY_PASSWORD)
        autoInitialize: true,
        autoUnlock: true,
        prunePolicy: { schedule: { cron: '0 4 * * 0', clock: 'CLOCK_LAST_RUN_TIME' }, maxUnusedPercent: 10 },
        checkPolicy: { schedule: { cron: '0 5 * * 0', clock: 'CLOCK_LAST_RUN_TIME' }, readDataSubsetPercent: 0 },
      },
    ],
    plans: [
      {
        id: 'wirehub',
        repo: 'wirehub',
        paths: ['/sources'],
        schedule: { cron: options.schedule, clock: 'CLOCK_LOCAL' },
        retention: { policyTimeBucketed: { daily: 7, weekly: 4, monthly: 12 } },
        // a finished snapshot touches the marker: blob clean-up deletes only after one, and /healthz?deep=1 reports its age
        hooks: [
          { conditions: ['CONDITION_SNAPSHOT_SUCCESS'], actionCommand: { command: `touch ${MARKER_FILE}` } },
          // the worker's backup watch alerts on a failure newer than the last success
          { conditions: ['CONDITION_SNAPSHOT_ERROR'], actionCommand: { command: `touch ${FAILURE_FILE}` } },
        ],
      },
    ],
    // no `auth`: Backrest asks the first visitor of its UI to create a login
  };
}

/** Where the staging scripts are in the image (this checkout's `docker/backup/`). */
export function scriptsSource(): string {
  return fileURLToPath(new URL('../../../docker/backup/', import.meta.url));
}

export function backupInit(env: Env, log: (line: string) => void = console.log): void {
  const dir = secretsDir(env);
  prepareDir(dir);

  const source = env['BACKUP_SCRIPTS_SRC'] ?? scriptsSource();
  mkdirSync(join(dir, 'backup'), { recursive: true });
  const scripts = readdirSync(source).filter((name) => name.endsWith('.sh'));
  for (const name of scripts) copyFileSync(join(source, name), join(dir, 'backup', name));
  log(`backup-init: staging scripts ready (${scripts.join(', ')})`);

  const { value: password, source: passwordSource } = ensureSecret(dir, 'restic_password', explicitValue(env, 'BACKUP_REPOSITORY_PASSWORD'), () => base64url(32));
  log(`backup-init: restic_password ${passwordSource}`);

  // tells the app and the worker that backups are on (the volume exists without the profile): a missing marker then means "no snapshot yet"
  const markerDir = env['BACKUP_MARKER_DIR'] ?? '/marker';
  if (existsSync(markerDir)) writeFileSync(join(markerDir, '.configured'), '');

  const configPath = env['BACKREST_CONFIG'] ?? '/config/config.json';
  if (existsSync(configPath)) {
    log('backup-init: Backrest is configured already — change repositories and plans in its UI');
    return;
  }
  const repository = explicitValue(env, 'BACKUP_REPOSITORY') ?? LOCAL_REPOSITORY;
  const schedule = checkCron(env['BACKUP_SCHEDULE'] || DEFAULT_SCHEDULE);
  const repoEnv: Record<string, string> = {};
  const awsId = explicitValue(env, 'BACKUP_AWS_ACCESS_KEY_ID');
  const awsSecret = explicitValue(env, 'BACKUP_AWS_SECRET_ACCESS_KEY');
  if (awsId !== undefined && awsSecret !== undefined) {
    repoEnv['AWS_ACCESS_KEY_ID'] = awsId;
    repoEnv['AWS_SECRET_ACCESS_KEY'] = awsSecret;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(backrestConfig({ repository, password, schedule, env: repoEnv }), null, 2)}\n`, { mode: 0o600 });
  log(`backup-init: Backrest configured — repository ${repository.replace(/\/\/[^@/]*@/, '//…@')}, plan /sources on "${schedule}"`);
  if (repository === LOCAL_REPOSITORY) {
    log('backup-init: WARNING the repository is a volume on this machine: it protects against mistakes, not against losing the disk. Set BACKUP_REPOSITORY (or add one in Backrest) to keep a copy elsewhere.');
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    backupInit(process.env);
  } catch (error) {
    console.error(`backup-init: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
