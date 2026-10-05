/**
 * `garage-init` — one-shot setup of the bundled single-node Garage
 * (`compose.yaml`). Idempotent: it runs on every `up`.
 *
 *   1. give the node a role in the cluster layout and apply it;
 *   2. the app's key and a read-only backup key: **Garage creates them** on
 *      first run, and their ids and secrets are written into the secrets
 *      volume (`s3_access_key_id`, `s3_secret_access_key`,
 *      `s3_backup_access_key_id`, `s3_backup_secret_access_key`), where the
 *      app and the backup mirror read them. Keys already in the volume are
 *      kept (and imported again into a Garage that lost them); keys set
 *      explicitly (`S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY`, the
 *      `S3_BACKUP_*` pair) are imported and win;
 *   3. create the bucket (`S3_BUCKET`) and grant the keys.
 *
 * Talks to Garage's admin API v2 (`GARAGE_ADMIN_URL`, the admin token from
 * `GARAGE_ADMIN_TOKEN` or the volume) with fetch: plain Node in the app image.
 *
 *   node --experimental-strip-types stack/garage-init.ts
 */

import { pathToFileURL } from 'node:url';

import { explicitValue, readSecret, secretsDir, writeFile, type Env } from './secrets.ts';

/** A Garage size: digits and an optional K, M, G or T (powers of 1000). */
export function parseSize(text: string): number {
  const match = /^(\d+)\s*([KMGT]?)B?$/i.exec(text.trim());
  if (match === null) throw new Error(`GARAGE_CAPACITY: not a size: ${text}`);
  const power = ({ '': 0, K: 1, M: 2, G: 3, T: 4 } as Record<string, number>)[(match[2] ?? '').toUpperCase()] ?? 0;
  return Number(match[1]) * 1000 ** power;
}

interface KeySpec {
  name: string;
  write: boolean;
  /** file names in the secrets volume */
  idFile: string;
  keyFile: string;
  /** the variables an explicit key is given in */
  idVar: string;
  keyVar: string;
}

export const KEYS: readonly KeySpec[] = [
  { name: 'wirehub-app', write: true, idFile: 's3_access_key_id', keyFile: 's3_secret_access_key', idVar: 'S3_ACCESS_KEY_ID', keyVar: 'S3_SECRET_ACCESS_KEY' },
  {
    name: 'wirehub-backup',
    write: false,
    idFile: 's3_backup_access_key_id',
    keyFile: 's3_backup_secret_access_key',
    idVar: 'S3_BACKUP_ACCESS_KEY_ID',
    keyVar: 'S3_BACKUP_SECRET_ACCESS_KEY',
  },
];

type Call = (method: string, path: string, body?: unknown) => Promise<any>;

export function adminClient(url: string, token: string, fetchImpl: typeof fetch = fetch): Call {
  const admin = url.replace(/\/+$/, '');
  return async (method, path, body) => {
    const response = await fetchImpl(`${admin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return text === '' ? undefined : JSON.parse(text);
  };
}

const missing = (error: unknown): boolean => {
  const status = (error as { status?: number }).status;
  return status === 404 || status === 400;
};

/**
 * One key by the rule above; returns the key id and how it was obtained.
 * Writes the id and secret into the secrets volume whenever they changed.
 */
export async function ensureKey(call: Call, dir: string, env: Env, spec: KeySpec): Promise<{ id: string; how: 'explicit' | 'kept' | 'imported' | 'created' }> {
  const explicitId = explicitValue(env, spec.idVar);
  const explicitSecret = explicitValue(env, spec.keyVar);
  const fileId = readSecret(dir, spec.idFile);
  const fileSecret = readSecret(dir, spec.keyFile);
  const given = explicitId !== undefined && explicitSecret !== undefined ? { id: explicitId, secret: explicitSecret } : fileId !== undefined && fileSecret !== undefined ? { id: fileId, secret: fileSecret } : undefined;

  if (given !== undefined) {
    let how: 'explicit' | 'kept' | 'imported' = explicitId !== undefined && explicitSecret !== undefined ? 'explicit' : 'kept';
    try {
      await call('GET', `/v2/GetKeyInfo?id=${encodeURIComponent(given.id)}`);
    } catch (error) {
      if (!missing(error)) throw error;
      await call('POST', '/v2/ImportKey', { accessKeyId: given.id, secretAccessKey: given.secret, name: spec.name });
      how = how === 'explicit' ? 'explicit' : 'imported';
    }
    if (fileId !== given.id) writeFile(dir, spec.idFile, given.id);
    if (fileSecret !== given.secret) writeFile(dir, spec.keyFile, given.secret);
    return { id: given.id, how };
  }

  const created = await call('POST', '/v2/CreateKey', { name: spec.name });
  let secret: string | undefined = created?.secretAccessKey ?? undefined;
  if (secret === undefined || secret === null) {
    const info = await call('GET', `/v2/GetKeyInfo?id=${encodeURIComponent(created.accessKeyId)}&showSecretKey=true`);
    secret = info?.secretAccessKey;
  }
  if (typeof created?.accessKeyId !== 'string' || typeof secret !== 'string') throw new Error(`Garage did not return the new key ${spec.name}.`);
  // the secret first: a reader that finds the id finds its secret too
  writeFile(dir, spec.keyFile, secret);
  writeFile(dir, spec.idFile, created.accessKeyId);
  return { id: created.accessKeyId, how: 'created' };
}

async function waitForGarage(call: Call): Promise<any> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call('GET', '/v2/GetClusterStatus');
    } catch (error) {
      if (attempt >= 60) throw error;
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
}

export async function garageInit(env: Env, call?: Call, log: (line: string) => void = console.log): Promise<void> {
  const dir = secretsDir(env);
  const token = explicitValue(env, 'GARAGE_ADMIN_TOKEN') ?? readSecret(dir, 'garage_admin_token');
  if (token === undefined) throw new Error(`No Garage admin token: set GARAGE_ADMIN_TOKEN, or let the bootstrap service write ${dir}/garage_admin_token.`);
  const api = call ?? adminClient(env['GARAGE_ADMIN_URL'] ?? 'http://garage:3903', token);
  const bucket = env['S3_BUCKET'] ?? 'wirehub';
  const capacity = parseSize(env['GARAGE_CAPACITY'] ?? '100G');

  const status = await waitForGarage(api);
  const node = status.nodes[0];
  if (node.role === null || node.role === undefined) {
    const layout = await api('GET', '/v2/GetClusterLayout');
    await api('POST', '/v2/UpdateClusterLayout', { roles: [{ id: node.id, zone: 'dc1', capacity, tags: ['wirehub'] }] });
    await api('POST', '/v2/ApplyClusterLayout', { version: layout.version + 1 });
    log(`garage-init: layout applied (node ${String(node.id).slice(0, 16)}…, ${capacity} bytes)`);
  } else {
    log('garage-init: layout already set');
  }

  const keys: { id: string; write: boolean; name: string }[] = [];
  for (const spec of KEYS) {
    const key = await ensureKey(api, dir, env, spec);
    keys.push({ id: key.id, write: spec.write, name: spec.name });
    log(`garage-init: key ${spec.name} ${key.how}`);
  }

  let info: any;
  try {
    info = await api('GET', `/v2/GetBucketInfo?globalAlias=${encodeURIComponent(bucket)}`);
    log(`garage-init: bucket ${bucket} present`);
  } catch (error) {
    if (!missing(error)) throw error;
    info = await api('POST', '/v2/CreateBucket', { globalAlias: bucket });
    log(`garage-init: bucket ${bucket} created`);
  }
  for (const key of keys) {
    await api('POST', '/v2/AllowBucketKey', {
      bucketId: info.id,
      accessKeyId: key.id,
      permissions: { read: true, write: key.write, owner: key.write },
    });
  }
  log(`garage-init: ready — bucket ${bucket}, ${keys.length} key(s)`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  garageInit(process.env).catch((error: unknown) => {
    console.error(`garage-init: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
