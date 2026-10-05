/**
 * The catalog codec (`specs/postgres-backend.md` §3.2, §7.1): a catalog tree
 * (`data/…` and `depictions/…`) exploded into rows shaped like the Postgres
 * tables, and rows rendered back into the tree.
 *
 * Pure and deterministic, no dependencies beyond `node:crypto` (for the
 * sha256 of binary files). Nothing here knows SQL: the rows are plain values
 * the Postgres backend writes and reads, and the same rows are what the
 * pg snapshot renders into the file map the catalog loaders read.
 *
 * The contract is byte identity: for every catalog that passes the canonical
 * JSON guard, `render(explode(files))` is the files, byte for byte.
 *
 * - JSON renders as `JSON.stringify(value, null, 2) + '\n'`; a document is
 *   held as `JSON.stringify(value)` (`body`), so key order survives.
 * - A list file (`connectors.json`, …) becomes one record per item with its
 *   position (`ord`) plus an **envelope** document: the file with its list
 *   member emptied. Rendering splices the records back in, in `ord` order.
 * - Files a store sorts itself render with that store's order (the asset
 *   index by id, `models.json` by record key, both in code-point order);
 *   explode refuses a file that is not already in that order.
 * - Markdown and plain text render byte for byte. Binary files are rows that
 *   name a blob by sha256; they render only when the caller hands the bytes.
 *
 * **Coverage rule:** every file maps to exactly one entry of `FILE_MAP`, or
 * explode reports it. Gitignored caches and temp files are skipped by name
 * (`isSkippedPath`); a test holds that list against `.gitignore`.
 */

import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** `studio.entity.kind` */
export const ENTITY_KINDS = [
  'design',
  'connector',
  'component',
  'wire',
  'pcba',
  'body',
  'interface',
  'mechanical',
  'kit',
  'wire-part',
  'wire-recipe',
  'vocab',
  'build',
  'depiction',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** What an envelope's records are: an entity kind, the asset index, or the model links. */
export type ListKind = EntityKind | 'asset' | 'model-link';

export type DocMediaType = 'application/json' | 'text/markdown' | 'text/plain';

/** `studio.record`: one document of an entity. */
export interface RecordRow {
  kind: EntityKind;
  slug: string;
  /** `''` = the entity's own document; `'drawing'` = a design's drawing sheet */
  collection: string;
  /** position in its list file; 0 for a file of its own */
  ord: number;
  /** exactly `JSON.stringify(value)` */
  body: string;
}

/** `studio.catalog_doc`: a file the app reads whole, or the envelope of a list file. */
export interface DocRow {
  path: string;
  mediaType: DocMediaType;
  /** JSON: `JSON.stringify(value)` (an envelope with its member emptied); text: the exact text */
  body: string;
  /** an envelope: whose records fill it, and which member (`''` = the file is the array) */
  list?: { kind: ListKind; collection: string; member: string };
}

/**
 * `studio.derived_doc`: a file the commit regenerates — the tag tables
 * (`tags`) or a module's derived record (`module`, at
 * `data/derived/<module>/<file>`; see `derivedModuleOf`).
 */
export interface DerivedRow {
  path: string;
  derivedKind: 'tags' | 'module';
  mediaType: DocMediaType;
  body: string;
}

/** `studio.design_revision` */
export interface RevisionRow {
  design: string;
  rev: number;
  body: string;
}

/** `studio.design_working` */
export interface WorkingRow {
  design: string;
  body: string;
}

/** `studio.design_draft` */
export interface DraftRow {
  design: string;
  n: number;
  body: string;
}

/** `studio.design_artwork`: `_versions/<design>/artwork/<name>` */
export interface ArtworkRow {
  design: string;
  name: string;
  sha256: string;
}

/** `studio.asset`: one entry of `assets/index.json` (its `bytes` is the blob's size) */
export interface AssetRow {
  sha256: string;
  mime: string;
  originalName: string;
  src: string;
}

/** `studio.drawing_photo`: `drawings/<design>.photo-ref.json` */
export interface DrawingPhotoRow {
  design: string;
  sha256: string;
}

/** `studio.depiction_file`: `depictions/<def>/<name>` (anything but `meta.json`) */
export interface DepictionFileRow {
  def: string;
  name: string;
  sha256: string;
}

/** `studio.model_link`: one link of `models.json` */
export interface ModelLinkRow {
  recordKey: string;
  body: string;
}

/** `studio.catalog_file`: any other binary file under `data/` or `depictions/` (a legacy drawing photo, a module's file) */
export interface CatalogFileRow {
  path: string;
  sha256: string;
}

/** `studio.blob`: bytes by content. `bytes` is absent when the tree named a blob it did not hold (an asset kept in the blob store). */
export interface BlobRow {
  sha256: string;
  size: number;
  mediaType: string;
  bytes?: Uint8Array;
}

export interface CatalogRows {
  records: RecordRow[];
  docs: DocRow[];
  derived: DerivedRow[];
  revisions: RevisionRow[];
  working: WorkingRow[];
  drafts: DraftRow[];
  artwork: ArtworkRow[];
  assets: AssetRow[];
  drawingPhotos: DrawingPhotoRow[];
  depictionFiles: DepictionFileRow[];
  modelLinks: ModelLinkRow[];
  files: CatalogFileRow[];
  blobs: BlobRow[];
}

export function emptyRows(): CatalogRows {
  return {
    records: [],
    docs: [],
    derived: [],
    revisions: [],
    working: [],
    drafts: [],
    artwork: [],
    assets: [],
    drawingPhotos: [],
    depictionFiles: [],
    modelLinks: [],
    files: [],
    blobs: [],
  };
}

/**
 * A binary file known by its content address rather than held as bytes (a
 * tree rebuilt from rows, whose blobs live in a blob store).
 */
export interface BlobRef {
  blob: string;
  size: number;
}

export type FileContent = string | Uint8Array | BlobRef;

export const isBlobRef = (content: unknown): content is BlobRef =>
  typeof content === 'object' && content !== null && !(content instanceof Uint8Array) && typeof (content as BlobRef).blob === 'string';

/** A catalog tree: path (`data/…`, `depictions/…`) → text (JSON, markdown, plain text), bytes, or a blob reference. */
export type CatalogFiles = ReadonlyMap<string, FileContent>;

/* ------------------------------------------------------------------ *
 * Shared rules
 * ------------------------------------------------------------------ */

/** `JSON.stringify(v, null, 2) + '\n'` — how every catalog JSON file is written. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** True when `text` is exactly the canonical rendering of what it parses to. */
export function isCanonicalJson(text: string): boolean {
  try {
    return canonicalJson(JSON.parse(text)) === text;
  } catch {
    return false;
  }
}

/** `studio.entity.slug` */
export const SLUG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const DESIGN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTWORK_NAME = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/;
const DEPICTION_FILE = /^[a-z0-9][a-z0-9._-]*\.(svg|png|jpg|jpeg|webp)$/;
const ASSET_FILE = /^([0-9a-f]{64})\.(png|jpg|pdf|glb|stl)$/;
const MODEL_RECORD_KEY = /^(connectors|components|wires|pcbas|bodies|interfaces|mechanicals|kits)\/[a-z0-9][a-z0-9._-]*$/;

/** The asset store's mime → file extension (`apps/studio/server/assets.ts` ASSET_MIME_EXT). */
export const ASSET_MIME_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'model/gltf-binary': 'glb',
  'model/stl': 'stl',
};

const MEDIA_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  glb: 'model/gltf-binary',
  stl: 'model/stl',
};

/** The blob media type for a file name. */
export function mediaTypeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MEDIA_BY_EXT[ext] ?? 'application/octet-stream';
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The sha256 of a file's content: a blob reference's own, else the hash of the text or bytes. */
export function contentSha(content: FileContent): string {
  return isBlobRef(content) ? content.blob : sha256Hex(content);
}

/** Code-point order — never `localeCompare`, whose answer depends on the machine's ICU data. */
export function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The list files: the definition kinds and the wire library (§3.3). */
export const LIST_FILES: readonly { file: string; kind: EntityKind }[] = [
  { file: 'connectors.json', kind: 'connector' },
  { file: 'components.json', kind: 'component' },
  { file: 'wires.json', kind: 'wire' },
  { file: 'pcbas.json', kind: 'pcba' },
  { file: 'bodies.json', kind: 'body' },
  { file: 'interfaces.json', kind: 'interface' },
  { file: 'mechanicals.json', kind: 'mechanical' },
  { file: 'kits.json', kind: 'kit' },
  { file: 'wire-parts.json', kind: 'wire-part' },
  { file: 'wire-recipes.json', kind: 'wire-recipe' },
];

/** The tag builder's outputs (derived, §3.2). */
export const DERIVED_TAG_FILES = ['tags/signal-tags.json', 'tags/instance-slots.json', 'tags/report.md'] as const;

/**
 * Gitignored runtime files under a catalog tree, skipped by name: the model
 * caches (dot-directories) and the temp files of atomic writes and imports.
 * Every pattern of the catalog's section of `.gitignore` is one of these
 * (`codec.test.ts`).
 */
export const SKIP_RULES: readonly { pattern: string; test: (segment: string, isLast: boolean) => boolean }[] = [
  // `.model-cache/`, `.kicad-3d-cache/`, `.*.tmp` (writeFileAtomic), any other dot-file or dot-directory
  { pattern: '.*', test: (segment) => segment.startsWith('.') },
  // the importer's and the pack installer's in-flight files
  { pattern: '*.import-tmp', test: (segment, isLast) => isLast && segment.endsWith('.import-tmp') },
  { pattern: '*.pack-tmp', test: (segment, isLast) => isLast && segment.endsWith('.pack-tmp') },
];

export function isSkippedPath(path: string): boolean {
  const segments = path.split('/');
  return segments.some((segment, i) => SKIP_RULES.some((rule) => rule.test(segment, i === segments.length - 1)));
}

/** Whether a catalog file is read as text (JSON, markdown, plain text) rather than bytes. */
export function isTextPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return /\.(json|md|txt)$/.test(name) || name === 'LICENSE' || name === 'NOTICE' || name === 'README';
}

/* ------------------------------------------------------------------ *
 * FILE_MAP — every file and where it goes (§3.2)
 * ------------------------------------------------------------------ */

export type FileClass = 'truth' | 'derived' | 'skipped';

/** One entry of §3.2, for the coverage rule and the docs. Patterns are written for people; `match` decides. */
export interface FileMapEntry {
  pattern: string;
  class: FileClass;
  table: string;
  match: (path: string) => boolean;
}

const re = (pattern: RegExp) => (path: string) => pattern.test(path);
const listPaths = new Set(LIST_FILES.map((l) => `data/${l.file}`));
const MODULE_DERIVED = /^data\/derived\/([a-z0-9]+(?:-[a-z0-9]+)*)\/[a-z0-9][a-z0-9-]*\.(json|md)$/;

/** The module a derived-record path belongs to (`data/derived/<module>/<file>`), or undefined. */
export function derivedModuleOf(path: string): string | undefined {
  return MODULE_DERIVED.exec(path)?.[1];
}

const derivedPaths = new Set(DERIVED_TAG_FILES.map((p) => `data/${p}`));

export const FILE_MAP: readonly FileMapEntry[] = [
  { pattern: '(gitignored caches and temp files)', class: 'skipped', table: '—', match: isSkippedPath },
  { pattern: 'data/designs/<id>.json', class: 'truth', table: "entity(design) + record('')", match: re(/^data\/designs\/[^/]+\.json$/) },
  { pattern: 'data/designs/_versions/<id>/<rev>.json', class: 'truth', table: 'design_revision', match: re(/^data\/designs\/_versions\/[^/]+\/\d+\.json$/) },
  { pattern: 'data/designs/_versions/<id>/working.json', class: 'truth', table: 'design_working', match: re(/^data\/designs\/_versions\/[^/]+\/working\.json$/) },
  { pattern: 'data/designs/_versions/<id>/drafts/<n>.json', class: 'truth', table: 'design_draft', match: re(/^data\/designs\/_versions\/[^/]+\/drafts\/\d+\.json$/) },
  { pattern: 'data/designs/_versions/<id>/artwork/<sha>.<ext>', class: 'truth', table: 'design_artwork → blob', match: re(/^data\/designs\/_versions\/[^/]+\/artwork\/[^/]+$/) },
  { pattern: 'data/drawings/<id>.photo-ref.json', class: 'truth', table: 'drawing_photo → asset', match: re(/^data\/drawings\/[^/]+\.photo-ref\.json$/) },
  { pattern: 'data/drawings/<id>.json', class: 'truth', table: "record('drawing') of the design", match: re(/^data\/drawings\/[^/]+\.json$/) },
  { pattern: 'data/assets/index.json', class: 'truth', table: 'asset (envelope catalog_doc)', match: (p) => p === 'data/assets/index.json' },
  { pattern: 'data/assets/<sha>.<ext>', class: 'truth', table: "asset → blob(class 'record')", match: re(/^data\/assets\/[0-9a-f]{64}\.[a-z0-9]+$/) },
  { pattern: 'data/{connectors,components,wires,pcbas,bodies,interfaces,mechanicals,kits,wire-parts,wire-recipes}.json', class: 'truth', table: 'entity + record, ordered (envelope catalog_doc)', match: (p) => listPaths.has(p) },
  { pattern: 'data/models.json', class: 'truth', table: 'model_link (envelope catalog_doc)', match: (p) => p === 'data/models.json' },
  { pattern: 'data/vocab/<list>.json', class: 'truth', table: 'entity(vocab) + record', match: re(/^data\/vocab\/[^/]+\.json$/) },
  { pattern: 'data/builds/<name>.json', class: 'truth', table: 'entity(build) + record', match: re(/^data\/builds\/[^/]+\.json$/) },
  { pattern: 'data/tags/{signal-tags.json,instance-slots.json,report.md}', class: 'derived', table: 'derived_doc', match: (p) => derivedPaths.has(p) },
  { pattern: 'data/derived/<module>/<file>.{json,md}', class: 'derived', table: "derived_doc (derived_kind 'module', module_id)", match: (p) => derivedModuleOf(p) !== undefined },
  { pattern: 'depictions/<def>/meta.json', class: 'truth', table: 'entity(depiction) + record', match: re(/^depictions\/[^/]+\/meta\.json$/) },
  { pattern: 'depictions/<def>/<file>', class: 'truth', table: 'depiction_file → blob', match: re(/^depictions\/[^/]+\/[^/]+$/) },
  { pattern: 'data/**/*.{json,md}, LICENSE, *.txt (part-numbers.json, strip-practice.json, tags/review.json, packs.json, setup.json, a module\'s files …)', class: 'truth', table: 'catalog_doc', match: (p) => p.startsWith('data/') && isTextPath(p) },
  { pattern: 'data/** (any other file: a legacy drawing photo, a module\'s binary)', class: 'truth', table: 'catalog_file → blob', match: (p) => p.startsWith('data/') },
];

/** The first `FILE_MAP` entry a path matches, or `undefined` (uncovered). */
export function classifyPath(path: string): FileMapEntry | undefined {
  return FILE_MAP.find((entry) => entry.match(path));
}

/* ------------------------------------------------------------------ *
 * explode
 * ------------------------------------------------------------------ */

export interface ExplodeResult {
  rows: CatalogRows;
  /** every reason the tree cannot be imported as it is: uncovered files, malformed or non-canonical documents */
  errors: string[];
}

type Json = unknown;
const isObject = (value: Json): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Explode a catalog tree into rows. Never throws on bad input: every problem
 * is an entry of `errors`, and a caller imports only when there is none.
 */
export function explode(files: CatalogFiles): ExplodeResult {
  const rows = emptyRows();
  const errors: string[] = [];
  const blobs = new Map<string, BlobRow>();
  const addBlob = (sha256: string, name: string, bytes: Uint8Array | undefined, size?: number): void => {
    const existing = blobs.get(sha256);
    if (existing !== undefined) {
      if (existing.bytes === undefined && bytes !== undefined) existing.bytes = bytes;
      if (existing.size === 0 && size !== undefined) existing.size = size;
      return;
    }
    blobs.set(sha256, { sha256, size: bytes?.length ?? size ?? 0, mediaType: mediaTypeOf(name), ...(bytes === undefined ? {} : { bytes }) });
  };
  const text = (path: string, content: FileContent): string | undefined => {
    if (typeof content === 'string') return content;
    if (isBlobRef(content)) {
      errors.push(`${path}: a text file cannot be a blob reference`);
      return undefined;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      errors.push(`${path}: not UTF-8 text`);
      return undefined;
    }
  };
  /** the sha256, size and (when held) bytes of a binary file */
  const binary = (content: FileContent): { sha: string; size: number; bytes: Uint8Array | undefined } => {
    if (isBlobRef(content)) return { sha: content.blob, size: content.size, bytes: undefined };
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    return { sha: sha256Hex(bytes), size: bytes.length, bytes };
  };
  /** parse a JSON file, insisting it is canonical */
  const json = (path: string, content: FileContent): { value: Json; body: string } | undefined => {
    const source = text(path, content);
    if (source === undefined) return undefined;
    let value: Json;
    try {
      value = JSON.parse(source) as Json;
    } catch (error) {
      errors.push(`${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      return undefined;
    }
    if (canonicalJson(value) !== source) {
      errors.push(`${path}: not canonical JSON (rewrite it as JSON.stringify(value, null, 2) + "\\n")`);
      return undefined;
    }
    return { value, body: JSON.stringify(value) };
  };
  const slugOk = (path: string, what: string, slug: string, rule: RegExp = SLUG): boolean => {
    if (rule.test(slug)) return true;
    errors.push(`${path}: '${slug}' is not a usable ${what}`);
    return false;
  };

  // asset bytes in the tree, by sha: the index decides which are assets
  const assetFiles = new Map<string, { name: string; bytes: Uint8Array | undefined; size: number }>();
  let assetIndex: { path: string; content: FileContent } | undefined;

  for (const path of [...files.keys()].sort(codePointCompare)) {
    const content = files.get(path) as FileContent;
    const entry = classifyPath(path);
    if (entry === undefined) {
      errors.push(`${path}: not covered by the codec's FILE_MAP (§3.2); map it before importing`);
      continue;
    }
    if (entry.class === 'skipped') continue;
    const parts = path.split('/');
    const name = parts[parts.length - 1] as string;
    const base = name.replace(/\.json$/, '');

    switch (entry.pattern) {
      case 'data/designs/<id>.json': {
        const parsed = json(path, content);
        if (parsed !== undefined && slugOk(path, 'design id', base, DESIGN_ID)) {
          rows.records.push({ kind: 'design', slug: base, collection: '', ord: 0, body: parsed.body });
        }
        break;
      }
      case 'data/designs/_versions/<id>/<rev>.json': {
        const design = parts[3] as string;
        const parsed = json(path, content);
        if (parsed === undefined || !slugOk(path, 'design id', design, DESIGN_ID)) break;
        const rev = Number(base);
        if (!isObject(parsed.value) || parsed.value['rev'] !== rev) {
          errors.push(`${path}: its "rev" is not ${rev}`);
          break;
        }
        rows.revisions.push({ design, rev, body: parsed.body });
        break;
      }
      case 'data/designs/_versions/<id>/working.json': {
        const design = parts[3] as string;
        const parsed = json(path, content);
        if (parsed !== undefined && slugOk(path, 'design id', design, DESIGN_ID)) rows.working.push({ design, body: parsed.body });
        break;
      }
      case 'data/designs/_versions/<id>/drafts/<n>.json': {
        const design = parts[3] as string;
        const parsed = json(path, content);
        const n = Number(base);
        if (parsed === undefined || !slugOk(path, 'design id', design, DESIGN_ID)) break;
        if (!Number.isInteger(n) || n < 1) {
          errors.push(`${path}: drafts are numbered from 1`);
          break;
        }
        rows.drafts.push({ design, n, body: parsed.body });
        break;
      }
      case 'data/designs/_versions/<id>/artwork/<sha>.<ext>': {
        const design = parts[3] as string;
        const match = ARTWORK_NAME.exec(name);
        if (!slugOk(path, 'design id', design, DESIGN_ID)) break;
        const { sha, size, bytes } = binary(content);
        if (match === null || match[1] !== sha) {
          errors.push(`${path}: an artwork blob is named <sha256 of its bytes>.<ext>`);
          break;
        }
        rows.artwork.push({ design, name, sha256: sha });
        addBlob(sha, name, bytes, size);
        break;
      }
      case 'data/drawings/<id>.photo-ref.json': {
        const design = name.slice(0, -'.photo-ref.json'.length);
        const parsed = json(path, content);
        if (parsed === undefined || !slugOk(path, 'design id', design, DESIGN_ID)) break;
        const value = parsed.value;
        if (!isObject(value) || Object.keys(value).join(',') !== 'assetId' || typeof value['assetId'] !== 'string' || !/^[0-9a-f]{64}$/.test(value['assetId'])) {
          errors.push(`${path}: a photo reference is exactly {"assetId": "<sha256>"}`);
          break;
        }
        rows.drawingPhotos.push({ design, sha256: value['assetId'] });
        break;
      }
      case 'data/drawings/<id>.json': {
        const parsed = json(path, content);
        if (parsed !== undefined && slugOk(path, 'design id', base, DESIGN_ID)) {
          rows.records.push({ kind: 'design', slug: base, collection: 'drawing', ord: 0, body: parsed.body });
        }
        break;
      }
      case 'data/assets/index.json':
        assetIndex = { path, content };
        break;
      case 'data/assets/<sha>.<ext>': {
        const match = ASSET_FILE.exec(name);
        const { sha, size, bytes } = binary(content);
        if (match === null || match[1] !== sha) {
          errors.push(`${path}: an asset is named <sha256 of its bytes>.<png|jpg|pdf|glb|stl>`);
          break;
        }
        assetFiles.set(sha, { name, bytes, size });
        break;
      }
      case 'data/{connectors,components,wires,pcbas,bodies,interfaces,mechanicals,kits,wire-parts,wire-recipes}.json': {
        const list = LIST_FILES.find((l) => `data/${l.file}` === path) as { file: string; kind: EntityKind };
        const parsed = json(path, content);
        if (parsed === undefined) break;
        if (!Array.isArray(parsed.value)) {
          errors.push(`${path}: a list file is a JSON array`);
          break;
        }
        const seen = new Set<string>();
        let ok = true;
        parsed.value.forEach((item, i) => {
          const id = isObject(item) ? item['id'] : undefined;
          if (typeof id !== 'string' || !SLUG.test(id)) {
            errors.push(`${path}: item ${i} has no usable "id"`);
            ok = false;
          } else if (seen.has(id)) {
            errors.push(`${path}: id '${id}' appears twice`);
            ok = false;
          } else seen.add(id);
        });
        if (!ok) break;
        parsed.value.forEach((item, ord) => {
          rows.records.push({ kind: list.kind, slug: (item as { id: string }).id, collection: '', ord, body: JSON.stringify(item) });
        });
        rows.docs.push({ path, mediaType: 'application/json', body: '[]', list: { kind: list.kind, collection: '', member: '' } });
        break;
      }
      case 'data/models.json': {
        const parsed = json(path, content);
        if (parsed === undefined) break;
        const value = parsed.value;
        if (!isObject(value) || !Array.isArray(value['links'])) {
          errors.push(`${path}: models.json is {"src", "links": [...]}`);
          break;
        }
        const links = value['links'] as Json[];
        const keys = links.map((link) => (isObject(link) ? link['record'] : undefined));
        const bad = keys.findIndex((key) => typeof key !== 'string' || !MODEL_RECORD_KEY.test(key));
        if (bad !== -1) {
          errors.push(`${path}: link ${bad} has no usable "record" (<kind>/<id>)`);
          break;
        }
        const sorted = [...(keys as string[])].sort(codePointCompare);
        if (sorted.some((key, i) => key !== keys[i] || (i > 0 && key === sorted[i - 1]))) {
          errors.push(`${path}: links are not unique and sorted by "record" in code-point order (the store's order)`);
          break;
        }
        links.forEach((link, i) => rows.modelLinks.push({ recordKey: keys[i] as string, body: JSON.stringify(link) }));
        rows.docs.push({ path, mediaType: 'application/json', body: JSON.stringify({ ...value, links: [] }), list: { kind: 'model-link', collection: '', member: 'links' } });
        break;
      }
      case 'data/vocab/<list>.json': {
        const parsed = json(path, content);
        if (parsed !== undefined && slugOk(path, 'vocab list id', base, DESIGN_ID)) {
          rows.records.push({ kind: 'vocab', slug: base, collection: '', ord: 0, body: parsed.body });
        }
        break;
      }
      case 'data/builds/<name>.json': {
        const parsed = json(path, content);
        if (parsed !== undefined && slugOk(path, 'build file name', base, DESIGN_ID)) {
          rows.records.push({ kind: 'build', slug: base, collection: '', ord: 0, body: parsed.body });
        }
        break;
      }
      case 'data/tags/{signal-tags.json,instance-slots.json,report.md}': {
        const rel = path.slice('data/'.length);
        if (rel.endsWith('.md')) {
          const source = text(path, content);
          if (source !== undefined) rows.derived.push({ path, derivedKind: 'tags', mediaType: 'text/markdown', body: source });
        } else {
          const parsed = json(path, content);
          if (parsed !== undefined) rows.derived.push({ path, derivedKind: 'tags', mediaType: 'application/json', body: parsed.body });
        }
        break;
      }
      case 'data/derived/<module>/<file>.{json,md}': {
        if (path.endsWith('.md')) {
          const source = text(path, content);
          if (source !== undefined) rows.derived.push({ path, derivedKind: 'module', mediaType: 'text/markdown', body: source });
        } else {
          const parsed = json(path, content);
          if (parsed !== undefined) rows.derived.push({ path, derivedKind: 'module', mediaType: 'application/json', body: parsed.body });
        }
        break;
      }
      case 'depictions/<def>/meta.json': {
        const def = parts[1] as string;
        const parsed = json(path, content);
        if (parsed !== undefined && slugOk(path, 'definition id', def)) rows.records.push({ kind: 'depiction', slug: def, collection: '', ord: 0, body: parsed.body });
        break;
      }
      case 'depictions/<def>/<file>': {
        const def = parts[1] as string;
        if (!slugOk(path, 'definition id', def)) break;
        if (!DEPICTION_FILE.test(name)) {
          errors.push(`${path}: a depiction file is <lowercase name>.(svg|png|jpg|jpeg|webp)`);
          break;
        }
        const { sha, size, bytes } = binary(content);
        rows.depictionFiles.push({ def, name, sha256: sha });
        addBlob(sha, name, bytes, size);
        break;
      }
      default: {
        if (entry.table === 'catalog_doc') {
          if (name.endsWith('.json')) {
            const parsed = json(path, content);
            if (parsed !== undefined) rows.docs.push({ path, mediaType: 'application/json', body: parsed.body });
          } else {
            const source = text(path, content);
            if (source !== undefined) rows.docs.push({ path, mediaType: name.endsWith('.md') ? 'text/markdown' : 'text/plain', body: source });
          }
        } else {
          const { sha, size, bytes } = binary(content);
          rows.files.push({ path, sha256: sha });
          addBlob(sha, name, bytes, size);
        }
      }
    }
  }

  // the asset index names the assets; their bytes are in the tree or (WIREHUB_BLOBS) in the blob store
  if (assetIndex !== undefined) {
    const parsed = json(assetIndex.path, assetIndex.content);
    if (parsed !== undefined) {
      if (!Array.isArray(parsed.value)) errors.push(`${assetIndex.path}: the asset index is a JSON array`);
      else {
        const entries = parsed.value as Json[];
        const shaped = entries.every(
          (e) =>
            isObject(e) &&
            Object.keys(e).join(',') === 'id,mime,originalName,src,bytes' &&
            typeof e['id'] === 'string' &&
            /^[0-9a-f]{64}$/.test(e['id']) &&
            typeof e['mime'] === 'string' &&
            ASSET_MIME_EXT[e['mime']] !== undefined &&
            typeof e['originalName'] === 'string' &&
            typeof e['src'] === 'string' &&
            Number.isInteger(e['bytes']),
        );
        const ids = shaped ? entries.map((e) => (e as { id: string }).id) : [];
        const sorted = [...ids].sort(codePointCompare);
        if (!shaped) errors.push(`${assetIndex.path}: every entry is exactly {id, mime, originalName, src, bytes}, in that order`);
        else if (sorted.some((id, i) => id !== ids[i] || (i > 0 && id === sorted[i - 1]))) {
          errors.push(`${assetIndex.path}: entries are not unique and sorted by id (the store's order)`);
        } else {
          for (const e of entries as { id: string; mime: string; originalName: string; src: string; bytes: number }[]) {
            rows.assets.push({ sha256: e.id, mime: e.mime, originalName: e.originalName, src: e.src });
            const file = assetFiles.get(e.id);
            if (file !== undefined && file.name !== `${e.id}.${ASSET_MIME_EXT[e.mime]}`) {
              errors.push(`data/assets/${file.name}: the index says this asset is ${e.mime}`);
            }
            if (file !== undefined && file.size !== e.bytes) errors.push(`data/assets/${file.name}: the index says ${e.bytes} bytes`);
            addBlob(e.id, `${e.id}.${ASSET_MIME_EXT[e.mime]}`, file?.bytes, e.bytes);
            assetFiles.delete(e.id);
          }
          rows.docs.push({ path: assetIndex.path, mediaType: 'application/json', body: '[]', list: { kind: 'asset', collection: '', member: '' } });
        }
      }
    }
  }
  for (const { name } of assetFiles.values()) errors.push(`data/assets/${name}: no entry of assets/index.json names it`);

  // a photo reference names an asset of this catalog
  const assetIds = new Set(rows.assets.map((a) => a.sha256));
  for (const photo of rows.drawingPhotos) {
    if (!assetIds.has(photo.sha256)) errors.push(`data/drawings/${photo.design}.photo-ref.json: asset ${photo.sha256} is not in assets/index.json`);
  }

  rows.blobs = [...blobs.values()].sort((a, b) => codePointCompare(a.sha256, b.sha256));
  return { rows, errors };
}

/* ------------------------------------------------------------------ *
 * render
 * ------------------------------------------------------------------ */

const ENVELOPE_RECORD_KINDS = new Set<ListKind>(LIST_FILES.map((l) => l.kind));

/** Where a record that is a file of its own lives. */
function recordPath(row: RecordRow): string | undefined {
  if (row.kind === 'design') return row.collection === '' ? `data/designs/${row.slug}.json` : row.collection === 'drawing' ? `data/drawings/${row.slug}.json` : undefined;
  if (row.collection !== '') return undefined;
  if (row.kind === 'vocab') return `data/vocab/${row.slug}.json`;
  if (row.kind === 'build') return `data/builds/${row.slug}.json`;
  if (row.kind === 'depiction') return `depictions/${row.slug}/meta.json`;
  return undefined;
}

const fromBody = (body: string): string => canonicalJson(JSON.parse(body));

export interface RenderOptions {
  /** blob bytes by sha256: given, binary files render too; absent, only text files */
  blobs?: (sha256: string) => Uint8Array | undefined;
}

/**
 * Render rows as a catalog tree. Text files always; binary files only for
 * the blobs `options.blobs` can hand over. Throws on rows that cannot have
 * come from `explode` (a record no file holds), which is a bug, not input.
 */
export function render(rows: CatalogRows, options: RenderOptions = {}): Map<string, string | Uint8Array> {
  const out = new Map<string, string | Uint8Array>();
  const put = (path: string, content: string | Uint8Array): void => {
    if (out.has(path)) throw new Error(`render: two rows render ${path}`);
    out.set(path, content);
  };
  const binary = (path: string, sha256: string): void => {
    const bytes = options.blobs?.(sha256);
    if (bytes !== undefined) put(path, bytes);
  };

  // list members, by (kind, collection), in ord order
  const lists = new Map<string, RecordRow[]>();
  for (const row of rows.records) {
    if (ENVELOPE_RECORD_KINDS.has(row.kind)) {
      const key = `${row.kind}\u0000${row.collection}`;
      let list = lists.get(key);
      if (list === undefined) lists.set(key, (list = []));
      list.push(row);
      continue;
    }
    const path = recordPath(row);
    if (path === undefined) throw new Error(`render: no file holds ${row.kind} '${row.slug}' (${row.collection})`);
    put(path, fromBody(row.body));
  }
  const blobSize = new Map(rows.blobs.map((b) => [b.sha256, b.size] as const));
  for (const doc of rows.docs) {
    if (doc.list === undefined) {
      put(doc.path, doc.mediaType === 'application/json' ? fromBody(doc.body) : doc.body);
      continue;
    }
    const { kind, collection, member } = doc.list;
    let items: Json[];
    if (kind === 'asset') {
      items = [...rows.assets]
        .sort((a, b) => codePointCompare(a.sha256, b.sha256))
        .map((a) => ({ id: a.sha256, mime: a.mime, originalName: a.originalName, src: a.src, bytes: blobSize.get(a.sha256) ?? 0 }));
    } else if (kind === 'model-link') {
      items = [...rows.modelLinks].sort((a, b) => codePointCompare(a.recordKey, b.recordKey)).map((l) => JSON.parse(l.body) as Json);
    } else {
      const members = lists.get(`${kind}\u0000${collection}`) ?? [];
      lists.delete(`${kind}\u0000${collection}`);
      items = [...members].sort((a, b) => a.ord - b.ord || codePointCompare(a.slug, b.slug)).map((r) => JSON.parse(r.body) as Json);
    }
    const envelope = JSON.parse(doc.body) as Json;
    if (member === '') put(doc.path, canonicalJson(items));
    else {
      if (!isObject(envelope)) throw new Error(`render: the envelope of ${doc.path} is not an object`);
      put(doc.path, canonicalJson({ ...envelope, [member]: items }));
    }
  }
  for (const [key, members] of lists) {
    if (members.length > 0) throw new Error(`render: ${key.replace('\u0000', '/')} records have no list file`);
  }
  for (const row of rows.derived) put(row.path, row.mediaType === 'application/json' ? fromBody(row.body) : row.body);
  for (const row of rows.revisions) put(`data/designs/_versions/${row.design}/${row.rev}.json`, fromBody(row.body));
  for (const row of rows.working) put(`data/designs/_versions/${row.design}/working.json`, fromBody(row.body));
  for (const row of rows.drafts) put(`data/designs/_versions/${row.design}/drafts/${row.n}.json`, fromBody(row.body));
  for (const row of rows.drawingPhotos) put(`data/drawings/${row.design}.photo-ref.json`, canonicalJson({ assetId: row.sha256 }));
  for (const row of rows.artwork) binary(`data/designs/_versions/${row.design}/artwork/${row.name}`, row.sha256);
  for (const row of rows.assets) binary(`data/assets/${row.sha256}.${ASSET_MIME_EXT[row.mime] ?? 'bin'}`, row.sha256);
  for (const row of rows.depictionFiles) binary(`depictions/${row.def}/${row.name}`, row.sha256);
  for (const row of rows.files) binary(row.path, row.sha256);
  return new Map([...out.entries()].sort(([a], [b]) => codePointCompare(a, b)));
}

/** Every entity the rows name, sorted — a design exists if any of its records, revisions or side rows does. */
export function entitiesOf(rows: CatalogRows): { kind: EntityKind; slug: string }[] {
  const keys = new Set<string>();
  const add = (kind: EntityKind, slug: string): void => void keys.add(`${kind}\u0000${slug}`);
  for (const r of rows.records) add(r.kind, r.slug);
  for (const r of [...rows.revisions, ...rows.working, ...rows.drafts, ...rows.artwork, ...rows.drawingPhotos]) add('design', r.design);
  for (const r of rows.depictionFiles) add('depiction', r.def);
  return [...keys]
    .sort(codePointCompare)
    .map((key) => {
      const [kind, slug] = key.split('\u0000') as [EntityKind, string];
      return { kind, slug };
    });
}

/** The text files of a tree (the snapshot's file map): `data/` paths with the prefix stripped. */
export function dataFileMap(files: ReadonlyMap<string, string | Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of files) if (path.startsWith('data/') && typeof content === 'string') out[path.slice('data/'.length)] = content;
  return out;
}
