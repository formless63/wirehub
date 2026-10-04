/**
 * `bootstrap` — the compose stack's first one-shot (`compose.yaml`). Every
 * other service waits for it (`depends_on: condition:
 * service_completed_successfully`). It fills the secrets volume
 * (`secrets.ts`) on first run and keeps it on every later one:
 *
 *   postgres_password    the bundled Postgres's password (`POSTGRES_PASSWORD_FILE`)
 *   database_url         the app's connection to it (`DATABASE_URL_FILE`), derived
 *   better_auth_secret   the sign-in session secret (`BETTER_AUTH_SECRET_FILE`)
 *   garage_rpc_secret    Garage's RPC secret
 *   garage_admin_token   Garage's admin API token (garage-init uses it)
 *   setup_code           the one-time first-run setup code (`WIREHUB_SETUP_CODE_FILE`)
 *   garage.toml          the bundled Garage's configuration, rewritten every run
 *
 * The S3 keys are not generated here: Garage creates them, and `garage-init`
 * writes them into the same volume. Values set explicitly (`POSTGRES_PASSWORD`,
 * `DATABASE_URL`, `BETTER_AUTH_SECRET`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`,
 * `WIREHUB_SETUP_CODE`, or their `_FILE` forms) win over generated ones.
 *
 *   node --experimental-strip-types stack/bootstrap.ts
 */

import { pathToFileURL } from 'node:url';

import { base64url, ensureSecret, explicitValue, hex, prepareDir, secretsDir, setupCode, writeFile, type Env, type SecretSource } from './secrets.ts';

/** The bundled Garage's configuration; secrets are read from the volume, never written into it. */
export function garageToml(options: { dir: string; region: string; rpcSecretFile: boolean; adminTokenFile: boolean }): string {
  return [
    '# Garage, single node, for WireHub — written by the bootstrap service on',
    '# every start (apps/studio/stack/bootstrap.ts); edits here are replaced.',
    'metadata_dir = "/var/lib/garage/meta"',
    'data_dir = "/var/lib/garage/data"',
    'db_engine = "sqlite"',
    'replication_factor = 1',
    '',
    'rpc_bind_addr = "[::]:3901"',
    'rpc_public_addr = "127.0.0.1:3901"',
    // the volume's files are 0644 (several users read them); it is mounted only into this stack
    'allow_world_readable_secrets = true',
    ...(options.rpcSecretFile ? [`rpc_secret_file = "${options.dir}/garage_rpc_secret"`] : []),
    '',
    '[s3_api]',
    `s3_region = "${options.region.replace(/[^A-Za-z0-9._-]/g, '')}"`,
    'api_bind_addr = "[::]:3900"',
    'root_domain = ".s3.garage.localhost"',
    '',
    '[admin]',
    'api_bind_addr = "[::]:3903"',
    ...(options.adminTokenFile ? [`admin_token_file = "${options.dir}/garage_admin_token"`] : []),
    '',
  ].join('\n');
}

/** The bundled Postgres's connection URL for a password. */
export function bundledDatabaseUrl(password: string): string {
  return `postgres://wirehub:${encodeURIComponent(password)}@postgres:5432/wirehub`;
}

/** Fill the secrets volume; returns where each secret came from (the log line). */
export function bootstrap(env: Env): Record<string, SecretSource | 'derived' | 'written'> {
  const dir = secretsDir(env);
  prepareDir(dir);
  const report: Record<string, SecretSource | 'derived' | 'written'> = {};
  const secret = (name: string, variable: string, generate: () => string): string => {
    const { value, source } = ensureSecret(dir, name, explicitValue(env, variable), generate);
    report[name] = source;
    return value;
  };

  const postgresPassword = secret('postgres_password', 'POSTGRES_PASSWORD', () => hex(24));
  const databaseUrl = explicitValue(env, 'DATABASE_URL');
  if (databaseUrl === undefined) {
    // follows the password: derived on every run, never generated on its own
    writeFile(dir, 'database_url', bundledDatabaseUrl(postgresPassword));
    report['database_url'] = 'derived';
  } else {
    writeFile(dir, 'database_url', databaseUrl);
    report['database_url'] = 'explicit';
  }
  secret('better_auth_secret', 'BETTER_AUTH_SECRET', () => base64url(32));
  secret('garage_rpc_secret', 'GARAGE_RPC_SECRET', () => hex(32));
  secret('garage_admin_token', 'GARAGE_ADMIN_TOKEN', () => base64url(32));
  secret('setup_code', 'WIREHUB_SETUP_CODE', setupCode);

  writeFile(dir, 'garage.toml', garageToml({ dir, region: env['S3_REGION'] ?? 'garage', rpcSecretFile: true, adminTokenFile: true }));
  report['garage.toml'] = 'written';
  return report;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const report = bootstrap(process.env);
    const line = Object.entries(report)
      .map(([name, source]) => `${name}: ${source}`)
      .join(', ');
    console.log(`bootstrap: ${secretsDir(process.env)} ready — ${line}`);
    if (report['setup_code'] === 'generated') {
      console.log('bootstrap: a first-run setup code was generated; the wirehub service prints it in its log.');
    }
  } catch (error) {
    console.error(`bootstrap: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
