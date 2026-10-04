// One-shot setup of a single-node Garage for WireHub (the `garage-init`
// service in compose.yaml). Idempotent: safe to run on every `up`.
//
//   1. give the node a role in the cluster layout and apply it;
//   2. import the app's access key (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY)
//      and, when set, a read-only key for backups (S3_BACKUP_ACCESS_KEY_ID /
//      S3_BACKUP_SECRET_ACCESS_KEY);
//   3. create the bucket (S3_BUCKET) and grant the keys.
//
// Talks to Garage's admin API v2 (GARAGE_ADMIN_URL, GARAGE_ADMIN_TOKEN) with
// fetch, so it runs in the WireHub image with no extra tools.

const env = process.env;
const admin = (env.GARAGE_ADMIN_URL ?? 'http://garage:3903').replace(/\/+$/, '');
const token = env.GARAGE_ADMIN_TOKEN ?? '';
const bucket = env.S3_BUCKET ?? 'wirehub';
const capacity = parseSize(env.GARAGE_CAPACITY ?? '100G');
const keys = [
  { id: env.S3_ACCESS_KEY_ID, secret: env.S3_SECRET_ACCESS_KEY, name: 'wirehub-app', write: true },
  { id: env.S3_BACKUP_ACCESS_KEY_ID, secret: env.S3_BACKUP_SECRET_ACCESS_KEY, name: 'wirehub-backup', write: false },
].filter((key) => (key.id ?? '') !== '');

function parseSize(text) {
  const match = /^(\d+)\s*([KMGT]?)B?$/i.exec(text.trim());
  if (match === null) throw new Error(`GARAGE_CAPACITY: not a size: ${text}`);
  const power = { '': 0, K: 1, M: 2, G: 3, T: 4 }[match[2].toUpperCase()];
  return Number(match[1]) * 1000 ** power;
}

async function call(method, path, body) {
  const response = await fetch(`${admin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return text === '' ? undefined : JSON.parse(text);
}

async function waitForGarage() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call('GET', '/v2/GetClusterStatus');
    } catch (error) {
      if (attempt >= 60) throw error;
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
}

async function main() {
  if (token === '') throw new Error('GARAGE_ADMIN_TOKEN is not set.');
  if (keys.length === 0) throw new Error('S3_ACCESS_KEY_ID is not set.');

  const status = await waitForGarage();
  const node = status.nodes[0];
  if (node.role === null || node.role === undefined) {
    const layout = await call('GET', '/v2/GetClusterLayout');
    await call('POST', '/v2/UpdateClusterLayout', { roles: [{ id: node.id, zone: 'dc1', capacity, tags: ['wirehub'] }] });
    await call('POST', '/v2/ApplyClusterLayout', { version: layout.version + 1 });
    console.log(`garage-init: layout applied (node ${node.id.slice(0, 16)}…, ${capacity} bytes)`);
  } else {
    console.log('garage-init: layout already set');
  }

  for (const key of keys) {
    try {
      await call('GET', `/v2/GetKeyInfo?id=${encodeURIComponent(key.id)}`);
      console.log(`garage-init: key ${key.name} present`);
    } catch (error) {
      if (error.status !== 404 && error.status !== 400) throw error;
      await call('POST', '/v2/ImportKey', { accessKeyId: key.id, secretAccessKey: key.secret, name: key.name });
      console.log(`garage-init: key ${key.name} imported`);
    }
  }

  let info;
  try {
    info = await call('GET', `/v2/GetBucketInfo?globalAlias=${encodeURIComponent(bucket)}`);
    console.log(`garage-init: bucket ${bucket} present`);
  } catch (error) {
    if (error.status !== 404 && error.status !== 400) throw error;
    info = await call('POST', '/v2/CreateBucket', { globalAlias: bucket });
    console.log(`garage-init: bucket ${bucket} created`);
  }
  for (const key of keys) {
    await call('POST', '/v2/AllowBucketKey', {
      bucketId: info.id,
      accessKeyId: key.id,
      permissions: { read: true, write: key.write, owner: key.write },
    });
  }
  console.log(`garage-init: ready — bucket ${bucket}, ${keys.length} key(s)`);
}

main().catch((error) => {
  console.error(`garage-init: ${error.message}`);
  process.exit(1);
});
