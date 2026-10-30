/**
 * `start` — the compose stack's startup initialisation, run inside the
 * long-running services instead of separate one-shot containers
 * (`compose.yaml`: the `wirehub` and `worker` commands):
 *
 *   node --experimental-strip-types --no-warnings stack/start.ts app      then server/serve.ts
 *   node --experimental-strip-types --no-warnings stack/start.ts worker   then server/worker.ts
 *
 * The app, in order:
 *   1. secrets: fills the secrets volume (`bootstrap.ts`) — the only step
 *      that runs as root (the volume may be owned by root after an upgrade);
 *      the process then drops to the image's `node` user for good;
 *   2. the bundled S3 store, when `GARAGE_ADMIN_URL` is set: Garage's layout,
 *      access keys and bucket (`garage-init.ts`), alongside step 3;
 *   3. the database, under a Postgres advisory lock so only one process runs
 *      it at a time: the roles (`pg/bootstrap.ts`), every pending migration
 *      shipped in the image (`pg/migrate.ts`, the modules' too), and — once, on
 *      a database with no organisation — a file catalog from before the
 *      database moved in (`pg/adopt.ts`);
 *   4. then the server itself (`server/serve.ts`).
 * The worker waits for the secrets the app writes, runs step 3 (without the
 * adoption) under the same lock — a no-op when the app got there first — and
 * then starts (`server/worker.ts`).
 *
 * While this runs, the app's port answers with 503: `/healthz` says
 * `{"status":"initialising","step":…}`, every other path a short page. A
 * failure stays reported there (`"status":"failed","error":"migration failed: …"`)
 * and in the log, and the process waits: nothing is retried in a loop, no
 * migration is generated, skipped or repaired, nothing is deleted. Fix the
 * cause and restart the service. Only a database that is not reachable yet is
 * waited for (it may still be starting).
 *
 * `WIREHUB_INIT=off` skips all of it (the `init-services` profile's one-shots
 * did it instead): the entry point starts straight away.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { bootstrap } from './bootstrap.ts';
import { garageInit } from './garage-init.ts';
import { APP_GID, APP_UID, explicitValue, readSecret, secretsDir, type Env } from './secrets.ts';

type Role = 'app' | 'worker';
type Status = { status: 'initialising'; step: string } | { status: 'failed'; error: string };

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const log = (line: string): void => console.log(`[init] ${line}`);

/** Read only while starting; dropped from the environment before the server or worker starts (they never read them). */
export const INIT_ONLY_VARS = [
  'POSTGRES_PASSWORD',
  'WIREHUB_OWNER_PASSWORD',
  'WIREHUB_APP_PASSWORD',
  'WIREHUB_RO_PASSWORD',
  'DATABASE_ADMIN_URL',
  'DATABASE_OWNER_URL',
  'DATABASE_RO_URL',
  'GARAGE_ADMIN_URL',
  'GARAGE_CAPACITY',
  'GARAGE_RPC_SECRET',
  'GARAGE_ADMIN_TOKEN',
  'S3_BACKUP_ACCESS_KEY_ID',
  'S3_BACKUP_SECRET_ACCESS_KEY',
] as const;

function dropInitOnlyVars(): void {
  for (const name of INIT_ONLY_VARS) {
    delete process.env[name];
    delete process.env[`${name}_FILE`];
  }
}

/** The advisory lock every starting process takes before touching the schema (one key for the whole hub). */
export const INIT_LOCK_KEY = 'wirehub-startup-init';

/**
 * The environment the init steps read explicit values from: `*_FILE`
 * variables that point into the secrets volume are dropped, because those
 * files are what the steps write — a generated value must not pass for one
 * the deployer set.
 */
export function initEnv(env: Env): Record<string, string | undefined> {
  const dir = secretsDir(env).replace(/\/+$/, '');
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith('_FILE') && value !== undefined && (value === dir || value.startsWith(`${dir}/`))) continue;
    out[key] = value;
  }
  return out;
}

/** A connection problem worth waiting out (the database is starting, restarting, or not resolvable yet). */
export function transientDbError(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', '57P03'].includes(code)) return true;
  return /Connection terminated|the database system is (starting up|shutting down|in recovery)/i.test(message(error));
}

/** `*_FILE` variables into the secrets volume whose plain variable is unset, and whose file is not there yet. */
export function missingSecretFiles(env: Env, exists: (path: string) => boolean = (path) => existsSync(path) && readFileSync(path, 'utf8').trim() !== ''): string[] {
  const dir = secretsDir(env).replace(/\/+$/, '');
  return Object.entries(env)
    .filter(([key, value]) => key.endsWith('_FILE') && value !== undefined && value.startsWith(`${dir}/`))
    .filter(([key]) => (env[key.slice(0, -'_FILE'.length)] ?? '').trim() === '')
    .map(([, path]) => path as string)
    .filter((path) => !exists(path));
}

/** The image's `node` user from here on (the secrets step alone needs root). */
function dropPrivileges(): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  process.setgroups?.([APP_GID]);
  process.setgid?.(APP_GID);
  process.setuid?.(APP_UID);
  if (process.env.HOME === '/root' || process.env.HOME === undefined) process.env.HOME = '/home/node';
  log(`running as uid ${APP_UID} from here on`);
}

/** The app's port while it initialises: 503 everywhere, `/healthz` in JSON. */
function statusServer(current: () => Status): Server | undefined {
  const port = Number(process.env.PORT ?? 5183);
  const host = process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port <= 0) return undefined;
  const server = createServer((request, response) => {
    const status = current();
    const headers = { 'cache-control': 'no-store', 'retry-after': '5' };
    if ((request.url ?? '/').split('?')[0] === '/healthz') {
      response.writeHead(503, { ...headers, 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, ...status }));
      return;
    }
    const text = status.status === 'initialising' ? `WireHub is starting: ${status.step}…` : `WireHub could not start: ${status.error}`;
    const escaped = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    response.writeHead(503, { ...headers, 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">${status.status === 'initialising' ? '<meta http-equiv="refresh" content="3">' : ''}<title>WireHub</title><p style="font:15px system-ui,sans-serif;margin:2rem">${escaped}</p>`,
    );
  });
  server.on('error', (error) => log(`status page: ${message(error)}`));
  server.listen(port, host);
  return server;
}

interface DbSecrets {
  adminUrl: string;
  ownerUrl: string;
  database: string;
  passwords: { owner: string; app: string; ro: string };
}

/** The database connections and passwords: explicit values, else the secrets volume's files. */
function dbSecrets(env: Env): DbSecrets {
  const dir = secretsDir(env);
  const need = (variable: string, file: string): string => {
    const value = explicitValue(env, variable) ?? readSecret(dir, file);
    if (value === undefined) throw new Error(`${variable} is not set and ${join(dir, file)} does not exist (the app's secrets step writes it).`);
    return value;
  };
  const appUrl = need('DATABASE_URL', 'database_url');
  return {
    adminUrl: need('DATABASE_ADMIN_URL', 'database_admin_url'),
    ownerUrl: need('DATABASE_OWNER_URL', 'database_owner_url'),
    database: (env.WIREHUB_DB_NAME ?? '').trim() || new URL(appUrl).pathname.slice(1) || 'wirehub',
    passwords: { owner: need('WIREHUB_OWNER_PASSWORD', 'wirehub_owner_password'), app: need('WIREHUB_APP_PASSWORD', 'wirehub_app_password'), ro: need('WIREHUB_RO_PASSWORD', 'wirehub_ro_password') },
  };
}

class StepError extends Error {}

/** Step 3: roles, migrations and (the app) the one-time adoption, under the advisory lock. */
async function databaseStep(role: Role, env: Env, setStep: (step: string) => void, beforeAdopt: () => Promise<void>, appEnv: Env = env): Promise<void> {
  const { default: pg } = await import('pg');
  const { redactUrl } = await import('../server/pg/config.ts');
  let secrets: DbSecrets;
  try {
    secrets = dbSecrets(env);
  } catch (error) {
    throw new StepError(`database settings: ${message(error)}`);
  }

  // the lock lives on the admin connection, held for the whole step; it is released when that connection ends
  let client: InstanceType<typeof pg.Client>;
  for (let attempt = 1; ; attempt += 1) {
    client = new pg.Client({ connectionString: secrets.adminUrl, application_name: `wirehub-init-${role}` });
    client.on('error', () => undefined);
    try {
      await client.connect();
      break;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (!transientDbError(error)) throw new StepError(`cannot connect to the database (${redactUrl(secrets.adminUrl)}): ${message(error)}`);
      setStep(`waiting for the database (${message(error)})`);
      if (attempt === 1 || attempt % 15 === 0) log(`waiting for the database at ${redactUrl(secrets.adminUrl)}: ${message(error)}`);
      await sleep(2000);
    }
  }
  try {
    const got = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [INIT_LOCK_KEY])).rows[0]?.ok === true;
    if (!got) {
      setStep('waiting for another WireHub process to finish migrating');
      log('another process is initialising the database; waiting for it');
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [INIT_LOCK_KEY]);
    }

    setStep('preparing the database roles');
    const { bootstrapDatabase } = await import('../server/pg/bootstrap.ts');
    try {
      await bootstrapDatabase(secrets.adminUrl, { database: secrets.database, passwords: secrets.passwords, log: (line) => log(`  ${line}`) });
    } catch (error) {
      throw new StepError(`database roles failed: ${message(error)}`);
    }

    setStep('running migrations');
    const { openPg } = await import('../server/pg/db.ts');
    const { migrateToLatest } = await import('../server/pg/migrate.ts');
    const { migrateModules } = await import('../server/pg/module-migrations.ts');
    const { registry } = await import('../server/modules.ts');
    const owner = openPg(secrets.ownerUrl, { max: 1, applicationName: `wirehub-migrate-${role}` });
    try {
      const applied = [...(await migrateToLatest(owner.db)), ...(await migrateModules(owner.db, registry.modules))];
      log(applied.length === 0 ? 'migrations: the database is up to date' : `migrations: applied ${applied.join(', ')}`);
    } catch (error) {
      throw new StepError(`migration failed: ${message(error)}`);
    } finally {
      await owner.close().catch(() => undefined);
    }

    if (role === 'app') {
      await beforeAdopt();
      setStep('checking for a file catalog to adopt');
      try {
        await adopt(appEnv);
      } catch (error) {
        throw new StepError(`adopting the file catalog failed: ${message(error)}`);
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Once, on a database with no organisation: a file catalog from before the database moved in (what `cli.ts adopt` does). */
async function adopt(env: Env): Promise<void> {
  const { resolveFileEnv } = await import('../server/env.ts');
  // the app's own connection and the S3 keys, as the server will read them
  const appEnv: Record<string, string | undefined> = { ...env };
  const files = resolveFileEnv(appEnv);
  if (files.errors.length > 0) throw new Error(files.errors.join(' '));
  const { blobStoreFromEnv } = await import('../server/blobs.ts');
  const { pgAppConfigFromEnv } = await import('../server/pg/config.ts');
  const { openPg } = await import('../server/pg/db.ts');
  const { adoptFileCatalog } = await import('../server/pg/adopt.ts');
  const { dataPath } = await import('@wirehub/catalog');
  const handle = openPg(pgAppConfigFromEnv(appEnv).url, { max: 2, applicationName: 'wirehub-adopt' });
  try {
    const blobs = blobStoreFromEnv(appEnv);
    const packs = (appEnv.WIREHUB_PACKS_DIR ?? '').trim();
    const starter = (appEnv.WIREHUB_STARTER_CATALOG ?? '/app/starter-catalog').trim();
    const outcome = await adoptFileCatalog(handle.db, {
      root: resolve(dataPath('..')),
      ...(packs === '' ? {} : { packs }),
      ...(starter === '' ? {} : { starter }),
      ...(blobs === undefined ? {} : { blobs }),
    });
    log(`adopt: ${outcome.message}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The worker: wait for the files the app's secrets and S3 steps write. */
async function waitForSecrets(env: Env, setStep: (step: string) => void): Promise<void> {
  const dir = secretsDir(env);
  const needed = (): string[] => [
    ...missingSecretFiles(env),
    ...['database_admin_url', 'database_owner_url', 'database_url', 'wirehub_owner_password', 'wirehub_app_password', 'wirehub_ro_password']
      .filter((name) => readSecret(dir, name) === undefined)
      .map((name) => join(dir, name)),
  ];
  for (let attempt = 1; ; attempt += 1) {
    const missing = [...new Set(needed())];
    if (missing.length === 0) return;
    setStep(`waiting for the app to write ${missing.join(', ')}`);
    if (attempt === 1 || attempt % 30 === 0) log(`waiting for the app's secrets step: ${missing.join(', ')}`);
    await sleep(1000);
  }
}

export async function initialise(role: Role, env: Env, setStep: (step: string) => void): Promise<void> {
  const clean = initEnv(env);
  if (role === 'worker') {
    await waitForSecrets(env, setStep);
    await databaseStep(role, clean, setStep, async () => {});
    return;
  }

  // 2. the bundled S3 store, alongside the database (adoption may upload into it, so it waits for this)
  let garage: Promise<void> = Promise.resolve();
  if ((clean.GARAGE_ADMIN_URL ?? '').trim() !== '') {
    garage = garageInit(clean, undefined, (line) => log(line.replace(/^garage-init: /, 'S3 store: '))).catch((error: unknown) => {
      throw new StepError(`S3 store (Garage) setup failed: ${message(error)}`);
    });
    // observed below; reported at once too, in case the database step is still waiting
    garage.catch((error: unknown) => console.error(`[init] ${message(error)}`));
  }
  setStep('setting up storage and the database');
  await databaseStep(role, clean, setStep, async () => {
    setStep('setting up the S3 store');
    await garage;
  }, env);
  await garage;
}

async function main(): Promise<void> {
  const role = process.argv[2];
  if (role !== 'app' && role !== 'worker') {
    console.error('usage: start.ts app | worker');
    process.exit(2);
  }
  const entry = new URL(role === 'app' ? '../server/serve.ts' : '../server/worker.ts', import.meta.url).href;
  const off = /^(0|off|false|no)$/i.test((process.env.WIREHUB_INIT ?? '').trim());

  // 1. the secrets (root, if the container runs as root), then never root again
  if (!off && role === 'app') {
    try {
      const report = bootstrap(initEnv(process.env));
      const generated = Object.entries(report).filter(([, source]) => source === 'generated').map(([name]) => name);
      log(`secrets: ${secretsDir(process.env)} ready${generated.length === 0 ? '' : ` (generated ${generated.join(', ')})`}`);
    } catch (error) {
      dropPrivileges();
      const reason = `secrets: ${message(error)}`;
      console.error(`[init] FAILED — ${reason}`);
      statusServer(() => ({ status: 'failed', error: reason }));
      return; // the status page keeps the process alive; restart once fixed
    }
  }
  dropPrivileges();
  if (off) {
    dropInitOnlyVars();
    await import(entry);
    return;
  }

  let status: Status = { status: 'initialising', step: 'starting' };
  const setStep = (step: string): void => {
    if (status.status === 'initialising' && status.step !== step) status = { status: 'initialising', step };
  };
  const server = role === 'app' ? statusServer(() => status) : undefined;
  const started = Date.now();
  try {
    await initialise(role, process.env, setStep);
  } catch (error) {
    const reason = error instanceof StepError ? error.message : `initialisation failed: ${message(error)}`;
    status = { status: 'failed', error: reason };
    console.error(`[init] FAILED — ${reason}`);
    console.error('[init] Nothing is retried, generated or repaired automatically. Fix the cause, then restart this service (docker compose restart).');
    if (server === undefined) setInterval(() => undefined, 1 << 30); // the worker: stay up, unhealthy, until restarted
    return;
  }
  log(`ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (server !== undefined) await new Promise<void>((done) => server.close(() => done()));
  dropInitOnlyVars();
  await import(entry);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
