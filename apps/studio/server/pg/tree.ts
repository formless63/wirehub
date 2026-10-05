/**
 * The catalog as a mutable in-memory tree, and every store's write half over
 * it (`specs/postgres-backend.md` §4.2, tasks B1–B3).
 *
 * The Postgres commit applies a change set to the catalog **as files**: the
 * snapshot at the locked head version becomes a `CatalogTree`, the change set
 * is applied through these stores by the very `commitChangeSet` the file
 * backend uses (preconditions, every change in order, the derived tag
 * tables), and the tree that results is exploded through the codec and
 * diffed against the rows it started from (`commit.ts`). Each write here does
 * what the file store does to its file — so a change means on Postgres
 * exactly what it means on files, byte for byte, by construction.
 *
 * Binary files are blob references (`BlobRef`); bytes a change brings are
 * kept in `bytes` (and are uploaded before the transaction).
 */

import { createCatalog, type Catalog, type CatalogSource } from '@wirehub/catalog';
import { ASSET_MIME_EXT, canonicalJson, codePointCompare, isBlobRef, mediaTypeOf, render, sha256Hex, type BlobRef, type FileContent } from '@wirehub/catalog/src/codec/index.ts';
import { buildTags, type TagReview } from '@wirehub/catalog/src/tags/build.ts';
import { decomposeConnector, formatVersionJson, type CableDesign, type ConnectorDefinition, type DesignVersionFile, type WireDefinition } from '@wirehub/model';

import type { WorkbenchDeps } from '../api.ts';
import type { AssetSummary } from '../assets.ts';
import type { BlobStore } from '../blobs.ts';
import type { DefinitionRecord } from '../definition-store.ts';
import type { DepictionStore } from '../depictions.ts';
import type { ModuleRegistry } from '@wirehub/modules';
import { moduleDerivedStore } from '../module-derived.ts';
import { MODELS_FILE_SRC, sortLinks, type ModelLink } from '../models/links.ts';
import { formatDoc, isDocPath, parseDoc, type DocStore } from '../storage/doc-store.ts';
import type { DraftFile } from '../versions.ts';
import { blobObjectKey } from './keys.ts';
import type { Snapshot } from './snapshot.ts';
import {
  pgAssetStore,
  pgBuildsStore,
  pgDefinitionStore,
  pgDesignStore,
  pgDrawingStore,
  pgModelLinkStore,
  pgTagStore,
  pgVersionStore,
  pgVocabStore,
  pgWireLibraryStore,
  artworkSnapshot,
  type PgReadContext,
} from './stores.ts';

const LIST_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEF_ID = /^[a-z0-9][a-z0-9.-]*$/;

export class CatalogTree {
  /** codec paths (`data/…`, `depictions/…`) → text, or a blob reference */
  readonly files: Map<string, string | BlobRef>;
  /** bytes the change set brings, by sha256 */
  readonly bytes = new Map<string, Uint8Array>();
  readonly source: CatalogSource;
  readonly catalog: Catalog;

  constructor(files: Iterable<[string, string | BlobRef]>) {
    this.files = new Map(files);
    const files_ = this.files;
    this.source = {
      name: 'the catalog being committed',
      read: (relative) => {
        const content = files_.get(`data/${relative}`);
        return typeof content === 'string' ? content : undefined;
      },
      list: (relativeDir) => {
        const dir = relativeDir.replace(/\/+$/, '');
        const prefix = dir === '' ? 'data/' : `data/${dir}/`;
        const names: string[] = [];
        for (const path of files_.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          if (rest !== '' && !rest.includes('/')) names.push(rest);
        }
        return names.sort();
      },
    };
    this.catalog = createCatalog(this.source);
  }

  /** The tree of a snapshot: its text files, and a reference for every binary file. */
  static fromSnapshot(snapshot: Snapshot): CatalogTree {
    const entries: [string, string | BlobRef][] = [];
    for (const [path, content] of render(snapshot.rows)) if (typeof content === 'string') entries.push([path, content]);
    const size = new Map(snapshot.rows.blobs.map((b) => [b.sha256, b.size] as const));
    const ref = (sha: string): BlobRef => ({ blob: sha, size: size.get(sha) ?? 0 });
    for (const a of snapshot.rows.assets) entries.push([`data/assets/${a.sha256}.${ASSET_MIME_EXT[a.mime] ?? 'bin'}`, ref(a.sha256)]);
    for (const [path, sha] of snapshot.blobOf) entries.push([path, ref(sha)]);
    return new CatalogTree(entries);
  }

  /** The tree as the codec reads it. */
  contents(): Map<string, FileContent> {
    return new Map([...this.files.entries()].sort(([a], [b]) => codePointCompare(a, b)));
  }

  text(path: string): string | undefined {
    const content = this.files.get(path);
    return typeof content === 'string' ? content : undefined;
  }

  json<T>(path: string): T | undefined {
    const text = this.text(path);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  /** Write a file's text; true when it changed. */
  write(path: string, text: string): boolean {
    if (this.files.get(path) === text) return false;
    this.files.set(path, text);
    return true;
  }

  writeJson(path: string, value: unknown): boolean {
    return this.write(path, canonicalJson(value));
  }

  writeBinary(path: string, bytes: Uint8Array): string {
    const sha = sha256Hex(bytes);
    this.bytes.set(sha, bytes);
    this.files.set(path, { blob: sha, size: bytes.length });
    return sha;
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Every path under a directory prefix (`data/designs/_versions/x/`). */
  under(prefix: string): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort(codePointCompare);
  }

  /** The tree as a snapshot the read stores understand. */
  view(): Snapshot {
    const blobOf = new Map<string, string>();
    for (const [path, content] of this.files) if (isBlobRef(content) && !path.startsWith('data/assets/')) blobOf.set(path, content.blob);
    // rows and files are not read by the stores
    return { version: 'tree', rows: undefined as never, files: this.files, source: this.source, catalog: this.catalog, blobOf, loadMs: 0 };
  }
}

/** A blob store that answers a tree's new bytes first, then the real store. */
function treeBlobs(tree: CatalogTree, orgId: string, blobs: BlobStore | undefined): BlobStore {
  const shaOf = (key: string): string => key.slice(key.lastIndexOf('/') + 1);
  return {
    describe: 'the commit tree',
    get: async (key) => {
      const own = tree.bytes.get(shaOf(key));
      if (own !== undefined) return Buffer.from(own);
      return blobs?.get(key);
    },
    has: async (key) => tree.bytes.has(shaOf(key)) || ((await blobs?.has(key)) ?? false),
    put: async () => {
      throw new Error('the commit tree takes bytes through its stores');
    },
    delete: async () => {
      throw new Error('the commit tree never deletes blobs');
    },
  };
  void orgId;
}

/**
 * Every store over the tree, read and write: what `commitChangeSet` applies
 * a change set through on Postgres.
 */
export function treeWorkbenchDeps(tree: CatalogTree, options: { orgId: string; blobs?: BlobStore; modules?: ModuleRegistry }): WorkbenchDeps {
  const context: PgReadContext = { snapshot: async () => tree.view(), blobs: treeBlobs(tree, options.orgId, options.blobs), orgId: options.orgId };
  const assetsRead = pgAssetStore(context);
  const assetIndex = (): AssetSummary[] => tree.json<AssetSummary[]>('data/assets/index.json') ?? [];
  const putAsset = (bytes: Uint8Array, mime: AssetSummary['mime'], originalName: string, src: string): AssetSummary => {
    const id = sha256Hex(bytes);
    const records = assetIndex();
    const existing = records.find((r) => r.id === id);
    if (existing !== undefined) return existing;
    const record: AssetSummary = { id, mime, originalName, src, bytes: bytes.length };
    tree.writeBinary(`data/assets/${id}.${ASSET_MIME_EXT[mime]}`, bytes);
    tree.writeJson('data/assets/index.json', [...records, record].sort((a, b) => codePointCompare(a.id, b.id)));
    return record;
  };
  const assets = { ...assetsRead, put: (bytes: Buffer, mime: AssetSummary['mime'], originalName: string, src: string) => putAsset(new Uint8Array(bytes), mime, originalName, src) };

  const designPath = (id: string): string => `data/designs/${id}.json`;
  const drawing = (id: string): { meta: string; ref: string; legacy: string[] } => ({
    meta: `data/drawings/${id}.json`,
    ref: `data/drawings/${id}.photo-ref.json`,
    legacy: [`data/drawings/${id}.photo.png`, `data/drawings/${id}.photo.jpg`],
  });
  const versionsDir = (id: string): string => `data/designs/_versions/${id}/`;
  const numbered = (prefix: string): number[] =>
    tree
      .under(prefix)
      .map((p) => /^(\d+)\.json$/.exec(p.slice(prefix.length))?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);

  const regenerateTags = (): boolean => {
    const review = tree.json<TagReview>('data/tags/review.json');
    if (review === undefined) throw new Error('the catalog has no tags/review.json');
    const c = tree.catalog;
    const out = buildTags({ vocab: c.loadVocab(), connectors: c.loadConnectors(), pcbas: c.loadPcbas(), wires: c.loadWires(), designs: c.loadDesigns(), review });
    const a = tree.writeJson('data/tags/signal-tags.json', out.tags);
    const b = tree.writeJson('data/tags/instance-slots.json', out.slots);
    const d = tree.write('data/tags/report.md', out.report);
    return a || b || d;
  };

  const docs: DocStore = {
    read: (path) => {
      const text = tree.text(path);
      return text === undefined ? undefined : parseDoc(path, text);
    },
    write: (path, value) => {
      if (!isDocPath(path)) throw new Error(`'${path}' is not a catalog document path`);
      tree.write(path, formatDoc(path, value));
    },
    remove: (path) => tree.remove(path),
  };

  const depictionMeta = (defId: string): string => {
    if (!DEF_ID.test(defId)) throw new Error(`'${defId}' is not a usable definition id`);
    return `depictions/${defId}/meta.json`;
  };
  const depictions: DepictionStore = {
    listDefIds: () =>
      [...new Set(tree.under('depictions/').filter((p) => p.endsWith('/meta.json')).map((p) => p.split('/')[1] as string))].sort(),
    readMeta: (defId) => tree.json<Record<string, unknown>>(depictionMeta(defId)),
    writeMeta: (defId, meta) => void tree.write(depictionMeta(defId), `${JSON.stringify(meta, null, 2)}\n`),
    readAsset: async (defId, file) => {
      const content = tree.files.get(`depictions/${defId}/${file}`);
      if (content === undefined) return undefined;
      if (typeof content === 'string') return new TextEncoder().encode(content);
      const bytes = await context.blobs?.get(blobObjectKey(options.orgId, content.blob));
      return bytes === undefined ? undefined : new Uint8Array(bytes);
    },
    writeAsset: (defId, file, content) => {
      depictionMeta(defId);
      tree.writeBinary(`depictions/${defId}/${file}`, typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content));
    },
    dirFor: () => undefined,
    readBoardMap: (defId) => {
      const value = docs.read(`data/kicad-maps/${defId}.json`);
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    },
    writeBoardMap: (defId, map) => docs.write(`data/kicad-maps/${defId}.json`, map),
  };

  const modelsFile = (): { src: string; links: ModelLink[] } => {
    const file = tree.json<{ src?: string; links?: ModelLink[] }>('data/models.json');
    return { src: file?.src ?? MODELS_FILE_SRC, links: Array.isArray(file?.links) ? file.links : [] };
  };
  const writeModels = (file: { src: string; links: ModelLink[] }): void => void tree.writeJson('data/models.json', { src: file.src, links: sortLinks(file.links) });

  // a module's derived records, over the tree being committed (module-derived.ts)
  const derived = moduleDerivedStore(options.modules, { loadDb: () => tree.catalog.loadDb(), loadDesigns: () => tree.catalog.loadDesigns(), docs });

  return {
    ...(derived === undefined ? {} : { derived }),
    designs: {
      ...pgDesignStore(context),
      write: (id: string, design: CableDesign) => ({ changed: tree.writeJson(designPath(id), design) }),
      remove: (id: string) => tree.remove(designPath(id)),
    },
    definitions: {
      ...pgDefinitionStore(context),
      write: (kind, records) => {
        const c = tree.catalog;
        const stored =
          kind === 'connectors'
            ? (records as ConnectorDefinition[]).map((r) => decomposeConnector(r, { bodies: c.loadBodies(), interfaces: c.loadInterfaces(), vocab: c.loadVocab() }))
            : records;
        return { changed: tree.writeJson(`data/${kind}.json`, stored as DefinitionRecord[]) };
      },
    },
    drawings: {
      ...pgDrawingStore(context, assets),
      writeMeta: (id, meta) => void tree.writeJson(drawing(id).meta, meta),
      writePhoto: (id, photo) => {
        const paths = drawing(id);
        for (const legacy of paths.legacy) tree.remove(legacy);
        if (photo === undefined) {
          tree.remove(paths.ref);
          return;
        }
        const ext = photo.mime === 'image/png' ? 'png' : 'jpg';
        const record = putAsset(new Uint8Array(photo.bytes), photo.mime, `${id}.${ext}`, `Product photo for the ${id} drawing sheet.`);
        tree.writeJson(paths.ref, { assetId: record.id });
      },
      move: (from, to) => {
        if (from === to) return;
        const [a, b] = [drawing(from), drawing(to)];
        const pairs: [string, string][] = [[a.meta, b.meta], [a.ref, b.ref], [a.legacy[0] as string, b.legacy[0] as string], [a.legacy[1] as string, b.legacy[1] as string]];
        for (const [x, y] of pairs) {
          const content = tree.files.get(x);
          if (content === undefined) continue;
          tree.files.set(y, content);
          tree.remove(x);
        }
      },
      remove: (id) => {
        const paths = drawing(id);
        for (const p of [paths.meta, paths.ref, ...paths.legacy]) tree.remove(p);
      },
    },
    assets,
    modelLinks: {
      ...pgModelLinkStore(context),
      put: (link) => {
        const file = modelsFile();
        writeModels({ ...file, links: [...file.links.filter((l) => l.record !== link.record), link] });
      },
      remove: (record) => {
        const file = modelsFile();
        const kept = file.links.filter((l) => l.record !== record);
        if (kept.length === file.links.length) return false;
        writeModels({ ...file, links: kept });
        return true;
      },
    },
    vocab: {
      ...pgVocabStore(context),
      write: (list) => {
        if (!LIST_ID.test(list.id) || !tree.has(`data/vocab/${list.id}.json`)) throw new Error(`'${list.id}' is not a vocab list`);
        tree.writeJson(`data/vocab/${list.id}.json`, list);
      },
    },
    tags: {
      ...pgTagStore(context),
      writeReview: (review) => void tree.writeJson('data/tags/review.json', review),
      regenerate: regenerateTags,
    },
    wireLibrary: {
      ...pgWireLibraryStore(context),
      writeParts: (parts) => void tree.writeJson('data/wire-parts.json', parts),
      writeRecipes: (recipes) => void tree.writeJson('data/wire-recipes.json', recipes),
      putWire: (wire) => {
        const stocks = tree.json<WireDefinition[]>('data/wires.json');
        if (stocks === undefined) throw new Error('the catalog has no wires.json');
        const at = stocks.findIndex((s) => s.id === wire.id);
        tree.writeJson('data/wires.json', at === -1 ? [...stocks, wire] : stocks.map((s, i) => (i === at ? wire : s)));
      },
    },
    builds: {
      ...pgBuildsStore(context),
      write: (name, file) => {
        if (!LIST_ID.test(name)) throw new Error(`'${name}' is not a build file name`);
        tree.writeJson(`data/builds/${name}.json`, file);
      },
    },
    versions: {
      ...pgVersionStore(context),
      // today's artwork is the database's own depiction tree (B7)
      snapshotArtwork: (defIds) => artworkSnapshot(context, defIds),
      write: (file: DesignVersionFile) => void tree.write(`${versionsDir(file.designId)}${file.rev}.json`, formatVersionJson(file)),
      setWorking: (id, state) => void tree.writeJson(`${versionsDir(id)}working.json`, state.basedOnRev === undefined ? {} : { basedOnRev: state.basedOnRev }),
      addDraft: (id, draft: DraftFile) => {
        const taken = numbered(`${versionsDir(id)}drafts/`);
        const n = taken.length === 0 ? 1 : Math.max(...taken) + 1;
        tree.writeJson(`${versionsDir(id)}drafts/${n}.json`, draft);
        return n;
      },
      removeDraft: (id, n) => tree.remove(`${versionsDir(id)}drafts/${n}.json`),
      move: (from, to) => {
        if (from === to) return;
        const [a, b] = [versionsDir(from), versionsDir(to)];
        const paths = tree.under(a);
        if (paths.length === 0) return;
        for (const p of tree.under(b)) tree.remove(p);
        for (const p of paths) {
          const rest = p.slice(a.length);
          const content = tree.files.get(p) as string | BlobRef;
          tree.remove(p);
          if (/^\d+\.json$/.test(rest) && typeof content === 'string') {
            // the snapshots name their design; a renamed cable's history follows it
            const file = JSON.parse(content) as DesignVersionFile;
            tree.write(`${b}${rest}`, formatVersionJson({ ...file, designId: to, design: { ...file.design, id: to } }));
          } else tree.files.set(`${b}${rest}`, content);
        }
      },
      writeArtwork: (id, blobs) => {
        for (const name of Object.keys(blobs).sort()) {
          if (!/^[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(name)) continue;
          const path = `${versionsDir(id)}artwork/${name}`;
          if (!tree.has(path)) tree.writeBinary(path, blobs[name] as Uint8Array);
        }
      },
    },
    depictions,
    docs,
    blob: async (sha) => {
      const path = [...tree.files.entries()].find(([, c]) => isBlobRef(c) && c.blob === sha)?.[0];
      if (path === undefined) return undefined;
      const bytes = await context.blobs?.get(blobObjectKey(options.orgId, sha));
      return bytes === undefined ? undefined : { bytes: new Uint8Array(bytes), mediaType: mediaTypeOf(path) };
    },
    loadDb: () => tree.catalog.loadDb(),
  };
}
