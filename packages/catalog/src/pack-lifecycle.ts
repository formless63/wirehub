/**
 * The pack lifecycle (`docs/catalog-store.md` §3): update with a diff,
 * disable, and what a deployment may and may not change of what a pack gave it.
 *
 * Everything here works on a **catalog view** (a `CatalogSource`: the catalog
 * with its pack layers read as one) and the installed list, and answers with a
 * *plan* before anything is written. Both backends use it unchanged: the file
 * backend applies a plan to its packs directory (`applyPackUpdate`,
 * `applyPackDisable`), the database backend runs the same handler over a
 * scratch directory it then commits as one change set.
 *
 * - **Ownership.** `packs.json` records, per pack, the ids it added to each
 *   record file (`InstalledPack.added`). Those records — and a pack's design
 *   files — are the pack's; an identical record that was already there is not.
 * - **Update.** The records of the installed version are compared with the
 *   new version's, field by field (`PackDiff`). A new record that clashes with
 *   a different one outside the pack is a conflict; a record the new version
 *   drops while something outside the pack still uses it is **retired**: it
 *   stays in the catalog as a record of the deployment's own (with its licence
 *   and `derivedFrom` kept), no longer the pack's, and the plan names it and
 *   its users; the resulting library is validated and only *new* errors block.
 * - **Disable.** The pack's records go, unless a record outside the pack
 *   references one of them, in which case nothing changes and the references
 *   are listed.
 *
 * Pure apart from reading directories: no clock, no network.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { benchRuleProblems, declarativeSchemeProblems, errors, ruleListProblems, validateDb, validateDesign, type Issue } from '@wirehub/model';

import { createCatalog } from './catalog.ts';
import {
  PACKS_FILE,
  canonical,
  canonicalPackText,
  idOf,
  packDocumentSrcProblems,
  installPackLayer,
  installedRecordOf,
  installedPackDir,
  applyPackAssets,
  applyPackLibrary,
  isAuxiliaryFile,
  mergeCatalogFile,
  KEYED_FILES,
  RECORD_FILES,
  keyedRecords,
  isPlainObject,
  packAssetFiles,
  packFiles,
  packOwnedAssets,
  readInstalledPacks,
  readPackManifest,
  recordsIn,
  writeFileReplacing,
  type InstalledPack,
  type InstalledPacks,
  type Json,
  type PackManifest,
} from './packs.ts';
import { fsCatalogSource, type CatalogSource } from './source.ts';

/* ------------------------------------------------------------------ *
 * Records of a catalog view
 * ------------------------------------------------------------------ */

/** The record files of a catalog; vocabulary lists and designs are found by listing. */
/** The record files whose records are parts with a licence (a retired one keeps its licence and origin); the rule files hold the shop's own rules. */
const PART_RECORD_FILES = RECORD_FILES.filter((f) => f !== 'validation-rules.json' && f !== 'bench-rules.json');

/** The keyed files (the pad table, the drawing art) are kept as records too, one per key (`packs.ts`, `KEYED_FILES`), so a pack owns its boards' pads and its art. */
const keyedFiles = Object.keys(KEYED_FILES);

/** The records of a file's parsed value: a list's or an entry list's items, a keyed file's keys (each with its id). */
function recordsOfFile(file: string, value: Json): Json[] {
  if (file in KEYED_FILES) return keyedRecords(file, value).map((r) => r.record);
  return recordsIn(value) ?? [];
}

/** One record, with the file it sits in. A design is a file of its own: its id is the file's name. */
export interface LocatedRecord {
  /** relative to the data root: `connectors.json`, `vocab/signals.json`, `designs/x.json` */
  file: string;
  id: string;
  record: Json;
}

/** Catalog files the loaders insist on: emptied, never removed. */
const REQUIRED_FILES = ['connectors.json', 'wires.json', 'components.json'];

export const recordKey = (file: string, id: string): string => `${file}#${id}`;

const stemOf = (file: string): string => (file.split('/').pop() ?? file).replace(/\.json$/, '');

/** What kind of thing a record file holds, in words (`connectors`, `signals`, `design`). */
export function recordKindOf(file: string): string {
  if (file.startsWith('designs/')) return 'design';
  if (file.startsWith('vocab/')) return stemOf(file);
  return stemOf(file);
}

/** Every record of a catalog source: the record files, the vocabulary lists' entries, the designs. */
export function catalogRecords(source: CatalogSource): Map<string, LocatedRecord> {
  const out = new Map<string, LocatedRecord>();
  const files = [
    ...RECORD_FILES,
    ...keyedFiles,
    ...source.list('vocab').filter((n) => n.endsWith('.json')).map((n) => `vocab/${n}`),
    ...source.list('designs').filter((n) => n.endsWith('.json')).map((n) => `designs/${n}`),
  ];
  for (const file of files) {
    const text = source.read(file);
    if (text === undefined) continue;
    const value = JSON.parse(text) as Json;
    if (file.startsWith('designs/')) {
      out.set(recordKey(file, stemOf(file)), { file, id: stemOf(file), record: value });
      continue;
    }
    for (const record of recordsOfFile(file, value)) {
      const id = idOf(record);
      if (id !== undefined) out.set(recordKey(file, id), { file, id, record });
    }
  }
  return out;
}

/** The records an installed pack owns, as they stand in `view`. */
export function ownedRecords(view: CatalogSource, pack: InstalledPack): Map<string, LocatedRecord> {
  const all = catalogRecords(view);
  const out = new Map<string, LocatedRecord>();
  for (const [file, ids] of Object.entries(pack.added)) {
    const wanted = file.startsWith('designs/') ? [stemOf(file)] : ids;
    for (const id of wanted) {
      const found = all.get(recordKey(file, id));
      if (found !== undefined) out.set(recordKey(file, id), found);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Diff
 * ------------------------------------------------------------------ */

/** One field of a record that differs; `path` is dotted (`pins.3.signal`, `terminals[1]`). */
export interface FieldChange {
  path: string;
  /** absent: the field is new */
  before?: Json;
  /** absent: the field was dropped */
  after?: Json;
}

export interface RecordRef {
  file: string;
  id: string;
  kind: string;
  label?: string;
}

export interface ChangedRecord extends RecordRef {
  fields: FieldChange[];
}

/** The record-level difference between two versions of a pack. */
export interface PackDiff {
  added: RecordRef[];
  changed: ChangedRecord[];
  removed: RecordRef[];
  unchanged: number;
}

const refOf = (r: LocatedRecord): RecordRef => {
  const label = isPlainObject(r.record) && typeof r.record['label'] === 'string' ? r.record['label'] : undefined;
  return { file: r.file, id: r.id, kind: recordKindOf(r.file), ...(label === undefined ? {} : { label }) };
};

const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Field-level differences of two JSON values: objects recursively, arrays whole. */
export function fieldChanges(before: Json, after: Json, path = ''): FieldChange[] {
  if (same(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const out: FieldChange[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const at = path === '' ? key : `${path}.${key}`;
      if (!(key in before)) out.push({ path: at, after: after[key] });
      else if (!(key in after)) out.push({ path: at, before: before[key] });
      else out.push(...fieldChanges(before[key], after[key], at));
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length && before.every((v, i) => !isPlainObject(v) || idOf(v) === idOf(after[i]))) {
    return before.flatMap((v, i) => fieldChanges(v, after[i], `${path}[${i}]`));
  }
  return [{ path, before, after }];
}

/** Compare the records a pack owns now (`current`) with the ones its new version supplies (`next`). */
export function diffRecords(current: ReadonlyMap<string, LocatedRecord>, next: ReadonlyMap<string, LocatedRecord>): PackDiff {
  const diff: PackDiff = { added: [], changed: [], removed: [], unchanged: 0 };
  for (const [key, record] of next) {
    const was = current.get(key);
    if (was === undefined) diff.added.push(refOf(record));
    else if (same(was.record, record.record)) diff.unchanged += 1;
    else diff.changed.push({ ...refOf(record), fields: fieldChanges(was.record, record.record) });
  }
  for (const [key, record] of current) if (!next.has(key)) diff.removed.push(refOf(record));
  return diff;
}

/* ------------------------------------------------------------------ *
 * References
 * ------------------------------------------------------------------ */

/** A record outside a pack that names one of the pack's records. */
export interface PackReference {
  /** the record that refers */
  from: RecordRef;
  /** where in it (`pins.1.signal`, `bodies[0]`, `instances.connectors[2].def`) */
  field: string;
  /** the pack record it names */
  to: string;
}

/** Fields that hold words, not references: an id spelled in prose is not a use. */
const PROSE_FIELDS = new Set(['id', 'label', 'short', 'src', 'note', 'notes', 'description', 'title', 'aliases', 'name', 'provenance', 'derivedFrom']);

function scan(value: Json, ids: ReadonlySet<string>, path: string, found: { field: string; to: string }[]): void {
  if (typeof value === 'string') {
    if (ids.has(value)) found.push({ field: path, to: value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, ids, `${path}[${i}]`, found));
  } else if (isPlainObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (PROSE_FIELDS.has(key)) continue;
      scan(v, ids, path === '' ? key : `${path}.${key}`, found);
    }
  }
}

/**
 * The records in `others` that name any of `ids` in a field that is not prose
 * (a connector's `body`, an interface's `bodies`, a design's instance `def`,
 * a kit line, a vocabulary entry's `deprecatedBy` …).
 */
export function referencesTo(others: Iterable<LocatedRecord>, ids: ReadonlySet<string>): PackReference[] {
  const out: PackReference[] = [];
  for (const other of others) {
    const found: { field: string; to: string }[] = [];
    // `id` of the record itself is skipped by PROSE_FIELDS; a design's own name is its file
    scan(other.record, ids, '', found);
    for (const f of found) out.push({ from: refOf(other), field: f.field, to: f.to });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Versions
 * ------------------------------------------------------------------ */

const parseVersion = (v: string): number[] => v.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);

/** -1, 0, 1 for a before b, equal, a after b (prerelease tags ignored). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export const majorOf = (v: string): number => parseVersion(v)[0] ?? 0;

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

/** Files to write (text) or delete (`null`), relative to the data root, in the catalog's flattened form. */
export type FileWrites = Map<string, string | null>;

function overlay(view: CatalogSource, writes: FileWrites): CatalogSource {
  return {
    name: `${view.name} (planned)`,
    read: (relative) => (writes.has(relative) ? (writes.get(relative) ?? undefined) : view.read(relative)),
    list(relativeDir) {
      const dir = relativeDir.replace(/\/+$/, '');
      const prefix = dir === '' ? '' : `${dir}/`;
      const names = new Set(view.list(relativeDir));
      for (const [path, text] of writes) {
        if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
        const name = path.slice(prefix.length);
        if (text === null) names.delete(name);
        else names.add(name);
      }
      return [...names].sort();
    },
  };
}

/**
 * What a catalog reads after a pack's auxiliary files (tag tables, other data
 * files) are layered in: the same merge the runtime does (`mergeCatalogFile`),
 * so a preview validates what will run. `base` is the catalog as it will stand
 * without this pack's own layer (an update passes the view with the installed
 * version left out). Record files (and the pad table) are the plan's own.
 */
function withPackAuxiliary(planned: CatalogSource, base: CatalogSource, packDir: string, packFirst = false): CatalogSource {
  const pack = fsCatalogSource(packDir);
  const dirsOf = new Map<string, Set<string>>();
  for (const f of packFiles(packDir).filter(isAuxiliaryFile)) {
    const i = f.lastIndexOf('/');
    if (i < 0) continue;
    const set = dirsOf.get(f.slice(0, i)) ?? new Set<string>();
    set.add(f.slice(i + 1));
    dirsOf.set(f.slice(0, i), set);
  }
  return {
    name: `${planned.name} (with the pack's own data files)`,
    read(relative) {
      if (!isAuxiliaryFile(relative)) return planned.read(relative);
      const both = packFirst ? [pack.read(relative), base.read(relative)] : [base.read(relative), pack.read(relative)];
      const texts = both.filter((t): t is string => t !== undefined);
      return texts.length === 0 ? undefined : mergeCatalogFile(relative, texts);
    },
    list(relativeDir) {
      const dir = relativeDir.replace(/\/+$/, '');
      return [...new Set([...planned.list(relativeDir), ...(dirsOf.get(dir) ?? [])])].sort();
    },
  };
}

const issueKey = (i: Issue): string => `${i.code}|${i.where ?? ''}|${i.message}`;

/** Library and design errors of a catalog, or the one error that stopped it loading. */
function libraryErrors(source: CatalogSource): Issue[] {
  try {
    const catalog = createCatalog(source);
    const db = catalog.loadDb();
    const issues = [...validateDb(db)];
    for (const design of catalog.loadDesigns()) issues.push(...validateDesign(design, db));
    return errors(issues);
  } catch (error) {
    return [{ code: 'catalog-unreadable', severity: 'error', message: error instanceof Error ? error.message : String(error), where: '' }];
  }
}

/** Errors the change adds: the ones in `after` that `before` did not already have. */
export function newErrors(before: CatalogSource, after: CatalogSource): Issue[] {
  const known = new Set(libraryErrors(before).map(issueKey));
  return libraryErrors(after).filter((i) => !known.has(issueKey(i)));
}

/** A keyed file with the given records put in place (or dropped), whatever else the file holds kept. */
function mergeKeyedFile(file: string, currentText: string | undefined, drop: ReadonlySet<string>, put: ReadonlyMap<string, Json>, packText: string | undefined): string | null | undefined {
  const current = currentText === undefined ? undefined : (JSON.parse(currentText) as Record<string, Json>);
  const pack = packText === undefined ? undefined : (JSON.parse(packText) as Record<string, Json>);
  const sections = KEYED_FILES[file] ?? [];
  const base: Record<string, Json> = { ...(current ?? (pack === undefined ? {} : Object.fromEntries(Object.entries(pack).filter(([k]) => !sections.includes(k))))) };
  const bySection = new Map<string, Record<string, Json>>(sections.map((s) => [s, isPlainObject(base[s]) ? { ...(base[s] as Record<string, Json>) } : {}] as const));
  const place = (id: string): { section: string; key: string } => {
    const slash = id.indexOf('/');
    return sections.length === 1 || slash < 0 ? { section: sections[0] as string, key: id } : { section: id.slice(0, slash), key: id.slice(slash + 1) };
  };
  for (const id of drop) {
    if (put.has(id)) continue;
    const { section, key } = place(id);
    delete bySection.get(section)?.[key];
  }
  for (const [id, record] of put) {
    const { section, key } = place(id);
    const { id: _id, ...entry } = record as Record<string, Json>;
    const target = bySection.get(section);
    if (target !== undefined) target[key] = entry;
  }
  const empty = [...bySection.values()].every((m) => Object.keys(m).length === 0);
  if (empty && drop.size > 0) return null;
  const next: Record<string, Json> = { ...base };
  for (const [section, m] of bySection) {
    if (Object.keys(m).length > 0) next[section] = m;
    else delete next[section];
  }
  const text = canonical(next);
  return text === currentText ? undefined : text;
}

/** The pack's section of a data file: list records in place, new ones appended, dropped ones gone. */
function mergeFile(file: string, currentText: string | undefined, drop: ReadonlySet<string>, put: ReadonlyMap<string, Json>, packText: string | undefined): string | null | undefined {
  if (file.startsWith('designs/')) {
    const id = stemOf(file);
    if (put.has(id)) return packText === undefined ? undefined : packText;
    return drop.has(id) ? null : undefined;
  }
  if (file in KEYED_FILES) return mergeKeyedFile(file, currentText, drop, put, packText);
  const current = currentText === undefined ? undefined : (JSON.parse(currentText) as Json);
  const pack = packText === undefined ? undefined : (JSON.parse(packText) as Json);
  const base = current ?? (pack !== undefined ? (Array.isArray(pack) ? [] : { ...(pack as Record<string, Json>), entries: [] }) : undefined);
  if (base === undefined) return undefined;
  const records = recordsIn(base) ?? [];
  const placed = new Set<string>();
  const next: Json[] = [];
  for (const record of records) {
    const id = idOf(record);
    if (id !== undefined && put.has(id)) {
      next.push(put.get(id));
      placed.add(id);
    } else if (id !== undefined && drop.has(id) && !put.has(id)) continue;
    else next.push(record);
  }
  for (const [id, record] of put) if (!placed.has(id)) next.push(record);
  if (next.length === 0 && drop.size > 0 && !REQUIRED_FILES.includes(file)) return null;
  const out = Array.isArray(base) ? next : { ...(base as Record<string, Json>), entries: next };
  const text = canonical(out);
  return text === currentText ? undefined : text;
}

/** The writes that take `view` to "these pack records in, these gone". */
function fileWrites(view: CatalogSource, packDir: string | undefined, drop: ReadonlyMap<string, LocatedRecord>, put: ReadonlyMap<string, LocatedRecord>): FileWrites {
  const files = new Set<string>([...[...drop.values()].map((r) => r.file), ...[...put.values()].map((r) => r.file)]);
  const writes: FileWrites = new Map();
  for (const file of [...files].sort()) {
    const dropIds = new Set([...drop.values()].filter((r) => r.file === file).map((r) => r.id));
    const putMap = new Map([...put.values()].filter((r) => r.file === file).map((r) => [r.id, r.record] as const));
    // a retired record is put from the catalog's own copy: the new pack version may not have the file
    const packText = packDir === undefined || !putMap.size || !existsSync(join(packDir, file)) ? undefined : canonicalPackText(file, readFileSync(join(packDir, file), 'utf8'));
    const out = mergeFile(file, view.read(file), dropIds, putMap, packText);
    if (out !== undefined) writes.set(file, out);
  }
  return writes;
}

/** The `added` map of a pack: file → ids (designs: none). */
function addedOf(records: Iterable<LocatedRecord>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of records) (out[r.file] ??= []).push(...(r.file.startsWith('designs/') ? [] : [r.id]));
  // files in the order `packFiles` lists them, as `installPackLayer` records them
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

/** The installed packs of both places — the packs directory (layers) and the catalog directory (merged). */
export interface InstalledAcross {
  /** every installed pack, layers first */
  packs: InstalledPack[];
  /** pack id → where it is installed */
  where: Map<string, 'layer' | 'merged'>;
}

export function installedAcross(dataDir: string, packsDir: string | undefined): InstalledAcross {
  const packs: InstalledPack[] = [];
  const where = new Map<string, 'layer' | 'merged'>();
  if (packsDir !== undefined && packsDir !== dataDir) {
    for (const p of readInstalledPacks(packsDir).packs) {
      packs.push(p);
      where.set(p.id, 'layer');
    }
  }
  for (const p of readInstalledPacks(dataDir).packs) {
    if (where.has(p.id)) continue;
    packs.push(p);
    where.set(p.id, 'merged');
  }
  return { packs, where };
}

/** What installing another version of a pack would do. */
export interface PackUpdatePlan {
  pack: { id: string; name: string; license: string; from: string; to: string; fromLicense: string };
  direction: 'upgrade' | 'downgrade' | 'same';
  /** the major version changes: designs can break; an update is only applied when this is accepted */
  major: boolean;
  licenseChanged: boolean;
  diff: PackDiff;
  /** new records that clash with a different record outside the pack */
  conflicts: string[];
  /** records the new version drops that something outside the pack still uses: they are kept, as `retired` */
  retired: RecordRef[];
  /** what outside the pack uses the retired records (informational: nothing is refused for it) */
  references: PackReference[];
  /** errors the new version would add to the library or its designs */
  issues: Issue[];
  /** nothing blocks it (a major change still needs `acceptMajor`) */
  ok: boolean;
  /** the planned file changes, flattened (not part of the answer shown to people) */
  writes: FileWrites;
  /** the pack's `added` after the update */
  added: Record<string, string[]>;
  /** the depiction and art files the new version ships (path → sha256; not part of the answer shown to people) */
  assets: Record<string, string>;
  /** the retired records as they are kept (marked), for a layered pack's catalog files (not part of the answer shown to people) */
  retiredRecords: LocatedRecord[];
}

/** A retired record as the deployment keeps it: its licence stays what it was, and it says where it began. */
function retiredAs(record: LocatedRecord, pack: { id: string; version: string; license: string }): LocatedRecord {
  if (!isPlainObject(record.record) || !PART_RECORD_FILES.includes(record.file)) return record;
  const kept: Record<string, Json> = { ...record.record };
  if (kept['license'] === undefined) kept['license'] = pack.license;
  if (kept['derivedFrom'] === undefined) kept['derivedFrom'] = { pack: pack.id, id: record.id, version: pack.version };
  return { ...record, record: kept };
}

/**
 * Plan `installed`'s pack `<manifest.id>` replaced by the pack in `packDir`. Throws when it is not installed.
 * `without` is the catalog read with the installed version's layer left out, so the new version's
 * auxiliary files replace the old ones in the check; absent, they are layered over `view`.
 */
export function planPackUpdate(view: CatalogSource, installed: readonly InstalledPack[], packDir: string, options: { without?: CatalogSource } = {}): PackUpdatePlan {
  const manifest: PackManifest = readPackManifest(packDir);
  const entry = installed.find((p) => p.id === manifest.id);
  if (entry === undefined) throw new Error(`Pack '${manifest.id}' is not installed.`);
  const owned = ownedRecords(view, entry);
  const everything = catalogRecords(view);
  const others = [...everything].filter(([key]) => !owned.has(key)).map(([, r]) => r);
  const otherByKey = new Map(others.map((r) => [recordKey(r.file, r.id), r] as const));

  const conflicts: string[] = [];
  const next = new Map<string, LocatedRecord>();
  for (const [key, record] of catalogRecords(fsCatalogSource(packDir))) {
    const other = otherByKey.get(key);
    if (other === undefined) next.set(key, record);
    else if (!same(other.record, record.record)) conflicts.push(`${record.file}: '${record.id}' already exists with different content`);
    // identical to a record outside the pack: shared, not the pack's
  }
  const diff = diffRecords(owned, next);
  const gone = new Map([...owned].filter(([key]) => !next.has(key)));
  // a dropped record something outside the pack still uses is kept (retired), not removed under its users
  const references = referencesTo(others, new Set([...gone.values()].filter((r) => !r.file.startsWith('designs/') && !(r.file in KEYED_FILES)).map((r) => r.id)));
  const used = new Set(references.map((r) => r.to));
  const retiring = new Map([...gone].filter(([, r]) => !r.file.startsWith('designs/') && !(r.file in KEYED_FILES) && used.has(r.id)));
  const dropped = new Map([...gone].filter(([key]) => !retiring.has(key)));
  const retiredMarked = new Map([...retiring].map(([key, r]) => [key, retiredAs(r, { id: entry.id, version: entry.version, license: entry.license })] as const));
  const puts = new Map([...next].filter(([key, r]) => !owned.has(key) || !same(owned.get(key)!.record, r.record)));
  const writes = fileWrites(view, packDir, dropped, new Map([...puts, ...retiredMarked]));
  const issues = conflicts.length === 0 ? newErrors(view, withPackAuxiliary(overlay(view, writes), options.without ?? view, packDir, options.without === undefined)) : [];
  const cmp = compareVersions(manifest.version, entry.version);
  return {
    pack: { id: manifest.id, name: manifest.name, license: manifest.license, from: entry.version, to: manifest.version, fromLicense: entry.license },
    direction: cmp > 0 ? 'upgrade' : cmp < 0 ? 'downgrade' : 'same',
    major: majorOf(manifest.version) !== majorOf(entry.version),
    licenseChanged: manifest.license !== entry.license,
    diff,
    conflicts,
    retired: [...retiring.values()].map(refOf),
    references: references.filter((r) => retiring.size > 0),
    issues,
    ok: conflicts.length === 0 && issues.length === 0,
    writes,
    added: addedOf(next.values()),
    assets: packOwnedAssets(packDir),
    retiredRecords: [...retiredMarked.values()],
  };
}

/** What disabling a pack would remove, and what stops it. */
export interface PackDisablePlan {
  pack: { id: string; version: string };
  /** the records that go */
  records: RecordRef[];
  /** records outside the pack that use them: when any, nothing is removed */
  references: PackReference[];
  ok: boolean;
  writes: FileWrites;
  /** the depiction and art files the pack owns (not part of the answer shown to people) */
  assets: Record<string, string>;
}

export function planPackDisable(view: CatalogSource, installed: readonly InstalledPack[], id: string): PackDisablePlan {
  const entry = installed.find((p) => p.id === id);
  if (entry === undefined) throw new Error(`Pack '${id}' is not installed.`);
  const owned = ownedRecords(view, entry);
  const others = [...catalogRecords(view)].filter(([key]) => !owned.has(key)).map(([, r]) => r);
  const references = referencesTo(others, new Set([...owned.values()].filter((r) => !r.file.startsWith('designs/') && !(r.file in KEYED_FILES)).map((r) => r.id)));
  return {
    pack: { id, version: entry.version },
    records: [...owned.values()].map(refOf),
    references,
    ok: references.length === 0,
    writes: fileWrites(view, undefined, owned, new Map()),
    assets: entry.assets ?? {},
  };
}

/* ------------------------------------------------------------------ *
 * Applying
 * ------------------------------------------------------------------ */

function applyWrites(dataDir: string, writes: FileWrites): void {
  for (const [file, text] of writes) {
    const path = join(dataDir, file);
    if (text === null) rmSync(path, { force: true });
    else writeFileReplacing(path, text);
  }
}

function saveInstalled(dir: string, mutate: (packs: InstalledPack[]) => InstalledPack[]): void {
  const installed: InstalledPacks = readInstalledPacks(dir);
  installed.packs = mutate(installed.packs);
  writeFileReplacing(join(dir, PACKS_FILE), canonical(installed));
}

/** Append retired records to the catalog's own record files (`layer`: the old layer's file gives a new file its shape). */
function keepRetired(dataDir: string, layerDir: string, retired: readonly LocatedRecord[]): void {
  const local = fsCatalogSource(dataDir);
  for (const file of [...new Set(retired.map((r) => r.file))].sort()) {
    const put = new Map(retired.filter((r) => r.file === file).map((r) => [r.id, r.record] as const));
    const shape = existsSync(join(layerDir, file)) ? readFileSync(join(layerDir, file), 'utf8') : undefined;
    const text = mergeFile(file, local.read(file), new Set(), put, shape);
    if (typeof text === 'string') writeFileReplacing(join(dataDir, file), text);
  }
}

/**
 * Apply an update plan: a layered pack is replaced as a layer (`installPackLayer`,
 * one directory swap); a pack merged into the catalog directory has its records
 * rewritten in place, and `packs.json` updated last. Call only with `plan.ok`.
 */
export function applyPackUpdate(dataDir: string, packsDir: string | undefined, packDir: string, plan: PackUpdatePlan, where: 'layer' | 'merged'): void {
  if (where === 'layer' && packsDir !== undefined) {
    // records the new version dropped but something still uses leave with the old layer: keep them in the catalog's own files first
    keepRetired(dataDir, installedPackDir(packsDir, plan.pack.id), plan.retiredRecords);
    installPackLayer(dataDir, packsDir, packDir);
    return;
  }
  const manifest = readPackManifest(packDir);
  applyWrites(dataDir, plan.writes);
  // the pack's depictions and art: replaced where it still owns them, removed where the new version drops them
  const before = readInstalledPacks(dataDir).packs.find((p) => p.id === manifest.id)?.assets;
  const assets = applyPackAssets(dataDir, packDir, before, plan.assets);
  applyPackLibrary(dataDir, packDir, before, assets);
  saveInstalled(dataDir, (packs) =>
    packs.map((p) =>
      p.id === manifest.id ? installedRecordOf(manifest, plan.added, assets, packDir) : p,
    ),
  );
}

/** Apply a disable plan (`plan.ok`): remove a layer, or the merged records, and the install record. */
export function applyPackDisable(dataDir: string, packsDir: string | undefined, id: string, plan: PackDisablePlan, where: 'layer' | 'merged'): void {
  if (where === 'layer' && packsDir !== undefined) {
    // the manifest goes first: a half-removed layer is then not read as a pack
    rmSync(installedPackDir(packsDir, id), { recursive: true, force: true });
    saveInstalled(packsDir, (packs) => packs.filter((p) => p.id !== id));
    return;
  }
  applyWrites(dataDir, plan.writes);
  // its depictions and art go, unless the catalog changed or replaced them since
  applyPackAssets(dataDir, undefined, plan.assets, {});
  applyPackLibrary(dataDir, undefined, plan.assets, {});
  saveInstalled(dataDir, (packs) => packs.filter((p) => p.id !== id));
}


/* ------------------------------------------------------------------ *
 * A pack not installed yet (install from a file or a URL)
 * ------------------------------------------------------------------ */

/**
 * The source checks of `verify-pack.mjs` that need no catalog: the manifest
 * reads, every record and vocabulary list cites a `src`. Sentences, empty
 * when the pack is fine.
 */
export function packSourceProblems(packDir: string): string[] {
  const problems: string[] = [];
  let manifest: PackManifest;
  try {
    manifest = readPackManifest(packDir);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) problems.push(`the manifest's version '${manifest.version}' is not semver (1.2.0)`);
  if (manifest.partNumberScheme !== undefined) {
    for (const p of declarativeSchemeProblems(manifest.partNumberScheme)) problems.push(`the manifest's partNumberScheme: ${p}`);
  }
  const rulesPath = join(packDir, 'validation-rules.json');
  if (existsSync(rulesPath)) {
    try {
      for (const p of ruleListProblems(JSON.parse(readFileSync(rulesPath, 'utf8')))) problems.push(`validation-rules.json: ${p}`);
    } catch {
      // not JSON: reported with the other files below
    }
  }
  const benchPath = join(packDir, 'bench-rules.json');
  if (existsSync(benchPath)) {
    try {
      const rules = JSON.parse(readFileSync(benchPath, 'utf8')) as unknown;
      if (!Array.isArray(rules)) problems.push('bench-rules.json: the rules are a list');
      else for (const p of benchRuleProblems(rules, 'bench-rules.json')) problems.push(p);
    } catch {
      // not JSON: reported with the other files below
    }
  }
  // a font a pack ships says whose it is and under what licence: `fonts/<name>.json` beside it, `{ family?, license, src }`
  for (const font of packAssetFiles(packDir).filter((f) => f.startsWith('fonts/'))) {
    const sidecar = join(packDir, font.replace(/\.[^./]+$/, '.json'));
    let meta: unknown;
    try {
      meta = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : undefined;
    } catch {
      meta = undefined;
    }
    const m = meta as { license?: unknown; src?: unknown } | undefined;
    if (m === undefined || typeof m.license !== 'string' || m.license.trim() === '' || typeof m.src !== 'string' || m.src.trim() === '') {
      problems.push(`${font}: a font needs ${font.replace(/\.[^./]+$/, '.json')} beside it naming its "license" (the terms that let documents embed it) and its "src"`);
    }
  }
  const files = packFiles(packDir);
  // a pack that carries a code module may have no records of its own
  if (files.length === 0 && manifest.module === undefined) problems.push('the pack has no data files');
  for (const relative of files) {
    let value: Json;
    try {
      value = JSON.parse(readFileSync(join(packDir, relative), 'utf8')) as Json;
    } catch {
      problems.push(`${relative} is not valid JSON`);
      continue;
    }
    problems.push(...packDocumentSrcProblems(relative, value));
  }
  return problems;
}

/** What installing a pack that is not installed yet would do. */
export interface PackInstallPreview {
  pack: { id: string; name: string; version: string; license: string };
  diff: PackDiff;
  conflicts: string[];
  /** `requires.packs` entries that are not installed (information: the library checks below say what breaks) */
  unmetRequires: string[];
  issues: Issue[];
  ok: boolean;
  writes: FileWrites;
  added: Record<string, string[]>;
  assets: Record<string, string>;
}

export function planNewPack(view: CatalogSource, installed: readonly InstalledPack[], packDir: string): PackInstallPreview {
  const manifest = readPackManifest(packDir);
  const everything = catalogRecords(view);
  const conflicts: string[] = [];
  const next = new Map<string, LocatedRecord>();
  for (const [key, record] of catalogRecords(fsCatalogSource(packDir))) {
    const other = everything.get(key);
    if (other === undefined) next.set(key, record);
    else if (!same(other.record, record.record)) conflicts.push(`${record.file}: '${record.id}' already exists with different content`);
  }
  const writes = fileWrites(view, packDir, new Map(), next);
  const unmetRequires = Object.keys(manifest.requires?.packs ?? {}).filter((id) => !installed.some((p) => p.id === id));
  const issues = conflicts.length === 0 ? newErrors(view, withPackAuxiliary(overlay(view, writes), view, packDir)) : [];
  return {
    pack: { id: manifest.id, name: manifest.name, version: manifest.version, license: manifest.license },
    diff: diffRecords(new Map(), next),
    conflicts,
    unmetRequires,
    issues,
    ok: conflicts.length === 0 && issues.length === 0,
    writes,
    added: addedOf(next.values()),
    assets: packOwnedAssets(packDir),
  };
}
