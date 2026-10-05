/**
 * Catalog packs in the file backend (`docs/catalog-store.md`).
 *
 * A pack is a directory laid out like `data/` plus a `wirehub-pack.json`
 * manifest. Two ways to use one:
 *
 * - **Layered, read-only** — `layeredCatalogSource([local, packA, packB])`
 *   merges the layers on every read: record files by id, vocabulary lists by
 *   entry id, tag tables by key, other files by first layer. The first layer
 *   wins, so a local record shadows a pack's. Tests and `pack verify` use
 *   this to see a catalog *with* a pack without writing anything.
 * - **Installed as a layer** — `installPackLayer` copies a pack into a
 *   *packs directory* (`<packs>/<id>/`, recorded in `<packs>/packs.json`)
 *   after checking that none of its records clashes with the catalog, and
 *   `catalogWithPacksSource(catalog, packs)` reads the catalog with every
 *   installed pack under it. The catalog's own files never receive a pack
 *   record: what first-run setup installs stays out of the starter catalog
 *   (and out of a checkout's commits). `localPartOf` is the other half — the
 *   part of an edited file that belongs in the catalog's own file once the
 *   records a pack supplies unchanged are left out.
 * - **Merged** — `planPackInstall` / `installPack` merge a pack's records
 *   into a catalog directory once, refuse any record whose id the catalog
 *   already uses for something different, and record the install in
 *   `packs.json`. After it, the records are ordinary catalog data (a tool
 *   that builds a catalog copy with a pack in it uses this).
 *
 * Canonical JSON (`JSON.stringify(v, null, 2) + '\n'`); list order is data —
 * local records first, a pack's appended in its own order.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fsCatalogSource, type CatalogSource } from './source.ts';

/** `wirehub-pack.json`. */
export interface PackManifest {
  format: 1;
  /** kebab, globally unique in a store */
  id: string;
  name: string;
  /** semver of the data */
  version: string;
  publisher?: { id: string; name: string };
  /** SPDX: the default for records that name none */
  license: string;
  catalogSchema?: number;
  requires?: { wirehub?: string; packs?: Record<string, string> };
  description?: string;
  counts?: Record<string, number>;
  homepage?: string;
  source?: string;
  /** the field it serves (`pro-audio`, `fieldbus` …), for the store index; the id when absent */
  domain?: string;
  /**
   * Every other file of the pack pinned by sha256 (lowercase hex; JSON in canonical
   * form), so a signature over the manifest (`wirehub-pack.sig`) covers the whole
   * pack (`pack-signature.ts`). Written by `store-index.mjs sign-pack`.
   */
  files?: Record<string, string>;
}

export const PACK_MANIFEST = 'wirehub-pack.json';

/** One installed pack, as `packs.json` records it. */
export interface InstalledPack {
  id: string;
  version: string;
  license: string;
  /** the record files and ids the pack added (`connectors.json` → ids, `vocab/signals.json` → entry ids, `designs/x.json` → []) */
  added: Record<string, string[]>;
  /**
   * The depiction and art files the pack installed, by path in the pack
   * (`depictions/<def>/mating-face.svg`, `depictions/<def>/meta.json`,
   * `art/x.png`) → sha256 of the content as installed (`assetSha`). Absent in
   * a `packs.json` from before ownership was recorded; then nothing is known
   * of the files and none is removed.
   */
  assets?: Record<string, string>;
  /**
   * Where it was installed from, when that was a store index (phase 5): the index,
   * the publisher whose key signed it and the keys whose signature verified, so a
   * later revocation of those keys flags the installed pack. Absent for a pack
   * installed from a file, a URL or a module.
   */
  origin?: { index: string; publisher?: string; signedBy?: string[] };
}

/** `packs.json`: the packs installed into this catalog. */
export interface InstalledPacks {
  src: string;
  packs: InstalledPack[];
}

export const PACKS_FILE = 'packs.json';

export const canonical = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export type Json = unknown;

export const isPlainObject = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const idOf = (value: Json): string | undefined =>
  isPlainObject(value) && typeof value['id'] === 'string' ? value['id'] : undefined;

/** Records by id, first layer wins; records without an id are kept in order. */
function mergeRecords(layers: Json[][]): Json[] {
  const seen = new Set<string>();
  const out: Json[] = [];
  for (const records of layers) {
    for (const record of records) {
      const id = idOf(record);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(record);
    }
  }
  return out;
}

/** Plain objects merged key by key, first layer wins at every leaf. */
function mergeObjects(layers: Record<string, Json>[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      const existing = out[key];
      if (existing === undefined) out[key] = value;
      else if (isPlainObject(existing) && isPlainObject(value)) out[key] = mergeObjects([existing, value]);
    }
  }
  return out;
}

/** The merge of one file's texts across layers, first layer first. */
export function mergeCatalogFile(relative: string, texts: string[]): string {
  if (texts.length === 1 || !relative.endsWith('.json')) return texts[0] as string;
  const values = texts.map((text) => JSON.parse(text) as Json);
  if (values.every(Array.isArray)) return canonical(mergeRecords(values as Json[][]));
  if (values.every((v) => isPlainObject(v) && Array.isArray(v['entries']))) {
    const lists = values as Record<string, Json>[];
    return canonical({ ...lists[0], entries: mergeRecords(lists.map((l) => l['entries'] as Json[])) });
  }
  if (relative.startsWith('tags/') && values.every(isPlainObject)) {
    return canonical(mergeObjects(values as Record<string, Json>[]));
  }
  return texts[0] as string;
}

/**
 * Several catalog sources read as one: a local catalog first, then the packs
 * it is layered over. Read-only — writes go to a layer's own directory.
 */
export function layeredCatalogSource(layers: readonly CatalogSource[], name?: string): CatalogSource {
  const first = layers[0];
  return {
    name: name ?? layers.map((layer) => layer.name).join(' + '),
    ...(first?.root === undefined ? {} : { root: first.root }),
    read(relative) {
      const texts = layers.map((layer) => layer.read(relative)).filter((t): t is string => t !== undefined);
      if (texts.length === 0) return undefined;
      return mergeCatalogFile(relative, texts);
    },
    list(relativeDir) {
      const names = new Set<string>();
      for (const layer of layers) for (const n of layer.list(relativeDir)) names.add(n);
      return [...names].sort();
    },
  };
}

/** A pack directory's manifest, or a sentence saying why it is not a pack. */
export function readPackManifest(dir: string): PackManifest {
  const path = join(dir, PACK_MANIFEST);
  if (!existsSync(path)) throw new Error(`${dir} is not a catalog pack: it has no ${PACK_MANIFEST}.`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackManifest;
  if (manifest.format !== 1) throw new Error(`${path}: unsupported pack format ${String(manifest.format)}.`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id ?? '')) throw new Error(`${path}: the pack id must be kebab-case.`);
  if (typeof manifest.version !== 'string' || typeof manifest.license !== 'string') {
    throw new Error(`${path}: a pack names its version and its licence.`);
  }
  return manifest;
}

/** Every data file of a pack directory, relative, sorted (the manifest and docs left out). */
export function packFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && path !== PACK_MANIFEST && path.endsWith('.json')) out.push(path);
    }
  };
  walk('');
  return out.sort();
}

/**
 * The art files of a pack that are not JSON — the images under `depictions/`
 * and `art/` (`svg`, `png`, `jpg`, `webp`) — relative, sorted. A layered install copies
 * them beside the data files, so a pack's faces and cutaways arrive with it
 * (`specs/drawing-language.md` §7).
 */
export function packAssetFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    if (!existsSync(join(dir, relative))) return;
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(svg|png|jpe?g|webp)$/.test(entry.name)) out.push(path);
    }
  };
  walk('depictions');
  walk('art');
  return out.sort();
}

/** sha256 of an asset as it is stored; a JSON file is hashed in the form the stores write it (2-space, trailing newline). */
export function assetSha(relative: string, bytes: Uint8Array | string): string {
  let content = bytes;
  if (relative.endsWith('.json')) {
    try {
      content = canonical(JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')));
    } catch {
      // not JSON after all: hashed as it is
    }
  }
  return createHash('sha256').update(content).digest('hex');
}

/** The depiction and art files a pack ships (`depictions/**`, JSON manifests included, and `art/**` images) → `assetSha`. */
export function packOwnedAssets(dir: string): Record<string, string> {
  const paths = new Set([...packAssetFiles(dir), ...packFiles(dir).filter((p) => p.startsWith('depictions/'))]);
  return Object.fromEntries([...paths].sort().map((p) => [p, assetSha(p, readFileSync(join(dir, p)))] as const));
}

/** Where a pack asset sits in a catalog tree (`<root>/data`, `<root>/depictions`), given the data directory. */
export function assetPath(dataDir: string, relative: string): string {
  return relative.startsWith('depictions/') ? join(dirname(dataDir), relative) : join(dataDir, relative);
}

/** The path of a pack asset in a flattened catalog (`depictions/…`, `data/art/…`). */
export const flatAssetPath = (relative: string): string => (relative.startsWith('depictions/') ? relative : `data/${relative}`);

/** What to do with a pack's asset files: write, remove, and which the pack owns afterwards. */
export interface AssetOps {
  write: string[];
  remove: string[];
  owned: Record<string, string>;
}

/**
 * The catalog's own files always win. `before` is what the pack owned (the
 * installed record), `next` what the version being installed ships, `current`
 * the hash of what the catalog holds now (`undefined`: nothing there).
 * - a shipped file nobody holds is written and owned;
 * - one the pack owned and nobody touched is replaced when it changed (still owned);
 * - anything else already there is the catalog's own: left alone, not owned
 *   (also when it happens to be identical);
 * - an owned file the new version no longer ships is removed, unless the
 *   catalog's copy was changed since (then it is the catalog's now).
 * An empty `next` is a disable.
 */
export function reconcileAssets(before: Readonly<Record<string, string>> | undefined, next: Readonly<Record<string, string>>, current: (relative: string) => string | undefined): AssetOps {
  const ops: AssetOps = { write: [], remove: [], owned: {} };
  for (const [path, sha] of Object.entries(next)) {
    const now = current(path);
    if (now === undefined) {
      ops.write.push(path);
      ops.owned[path] = sha;
    } else if (before?.[path] !== undefined && now === before[path]) {
      if (now !== sha) ops.write.push(path);
      ops.owned[path] = sha;
    }
  }
  for (const [path, sha] of Object.entries(before ?? {})) {
    if (path in next) continue;
    if (current(path) === sha) ops.remove.push(path);
  }
  return ops;
}

/** Apply `reconcileAssets` to the catalog tree beside `dataDir` (the merged layout: `depictions/` next to `data/`). Returns what the pack owns now. */
export function applyPackAssets(dataDir: string, packDir: string | undefined, before: Readonly<Record<string, string>> | undefined, next: Readonly<Record<string, string>>): Record<string, string> {
  const current = (relative: string): string | undefined => {
    const path = assetPath(dataDir, relative);
    return existsSync(path) ? assetSha(relative, readFileSync(path)) : undefined;
  };
  const ops = reconcileAssets(before, next, current);
  for (const relative of ops.remove) rmSync(assetPath(dataDir, relative), { force: true });
  for (const relative of ops.write) {
    if (packDir === undefined) continue;
    const to = assetPath(dataDir, relative);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(packDir, relative), to);
  }
  return ops.owned;
}

/** What installing a pack would do, before anything is written. */
export interface PackInstallPlan {
  manifest: PackManifest;
  /** file → its new text (only files that change) */
  writes: Record<string, string>;
  added: Record<string, string[]>;
  /** records the catalog already has under the same id with different content */
  conflicts: string[];
  /** the pack is already installed at this version */
  alreadyInstalled: boolean;
}

/** Where a record or entry list sits in a file's JSON. */
export function recordsIn(value: Json): Json[] | undefined {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value) && Array.isArray(value['entries'])) return value['entries'] as Json[];
  return undefined;
}

/**
 * Plan the install of the pack at `packDir` into the catalog directory
 * `catalogDir`: every record whose id is new is appended; a record the catalog
 * already has, identical, is skipped; a record the catalog has *differently*
 * is a conflict, and a plan with conflicts must not be applied.
 */
export function planPackInstall(catalogDir: string, packDir: string): PackInstallPlan {
  return planAgainst(fsCatalogSource(catalogDir), readInstalledPacks(catalogDir), packDir);
}

function planAgainst(local: CatalogSource, installed: InstalledPacks, packDir: string): PackInstallPlan {
  const manifest = readPackManifest(packDir);
  const writes: Record<string, string> = {};
  const added: Record<string, string[]> = {};
  const conflicts: string[] = [];
  for (const relative of packFiles(packDir)) {
    const packText = readFileSync(join(packDir, relative), 'utf8');
    const localText = local.read(relative);
    if (localText === undefined) {
      writes[relative] = packText;
      const records = recordsIn(JSON.parse(packText) as Json);
      added[relative] = records === undefined ? [] : records.map(idOf).filter((id): id is string => id !== undefined);
      continue;
    }
    const packValue = JSON.parse(packText) as Json;
    const localValue = JSON.parse(localText) as Json;
    const packRecords = recordsIn(packValue);
    const localRecords = recordsIn(localValue);
    if (packRecords === undefined || localRecords === undefined) {
      if (localText !== packText && JSON.stringify(localValue) !== JSON.stringify(packValue)) {
        conflicts.push(`${relative}: the catalog already has a different file`);
      }
      continue;
    }
    const byId = new Map(localRecords.map((r) => [idOf(r), r] as const));
    const fresh: Json[] = [];
    for (const record of packRecords) {
      const id = idOf(record);
      const existing = id === undefined ? undefined : byId.get(id);
      if (existing === undefined) fresh.push(record);
      else if (JSON.stringify(existing) !== JSON.stringify(record)) conflicts.push(`${relative}: '${id}' already exists with different content`);
    }
    if (fresh.length === 0) continue;
    added[relative] = fresh.map(idOf).filter((id): id is string => id !== undefined);
    const merged = Array.isArray(localValue) ? [...localValue, ...fresh] : { ...(localValue as Record<string, Json>), entries: [...localRecords, ...fresh] };
    writes[relative] = canonical(merged);
  }
  const alreadyInstalled = installed.packs.some((p) => p.id === manifest.id && p.version === manifest.version);
  return { manifest, writes, added, conflicts, alreadyInstalled };
}

/** `packs.json`, or an empty record when nothing was installed. */
export function readInstalledPacks(catalogDir: string): InstalledPacks {
  const path = join(catalogDir, PACKS_FILE);
  if (!existsSync(path)) return { src: 'catalog packs installed into this catalog (docs/catalog-store.md)', packs: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as InstalledPacks;
}

export function writeFileReplacing(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.pack-tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/**
 * Install the pack at `packDir` into `catalogDir`. Throws, naming every
 * conflict, and writes nothing, when the plan has conflicts. Installing the
 * same version twice is a no-op. Returns the plan that was applied.
 */
export function installPack(catalogDir: string, packDir: string): PackInstallPlan {
  const plan = planPackInstall(catalogDir, packDir);
  if (plan.alreadyInstalled) return plan;
  if (plan.conflicts.length > 0) {
    throw new Error(`Pack '${plan.manifest.id}' cannot be installed: ${plan.conflicts.join('; ')}.`);
  }
  for (const [relative, text] of Object.entries(plan.writes)) writeFileReplacing(join(catalogDir, relative), text);
  const installed = readInstalledPacks(catalogDir);
  // the merging installer keeps a pack's depictions as `data/depictions/…` documents (as before); it records the
  // files the pack ships like a layered install does, so an update brings them beside the catalog and keeps the record the same
  const assets = packOwnedAssets(packDir);
  const record: InstalledPack = { id: plan.manifest.id, version: plan.manifest.version, license: plan.manifest.license, added: plan.added, ...(Object.keys(assets).length === 0 ? {} : { assets }) };
  installed.packs = [...installed.packs.filter((p) => p.id !== record.id), record];
  writeFileReplacing(join(catalogDir, PACKS_FILE), canonical(installed));
  return plan;
}

/* ------------------------------------------------------------------ *
 * Packs as layers under a catalog (the packs directory)
 * ------------------------------------------------------------------ */

/** The directory of an installed pack inside a packs directory. */
export function installedPackDir(packsDir: string, id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`'${id}' is not a pack id.`);
  return join(packsDir, id);
}

/** A source per pack installed in `packsDir`, in install order (`packs.json`). */
export function installedPackSources(packsDir: string): CatalogSource[] {
  return readInstalledPacks(packsDir)
    .packs.map((pack) => installedPackDir(packsDir, pack.id))
    .filter((dir) => existsSync(dir))
    .map((dir) => fsCatalogSource(dir, `pack ${dir}`));
}

/**
 * The catalog in `catalogDir` with every pack installed in `packsDir` under
 * it, the installed list re-read on every call (a pack installed while a host
 * runs is seen at once). `first` layers, when given, sit above the catalog
 * (derived files kept beside the packs). Read-only like any layered source.
 */
export function catalogWithPacksSource(catalogDir: string, packsDir: string, options: { name?: string; first?: () => CatalogSource[] } = {}): CatalogSource {
  const catalog = fsCatalogSource(catalogDir, options.name ?? catalogDir);
  const layers = (): CatalogSource[] => [...(options.first?.() ?? []), catalog, ...installedPackSources(packsDir)];
  return {
    name: options.name ?? catalogDir,
    root: catalogDir,
    read: (relative) => layeredCatalogSource(layers()).read(relative),
    list: (relativeDir) => layeredCatalogSource(layers()).list(relativeDir),
  };
}

/**
 * The part of a catalog file that belongs in the catalog's own file, given
 * the whole (merged) value a store is about to write: the records the packs
 * supply **unchanged** are left out; a pack record that was edited stays (the
 * local copy shadows the pack's). Record lists by id, vocabulary lists by
 * entry id, tag tables key by key; any other file is kept whole unless a pack
 * holds exactly the same value. `undefined` when nothing local is left and
 * the catalog has no such file yet (so there is nothing to write).
 */
export function localPartOf(relative: string, value: unknown, packs: readonly CatalogSource[], localExists: boolean): unknown {
  const packValues = packs.map((pack) => pack.read(relative)).filter((t): t is string => t !== undefined).map((t) => JSON.parse(t) as Json);
  if (packValues.length === 0) return value;
  const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);
  const supplied = new Map<string, Json>();
  for (const packValue of packValues) {
    for (const record of recordsIn(packValue) ?? []) {
      const id = idOf(record);
      if (id !== undefined && !supplied.has(id)) supplied.set(id, record);
    }
  }
  const records = recordsIn(value);
  if (records !== undefined && packValues.every((v) => recordsIn(v) !== undefined)) {
    const kept = records.filter((record) => {
      const id = idOf(record);
      const pack = id === undefined ? undefined : supplied.get(id);
      return pack === undefined || !same(pack, record);
    });
    if (kept.length === 0 && !localExists) return undefined;
    return Array.isArray(value) ? kept : { ...(value as Record<string, Json>), entries: kept };
  }
  if (packValues.some((v) => same(v, value))) return localExists ? value : undefined;
  return value;
}

/** What `installPackLayer` did. */
export interface PackLayerInstall {
  manifest: PackManifest;
  added: Record<string, string[]>;
  alreadyInstalled: boolean;
}

/**
 * Install the pack at `packDir` as a layer: check it against the catalog in
 * `catalogDir` with the *other* installed packs under it (a record id already
 * used for something different is a conflict, and nothing is written), then
 * copy its files to `<packsDir>/<id>/` and record it in `<packsDir>/packs.json`.
 * The same version again is a no-op; another version replaces the layer.
 */
export function installPackLayer(catalogDir: string, packsDir: string, packDir: string): PackLayerInstall {
  const manifest = readPackManifest(packDir);
  const installed = readInstalledPacks(packsDir);
  const others = installed.packs.filter((p) => p.id !== manifest.id).map((p) => installedPackDir(packsDir, p.id)).filter((dir) => existsSync(dir));
  const local = layeredCatalogSource([fsCatalogSource(catalogDir), ...others.map((dir) => fsCatalogSource(dir))]);
  const plan = planAgainst(local, installed, packDir);
  if (plan.alreadyInstalled && existsSync(installedPackDir(packsDir, manifest.id))) return { manifest, added: plan.added, alreadyInstalled: true };
  if (plan.conflicts.length > 0) throw new Error(`Pack '${manifest.id}' cannot be installed: ${plan.conflicts.join('; ')}.`);
  const target = installedPackDir(packsDir, manifest.id);
  const staging = `${target}.${process.pid}.pack-tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, PACK_MANIFEST), readFileSync(join(packDir, PACK_MANIFEST)));
  for (const relative of packFiles(packDir)) {
    mkdirSync(dirname(join(staging, relative)), { recursive: true });
    cpSync(join(packDir, relative), join(staging, relative));
  }
  for (const relative of packAssetFiles(packDir)) {
    mkdirSync(dirname(join(staging, relative)), { recursive: true });
    cpSync(join(packDir, relative), join(staging, relative));
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  const assets = packOwnedAssets(packDir);
  const record: InstalledPack = { id: manifest.id, version: manifest.version, license: manifest.license, added: plan.added, ...(Object.keys(assets).length === 0 ? {} : { assets }) };
  installed.packs = [...installed.packs.filter((p) => p.id !== record.id), record];
  writeFileReplacing(join(packsDir, PACKS_FILE), canonical(installed));
  return { manifest, added: plan.added, alreadyInstalled: false };
}

/**
 * Record (or, with `undefined`, forget) where an installed pack came from
 * (`InstalledPack.origin`) in the `packs.json` of `dir`. Nothing happens when
 * the pack is not recorded there.
 */
export function setInstalledPackOrigin(dir: string, id: string, origin: InstalledPack['origin']): void {
  const installed = readInstalledPacks(dir);
  const entry = installed.packs.find((p) => p.id === id);
  if (entry === undefined) return;
  if (origin === undefined) delete entry.origin;
  else entry.origin = origin;
  writeFileReplacing(join(dir, PACKS_FILE), canonical(installed));
}
