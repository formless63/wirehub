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
  /**
   * A numbering scheme this pack offers (a declarative definition,
   * `@wirehub/model` `pn-declarative.ts`). Installing the pack never switches
   * the hub's scheme: Settings offers it, and an owner confirms.
   */
  partNumberScheme?: unknown;
  /**
   * The code module the pack carries (`specs/runtime-modules.md`): its entries
   * under `code/<module id>/`, the module API it was built against, and what it
   * declares it uses. Checked by the host (`@wirehub/modules`
   * `codeModuleManifestProblems`); absent for a data pack.
   */
  module?: PackModule;
}

/** A pack manifest's `module` block (the shape `@wirehub/modules` names `CodeModuleManifest`). */
export interface PackModule {
  id: string;
  version: string;
  label: string;
  apiVersion: string;
  /** `code/<id>/server.mjs` */
  server: string;
  /** `code/<id>/browser.mjs` */
  browser?: string;
  /** `code/<id>/browser.css` */
  css?: string;
  extensionPoints: string[];
  permissions: string[];
  description?: string;
}

/** The code module of an installed pack, as `packs.json` records it. */
export interface InstalledModule {
  id: string;
  version: string;
  label: string;
  apiVersion: string;
  /** sha256 of each entry as installed */
  files: { server: string; browser?: string; css?: string };
  extensionPoints: string[];
  permissions: string[];
  /** how its signature was trusted: a store's publisher key, or a key an owner pinned; the keys that verified */
  trust?: { via: 'store' | 'pinned'; keys: string[] };
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
  /** the code module the pack carries (`PackManifest.module`), with the sha256 of its files */
  module?: InstalledModule;
  /** the numbering scheme the pack's manifest offers, as it was when installed (an owner may adopt it in Settings) */
  partNumberScheme?: unknown;
}

/** What an installed pack's record keeps of its manifest. */
export const manifestOffers = (manifest: PackManifest): Pick<InstalledPack, 'partNumberScheme'> => (manifest.partNumberScheme === undefined ? {} : { partNumberScheme: manifest.partNumberScheme });

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

const codePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Files of a pack that carry no `src` of their own, because they are not records:
 * - a drawing's sidecars (`drawings/<id>.json`, the title-block facts, and `drawings/<id>.photo-ref.json`,
 *   exactly `{ "assetId" }`, which the Postgres codec holds as a row): the photo is an asset whose index
 *   entry cites its source;
 * - a design's saved versions (`designs/_versions/…`): frozen snapshots of a design, which cites its own.
 * A board's build file (`builds/<name>.json`) is checked per build instead (`packDocumentSrcProblems`).
 */
export const isSrcExempt = (relative: string): boolean => /^drawings\/[^/]+\.json$/.test(relative) || relative.startsWith('designs/_versions/');

/**
 * What a pack file lacks of the catalog's rule that every data record cites where its values came from
 * (the verifier's check, `verify-pack.mjs` and `packSourceProblems`): sentences, empty when it is fine.
 */
export function packDocumentSrcProblems(relative: string, value: Json): string[] {
  if (isSrcExempt(relative)) return [];
  const problems: string[] = [];
  const records = recordsIn(value);
  for (const record of records ?? []) {
    const src = isPlainObject(record) ? record['src'] : undefined;
    if (typeof src !== 'string' || src.trim() === '') problems.push(`${relative}: record '${idOf(record) ?? '?'}' has no src`);
  }
  if (relative.startsWith('builds/') && isPlainObject(value) && Array.isArray(value['builds'])) {
    for (const build of value['builds'] as Json[]) {
      const src = isPlainObject(build) ? build['src'] : undefined;
      if (typeof src !== 'string' || src.trim() === '') problems.push(`${relative}: build '${isPlainObject(build) && typeof build['key'] === 'string' ? build['key'] : '?'}' has no src`);
    }
    return problems;
  }
  if (isPlainObject(value) && !Array.isArray(value['entries']) && !value['src']) problems.push(`${relative}: the document has no src`);
  if (isPlainObject(value) && Array.isArray(value['entries']) && !value['src']) problems.push(`${relative}: the list has no src`);
  return problems;
}

/**
 * A pack document as the catalog stores it: JSON in canonical form
 * (`JSON.stringify(v, null, 2) + '\n'`), and the two files whose order is the store's
 * own in that order: `models.json` links by record key and `assets/index.json` entries
 * by id (each entry's keys as the asset store writes them), both in code-point order.
 * Anything else, and text that is not JSON, is returned as it is.
 */
export function canonicalPackText(relative: string, text: string): string {
  if (!relative.endsWith('.json')) return text;
  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch {
    return text;
  }
  if (relative === 'models.json' && isPlainObject(value) && Array.isArray(value['links']) && value['links'].every((l) => isPlainObject(l) && typeof l['record'] === 'string')) {
    const links = (value['links'] as Record<string, Json>[]).map((l, i) => [l, i] as const).sort(([a, i], [b, j]) => codePoint(a['record'] as string, b['record'] as string) || i - j);
    value = { ...value, links: links.map(([l]) => l) };
  } else if (relative === 'assets/index.json' && Array.isArray(value) && value.every((e) => isPlainObject(e) && typeof e['id'] === 'string')) {
    const keys = ['id', 'mime', 'originalName', 'src', 'bytes'];
    const ordered = (value as Record<string, Json>[]).map((e) => (Object.keys(e).every((k) => keys.includes(k)) ? Object.fromEntries(keys.filter((k) => k in e).map((k) => [k, e[k]] as const)) : e));
    value = ordered.map((e, i) => [e, i] as const).sort(([a, i], [b, j]) => codePoint(a['id'] as string, b['id'] as string) || i - j).map(([e]) => e);
  }
  return canonical(value);
}

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
  // the model links of every layer, one per record (the first layer's wins), in the store's order
  if (relative === 'models.json' && values.every((v) => isPlainObject(v) && Array.isArray(v['links']))) {
    const seen = new Set<string>();
    const links = values
      .flatMap((v) => (v as { links: Json[] }).links)
      .filter((l) => {
        const key = isPlainObject(l) && typeof l['record'] === 'string' ? l['record'] : undefined;
        if (key === undefined) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return canonicalPackText(relative, canonical({ ...(values[0] as Record<string, Json>), links }));
  }
  if (relative === 'assets/index.json' && values.every(Array.isArray)) return canonicalPackText(relative, canonical(mergeRecords(values as Json[][])));
  if (values.every(Array.isArray)) return canonical(mergeRecords(values as Json[][]));
  if (values.every((v) => isPlainObject(v) && Array.isArray(v['entries']))) {
    const lists = values as Record<string, Json>[];
    return canonical({ ...lists[0], entries: mergeRecords(lists.map((l) => l['entries'] as Json[])) });
  }
  if ((relative.startsWith('tags/') || relative in KEYED_FILES) && values.every(isPlainObject)) {
    return canonical(mergeObjects(values as Record<string, Json>[]));
  }
  return texts[0] as string;
}

/** The pad table beside the board records: pads per board, per terminal (`PcbaPadTable`). A pack may ship one. */
export const PCBA_PADS_FILE = 'pcba-pads.json';

/** The drawing art a hub or a pack supplies as data: `{ faces, plugs, cutaways }` by connector or wire id (`DrawingArt`, `@wirehub/docs`). */
export const DRAWING_ART_FILE = 'drawing-art.json';

/**
 * Files that are one object of keyed sections rather than a list of records: the pad table (`boards`,
 * keyed by board id) and the drawing art (`faces`, `plugs`, `cutaways`, keyed by definition id). They
 * layer key by key, and the pack lifecycle treats each key as a record the pack owns (id `<key>`, or
 * `<section>/<key>` when the file has several sections), so an update replaces them and a disable removes them.
 */
export const KEYED_FILES: Readonly<Record<string, readonly string[]>> = { [PCBA_PADS_FILE]: ['boards'], [DRAWING_ART_FILE]: ['faces', 'plugs', 'cutaways'] };

/** The record id of one key of a keyed file. */
export const keyedId = (file: string, section: string, key: string): string => ((KEYED_FILES[file] ?? []).length === 1 ? key : `${section}/${key}`);

/** The records of a keyed file's parsed value, each `{ id, ...value }`. */
export function keyedRecords(file: string, value: Json): { id: string; section: string; key: string; record: Json }[] {
  const out: { id: string; section: string; key: string; record: Json }[] = [];
  if (!isPlainObject(value)) return out;
  for (const section of KEYED_FILES[file] ?? []) {
    const entries = value[section];
    if (!isPlainObject(entries)) continue;
    for (const [key, entry] of Object.entries(entries)) {
      const id = keyedId(file, section, key);
      out.push({ id, section, key, record: isPlainObject(entry) ? { id, ...entry } : { id } });
    }
  }
  return out;
}

/** The record files of a catalog (merged in place by id; the pad table by board); every other JSON file a pack ships is auxiliary and layered as a whole. */
export const RECORD_FILES: readonly string[] = ['bodies', 'interfaces', 'connectors', 'wires', 'components', 'mechanicals', 'kits', 'pcbas', 'devices', 'conditioning-recipes', 'hazards', 'products', 'validation-rules', 'bench-rules'].map((n) => `${n}.json`);
const RECORD_FILE_NAMES = new Set<string>([...RECORD_FILES, ...Object.keys(KEYED_FILES)]);

/**
 * A data file that is not a list of records the lifecycle tracks by id: the pad
 * table, tag tables, rules, bench rules and the like. These are read through
 * the layers (`mergeCatalogFile`), so a pack's copy takes effect when it is
 * installed as a layer; the install preview reads them the same way
 * (`planNewPack`), so what is validated is what will run.
 */
export function isAuxiliaryFile(relative: string): boolean {
  if (!relative.endsWith('.json') || relative === PACK_MANIFEST || relative === PACKS_FILE) return false;
  if (RECORD_FILE_NAMES.has(relative)) return false;
  return !(relative.startsWith('vocab/') || relative.startsWith('designs/') || relative.startsWith('depictions/') || relative.startsWith('art/') || relative.startsWith('code/'));
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
 * An image a pack adds to the shared asset library (a drawing's product photo, say): `assets/<sha256>.png|jpg`,
 * named by the hash of its bytes, with its entry in the pack's `assets/index.json`. It lands where the
 * library keeps its own (`data/assets/<sha256>.<ext>`); the pack owns it like its other files.
 */
export const PACK_ASSET_IMAGE = /^assets\/[0-9a-f]{64}\.(?:png|jpg)$/;

/**
 * The files of a pack that are not JSON — the images under `depictions/` and
 * `art/` (`svg`, `png`, `jpg`, `webp`), vendor PDFs under `docs/` and `assets/`,
 * fonts under `fonts/` (`ttf`, `otf`, `woff2`) and a code module's entries under `code/`
 * (`.mjs`, `.css`; `specs/runtime-modules.md`) — relative, sorted. A layered
 * install copies them beside the data files, so a pack's faces, cutaways and
 * code arrive with it (`specs/drawing-language.md` §7).
 */
export function packAssetFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (relative: string, name: RegExp): void => {
    if (!existsSync(join(dir, relative))) return;
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path, name);
      else if (entry.isFile() && name.test(entry.name)) out.push(path);
    }
  };
  walk('depictions', /\.(svg|png|jpe?g|webp)$/);
  walk('art', /\.(svg|png|jpe?g|webp)$/);
  walk('docs', /\.pdf$/);
  walk('assets', /\.pdf$/);
  // an image of the shared asset library, named by its hash, with its `assets/index.json` entry (cs-8re)
  if (existsSync(join(dir, 'assets'))) for (const entry of readdirSync(join(dir, 'assets'), { withFileTypes: true })) if (entry.isFile() && PACK_ASSET_IMAGE.test(`assets/${entry.name}`)) out.push(`assets/${entry.name}`);
  walk('fonts', /\.(ttf|otf|woff2)$/);
  walk('code', /\.(mjs|css)$/);
  return out.sort();
}

/**
 * The `packs.json` record of a pack about to be installed from `packDir`: its
 * id, version, licence, the records it added, the files it owns and, for a pack
 * that carries code, the module with the sha256 of its entries.
 */
export function installedRecordOf(manifest: PackManifest, added: Record<string, string[]>, assets: Record<string, string>, packDir: string): InstalledPack {
  const record: InstalledPack = { id: manifest.id, version: manifest.version, license: manifest.license, added, ...(Object.keys(assets).length === 0 ? {} : { assets }), ...manifestOffers(manifest) };
  const m = manifest.module;
  if (m === undefined) return record;
  const sha = (relative: string): string => createHash('sha256').update(readFileSync(join(packDir, relative))).digest('hex');
  record.module = {
    id: m.id,
    version: m.version,
    label: m.label,
    apiVersion: m.apiVersion,
    files: { server: sha(m.server), ...(m.browser === undefined ? {} : { browser: sha(m.browser) }), ...(m.css === undefined ? {} : { css: sha(m.css) }) },
    extensionPoints: [...m.extensionPoints],
    permissions: [...m.permissions],
  };
  return record;
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
  return relative.startsWith('depictions/') ? join(dirname(dataDir), relative) : join(dataDir, dataRelativeOf(relative));
}

/**
 * Where a pack's file sits under the catalog's `data/`: where it is in the pack, except a pack's
 * `assets/…` PDFs, which go to `pack-assets/…` (`data/assets/` is the shared asset library, whose
 * files are named by their hash).
 */
export const dataRelativeOf = (relative: string): string => (relative.startsWith('assets/') && relative !== 'assets/index.json' && !PACK_ASSET_IMAGE.test(relative) ? `pack-assets/${relative.slice('assets/'.length)}` : relative);

/** The path of a pack asset in a flattened catalog (`depictions/…`, `data/art/…`, `data/docs/…`, `data/fonts/…`). */
export const flatAssetPath = (relative: string): string => (relative.startsWith('depictions/') ? relative : `data/${dataRelativeOf(relative)}`);

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
    if (relative.endsWith('.json')) writeFileSync(to, canonicalPackText(relative, readFileSync(join(packDir, relative), 'utf8')));
    else cpSync(join(packDir, relative), to);
  }
  return ops.owned;
}

/**
 * The shared asset library after a pack's images came or went in a merged catalog (`dataDir`): the pack's
 * `assets/index.json` entries for images it owns now are added (an entry of the catalog's own stays), the
 * entries of images it no longer owns and no longer has are removed, and so is a drawing's photo pointer
 * (`drawings/<id>.photo-ref.json`) at one of them; a pack's pointer is written where the catalog has none.
 * `before` and `owned` are the pack's `assets` record before and after.
 */
export function applyPackLibrary(dataDir: string, packDir: string | undefined, before: Readonly<Record<string, string>> | undefined, owned: Readonly<Record<string, string>>): void {
  const image = (relative: string): string | undefined => (PACK_ASSET_IMAGE.test(relative) ? relative.slice('assets/'.length, -'.xxx'.length) : undefined);
  const gone = new Set(Object.keys(before ?? {}).filter((r) => !(r in owned) && !existsSync(assetPath(dataDir, r))).flatMap((r) => image(r) ?? []));
  const keep = new Set(Object.keys(owned).flatMap((r) => image(r) ?? []));
  const indexPath = join(dataDir, 'assets/index.json');
  const entries = existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, Json>[]) : [];
  const packEntries = packDir !== undefined && existsSync(join(packDir, 'assets/index.json')) ? (JSON.parse(readFileSync(join(packDir, 'assets/index.json'), 'utf8')) as Record<string, Json>[]) : [];
  const next = entries.filter((e) => !gone.has(e['id'] as string));
  for (const e of packEntries) if (keep.has(e['id'] as string) && !next.some((n) => n['id'] === e['id'])) next.push(e);
  if (JSON.stringify(next) !== JSON.stringify(entries)) {
    mkdirSync(join(dataDir, 'assets'), { recursive: true });
    writeFileReplacing(indexPath, canonicalPackText('assets/index.json', JSON.stringify(next)));
  }
  const drawings = join(dataDir, 'drawings');
  const refOf = (file: string): string | undefined => {
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as { assetId?: string }).assetId;
    } catch {
      return undefined;
    }
  };
  if (existsSync(drawings)) {
    for (const name of readdirSync(drawings)) {
      if (!name.endsWith('.photo-ref.json')) continue;
      const id = refOf(join(drawings, name));
      if (id !== undefined && gone.has(id)) rmSync(join(drawings, name), { force: true });
    }
  }
  if (packDir === undefined || !existsSync(join(packDir, 'drawings'))) return;
  for (const name of readdirSync(join(packDir, 'drawings'))) {
    if (!name.endsWith('.photo-ref.json') || existsSync(join(drawings, name))) continue;
    const id = refOf(join(packDir, 'drawings', name));
    if (id === undefined || !keep.has(id)) continue;
    mkdirSync(drawings, { recursive: true });
    writeFileReplacing(join(drawings, name), canonicalPackText(`drawings/${name}`, readFileSync(join(packDir, 'drawings', name), 'utf8')));
  }
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
    const packText = canonicalPackText(relative, readFileSync(join(packDir, relative), 'utf8'));
    const localText = local.read(relative);
    if (localText === undefined) {
      writes[relative] = packText;
      const parsed = JSON.parse(packText) as Json;
      const records = relative in KEYED_FILES ? keyedRecords(relative, parsed) : recordsIn(parsed);
      added[relative] = records === undefined ? [] : records.map(idOf).filter((id): id is string => id !== undefined);
      continue;
    }
    const packValue = JSON.parse(packText) as Json;
    const localValue = JSON.parse(localText) as Json;
    if (relative in KEYED_FILES) {
      // a keyed file (the pad table, the drawing art) is merged key by key: one the catalog already has, differently, is a conflict
      const have = new Map(keyedRecords(relative, localValue).map((r) => [r.id, r] as const));
      const fresh = keyedRecords(relative, packValue).filter((r) => {
        const mine = have.get(r.id);
        if (mine === undefined) return true;
        if (JSON.stringify(mine.record) !== JSON.stringify(r.record)) conflicts.push(`${relative}: '${r.id}' already exists with different content`);
        return false;
      });
      if (fresh.length > 0) {
        added[relative] = fresh.map((r) => r.id);
        const merged: Record<string, Json> = { ...(localValue as Record<string, Json>) };
        for (const r of fresh) {
          const section = isPlainObject(merged[r.section]) ? { ...(merged[r.section] as Record<string, Json>) } : {};
          const entries = (packValue as Record<string, Json>)[r.section] as Record<string, Json>;
          section[r.key] = entries[r.key];
          merged[r.section] = section;
        }
        writes[relative] = canonical(merged);
      }
      continue;
    }
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
  // a code module's entries are files the loader reads: beside the catalog's data (`<catalog>/code/<module>/…`)
  const code = Object.fromEntries(Object.entries(assets).filter(([path]) => path.startsWith('code/')));
  if (Object.keys(code).length > 0) applyPackAssets(catalogDir, packDir, undefined, code);
  // vendor PDFs and fonts are files the catalog serves by content address: beside the catalog's data, owned by the pack
  const blobs = Object.fromEntries(Object.entries(assets).filter(([path]) => /^(?:docs|assets|fonts)\//.test(path) && !path.endsWith('.json')));
  if (Object.keys(blobs).length > 0) applyPackLibrary(catalogDir, packDir, undefined, applyPackAssets(catalogDir, packDir, undefined, blobs));
  const record = installedRecordOf(plan.manifest, plan.added, assets, packDir);
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
export function installedPackSources(packsDir: string, except: readonly string[] = []): CatalogSource[] {
  return readInstalledPacks(packsDir)
    .packs.filter((pack) => !except.includes(pack.id))
    .map((pack) => installedPackDir(packsDir, pack.id))
    .filter((dir) => existsSync(dir))
    .map((dir) => fsCatalogSource(dir, `pack ${dir}`));
}

/**
 * The catalog in `catalogDir` with every pack installed in `packsDir` under
 * it, the installed list re-read on every call (a pack installed while a host
 * runs is seen at once). `first` layers, when given, sit above the catalog
 * (derived files kept beside the packs). Read-only like any layered source.
 */
export function catalogWithPacksSource(catalogDir: string, packsDir: string, options: { name?: string; first?: () => CatalogSource[]; except?: readonly string[] } = {}): CatalogSource {
  const catalog = fsCatalogSource(catalogDir, options.name ?? catalogDir);
  const layers = (): CatalogSource[] => [...(options.first?.() ?? []), catalog, ...installedPackSources(packsDir, options.except)];
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
  // documents are stored canonical, whatever form the pack shipped them in
  for (const relative of packFiles(packDir)) {
    mkdirSync(dirname(join(staging, relative)), { recursive: true });
    writeFileSync(join(staging, relative), canonicalPackText(relative, readFileSync(join(packDir, relative), 'utf8')));
  }
  for (const relative of packAssetFiles(packDir)) {
    mkdirSync(dirname(join(staging, relative)), { recursive: true });
    cpSync(join(packDir, relative), join(staging, relative));
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  const assets = packOwnedAssets(packDir);
  const record = installedRecordOf(manifest, plan.added, assets, packDir);
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
  updateInstalledPack(dir, id, (entry) => {
    if (origin === undefined) delete entry.origin;
    else entry.origin = origin;
  });
}

/** Record how an installed pack's code module was trusted (`InstalledModule.trust`). Nothing happens without a module. */
export function setInstalledModuleTrust(dir: string, id: string, trust: NonNullable<InstalledModule['trust']>): void {
  updateInstalledPack(dir, id, (entry) => {
    if (entry.module !== undefined) entry.module.trust = trust;
  });
}

function updateInstalledPack(dir: string, id: string, change: (entry: InstalledPack) => void): void {
  const installed = readInstalledPacks(dir);
  const entry = installed.packs.find((p) => p.id === id);
  if (entry === undefined) return;
  change(entry);
  writeFileReplacing(join(dir, PACKS_FILE), canonical(installed));
}
