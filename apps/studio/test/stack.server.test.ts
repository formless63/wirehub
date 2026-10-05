/**
 * The compose stack's one-shots (`stack/`): `bootstrap` fills the secrets
 * volume and keeps it, `garage-init` gets its S3 keys from Garage and writes
 * them there, `backup-init` stages the backup scripts and configures Backrest
 * once. Every case runs against a temporary directory standing in for the
 * volume; Garage is a fake admin API. A last group checks that `compose.yaml`
 * needs no variable and reads only files the stack writes.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backrestConfig, backupInit, checkCron, LOCAL_REPOSITORY, MARKER_FILE } from '../stack/backup-init.ts';
import { bootstrap, bundledDatabaseUrl, garageToml } from '../stack/bootstrap.ts';
import { ensureKey, garageInit, KEYS, parseSize } from '../stack/garage-init.ts';
import { readSecret } from '../stack/secrets.ts';

let dir = '';
const env = (extra: Record<string, string> = {}): Record<string, string> => ({ WIREHUB_SECRETS_DIR: dir, ...extra });
const read = (name: string): string => readFileSync(join(dir, name), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirehub-stack-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('bootstrap', () => {
  it('generates every secret on first run, readable by every service', () => {
    const report = bootstrap(env());
    expect(report).toMatchObject({
      postgres_password: 'generated',
      wirehub_owner_password: 'generated',
      wirehub_app_password: 'generated',
      wirehub_ro_password: 'generated',
      database_admin_url: 'derived',
      database_owner_url: 'derived',
      database_url: 'derived',
      database_ro_url: 'derived',
      better_auth_secret: 'generated',
      garage_rpc_secret: 'generated',
      garage_admin_token: 'generated',
      setup_code: 'generated',
      'garage.toml': 'written',
    });
    expect(read('postgres_password')).toMatch(/^[0-9a-f]{48}\n$/);
    expect(read('garage_rpc_secret')).toMatch(/^[0-9a-f]{64}\n$/);
    expect(read('better_auth_secret').trim().length).toBeGreaterThanOrEqual(43);
    expect(read('setup_code')).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}\n$/);
    expect(read('database_admin_url').trim()).toBe(bundledDatabaseUrl(read('postgres_password').trim()));
    expect(read('database_owner_url').trim()).toBe(`postgres://studio_owner:${read('wirehub_owner_password').trim()}@postgres:5432/wirehub`);
    expect(read('database_url').trim()).toBe(`postgres://studio_app:${read('wirehub_app_password').trim()}@postgres:5432/wirehub`);
    expect(read('database_ro_url').trim()).toBe(`postgres://studio_ro:${read('wirehub_ro_password').trim()}@postgres:5432/wirehub`);
    expect(statSync(join(dir, 'postgres_password')).mode & 0o777).toBe(0o644);
  });

  it('keeps what it generated: a second run changes nothing', () => {
    bootstrap(env());
    const names = ['postgres_password', 'wirehub_owner_password', 'wirehub_app_password', 'wirehub_ro_password', 'better_auth_secret', 'garage_rpc_secret', 'garage_admin_token', 'setup_code', 'database_url', 'database_owner_url', 'database_admin_url'];
    const before = names.map(read);
    const report = bootstrap(env());
    expect(report.postgres_password).toBe('kept');
    expect(report.setup_code).toBe('kept');
    expect(names.map(read)).toEqual(before);
  });

  it('lets explicit values win, from the variable or its _FILE, and the URL follows the password', () => {
    bootstrap(env());
    const file = join(dir, 'given-secret');
    writeFileSync(file, 'from-a-docker-secret\n');
    const report = bootstrap(env({ POSTGRES_PASSWORD: 'p@ss word', WIREHUB_APP_PASSWORD: 'app/pw', BETTER_AUTH_SECRET_FILE: file, WIREHUB_SETUP_CODE: '  ' }));
    expect(report.postgres_password).toBe('explicit');
    expect(report.wirehub_app_password).toBe('explicit');
    expect(report.better_auth_secret).toBe('explicit');
    expect(report.setup_code).toBe('kept');
    expect(read('postgres_password')).toBe('p@ss word\n');
    expect(read('database_admin_url').trim()).toBe('postgres://wirehub:p%40ss%20word@postgres:5432/wirehub');
    expect(read('database_url').trim()).toBe('postgres://studio_app:app%2Fpw@postgres:5432/wirehub');
    expect(read('better_auth_secret')).toBe('from-a-docker-secret\n');
    // your own Postgres: the role URLs follow the admin URL's server and database
    bootstrap(env({ DATABASE_ADMIN_URL: 'postgres://admin:x@db.example.com:6543/hub?sslmode=require' }));
    expect(read('database_admin_url')).toBe('postgres://admin:x@db.example.com:6543/hub?sslmode=require\n');
    expect(read('database_owner_url')).toMatch(/^postgres:\/\/studio_owner:[0-9a-f]{48}@db\.example\.com:6543\/hub\?sslmode=require\n$/);
    // …and a URL given outright is used as given
    bootstrap(env({ DATABASE_URL: 'postgres://me:y@elsewhere:5432/hub' }));
    expect(read('database_url')).toBe('postgres://me:y@elsewhere:5432/hub\n');
  });

  it('writes a Garage config that reads its secrets from the volume', () => {
    bootstrap(env({ S3_REGION: 'garage' }));
    const toml = read('garage.toml');
    expect(toml).toContain(`rpc_secret_file = "${dir}/garage_rpc_secret"`);
    expect(toml).toContain(`admin_token_file = "${dir}/garage_admin_token"`);
    expect(toml).toContain('s3_region = "garage"');
    expect(toml).not.toContain(read('garage_rpc_secret').trim());
    expect(garageToml({ dir: '/x', region: 'eu"; evil', rpcSecretFile: false, adminTokenFile: false })).toContain('s3_region = "euevil"');
  });
});

/** A fake Garage admin API: keys, one bucket, layout. */
function fakeGarage(): { call: (method: string, path: string, body?: any) => Promise<any>; keys: Map<string, { secret: string; name: string }>; grants: unknown[] } {
  const keys = new Map<string, { secret: string; name: string }>();
  const grants: unknown[] = [];
  let bucket: { id: string } | undefined;
  let role: unknown = null;
  let created = 0;
  const notFound = (): never => {
    throw Object.assign(new Error('404'), { status: 404 });
  };
  return {
    keys,
    grants,
    async call(method, path, body) {
      const [route, query = ''] = path.split('?');
      const params = new URLSearchParams(query);
      switch (`${method} ${route}`) {
        case 'GET /v2/GetClusterStatus':
          return { nodes: [{ id: 'node0000000000000000', role }] };
        case 'GET /v2/GetClusterLayout':
          return { version: 0 };
        case 'POST /v2/UpdateClusterLayout':
          role = body.roles[0];
          return {};
        case 'POST /v2/ApplyClusterLayout':
          return {};
        case 'GET /v2/GetKeyInfo': {
          const key = keys.get(params.get('id') ?? '');
          return key === undefined ? notFound() : { accessKeyId: params.get('id'), name: key.name };
        }
        case 'POST /v2/ImportKey':
          keys.set(body.accessKeyId, { secret: body.secretAccessKey, name: body.name });
          return {};
        case 'POST /v2/CreateKey': {
          created += 1;
          const id = `GK${String(created).padStart(24, '0')}`;
          keys.set(id, { secret: `${created}`.repeat(64).slice(0, 64), name: body.name });
          return { accessKeyId: id, secretAccessKey: keys.get(id)?.secret };
        }
        case 'GET /v2/GetBucketInfo':
          return bucket ?? notFound();
        case 'POST /v2/CreateBucket':
          bucket = { id: 'b1' };
          return bucket;
        case 'POST /v2/AllowBucketKey':
          grants.push(body);
          return {};
        default:
          throw new Error(`unexpected ${method} ${path}`);
      }
    },
  };
}

describe('garage-init', () => {
  it('has Garage create the app and backup keys, and writes them into the volume', async () => {
    bootstrap(env());
    const garage = fakeGarage();
    const lines: string[] = [];
    await garageInit(env(), garage.call, (line) => lines.push(line));
    const appId = readSecret(dir, 's3_access_key_id');
    expect(appId).toMatch(/^GK/);
    expect(readSecret(dir, 's3_secret_access_key')).toBe(garage.keys.get(appId!)?.secret);
    expect(readSecret(dir, 's3_backup_access_key_id')).not.toBe(appId);
    expect(lines).toContain('garage-init: key wirehub-app created');
    expect(garage.grants).toEqual([
      { bucketId: 'b1', accessKeyId: appId, permissions: { read: true, write: true, owner: true } },
      { bucketId: 'b1', accessKeyId: readSecret(dir, 's3_backup_access_key_id'), permissions: { read: true, write: false, owner: false } },
    ]);
    // a second run keeps them
    const again: string[] = [];
    await garageInit(env(), garage.call, (line) => again.push(line));
    expect(again).toContain('garage-init: key wirehub-app kept');
    expect(readSecret(dir, 's3_access_key_id')).toBe(appId);
    expect(garage.keys.size).toBe(2);
  });

  it('imports the volume\'s keys into a Garage that lost them', async () => {
    writeFileSync(join(dir, 's3_access_key_id'), 'GK111111111111111111111111\n');
    writeFileSync(join(dir, 's3_secret_access_key'), 'a'.repeat(64));
    const garage = fakeGarage();
    const key = await ensureKey(garage.call, dir, env(), KEYS[0]!);
    expect(key).toEqual({ id: 'GK111111111111111111111111', how: 'imported' });
    expect(garage.keys.get('GK111111111111111111111111')?.secret).toBe('a'.repeat(64));
  });

  it('imports explicit keys, which win over the volume\'s', async () => {
    writeFileSync(join(dir, 's3_access_key_id'), 'GKold\n');
    writeFileSync(join(dir, 's3_secret_access_key'), 'old\n');
    const garage = fakeGarage();
    const key = await ensureKey(garage.call, dir, env({ S3_ACCESS_KEY_ID: 'GKmine', S3_SECRET_ACCESS_KEY: 'mysecret' }), KEYS[0]!);
    expect(key.how).toBe('explicit');
    expect(readSecret(dir, 's3_access_key_id')).toBe('GKmine');
    expect(readSecret(dir, 's3_secret_access_key')).toBe('mysecret');
    expect(garage.keys.has('GKmine')).toBe(true);
  });

  it('needs the admin token, and reads sizes in powers of 1000', async () => {
    await expect(garageInit(env(), fakeGarage().call, () => undefined)).rejects.toThrow(/No Garage admin token/);
    expect(parseSize('100G')).toBe(100e9);
    expect(parseSize('512M')).toBe(512e6);
    expect(() => parseSize('lots')).toThrow(/not a size/);
  });
});

describe('backup-init', () => {
  const config = (): string => join(dir, 'backrest', 'config.json');

  it('stages the scripts, keeps a restic password, and configures Backrest once', () => {
    const lines: string[] = [];
    backupInit(env({ BACKREST_CONFIG: config() }), (line) => lines.push(line));
    expect(existsSync(join(dir, 'backup', 'pg-dump.sh'))).toBe(true);
    expect(existsSync(join(dir, 'backup', 'blob-mirror.sh'))).toBe(true);
    const password = readSecret(dir, 'restic_password');
    expect(password?.length).toBeGreaterThanOrEqual(43);
    const seeded = JSON.parse(readFileSync(config(), 'utf8'));
    expect(seeded.repos[0]).toMatchObject({ id: 'wirehub', uri: LOCAL_REPOSITORY, password, autoInitialize: true });
    expect(seeded.plans[0]).toMatchObject({ repo: 'wirehub', paths: ['/sources'], schedule: { cron: '0 3 * * *' } });
    expect(seeded.auth).toBeUndefined();
    // a finished snapshot touches the marker the app and the worker read; a failed one leaves a failure marker
    expect(seeded.plans[0].hooks).toEqual([
      { conditions: ['CONDITION_SNAPSHOT_SUCCESS'], actionCommand: { command: 'touch /marker/.last-snapshot' } },
      { conditions: ['CONDITION_SNAPSHOT_ERROR'], actionCommand: { command: 'touch /marker/.last-failure' } },
    ]);
    expect(lines.some((l) => l.includes('WARNING the repository is a volume on this machine'))).toBe(true);
    // Backrest owns it after the first run
    writeFileSync(config(), '{"edited":true}\n');
    backupInit(env({ BACKREST_CONFIG: config(), BACKUP_REPOSITORY: 'rest:http://nas:8000/x' }), () => undefined);
    expect(readFileSync(config(), 'utf8')).toBe('{"edited":true}\n');
    expect(readSecret(dir, 'restic_password')).toBe(password);
  });

  it('marks backups as configured in the marker volume, when it is mounted', () => {
    const marker = join(dir, 'marker');
    mkdirSync(marker, { recursive: true });
    backupInit(env({ BACKREST_CONFIG: config(), BACKUP_MARKER_DIR: marker }), () => undefined);
    expect(existsSync(join(marker, '.configured'))).toBe(true);
    expect(existsSync(join(marker, '.last-snapshot'))).toBe(false);
  });

  it('takes a repository, its password, S3 credentials and a schedule', () => {
    backupInit(
      env({
        BACKREST_CONFIG: config(),
        BACKUP_REPOSITORY: 's3:https://s3.example.com/bucket/wirehub',
        BACKUP_REPOSITORY_PASSWORD: 'existing-repo-password',
        BACKUP_AWS_ACCESS_KEY_ID: 'AKIA',
        BACKUP_AWS_SECRET_ACCESS_KEY: 'shh',
        BACKUP_SCHEDULE: '30 1 * * *',
      }),
      () => undefined,
    );
    const seeded = JSON.parse(readFileSync(config(), 'utf8'));
    expect(seeded.repos[0]).toMatchObject({ uri: 's3:https://s3.example.com/bucket/wirehub', password: 'existing-repo-password', env: ['AWS_ACCESS_KEY_ID=AKIA', 'AWS_SECRET_ACCESS_KEY=shh'] });
    expect(seeded.plans[0].schedule.cron).toBe('30 1 * * *');
  });

  it('refuses a schedule that is not cron', () => {
    expect(() => checkCron('daily')).toThrow(/five-field cron/);
    expect(checkCron(' 0  3 * * 1-5 ')).toBe('0 3 * * 1-5');
    expect(backrestConfig({ repository: '/r', password: 'p', schedule: '0 3 * * *' })).toMatchObject({ version: 6, instance: 'wirehub' });
  });
});

describe('compose.yaml', () => {
  const compose = readFileSync(join(process.cwd(), '..', '..', 'compose.yaml'), 'utf8');

  it('needs no variable: nothing is required, every setting has a default', () => {
    expect(compose).not.toMatch(/\$\{[A-Z0-9_]+:?\?/);
  });

  it('reads only files the stack writes into the secrets volume', () => {
    const written = new Set([
      // bootstrap
      'postgres_password',
      'wirehub_owner_password',
      'wirehub_app_password',
      'wirehub_ro_password',
      'database_admin_url',
      'database_owner_url',
      'database_url',
      'database_ro_url',
      'better_auth_secret',
      'garage_rpc_secret',
      'garage_admin_token',
      'setup_code',
      'garage.toml',
      // garage-init
      ...KEYS.flatMap((k) => [k.idFile, k.keyFile]),
      // backup-init
      'backup/pg-dump.sh',
      'backup/blob-mirror.sh',
    ]);
    const read = [...compose.matchAll(/\/run\/wirehub\/([A-Za-z0-9_./-]+)/g)].map((m) => m[1] as string);
    expect(read.length).toBeGreaterThan(10);
    for (const name of read) expect(written.has(name), name).toBe(true);
  });

  it('hands the app every generated secret as a _FILE', () => {
    for (const name of ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'WIREHUB_SETUP_CODE', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      expect(compose, name).toMatch(new RegExp(`\\n      ${name}_FILE: /run/wirehub/`));
    }
  });

  it('runs the worker after migrate, inside its memory budget (S6: 1.5 GiB, one STEP conversion below it)', () => {
    const service = /\n  worker:\n([\s\S]*?)\n\n/.exec(compose)?.[1] ?? '';
    expect(service).toContain('server/worker.ts');
    expect(service).toMatch(/\n    mem_limit: 1536m\n/);
    expect(service).toMatch(/migrate:\n        condition: service_completed_successfully/);
    expect(service).toContain('DATABASE_URL_FILE: /run/wirehub/database_url');
    expect(service).toContain('- backups:/backups:ro');
    const stepLimit = Number(/WIREHUB_STEP_RSS_LIMIT_MB: \$\{WIREHUB_STEP_RSS_LIMIT_MB:-(\d+)\}/.exec(service)?.[1]);
    expect(stepLimit).toBeGreaterThan(1100);
    expect(stepLimit).toBeLessThan(1536 - 200);
    // the app's own budget stays what it was: STEP conversion is the worker's
    expect(/\n  wirehub:\n[\s\S]*?\n    mem_limit: (\d+m)\n/.exec(compose)?.[1]).toBe('768m');
  });

  it('mounts the backup marker read-only into the app and the worker, writable only for backup-init and Backrest', () => {
    const service = (name: string): string => new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)\\n\\n`).exec(compose)?.[1] ?? '';
    for (const name of ['wirehub', 'worker']) {
      expect(service(name), name).toContain('- backup_marker:/backup-marker:ro');
      expect(service(name), name).toContain('WIREHUB_BACKUP_MARKER: ${WIREHUB_BACKUP_MARKER:-/backup-marker/.last-snapshot}');
    }
    expect(service('backup-init')).toContain('- backup_marker:/marker\n');
    expect(service('backrest')).toContain('- backup_marker:/marker\n');
    // the hook's file is the one the readers name
    expect(MARKER_FILE).toBe('/marker/.last-snapshot');
  });

  it('pairs every bundled-service marker', () => {
    for (const block of ['bundled-postgres', 'bundled-s3']) {
      const opens = compose.split('\n').filter((line) => line.trim().startsWith(`# >>> ${block}`)).length;
      const closes = compose.split('\n').filter((line) => line.trim() === `# <<< ${block}`).length;
      expect(opens, block).toBeGreaterThan(0);
      expect(opens, block).toBe(closes);
    }
  });
});


