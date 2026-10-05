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
//
//   Phase 5: publisher keys, signed packs, review status, yanking and revocation
//   node scripts/store-index.mjs publisher-keygen --out <dir> [--id <publisher-id>] [--name <name>]
//       a publisher's key pair: <dir>/wirehub-publisher.key (secret) and .pub; prints the
//       publisher entry to add to the index's store-meta.json (`publisher` below)
//   node scripts/store-index.mjs sign-pack <pack-dir> [--key <file>]...
//       pin every file of the pack by sha256 in its manifest ("files") and write
//       <pack-dir>/wirehub-pack.sig, one signature per --key (a rotation signs with both);
//       without --key, reads WIREHUB_PACK_SIGNING_KEY. The manifest must name its publisher.
//   node scripts/store-index.mjs verify-pack-signature <pack-dir|bundle> --pubkey <RW…|file>
//       check a pack's signature and its pinned files; exit 1 when they do not hold
//   store-meta.json (beside the bundles, or --meta <file>) is what `build` adds to the index;
//   these edit it (then build and sign again):
//   node scripts/store-index.mjs publisher <bundles-dir> --id <id> --name <name> --pubkey <RW…|file> [--url <url>]
//   node scripts/store-index.mjs review <bundles-dir> <id>@<version> --status reviewed --by <who> --on <date> [--note <text>]
//   node scripts/store-index.mjs review <bundles-dir> <id>@<version> --status flagged --reason <text> [--by <who>] [--on <date>]
//   node scripts/store-index.mjs review <bundles-dir> <id>@<version> --status unreviewed
//   node scripts/store-index.mjs yank <bundles-dir> <id>@<version> --reason <text> [--on <date>]
//   node scripts/store-index.mjs unyank <bundles-dir> <id>@<version>
//   node scripts/store-index.mjs revoke <bundles-dir> --pubkey <RW…|file> [--reason <text>] [--on <date>]
//
//   node scripts/store-index.mjs official-pubkey
//       print the official index's public key as this repository records it
//       (OFFICIAL_STORE_PUBLIC_KEY in apps/studio/server/store.ts); empty while it is
//       still the placeholder
//   node scripts/store-index.mjs official-publisher-key
//       print the key of the 'wirehub' publisher as recorded in
//       scripts/official-store-meta.json (the key CI's WIREHUB_PACK_SIGNING_KEY must match)
//   node scripts/store-index.mjs official --out <dir> [--generated <iso>] [--meta <file>] [--modules <dir>]
//       the official index of WireHub's bundled packs (modules/*/pack, not the
//       example): bundles plus an unsigned index.json, ready for `sign`. With --meta
//       scripts/official-store-meta.json the index lists the publisher, and every pack
//       must then be signed (sign-pack) by it. --modules reads the packs from another
//       directory (tests)

import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const store = await import(new URL('packages/catalog/src/store-index.ts', `file://${root}`).href);
const packSig = await import(new URL('packages/catalog/src/pack-signature.ts', `file://${root}`).href);
// The pack archive reader needs the workspace installed (it resolves @wirehub/catalog); the commands that
// only handle keys and signatures do not, so `keygen` works from a plain clone of the repository.
const NO_ARCHIVE = new Set(['keygen', 'pubkey', 'publisher-keygen', 'sign', 'verify', 'official-pubkey', 'official-publisher-key']);
const archive = NO_ARCHIVE.has(process.argv.slice(2).find((a) => !a.startsWith('--'))) ? undefined : await import(new URL('apps/studio/server/pack-archive.ts', `file://${root}`).href);

export const OFFICIAL_STORE = { id: 'wirehub', name: 'WireHub bundled packs', homepage: 'https://github.com/formless63/wirehub' };

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function args(argv) {
  const positional = [];
  const flags = { keys: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (name === 'required') flags.required = true;
      else {
        const value = argv[++i];
        if (value === undefined) die(`--${name} needs a value`, 2);
        flags[name] = value;
        if (name === 'key') flags.keys.push(value);
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

/** A public key given as the `RW…` line or a `.pub` file. */
const publicKeyArg = (value) => (existsSync(value) ? readFileSync(value, 'utf8') : value);

/* ---- store-meta.json: publishers, revoked keys, review and yank per version ---- */

const metaPath = (dir, flags) => flags.meta ?? join(dir, 'store-meta.json');

function readMeta(dir, flags) {
  const path = metaPath(dir, flags);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    die(`${path}: ${error.message}`);
  }
}

function writeMeta(dir, flags, meta) {
  const path = metaPath(dir, flags);
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`${path} updated; now build and sign the index again.`);
}

function versionKey(text) {
  const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(text ?? '');
  if (m === null) die(`'${text ?? ''}' is not <pack-id>@<version>`, 2);
  return text;
}

function setVersionMeta(meta, key, field, value) {
  const versions = { ...(meta.versions ?? {}) };
  const entry = { ...(versions[key] ?? {}) };
  if (value === undefined) delete entry[field];
  else entry[field] = value;
  if (Object.keys(entry).length === 0) delete versions[key];
  else versions[key] = entry;
  return { ...meta, versions };
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

function packSigningKeys(flags) {
  if (flags.keys.length > 0) return flags.keys.map((file) => readFileSync(file, 'utf8'));
  const env = process.env.WIREHUB_PACK_SIGNING_KEY;
  return env === undefined || env.trim() === '' ? [] : [env];
}

/** A pack directory as a studio reads it (the same allowlist and limits): manifest, shipped files, signature. */
function readPackDir(packDir) {
  const manifest = JSON.parse(readFileSync(join(packDir, 'wirehub-pack.json'), 'utf8'));
  let read;
  try {
    read = archive.readPackBytes(zip(filesOf(packDir).map((path) => [path, readFileSync(join(packDir, path))])));
  } catch (error) {
    die(`${packDir}: ${error.message}`);
  }
  return { manifest, read };
}

/** Pin every file and sign the manifest with each key. */
function signPack(packDir, pems) {
  const { manifest, read } = readPackDir(packDir);
  if (typeof manifest.publisher?.id !== 'string') die(`${packDir}: the manifest names no publisher ({ "publisher": { "id", "name" } }); a signed pack names the publisher whose key signs it.`);
  const { files: _old, ...rest } = manifest;
  const signed = { ...rest, files: packSig.packDigests(read.shipped) };
  writeFileSync(join(packDir, 'wirehub-pack.json'), `${JSON.stringify(signed, null, 2)}\n`);
  writeFileSync(join(packDir, packSig.PACK_SIGNATURE), packSig.signPackManifest(signed, pems));
  return { manifest: signed, keys: pems.map((pem) => store.storePublicKeyOf(pem)) };
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
  let whole;
  try {
    whole = archive.readPackBytes(bytes);
    read = whole.files;
  } catch (error) {
    die(`${packDir}: ${error.message}`);
  }
  // a signed pack whose files changed after signing would be refused by every hub
  const stale = packSig.packFileProblems(manifest, whole.shipped);
  if (stale.length > 0) die(`${packDir}: the manifest's pinned files do not match (${stale.slice(0, 3).join('; ')}); run sign-pack again.`);
  for (const path of filesOf(packDir)) {
    if (/^(depictions|art)\//.test(path) && /\.(svg|png|jpe?g|webp|JPE?G|PNG|SVG|WEBP)$/.test(path) && !read.has(path)) {
      die(`${packDir}: '${path}' is an image a studio would not install (lowercase svg/png/jpg/jpeg/webp, safe file names under depictions/ or art/).`);
    }
    if (/^(docs|assets|fonts)\//.test(path) && /\.(pdf|ttf|otf|woff2)$/i.test(path) && !read.has(path)) {
      die(`${packDir}: '${path}' is a PDF or font a studio would not install (lowercase .pdf under docs/ or assets/, .ttf/.otf/.woff2 under fonts/, safe file names).`);
    }
  }
  mkdirSync(out, { recursive: true });
  const file = join(out, `${folder}.zip`);
  writeFileSync(file, bytes);
  return file;
}

/** Every bundle in a directory, read as the studio reads it. */
function readBundles(dir, baseUrl, meta = {}) {
  const bundles = [];
  const revoked = new Map((meta.revokedKeys ?? []).map((r) => [store.normalStoreKey(r.key), r]));
  for (const name of readdirSync(dir).sort()) {
    if (!(name.endsWith('.zip') || name.endsWith('.json')) || name === 'index.json' || name === 'store-meta.json') continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const bytes = new Uint8Array(readFileSync(path));
    let read;
    try {
      read = archive.readPackBytes(bytes);
    } catch (error) {
      if (name.endsWith('.json')) continue; // not a bundle: some other JSON file
      die(`${name}: ${error.message}`);
    }
    const raw = read.shipped.get('wirehub-pack.json');
    if (raw === undefined) die(`${name}: no wirehub-pack.json in it`);
    const manifest = JSON.parse(new TextDecoder().decode(raw));
    // a pack whose publisher the index lists must carry that publisher's signature over its pinned files
    let signedBy;
    const publisher = (meta.publishers ?? []).find((p) => p.id === manifest.publisher?.id);
    if (publisher !== undefined) {
      const keys = [publisher.key, ...(publisher.keys ?? [])];
      const check = packSig.verifyPackSignature(manifest, read.signature, keys, revoked);
      if (!check.ok && check.revoked === undefined) die(`${name}: its manifest names publisher '${publisher.id}', but ${check.reason}. Sign it with sign-pack.`);
      const pins = manifest.files === undefined ? ['the manifest pins no files'] : packSig.packFileProblems(manifest, read.shipped);
      if (pins.length > 0) die(`${name}: ${pins.slice(0, 3).join('; ')}; run sign-pack again.`);
      signedBy = check.ok ? check.signers : check.revoked;
      if (!check.ok) console.log(`warning: ${name} is signed only by a revoked key; hubs will refuse to install it.`);
    }
    bundles.push({
      ...(signedBy === undefined ? {} : { signedBy }),
      manifest,
      url: baseUrl === undefined ? encodeURIComponent(name) : new URL(encodeURIComponent(name), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    });
  }
  return bundles;
}

function buildIndex(dir, flags, storeInfo) {
  const meta = readMeta(dir, flags);
  let index;
  try {
    index = store.buildStoreIndex(storeInfo, readBundles(dir, flags['base-url'], meta), flags.generated, meta);
  } catch (error) {
    die(error.message);
  }
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
  case 'publisher-keygen': {
    if (flags.out === undefined) die('usage: store-index.mjs publisher-keygen --out <dir> (outside the repository) [--id <publisher-id>] [--name <name>]', 2);
    if (insideRepo(flags.out)) die('Refusing to write a private key inside the repository. Choose a directory outside it.');
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    const pub = store.storePublicKeyOf(pem);
    mkdirSync(flags.out, { recursive: true });
    const keyFile = join(flags.out, 'wirehub-publisher.key');
    if (existsSync(keyFile)) die(`${keyFile} exists; not overwriting a key.`);
    writeFileSync(keyFile, pem, { mode: 0o600 });
    writeFileSync(join(flags.out, 'wirehub-publisher.pub'), store.storePublicKeyFile(pub));
    console.log(`private key: ${keyFile} (secret: sign packs with it, never commit it)`);
    console.log(`public key:  ${pub}`);
    console.log(`the publisher entry for the store's store-meta.json (or: store-index.mjs publisher <bundles-dir> --id … --name … --pubkey ${pub}):`);
    console.log(JSON.stringify({ id: flags.id ?? '<publisher-id>', name: flags.name ?? '<publisher name>', key: pub }, null, 2));
    break;
  }
  case 'sign-pack': {
    if (rest.length !== 1) die('usage: store-index.mjs sign-pack <pack-dir> [--key <file>]...', 2);
    const pems = packSigningKeys(flags);
    if (pems.length === 0) die('No signing key (--key <file>, or WIREHUB_PACK_SIGNING_KEY).');
    const { manifest, keys } = signPack(rest[0], pems);
    console.log(`signed: ${join(rest[0], packSig.PACK_SIGNATURE)} (${manifest.id} ${manifest.version}, ${Object.keys(manifest.files).length} files pinned) with ${keys.join(', ')}`);
    break;
  }
  case 'verify-pack-signature': {
    if (rest.length !== 1 || flags.pubkey === undefined) die('usage: store-index.mjs verify-pack-signature <pack-dir|bundle> --pubkey <RW…|file>', 2);
    let manifest;
    let read;
    if (statSync(rest[0]).isDirectory()) ({ manifest, read } = readPackDir(rest[0]));
    else {
      try {
        read = archive.readPackBytes(new Uint8Array(readFileSync(rest[0])));
      } catch (error) {
        die(`${rest[0]}: ${error.message}`);
      }
      manifest = JSON.parse(new TextDecoder().decode(read.shipped.get('wirehub-pack.json') ?? new Uint8Array()));
    }
    const check = packSig.verifyPackSignature(manifest, read.signature, [publicKeyArg(flags.pubkey)]);
    if (!check.ok) die(`NOT VERIFIED: ${check.reason}`);
    const pins = manifest.files === undefined ? ['the manifest pins no files'] : packSig.packFileProblems(manifest, read.shipped);
    if (pins.length > 0) die(`Signed, but the files do not match: ${pins.join('; ')}`);
    console.log(`verified: ${manifest.id} ${manifest.version}, ${Object.keys(manifest.files).length} files pinned`);
    break;
  }
  case 'publisher': {
    if (rest.length !== 1 || flags.id === undefined || flags.name === undefined || flags.pubkey === undefined) die('usage: store-index.mjs publisher <bundles-dir> --id <id> --name <name> --pubkey <RW…|file> [--url <url>]', 2);
    let key;
    try {
      key = store.normalStoreKey(publicKeyArg(flags.pubkey));
    } catch (error) {
      die(error.message);
    }
    const meta = readMeta(rest[0], flags);
    const others = (meta.publishers ?? []).filter((p) => p.id !== flags.id);
    const before = (meta.publishers ?? []).find((p) => p.id === flags.id);
    // a new key for a known publisher is a rotation: the old one stays valid for the packs it signed, unless revoked
    const kept = before === undefined ? [] : [before.key, ...(before.keys ?? [])].map(store.normalStoreKey).filter((k) => k !== key);
    const entry = { id: flags.id, name: flags.name, key, ...(kept.length === 0 ? {} : { keys: [...new Set(kept)] }), ...(flags.url === undefined ? {} : { url: flags.url }) };
    writeMeta(rest[0], flags, { ...meta, publishers: [...others, entry].sort((a, b) => a.id.localeCompare(b.id)) });
    break;
  }
  case 'review': {
    if (rest.length !== 2 || flags.status === undefined) die('usage: store-index.mjs review <bundles-dir> <id>@<version> --status reviewed|flagged|unreviewed …', 2);
    const key = versionKey(rest[1]);
    let review;
    if (flags.status === 'reviewed') {
      if (flags.by === undefined || flags.on === undefined) die('a reviewed version names who reviewed it and when: --by <who> --on <date>', 2);
      review = { status: 'reviewed', by: flags.by, on: flags.on, ...(flags.note === undefined ? {} : { note: flags.note }) };
    } else if (flags.status === 'flagged') {
      if (flags.reason === undefined) die('a flagged version says why: --reason <text>', 2);
      review = { status: 'flagged', reason: flags.reason, ...(flags.by === undefined ? {} : { by: flags.by }), ...(flags.on === undefined ? {} : { on: flags.on }) };
    } else if (flags.status !== 'unreviewed') die('--status is reviewed, flagged or unreviewed', 2);
    writeMeta(rest[0], flags, setVersionMeta(readMeta(rest[0], flags), key, 'review', review));
    break;
  }
  case 'yank': {
    if (rest.length !== 2 || flags.reason === undefined) die('usage: store-index.mjs yank <bundles-dir> <id>@<version> --reason <text> [--on <date>]', 2);
    writeMeta(rest[0], flags, setVersionMeta(readMeta(rest[0], flags), versionKey(rest[1]), 'yanked', { reason: flags.reason, ...(flags.on === undefined ? {} : { on: flags.on }) }));
    break;
  }
  case 'unyank': {
    if (rest.length !== 2) die('usage: store-index.mjs unyank <bundles-dir> <id>@<version>', 2);
    writeMeta(rest[0], flags, setVersionMeta(readMeta(rest[0], flags), versionKey(rest[1]), 'yanked', undefined));
    break;
  }
  case 'revoke': {
    if (rest.length !== 1 || flags.pubkey === undefined) die('usage: store-index.mjs revoke <bundles-dir> --pubkey <RW…|file> [--reason <text>] [--on <date>]', 2);
    let key;
    try {
      key = store.normalStoreKey(publicKeyArg(flags.pubkey));
    } catch (error) {
      die(error.message);
    }
    const meta = readMeta(rest[0], flags);
    const others = (meta.revokedKeys ?? []).filter((r) => store.normalStoreKey(r.key) !== key);
    writeMeta(rest[0], flags, { ...meta, revokedKeys: [...others, { key, ...(flags.reason === undefined ? {} : { reason: flags.reason }), ...(flags.on === undefined ? {} : { on: flags.on }) }] });
    break;
  }
  case 'official-pubkey': {
    const source = readFileSync(join(root, 'apps/studio/server/store.ts'), 'utf8');
    const key = /^export const OFFICIAL_STORE_PUBLIC_KEY(?::\s*string)?\s*=\s*'([^']*)';$/m.exec(source);
    if (key === null) die('apps/studio/server/store.ts has no OFFICIAL_STORE_PUBLIC_KEY line');
    console.log(key[1]);
    break;
  }
  case 'official-publisher-key': {
    const meta = JSON.parse(readFileSync(join(root, 'scripts/official-store-meta.json'), 'utf8'));
    const publisher = (meta.publishers ?? []).find((p) => p.id === 'wirehub');
    if (publisher === undefined) die('scripts/official-store-meta.json records no wirehub publisher');
    console.log(publisher.key);
    break;
  }
  case 'official': {
    if (flags.out === undefined) die('usage: store-index.mjs official --out <dir> [--meta <file>] [--modules <dir>]', 2);
    const modules = flags.modules === undefined ? join(root, 'modules') : resolve(flags.modules);
    for (const id of readdirSync(modules).sort()) {
      const pack = join(modules, id, 'pack');
      if (id === 'example' || !existsSync(join(pack, 'wirehub-pack.json'))) continue;
      console.log(`bundle: ${bundlePack(pack, flags.out)}`);
    }
    buildIndex(flags.out, { ...flags, out: join(flags.out, 'index.json') }, OFFICIAL_STORE);
    break;
  }
  default:
    die('usage: store-index.mjs keygen | pubkey | bundle | build | sign | verify | publisher-keygen | sign-pack | verify-pack-signature | publisher | review | yank | unyank | revoke | official-pubkey | official-publisher-key | official (see the header of scripts/store-index.mjs)', 2);
}
