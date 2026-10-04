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
 * - **Installed** — `planPackInstall` / `installPack` merge a pack's records
 *   into a catalog directory once, refuse any record whose id the catalog
 *   already uses for something different, and record the install in
 *   `packs.json`. This is what first-run setup does for the domain modules a
 *   person picks; after it, the records are ordinary catalog data.
 *
 * Canonical JSON (`JSON.stringify(v, null, 2) + '\n'`); list order is data —
 * local records first, a pack's appended in its own order.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
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
}

export const PACK_MANIFEST = 'wirehub-pack.json';

/** One installed pack, as `packs.json` records it. */
export interface InstalledPack {
  id: string;
  version: string;
  license: string;
  /** the record files and ids the pack added (`connectors.json` → ids, `vocab/signals.json` → entry ids, `designs/x.json` → []) */
  added: Record<string, string[]>;
}

/** `packs.json`: the packs installed into this catalog. */
export interface InstalledPacks {
  src: string;
  packs: InstalledPack[];
}

const PACKS_FILE = 'packs.json';

const canonical = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

type Json = unknown;

const isPlainObject = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idOf = (value: Json): string | undefined =>
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
function recordsIn(value: Json): Json[] | undefined {
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
  const manifest = readPackManifest(packDir);
  const local = fsCatalogSource(catalogDir);
  const installed = readInstalledPacks(catalogDir);
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

function writeFileReplacing(path: string, text: string): void {
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
  const record: InstalledPack = { id: plan.manifest.id, version: plan.manifest.version, license: plan.manifest.license, added: plan.added };
  installed.packs = [...installed.packs.filter((p) => p.id !== record.id), record];
  writeFileReplacing(join(catalogDir, PACKS_FILE), canonical(installed));
  return plan;
}
