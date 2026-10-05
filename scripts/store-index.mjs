#!/usr/bin/env node
// Build, sign and verify a WireHub catalog store index (docs/catalog-store.md §4).
// Plain Node 24 (type stripping), no install needed.
//
//   node scripts/store-index.mjs keygen --out <dir>
//       a new ed25519 key pair: <dir>/wirehub-store.key (PKCS#8 PEM, mode 600; keep it
//       secret, never commit it) and <dir>/wirehub-store.pub (minisign public key)
//   node scripts/store-index.mjs pubkey [--key <file>]
//       print the public key (RW…) of a private key; without --key, reads the
//       WIREHUB_STORE_SIGNING_KEY environment variable
//   node scripts/store-index.mjs bundle <pack-dir>... --out <dir>
//       zip each pack directory as <dir>/<id>-<version>.zip (stored, sorted, fixed dates:
//       the same pack always gives the same bytes), its depictions/** and art/** images
//       included; refuses a pack a studio would not install (image type or size)
//   node scripts/store-index.mjs build <bundles-dir> [--out <file>] [--store-id <id>]
//       [--store-name <name>] [--homepage <url>] [--base-url <url>] [--generated <iso>]
//       index every bundle (.zip or JSON bundle) in the directory into index.json
//       (default <bundles-dir>/index.json); bundle URLs are relative to the index
//       unless --base-url is given
//   node scripts/store-index.mjs sign <index.json> [--key <file>] [--required]
//       write <index.json>.minisig; without --key, reads WIREHUB_STORE_SIGNING_KEY;
//       with no key at all it says so and leaves the index unsigned (exit 0), or
//       fails with --required
//   node scripts/store-index.mjs verify <index.json> --pubkey <RW…|file>
//       check the signature (and the index's shape); exit 1 when it does not verify
//   node scripts/store-index.mjs official-pubkey
//       print the official index's public key as this repository records it
//       (OFFICIAL_STORE_PUBLIC_KEY in apps/studio/server/store.ts); empty while it is
//       still the placeholder
//   node scripts/store-index.mjs official --out <dir> [--generated <iso>]
//       the official index of WireHub's bundled packs (modules/*/pack, not the
//       example): bundles plus an unsigned index.json, ready for `sign`

import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const store = await import(new URL('packages/catalog/src/store-index.ts', `file://${root}`).href);
const archive = await import(new URL('apps/studio/server/pack-archive.ts', `file://${root}`).href);

export const OFFICIAL_STORE = { id: 'wirehub', name: 'WireHub bundled packs', homepage: 'https://github.com/formless63/wirehub' };

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function args(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (name === 'required') flags.required = true;
      else {
        const value = argv[++i];
        if (value === undefined) die(`--${name} needs a value`, 2);
        flags[name] = value;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

const insideRepo = (path) => {
  const r = relative(root, resolve(path));
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r));
};

function signingKey(flags) {
  if (flags.key !== undefined) return readFileSync(flags.key, 'utf8');
  const env = process.env.WIREHUB_STORE_SIGNING_KEY;
  return env === undefined || env.trim() === '' ? undefined : env;
}

/* ---- zip (stored entries, fixed 1980-01-01 dates) ---- */

function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function filesOf(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesOf(dir, path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

/** Zip one pack directory as `<id>-<version>.zip` under `out`; returns its path. */
export function bundlePack(packDir, out) {
  const manifest = JSON.parse(readFileSync(join(packDir, 'wirehub-pack.json'), 'utf8'));
  if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') die(`${packDir}: the manifest names no id or version`);
  const folder = `${manifest.id}-${manifest.version}`;
  const bytes = zip(filesOf(packDir).map((path) => [`${folder}/${path}`, readFileSync(join(packDir, path))]));
  // what a studio would unpack must carry every image the pack ships (depictions/**, art/**): the
  // allowlist and the size limits are the installer's (`pack-archive.ts`), so a pack that would be refused is refused here
  let read;
  try {
    read = archive.readPackBytes(bytes).files;
  } catch (error) {
    die(`${packDir}: ${error.message}`);
  }
  for (const path of filesOf(packDir)) {
    if (/^(depictions|art)\//.test(path) && /\.(svg|png|jpe?g|webp|JPE?G|PNG|SVG|WEBP)$/.test(path) && !read.has(path)) {
      die(`${packDir}: '${path}' is an image a studio would not install (lowercase svg/png/jpg/jpeg/webp, safe file names under depictions/ or art/).`);
    }
  }
  mkdirSync(out, { recursive: true });
  const file = join(out, `${folder}.zip`);
  writeFileSync(file, bytes);
  return file;
}

/** Every bundle in a directory, read as the studio reads it. */
function readBundles(dir, baseUrl) {
  const bundles = [];
  for (const name of readdirSync(dir).sort()) {
    if (!(name.endsWith('.zip') || name.endsWith('.json')) || name === 'index.json') continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const bytes = new Uint8Array(readFileSync(path));
    let files;
    try {
      files = archive.readPackBytes(bytes).files;
    } catch (error) {
      if (name.endsWith('.json')) continue; // not a bundle: some other JSON file
      die(`${name}: ${error.message}`);
    }
    const raw = files.get('wirehub-pack.json');
    if (raw === undefined) die(`${name}: no wirehub-pack.json in it`);
    const manifest = JSON.parse(new TextDecoder().decode(raw));
    bundles.push({
      manifest,
      url: baseUrl === undefined ? encodeURIComponent(name) : new URL(encodeURIComponent(name), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    });
  }
  return bundles;
}

function buildIndex(dir, flags, storeInfo) {
  const index = store.buildStoreIndex(storeInfo, readBundles(dir, flags['base-url']), flags.generated);
  const checked = store.parseStoreIndex(index);
  if (checked.problems.length > 0) die(`The index is not valid: ${checked.problems.join('; ')}`);
  const out = flags.out ?? join(dir, 'index.json');
  writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`index: ${out} (${index.packs.length} pack${index.packs.length === 1 ? '' : 's'}, ${index.packs.reduce((n, p) => n + p.versions.length, 0)} versions)`);
  return out;
}

function signIndex(file, flags) {
  const key = signingKey(flags);
  if (key === undefined) {
    const sentence = 'No signing key (WIREHUB_STORE_SIGNING_KEY or --key): the index is left UNSIGNED, and deployments will refuse it until it is signed.';
    if (flags.required) die(sentence);
    console.log(sentence);
    return false;
  }
  const bytes = readFileSync(file);
  const index = JSON.parse(bytes.toString('utf8'));
  const comment = `wirehub store index ${index.store?.id ?? ''}${index.generated === undefined ? '' : ` ${index.generated}`} file:${basename(file)}`;
  writeFileSync(`${file}${store.STORE_SIGNATURE_SUFFIX}`, store.signStoreIndex(bytes, key, comment));
  console.log(`signed: ${file}${store.STORE_SIGNATURE_SUFFIX} with ${store.storePublicKeyOf(key)}`);
  return true;
}

const { positional, flags } = args(process.argv.slice(2));
const [command, ...rest] = positional;

switch (command) {
  case 'keygen': {
    if (flags.out === undefined) die('usage: store-index.mjs keygen --out <dir> (outside the repository)', 2);
    if (insideRepo(flags.out)) die('Refusing to write a private key inside the repository. Choose a directory outside it.');
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    const pub = store.storePublicKeyOf(pem);
    mkdirSync(flags.out, { recursive: true });
    const keyFile = join(flags.out, 'wirehub-store.key');
    if (existsSync(keyFile)) die(`${keyFile} exists; not overwriting a key.`);
    writeFileSync(keyFile, pem, { mode: 0o600 });
    writeFileSync(join(flags.out, 'wirehub-store.pub'), store.storePublicKeyFile(pub));
    console.log(`private key: ${keyFile} (secret: store it as the WIREHUB_STORE_SIGNING_KEY secret, never commit it)`);
    console.log(`public key:  ${pub}`);
    break;
  }
  case 'pubkey': {
    const key = signingKey(flags);
    if (key === undefined) die('usage: store-index.mjs pubkey --key <file> (or set WIREHUB_STORE_SIGNING_KEY)', 2);
    console.log(store.storePublicKeyOf(key));
    break;
  }
  case 'bundle': {
    if (rest.length === 0 || flags.out === undefined) die('usage: store-index.mjs bundle <pack-dir>... --out <dir>', 2);
    for (const dir of rest) console.log(`bundle: ${bundlePack(dir, flags.out)}`);
    break;
  }
  case 'build': {
    if (rest.length !== 1) die('usage: store-index.mjs build <bundles-dir> [--out <file>] [--store-id <id>] [--store-name <name>] [--homepage <url>] [--base-url <url>]', 2);
    if (flags['store-id'] === undefined || flags['store-name'] === undefined) die('build needs --store-id <kebab-id> and --store-name <name>', 2);
    buildIndex(rest[0], flags, { id: flags['store-id'], name: flags['store-name'], ...(flags.homepage === undefined ? {} : { homepage: flags.homepage }) });
    break;
  }
  case 'sign': {
    if (rest.length !== 1) die('usage: store-index.mjs sign <index.json> [--key <file>] [--required]', 2);
    signIndex(rest[0], flags);
    break;
  }
  case 'verify': {
    if (rest.length !== 1 || flags.pubkey === undefined) die('usage: store-index.mjs verify <index.json> --pubkey <RW…|file>', 2);
    const pub = existsSync(flags.pubkey) ? readFileSync(flags.pubkey, 'utf8') : flags.pubkey;
    const sigFile = `${rest[0]}${store.STORE_SIGNATURE_SUFFIX}`;
    if (!existsSync(sigFile)) die(`${sigFile} does not exist: the index is unsigned.`);
    const bytes = readFileSync(rest[0]);
    const check = store.verifyStoreSignature(bytes, readFileSync(sigFile, 'utf8'), pub);
    if (!check.ok) die(`NOT VERIFIED: ${check.reason}`);
    const shape = store.parseStoreIndex(JSON.parse(bytes.toString('utf8')));
    if (shape.problems.length > 0) die(`Signed, but not a valid index: ${shape.problems.join('; ')}`);
    console.log(`verified (${check.trustedComment})`);
    break;
  }
  case 'official-pubkey': {
    const source = readFileSync(join(root, 'apps/studio/server/store.ts'), 'utf8');
    const key = /^export const OFFICIAL_STORE_PUBLIC_KEY = '([^']*)';$/m.exec(source);
    if (key === null) die('apps/studio/server/store.ts has no OFFICIAL_STORE_PUBLIC_KEY line');
    console.log(key[1]);
    break;
  }
  case 'official': {
    if (flags.out === undefined) die('usage: store-index.mjs official --out <dir>', 2);
    const modules = join(root, 'modules');
    for (const id of readdirSync(modules).sort()) {
      const pack = join(modules, id, 'pack');
      if (id === 'example' || !existsSync(join(pack, 'wirehub-pack.json'))) continue;
      console.log(`bundle: ${bundlePack(pack, flags.out)}`);
    }
    buildIndex(flags.out, { ...flags, out: join(flags.out, 'index.json') }, OFFICIAL_STORE);
    break;
  }
  default:
    die('usage: store-index.mjs keygen | pubkey | bundle | build | sign | verify | official (see the header of scripts/store-index.mjs)', 2);
}
