#!/usr/bin/env -S node --experimental-strip-types
/**
 * The Postgres backend's commands (`specs/postgres-backend.md` §6, §7):
 *
 *   pnpm --filter studio db:bootstrap                 roles + database (DATABASE_ADMIN_URL, WIREHUB_*_PASSWORD)
 *   pnpm --filter studio db:migrate                   every pending migration (DATABASE_OWNER_URL)
 *   pnpm --filter studio pg:import --from <dir> --org <slug> [--create-org] [--name <org name>] [--dry-run] [--if-empty]
 *   pnpm --filter studio pg:export --out <dir> [--with-blobs]
 *   cli.ts adopt --from <dir> --packs <dir> --starter <pristine data dir>   the compose migrate step
 *   pnpm --filter studio pg:gate --from <dir>         the S1 gate: files vs the database
 *   cli.ts owner-password [--email <owner>] [--org <slug>]   set an owner's email + password login (the password on stdin or a hidden prompt); a hub nobody can sign in to
 *
 * `--packs <dir>` (default WIREHUB_PACKS_DIR): a file deployment's installed
 * packs, flattened into the catalog on import and in the gate.
 *
 * `<dir>` holds a catalog's `data/` (and `depictions/`), like `packages/catalog`;
 * relative paths resolve from where pnpm was run. The app connection is
 * DATABASE_URL (studio_app), the org WIREHUB_ORG (default: the only one), the
 * blob store WIREHUB_BLOBS (`fs:<dir>` or `s3`).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { dataPath } from '@wirehub/catalog';
import { readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';

import { ASSET_MIME_EXT } from '@wirehub/catalog/src/codec/index.ts';
import { blobStoreFromEnv, type BlobStore } from '../blobs.ts';
import { fileModelCache } from '../models/cache.ts';
import { defaultWorkbenchDeps } from '../default-deps.ts';
import { bootstrapDatabase } from './bootstrap.ts';
import { PgConfigError, pgAppConfigFromEnv, redactUrl, requireEnv } from './config.ts';
import { catalogHeadVersion, openPg, resolveOrgId } from './db.ts';
import { writeExport } from './export.ts';
import { formatGateReport, runGate } from './gate.ts';
import { ImportError, importCatalog } from './import.ts';
import { adoptFileCatalog } from './adopt.ts';
import { migrateToLatest } from './migrate.ts';
import { OwnerPasswordError, setOwnerPassword } from './owner-password.ts';
import { notifierFromEnv } from '../notify.ts';
import { migrateModules } from './module-migrations.ts';
import { registry } from '../modules.ts';
import { SnapshotCache } from './snapshot.ts';

const env = process.env;
const from = (path: string): string => resolve(env.INIT_CWD ?? process.cwd(), path);
const log = (line: string): void => console.log(line);

function blobs(): BlobStore | undefined {
  return blobStoreFromEnv(env);
}

async function bootstrap(): Promise<void> {
  const adminUrl = requireEnv(env, 'DATABASE_ADMIN_URL', 'db:bootstrap');
  const database = (env.WIREHUB_DB_NAME ?? '').trim() || new URL(requireEnv(env, 'DATABASE_URL', 'db:bootstrap (for the database name)')).pathname.slice(1) || 'wirehub';
  const passwords = {
    owner: requireEnv(env, 'WIREHUB_OWNER_PASSWORD', 'db:bootstrap'),
    app: requireEnv(env, 'WIREHUB_APP_PASSWORD', 'db:bootstrap'),
    ro: requireEnv(env, 'WIREHUB_RO_PASSWORD', 'db:bootstrap'),
  };
  log(`bootstrapping ${database} on ${redactUrl(adminUrl)}`);
  await bootstrapDatabase(adminUrl, { database, passwords, log: (line) => log(`  ${line}`) });
}

async function migrate(): Promise<void> {
  const url = requireEnv(env, 'DATABASE_OWNER_URL', 'db:migrate');
  const handle = openPg(url, { max: 1, applicationName: 'wirehub-migrate' });
  try {
    const applied = [...(await migrateToLatest(handle.db)), ...(await migrateModules(handle.db, registry.modules))];
    log(applied.length === 0 ? 'the database is up to date' : `applied ${applied.join(', ')}`);
  } finally {
    await handle.close();
  }
}

async function importCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { from: { type: 'string' }, org: { type: 'string' }, name: { type: 'string' }, 'create-org': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'if-empty': { type: 'boolean' }, packs: { type: 'string' } } });
  if (values.from === undefined || values.org === undefined) throw new PgConfigError('pg:import needs --from <catalog dir> and --org <slug>.');
  const root = from(values.from);
  if (!existsSync(resolve(root, 'data'))) throw new PgConfigError(`${root} has no data/ directory.`);
  // installed packs (WIREHUB_PACKS_DIR, or --packs) are flattened into the catalog: the database holds them as records
  const packs = values.packs ?? (env.WIREHUB_PACKS_DIR?.trim() || undefined);
  const files = readFlattenedCatalog(root, packs === undefined ? undefined : from(packs));
  const store = blobs();
  const handle = openPg(pgAppConfigFromEnv(env).url, { max: 2, applicationName: 'wirehub-import' });
  try {
    // a deployment's first start: load the catalog once, then never again (the compose stack's migrate step)
    if (values['if-empty'] === true) {
      const existing = await resolveOrgId(handle.db, values.org);
      const version = existing === undefined ? undefined : await catalogHeadVersion(handle.db, existing);
      if (version !== undefined && version !== '0') {
        log(`org '${values.org}' already holds a catalog (version ${version}); nothing imported`);
        return;
      }
    }
    const report = await importCatalog(handle.db, {
      org: { slug: values.org, name: values.name ?? values.org, create: values['create-org'] === true },
      files,
      ...(store === undefined ? {} : { blobs: store }),
      // an asset the file backend kept in the blob store (WIREHUB_BLOBS) rather than in data/assets/
      fetchMissing: async (blob) => {
        const ext = ASSET_MIME_EXT[blob.mediaType];
        if (store === undefined || ext === undefined) return undefined;
        const bytes = await store.get(`assets/${blob.sha256}.${ext}`);
        return bytes === undefined ? undefined : new Uint8Array(bytes);
      },
      dryRun: values['dry-run'] === true,
      message: `Import the catalog from ${values.from}`,
    });
    if (values['dry-run'] === true) log(`dry run: ${files.size} files explode cleanly into ${report.rows.records.length} records, ${report.rows.docs.length} docs, ${report.rows.blobs.length} blobs`);
    else log(`imported ${files.size} files into org '${values.org}' (version ${report.version}, change set ${report.changeSetId}): ${JSON.stringify(report.counts)}, ${report.uploaded} blob(s) uploaded`);
  } finally {
    await handle.close();
  }
}
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const { createInterface } = await import('node:readline');
  const { Writable } = await import('node:stream');
  let muted = false;
  // the prompt is written by hand; what is typed is not echoed
  const out = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  process.stdout.write('New password: ');
  muted = true;
  const first = await new Promise<string>((done) => rl.question('', (a) => { process.stdout.write('\n'); done(a); }));
  process.stdout.write('Again: ');
  const second = await new Promise<string>((done) => rl.question('', (a) => { process.stdout.write('\n'); done(a); }));
  rl.close();
  if (first !== second) throw new PgConfigError('The two passwords differ; nothing was changed.');
  return first;
}

/**
 * `owner-password`: the escape hatch for a hub nobody can sign in to — an owner's email + password
 * login, set from the server's shell (`server/pg/owner-password.ts`).
 */
async function ownerPasswordCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { email: { type: 'string' }, org: { type: 'string' } } });
  const password = await readPassword();
  const handle = openPg(pgAppConfigFromEnv(env).url, { max: 1, applicationName: 'wirehub-owner-password' });
  try {
    const orgId = await resolveOrgId(handle.db, values.org);
    if (orgId === undefined) throw new PgConfigError(values.org === undefined ? 'This hub has no organisation yet: finish first-run setup in the browser.' : `There is no organisation '${values.org}'.`);
    try {
      const done = await setOwnerPassword(handle.db, orgId, { ...(values.email === undefined ? {} : { email: values.email }), password });
      log(`${done.action === 'created' ? 'made the email + password login of' : 'replaced the password of'} ${done.name} <${done.email}>; sign in at the hub's address with it.`);
      log('Email + password sign-in must be on (Settings > Sign-in & accounts, or AUTH_LOCAL_ACCOUNTS=true on the server).');
    } catch (error) {
      if (error instanceof OwnerPasswordError) throw new PgConfigError(error.message);
      throw error;
    }
  } finally {
    await handle.close();
  }
}

/**
 * `adopt`: the compose stack's migrate step. On a database with no org yet,
 * a file deployment that was in use (its first-run setup completed, or its
 * catalog differs from the pristine starter the image carries) is imported as
 * the org `main`, its packs flattened in; a fresh install is left for
 * first-run setup to create (plan §9.1). Does nothing once any org exists.
 */
async function adoptCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { from: { type: 'string' }, packs: { type: 'string' }, starter: { type: 'string' }, org: { type: 'string' }, name: { type: 'string' } } });
  const packs = values.packs ?? (env.WIREHUB_PACKS_DIR?.trim() || undefined);
  const handle = openPg(pgAppConfigFromEnv(env).url, { max: 2, applicationName: 'wirehub-adopt' });
  try {
    const store = blobs();
    const outcome = await adoptFileCatalog(handle.db, {
      root: from(values.from ?? dataPath('..')),
      ...(packs === undefined ? {} : { packs: from(packs) }),
      ...(values.starter === undefined ? {} : { starter: from(values.starter) }),
      ...(values.org === undefined ? {} : { org: values.org }),
      ...(values.name === undefined ? {} : { name: values.name }),
      ...(store === undefined ? {} : { blobs: store }),
    });
    log(`adopt: ${outcome.message}`);
  } finally {
    await handle.close();
  }
}

async function exportCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { out: { type: 'string' }, 'with-blobs': { type: 'boolean' } } });
  if (values.out === undefined) throw new PgConfigError('pg:export needs --out <dir>.');
  const config = pgAppConfigFromEnv(env);
  const handle = openPg(config.url, { max: 2, applicationName: 'wirehub-export' });
  try {
    const orgId = await resolveOrgId(handle.db, config.org);
    if (orgId === undefined) throw new PgConfigError('No org to export (set WIREHUB_ORG).');
    const snapshot = await new SnapshotCache(handle.db, orgId).get();
    const store = values['with-blobs'] === true ? blobs() : undefined;
    const n = await writeExport(snapshot, from(values.out), store === undefined ? {} : { blobs: store, orgId });
    log(`exported version ${snapshot.version}: ${n} files into ${from(values.out)}${store === undefined ? ' (text only)' : ''}`);
  } finally {
    await handle.close();
  }
}

async function gateCommand(args: string[]): Promise<boolean> {
  const { values } = parseArgs({ args, options: { from: { type: 'string' }, packs: { type: 'string' }, models: { type: 'boolean' } } });
  const root = from(values.from ?? dataPath('..'));
  const packs = values.packs ?? (env.WIREHUB_PACKS_DIR?.trim() || undefined);
  const config = pgAppConfigFromEnv(env);
  const handle = openPg(config.url, { max: 4, applicationName: 'wirehub-gate' });
  try {
    const orgId = await resolveOrgId(handle.db, config.org);
    if (orgId === undefined) throw new PgConfigError('No org to compare (set WIREHUB_ORG).');
    const store = blobs();
    // the real file stores read the live catalog (its packs layered under it) — compare them when that is the tree
    const live = resolve(root) === resolve(dataPath('..'));
    const report = await runGate({
      tree: readFlattenedCatalog(root, packs === undefined ? undefined : from(packs)),
      root,
      pg: { db: handle.db, cache: new SnapshotCache(handle.db, orgId), ...(store === undefined ? {} : { blobs: store }) },
      ...(live ? { filesDeps: defaultWorkbenchDeps(store === undefined ? {} : { blobs: store }) } : {}),
      // --models: after the model-cache job, every live key built (and equal to the file cache's, when there is one)
      ...(values.models === true ? { models: live ? { fileCache: fileModelCache() } : {} } : {}),
    });
    log(formatGateReport(report));
    if (!report.ok) {
      const differences = report.checks.reduce((n, c) => n + c.diffs.length, 0);
      await notifierFromEnv(env).notify({ event: 'parity-diff', severity: 'high', title: 'Catalog parity differs', message: `The files-vs-database gate found ${differences} difference(s) in ${report.checks.filter((c) => c.diffs.length > 0).map((c) => c.name).join(', ')}.`, data: { differences } });
    }
    return report.ok;
  } finally {
    await handle.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case 'bootstrap':
      await bootstrap();
      break;
    case 'migrate':
      await migrate();
      break;
    case 'import':
      await importCommand(rest);
      break;
    case 'export':
      await exportCommand(rest);
      break;
    case 'adopt':
      await adoptCommand(rest);
      break;
    case 'owner-password':
      await ownerPasswordCommand(rest);
      break;
    case 'gate':
      if (!(await gateCommand(rest))) process.exitCode = 1;
      break;
    default:
      console.error('usage: cli.ts bootstrap | migrate | import --from <dir> --org <slug> | export --out <dir> | gate --from <dir> | owner-password [--email <owner>] [--org <slug>]');
      process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof PgConfigError || error instanceof ImportError) {
    console.error(error.message);
    process.exitCode = 1;
  } else throw error;
}
