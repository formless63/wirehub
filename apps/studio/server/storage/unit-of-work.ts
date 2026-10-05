/**
 * The unit of work (storage seams; `specs/storage-seam.md`).
 *
 * One per request:
 *
 * 1. **Snapshot.** `deps.loadDb()` answers from a catalog snapshot cached by
 *    catalog version (`deps.catalogVersion`), loaded at most once per request.
 * 2. **Run.** The handler runs the existing pure core logic against *staged*
 *    stores: the same store interfaces, reading through to the backend, but
 *    every write lands in the change set (and is read back from it — a
 *    handler sees its own writes) instead of in storage.
 * 3. **Commit.** If the handler answered < 400 and staged anything, the whole
 *    change set is committed in one step: every precondition checked first
 *    (a record read and then changed underneath the request refuses the whole
 *    set), then every change applied in order through the backend's own
 *    stores, then the derived records recomputed. A handler that refuses (4xx)
 *    writes nothing, by construction.
 *
 * `commitChangeSet` applies a set through any `WorkbenchDeps` whose stores
 * persist — the file stores today, in-memory stores in tests, a Postgres
 * backend's stores later (inside its transaction).
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { CableDesign, Db, SignalTags, WireDefinition } from '@wirehub/model';

import type { WorkbenchDeps } from '../api.ts';
import type { AssetMime, AssetSummary, AssetStore } from '../assets.ts';
import type { BuildsStore } from '../builds.ts';
import type { DefinitionKind, DefinitionRecord, DefinitionStore } from '../definition-store.ts';
import type { DesignStore, DesignSummary } from '../designs.ts';
import type { DrawingStore, StoredDrawing } from '../drawings.ts';
import { contentETag } from '../etag.ts';
import type { DraftFile, DraftSummary, VersionStore, WorkingState } from '../versions.ts';
import type { TagStore, VocabStore } from '../vocab-store.ts';
import type { TagReview } from '@wirehub/catalog/src/tags/build.ts';
import type { WireLibraryStore } from '../wire-library.ts';
import { sortLinks, type ModelLink, type ModelLinkStore } from '../models/links.ts';
import type { DepictionStore } from '../depictions.ts';
import { isCatalogFilePath, isDocPath, type CatalogFileStore, type DocStore } from './doc-store.ts';
import { StaleRecordError, type ChangeSet, type CommitResult, type DerivedKind, type RecordChange, type RecordKind } from './change-set.ts';

const ref = (kind: RecordKind, key: string): string => `${kind}\u0000${key}`;
const clone = <T>(value: T): T => structuredClone(value);
const versionOf = (value: unknown): string | null => (value === undefined ? null : contentETag(value));
/** the version of a binary record: its sha256 (an ETag of the bytes as JSON would be large and slow) */
const bytesVersion = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/* ------------------------------------------------------------------ *
 * Catalog snapshot, cached by catalog version
 * ------------------------------------------------------------------ */

let cachedDb: { loader: WorkbenchDeps['loadDb']; version: string; db: Db } | undefined;

/** The db for one request: the backend's, reused across requests while the catalog version holds. */
async function snapshotDb(deps: WorkbenchDeps): Promise<Db> {
  const version = deps.catalogVersion === undefined ? undefined : await deps.catalogVersion();
  if (version === undefined) return await deps.loadDb();
  if (cachedDb?.version !== version || cachedDb.loader !== deps.loadDb) cachedDb = { loader: deps.loadDb, version, db: await deps.loadDb() };
  // each request gets its own copy: nothing a handler does can leak into the next one
  return clone(cachedDb.db);
}

/* ------------------------------------------------------------------ *
 * The unit of work
 * ------------------------------------------------------------------ */

export class UnitOfWork {
  readonly changes: RecordChange[] = [];
  /** what this request read, record by record: the version its writes are conditional on */
  private readonly seen = new Map<string, string | null>();
  /** derived records a handler asked for explicitly (`TagStore.regenerate`) */
  readonly derive = new Set<DerivedKind>();
  readonly deps: WorkbenchDeps;
  private db: Promise<Db> | undefined;

  readonly base: WorkbenchDeps;

  constructor(base: WorkbenchDeps) {
    this.base = base;
    const staged: WorkbenchDeps = {
      ...base,
      loadDb: async () => this.withStagedDefinitions(await (this.db ??= snapshotDb(base))),
    };
    if (base.designs !== undefined) staged.designs = this.designs(base.designs);
    if (base.definitions !== undefined) staged.definitions = this.definitions(base.definitions);
    if (base.assets !== undefined) staged.assets = this.assets(base.assets);
    if (base.drawings !== undefined) staged.drawings = this.drawings(base.drawings);
    if (base.vocab !== undefined) staged.vocab = this.vocab(base.vocab);
    if (base.tags !== undefined) staged.tags = this.tags(base.tags);
    if (base.wireLibrary !== undefined) staged.wireLibrary = this.wireLibrary(base.wireLibrary);
    if (base.builds !== undefined) staged.builds = this.builds(base.builds);
    if (base.versions !== undefined) staged.versions = this.versions(base.versions);
    if (base.modelLinks !== undefined) staged.modelLinks = this.modelLinks(base.modelLinks);
    if (base.docs !== undefined) staged.docs = this.docs(base.docs);
    if (base.files !== undefined) staged.files = this.files();
    if (base.depictions !== undefined) staged.depictions = this.depictions(base.depictions, staged.docs);
    this.deps = staged;
  }

  /**
   * The request's db with the definitions this unit has staged laid in, so a later
   * request of one batch (an import's design after its new connectors and stocks)
   * validates against them. Records new in this unit are appended as written; a
   * record the snapshot already has keeps its (composed) snapshot form.
   */
  private withStagedDefinitions(db: Db): Db {
    let out: Db | undefined;
    for (const kind of ['connectors', 'wires', 'components', 'pcbas', 'mechanicals'] as const) {
      const s = this.staged<{ id: string }[]>('definitions', kind);
      if (!s.found || s.value === undefined) continue;
      const have = new Set((db[kind] ?? []).map((r) => r.id));
      const added = s.value.filter((r) => !have.has(r.id));
      if (added.length === 0) continue;
      out ??= { ...db };
      (out as unknown as Record<string, unknown>)[kind] = [...(db[kind] ?? []), ...added];
    }
    return out ?? db;
  }

  /* ----------------------------- staging ----------------------------- */

  /** Remember the version of a record the first time this request reads it. */
  private observe(kind: RecordKind, key: string, value: unknown): void {
    const k = ref(kind, key);
    if (!this.seen.has(k)) this.seen.set(k, versionOf(value));
  }

  private stage(change: Omit<RecordChange, 'expect'>): void {
    const k = ref(change.kind, change.key);
    const expect = this.seen.get(k);
    this.changes.push({ ...change, ...(expect === undefined ? {} : { expect }) });
  }

  /** The last staged change to a record, if any. */
  private latest(kind: RecordKind, key: string): RecordChange | undefined {
    for (let i = this.changes.length - 1; i >= 0; i -= 1) {
      const c = this.changes[i] as RecordChange;
      if (c.kind === kind && c.key === key) return c;
    }
    return undefined;
  }

  /** Staged value: `{ found: true, value }` (value `undefined` = deleted) or `{ found: false }` = read through. */
  private staged<T>(kind: RecordKind, key: string): { found: true; value: T | undefined } | { found: false } {
    const c = this.latest(kind, key);
    if (c === undefined) return { found: false };
    return { found: true, value: c.op === 'put' ? clone(c.value as T) : undefined };
  }

  private stagedKeys(kind: RecordKind): Map<string, RecordChange> {
    const out = new Map<string, RecordChange>();
    for (const c of this.changes) if (c.kind === kind) out.set(c.key, c);
    return out;
  }

  get changeSet(): RecordChange[] {
    return this.changes;
  }

  /* ------------------------------ stores ----------------------------- */

  private designs(base: DesignStore): DesignStore {
    const read = async (id: string): Promise<CableDesign | undefined> => {
      const s = this.staged<CableDesign>('design', id);
      if (s.found) return s.value;
      const value = await base.read(id);
      this.observe('design', id, value);
      return value;
    };
    return {
      list: async () => {
        const rows = new Map<string, DesignSummary>((await base.list()).map((row) => [row.id, row]));
        for (const [id, c] of this.stagedKeys('design')) {
          if (c.op === 'put') rows.set(id, { id, label: (c.value as CableDesign).label });
          else rows.delete(id);
        }
        return [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      },
      has: async (id) => {
        const s = this.staged<CableDesign>('design', id);
        return s.found ? s.value !== undefined : await base.has(id);
      },
      read,
      write: async (id, design) => {
        const current = await read(id);
        if (current !== undefined && isDeepStrictEqual(current, design)) return { changed: false };
        this.stage({ kind: 'design', key: id, op: 'put', value: clone(design) });
        return { changed: true };
      },
      remove: async (id) => {
        await read(id);
        this.stage({ kind: 'design', key: id, op: 'delete' });
      },
    };
  }

  private definitions(base: DefinitionStore): DefinitionStore {
    const list = async (kind: DefinitionKind): Promise<DefinitionRecord[]> => {
      const s = this.staged<DefinitionRecord[]>('definitions', kind);
      if (s.found) return s.value ?? [];
      const value = await base.list(kind);
      this.observe('definitions', kind, value);
      return value;
    };
    return {
      list,
      write: async (kind, records) => {
        if (isDeepStrictEqual(await list(kind), records)) return { changed: false };
        this.stage({ kind: 'definitions', key: kind, op: 'put', value: clone(records) });
        return { changed: true };
      },
    };
  }

  private assets(base: AssetStore): AssetStore {
    const stagedAsset = (id: string): { record: AssetSummary; bytes: Buffer } | undefined => {
      const c = this.latest('asset', id);
      if (c?.op !== 'put' || c.bytes === undefined) return undefined;
      return { record: c.value as AssetSummary, bytes: Buffer.from(c.bytes) };
    };
    return {
      list: async () => {
        const rows = await base.list();
        const ids = new Set(rows.map((r) => r.id));
        for (const [id, c] of this.stagedKeys('asset')) if (c.op === 'put' && !ids.has(id)) rows.push(c.value as AssetSummary);
        return rows;
      },
      get: async (id) => stagedAsset(id) ?? (await base.get(id)),
      put: async (bytes, mime: AssetMime, originalName, src) => {
        const id = createHash('sha256').update(bytes).digest('hex');
        const existing = stagedAsset(id)?.record ?? (await base.get(id))?.record;
        if (existing !== undefined) return existing;
        const record: AssetSummary = { id, mime, originalName, src, bytes: bytes.byteLength };
        this.stage({ kind: 'asset', key: id, op: 'put', value: record, bytes: new Uint8Array(bytes) });
        return record;
      },
    };
  }

  private drawings(base: DrawingStore): DrawingStore {
    /** where a design's drawing lives now, following staged renames */
    const origin = (id: string): string | undefined => {
      let key: string | undefined = id;
      for (let i = this.changes.length - 1; i >= 0; i -= 1) {
        const c = this.changes[i] as RecordChange;
        if (c.kind !== 'drawing' || c.op !== 'move') continue;
        if (c.to === key) key = c.key;
        else if (c.key === key) return undefined;
      }
      return key;
    };
    const read = async (id: string): Promise<StoredDrawing> => {
      const from = origin(id);
      const stored = from === undefined ? { meta: {} } : await base.read(from);
      if (from === id) this.observe('drawing', id, stored.meta);
      let meta = stored.meta;
      let photo = stored.photo;
      const m = this.latest('drawing', id);
      if (m?.op === 'put') meta = clone(m.value as StoredDrawing['meta']);
      if (m?.op === 'delete') {
        meta = {};
        photo = undefined;
      }
      const p = this.latest('drawing-photo', id);
      if (p !== undefined && (m === undefined || this.changes.indexOf(p) > this.changes.indexOf(m))) {
        photo = p.op === 'put' && p.bytes !== undefined ? `data:${(p.value as { mime: string }).mime};base64,${Buffer.from(p.bytes).toString('base64')}` : undefined;
      }
      return photo === undefined ? { meta } : { meta, photo };
    };
    return {
      read,
      writeMeta: async (id, meta) => {
        await read(id);
        this.stage({ kind: 'drawing', key: id, op: 'put', value: clone(meta) });
      },
      writePhoto: async (id, photo) => {
        await read(id);
        if (photo === undefined) this.stage({ kind: 'drawing-photo', key: id, op: 'delete' });
        else this.stage({ kind: 'drawing-photo', key: id, op: 'put', value: { mime: photo.mime }, bytes: new Uint8Array(photo.bytes) });
      },
      move: async (from, to) => {
        if (from !== to) this.stage({ kind: 'drawing', key: from, op: 'move', to });
      },
      remove: async (id) => {
        this.stage({ kind: 'drawing', key: id, op: 'delete' });
      },
    };
  }

  private modelLinks(base: ModelLinkStore): ModelLinkStore {
    const get = async (record: string): Promise<ModelLink | undefined> => {
      const s = this.staged<ModelLink>('model-link', record);
      if (s.found) return s.value;
      const value = await base.get(record);
      this.observe('model-link', record, value);
      return value === undefined ? undefined : clone(value);
    };
    return {
      list: async () => {
        const rows = new Map((await base.list()).map((l) => [l.record, l] as const));
        for (const [record, c] of this.stagedKeys('model-link')) {
          if (c.op === 'put') rows.set(record, clone(c.value as ModelLink));
          else rows.delete(record);
        }
        return sortLinks([...rows.values()]);
      },
      get,
      put: async (link) => {
        await get(link.record);
        this.stage({ kind: 'model-link', key: link.record, op: 'put', value: clone(link) });
      },
      remove: async (record) => {
        const current = await get(record);
        if (current === undefined) return false;
        this.stage({ kind: 'model-link', key: record, op: 'delete' });
        return true;
      },
    };
  }

  private docs(base: DocStore): DocStore {
    const read = async (path: string): Promise<unknown> => {
      const s = this.staged<unknown>('doc', path);
      if (s.found) return s.value;
      const value = await base.read(path);
      this.observe('doc', path, value);
      return value;
    };
    return {
      read,
      write: async (path, value) => {
        if (!isDocPath(path)) throw new Error(`'${path}' is not a catalog document path`);
        await read(path);
        this.stage({ kind: 'doc', key: path, op: 'put', value: clone(value) });
      },
      remove: async (path) => {
        await read(path);
        this.stage({ kind: 'doc', key: path, op: 'delete' });
      },
    };
  }

  private files(): CatalogFileStore {
    return {
      write: (path, bytes) => {
        if (!isCatalogFilePath(path)) throw new Error(`'${path}' is not a catalog file path`);
        this.stage({ kind: 'catalog-file', key: path, op: 'put', bytes: new Uint8Array(bytes) });
      },
      remove: (path) => {
        if (!isCatalogFilePath(path)) throw new Error(`'${path}' is not a catalog file path`);
        this.stage({ kind: 'catalog-file', key: path, op: 'delete' });
      },
    };
  }

  private depictions(base: DepictionStore, docs: DocStore | undefined): DepictionStore {
    const readMeta = async (defId: string): Promise<Record<string, unknown> | undefined> => {
      const s = this.staged<Record<string, unknown>>('depiction-meta', defId);
      if (s.found) return s.value;
      const value = await base.readMeta(defId);
      this.observe('depiction-meta', defId, value);
      return value === undefined ? undefined : clone(value);
    };
    const stagedAsset = (defId: string, file: string): RecordChange | undefined => this.latest('depiction-asset', `${defId}/${file}`);
    const store: DepictionStore = {
      listDefIds: async () => {
        const ids = new Set(await base.listDefIds());
        for (const [defId, c] of this.stagedKeys('depiction-meta')) if (c.op === 'put') ids.add(defId);
        return [...ids].sort();
      },
      readMeta,
      writeMeta: async (defId, meta) => {
        await readMeta(defId);
        this.stage({ kind: 'depiction-meta', key: defId, op: 'put', value: clone(meta) });
      },
      readAsset: async (defId, file) => {
        const c = stagedAsset(defId, file);
        if (c !== undefined) return c.op === 'put' && c.bytes !== undefined ? new Uint8Array(c.bytes) : undefined;
        const bytes = await base.readAsset(defId, file);
        this.observe('depiction-asset', `${defId}/${file}`, bytes === undefined ? undefined : bytesVersion(bytes));
        return bytes;
      },
      writeAsset: async (defId, file, content) => {
        if (stagedAsset(defId, file) === undefined) await store.readAsset(defId, file);
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
        this.stage({ kind: 'depiction-asset', key: `${defId}/${file}`, op: 'put', bytes });
      },
      // a directory on disk does not hold staged files yet: no directory to check them in
      ...(base.removeAsset === undefined
        ? {}
        : {
            removeAsset: async (defId: string, file: string) => {
              if (file === 'meta.json') {
                await readMeta(defId);
                this.stage({ kind: 'depiction-meta', key: defId, op: 'delete' });
                return;
              }
              if (stagedAsset(defId, file) === undefined) await store.readAsset(defId, file);
              this.stage({ kind: 'depiction-asset', key: `${defId}/${file}`, op: 'delete' });
            },
          }),
      dirFor: (defId) => ([...this.stagedKeys('depiction-asset').keys()].some((k) => k.startsWith(`${defId}/`)) ? undefined : base.dirFor(defId)),
    };
    // the reviewed board maps are catalog documents (data/kicad-maps/<def>.json)
    if (docs !== undefined) {
      store.readBoardMap = async (defId) => {
        const value = await docs.read(`data/kicad-maps/${defId}.json`);
        return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
      };
      store.writeBoardMap = (defId, map) => docs.write(`data/kicad-maps/${defId}.json`, map);
    } else {
      if (base.readBoardMap !== undefined) store.readBoardMap = (defId) => (base.readBoardMap as NonNullable<DepictionStore['readBoardMap']>)(defId);
      if (base.writeBoardMap !== undefined) store.writeBoardMap = (defId, map) => (base.writeBoardMap as NonNullable<DepictionStore['writeBoardMap']>)(defId, map);
    }
    return store;
  }

  private vocab(base: VocabStore): VocabStore {
    const read: VocabStore['read'] = async (list) => {
      const s = this.staged<Awaited<ReturnType<VocabStore['read']>>>('vocab', list);
      if (s.found) return s.value;
      const value = await base.read(list);
      this.observe('vocab', list, value);
      return value;
    };
    return {
      ids: () => base.ids(),
      read,
      write: async (list) => {
        await read(list.id);
        this.stage({ kind: 'vocab', key: list.id, op: 'put', value: clone(list) });
      },
    };
  }

  private tags(base: TagStore): TagStore {
    const review = async (): Promise<TagReview> => {
      const s = this.staged<TagReview>('tag-review', 'review');
      if (s.found && s.value !== undefined) return s.value;
      const value = await base.review();
      this.observe('tag-review', 'review', value);
      return value;
    };
    return {
      tags: async (): Promise<SignalTags> => {
        // a staged review answers with the table it will derive at commit
        const s = this.staged<TagReview>('tag-review', 'review');
        if (s.found && s.value !== undefined && base.preview !== undefined) return await base.preview(s.value);
        return await base.tags();
      },
      review,
      writeReview: async (next) => {
        await review();
        this.stage({ kind: 'tag-review', key: 'review', op: 'put', value: clone(next) });
      },
      regenerate: () => {
        this.derive.add('tags');
        return true;
      },
      ...(base.preview === undefined ? {} : { preview: (r: TagReview) => (base.preview as NonNullable<TagStore['preview']>)(r) }),
    };
  }

  private wireLibrary(base: WireLibraryStore): WireLibraryStore {
    const part = async <T>(key: 'parts' | 'recipes', load: () => Promise<T>): Promise<T> => {
      const s = this.staged<T>('wire-library', key);
      if (s.found && s.value !== undefined) return s.value;
      const value = await load();
      this.observe('wire-library', key, value);
      return value;
    };
    return {
      read: async () => {
        const stored = await base.read();
        return {
          parts: await part('parts', async () => stored.parts),
          recipes: await part('recipes', async () => stored.recipes),
        };
      },
      writeParts: async (parts) => {
        await part('parts', async () => (await base.read()).parts);
        this.stage({ kind: 'wire-library', key: 'parts', op: 'put', value: clone(parts) });
      },
      ...(base.practice === undefined ? {} : { practice: () => (base.practice as NonNullable<WireLibraryStore['practice']>)() }),
      writeRecipes: async (recipes) => {
        await part('recipes', async () => (await base.read()).recipes);
        this.stage({ kind: 'wire-library', key: 'recipes', op: 'put', value: clone(recipes) });
      },
      wires: async () => {
        const rows: WireDefinition[] = await base.wires();
        for (const w of rows) this.observe('wire', w.id, w);
        for (const [id, c] of this.stagedKeys('wire')) {
          const at = rows.findIndex((w) => w.id === id);
          if (at === -1) rows.push(clone(c.value as WireDefinition));
          else rows[at] = clone(c.value as WireDefinition);
        }
        return rows;
      },
      putWire: async (wire) => {
        const current = (await base.wires()).find((w) => w.id === wire.id);
        this.observe('wire', wire.id, current);
        this.stage({ kind: 'wire', key: wire.id, op: 'put', value: clone(wire) });
      },
    };
  }

  private builds(base: BuildsStore): BuildsStore {
    const read: BuildsStore['read'] = async (name) => {
      const s = this.staged<Awaited<ReturnType<BuildsStore['read']>>>('builds', name);
      if (s.found) return s.value;
      const value = await base.read(name);
      this.observe('builds', name, value);
      return value;
    };
    return {
      list: async () => {
        const rows = new Map((await base.list()).map((row) => [row.name, row]));
        for (const [name, c] of this.stagedKeys('builds')) if (c.op === 'put') rows.set(name, { name, file: clone(c.value) as never });
        return [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      },
      read,
      write: async (name, file) => {
        await read(name);
        this.stage({ kind: 'builds', key: name, op: 'put', value: clone(file) });
      },
    };
  }

  private versions(base: VersionStore): VersionStore {
    const byDesign = (kind: RecordKind, id: string): Map<number, RecordChange> => {
      const out = new Map<number, RecordChange>();
      for (const [key, c] of this.stagedKeys(kind)) {
        const slash = key.lastIndexOf('/');
        if (key.slice(0, slash) === id) out.set(Number(key.slice(slash + 1)), c);
      }
      return out;
    };
    const read: VersionStore['read'] = async (id, rev) => {
      const s = this.staged<Awaited<ReturnType<VersionStore['read']>>>('design-version', `${id}/${rev}`);
      if (s.found) return s.value;
      const value = await base.read(id, rev);
      this.observe('design-version', `${id}/${rev}`, value);
      return value;
    };
    const working: VersionStore['working'] = async (id) => {
      const s = this.staged<WorkingState>('version-working', id);
      if (s.found && s.value !== undefined) return s.value;
      const value = await base.working(id);
      this.observe('version-working', id, value);
      return value;
    };
    const drafts = async (id: string): Promise<DraftSummary[]> => {
      const rows = new Map((await base.drafts(id)).map((d) => [d.n, d]));
      for (const [n, c] of byDesign('version-draft', id)) {
        if (c.op === 'put') {
          const { design: _design, ...rest } = c.value as DraftFile;
          rows.set(n, { n, ...rest });
        } else rows.delete(n);
      }
      return [...rows.values()].sort((a, b) => a.n - b.n);
    };
    const store: VersionStore = {
      revisions: async (id) => {
        const revs = new Set(await base.revisions(id));
        for (const [rev, c] of byDesign('design-version', id)) if (c.op === 'put') revs.add(rev);
        return [...revs].sort((a, b) => a - b);
      },
      read,
      write: async (file) => {
        await read(file.designId, file.rev);
        this.stage({ kind: 'design-version', key: `${file.designId}/${file.rev}`, op: 'put', value: clone(file) });
      },
      working,
      setWorking: async (id, state) => {
        await working(id);
        this.stage({ kind: 'version-working', key: id, op: 'put', value: clone(state) });
      },
      drafts,
      readDraft: async (id, n) => {
        const s = this.staged<DraftFile>('version-draft', `${id}/${n}`);
        if (s.found) return s.value;
        return await base.readDraft(id, n);
      },
      addDraft: async (id, draft) => {
        const taken = (await drafts(id)).map((d) => d.n);
        const n = taken.length === 0 ? 1 : Math.max(...taken) + 1;
        this.observe('version-draft', `${id}/${n}`, undefined);
        this.stage({ kind: 'version-draft', key: `${id}/${n}`, op: 'put', value: clone(draft) });
        return n;
      },
      removeDraft: async (id, n) => {
        this.stage({ kind: 'version-draft', key: `${id}/${n}`, op: 'delete' });
      },
      move: async (from, to) => {
        if (from !== to) this.stage({ kind: 'design-versions', key: from, op: 'move', to });
      },
    };
    if (base.snapshotArtwork !== undefined) store.snapshotArtwork = (defIds) => (base.snapshotArtwork as NonNullable<VersionStore['snapshotArtwork']>)(defIds);
    if (base.writeArtwork !== undefined) {
      store.writeArtwork = async (id, blobs) => {
        for (const name of Object.keys(blobs).sort()) {
          this.stage({ kind: 'version-artwork', key: `${id}/${name}`, op: 'put', bytes: new Uint8Array(blobs[name] as Uint8Array) });
        }
      };
    }
    if (base.readArtworkBlob !== undefined) {
      store.readArtworkBlob = async (id, blob) => {
        const c = this.latest('version-artwork', `${id}/${blob}`);
        if (c?.op === 'put' && c.bytes !== undefined) return new Uint8Array(c.bytes);
        return await (base.readArtworkBlob as NonNullable<VersionStore['readArtworkBlob']>)(id, blob);
      };
    }
    return store;
  }

  /* ------------------------------ commit ----------------------------- */

  /** Commit what was staged, in one step. A no-op when nothing was. */
  async commit(context: ChangeSet['context']): Promise<CommitResult> {
    if (this.changes.length === 0 && this.derive.size === 0) return { applied: 0, derived: [] };
    const set: ChangeSet = { changes: this.changes, context };
    // a backend that commits in its own transaction (Postgres) brings `commit`; the file stores apply through themselves
    const result = this.base.commit !== undefined ? await this.base.commit(set, this.derive) : await commitChangeSet(this.base, set, this.derive);
    // what follows a commit (a model build to queue) never fails the request that made it
    if (this.base.afterCommit !== undefined) await Promise.resolve(this.base.afterCommit(set)).catch((error: unknown) => console.warn(`[jobs] after commit: ${error instanceof Error ? error.message : String(error)}`));
    return result;
  }
}

/* ------------------------------------------------------------------ *
 * Applying a change set through a backend's stores
 * ------------------------------------------------------------------ */

/**
 * The current value of one record, as the backend has it (a dry run's
 * "before"); binary records answer `{ sha256 }`. `unknown` when this host
 * keeps no such records.
 */
export async function currentValue(base: WorkbenchDeps, change: RecordChange): Promise<unknown> {
  const { kind, key } = change;
  const slash = key.lastIndexOf('/');
  const [head, tail] = [key.slice(0, slash), Number(key.slice(slash + 1))];
  switch (kind) {
    case 'design':
      return base.designs.read(key);
    case 'definitions':
      return base.definitions?.list(key as DefinitionKind);
    case 'drawing':
      return base.drawings === undefined ? undefined : (await base.drawings.read(key)).meta;
    case 'vocab':
      return base.vocab?.read(key);
    case 'tag-review':
      return base.tags?.review();
    case 'wire-library':
      return base.wireLibrary === undefined ? undefined : (await base.wireLibrary.read())[key as 'parts' | 'recipes'];
    case 'wire':
      return base.wireLibrary === undefined ? undefined : (await base.wireLibrary.wires()).find((w) => w.id === key);
    case 'builds':
      return base.builds?.read(key);
    case 'design-version':
      return base.versions?.read(head, tail);
    case 'version-working':
      return base.versions?.working(key);
    case 'version-draft':
      return base.versions?.readDraft(head, tail);
    case 'model-link':
      return base.modelLinks?.get(key);
    case 'depiction-meta':
      return base.depictions?.readMeta(key);
    case 'doc':
      return base.docs?.read(key);
    default:
      return undefined;
  }
}

/** The current version of one record, as the backend has it — for the preconditions. */
async function currentVersion(base: WorkbenchDeps, change: RecordChange): Promise<string | null | 'unknown'> {
  const { kind, key } = change;
  const slash = key.lastIndexOf('/');
  const [head, tail] = [key.slice(0, slash), Number(key.slice(slash + 1))];
  switch (kind) {
    case 'design':
      return versionOf(await base.designs.read(key));
    case 'definitions':
      return base.definitions === undefined ? 'unknown' : versionOf(await base.definitions.list(key as DefinitionKind));
    case 'drawing':
      return base.drawings === undefined ? 'unknown' : versionOf((await base.drawings.read(key)).meta);
    case 'vocab':
      return base.vocab === undefined ? 'unknown' : versionOf(await base.vocab.read(key));
    case 'tag-review':
      return base.tags === undefined ? 'unknown' : versionOf(await base.tags.review());
    case 'wire-library':
      return base.wireLibrary === undefined ? 'unknown' : versionOf((await base.wireLibrary.read())[key as 'parts' | 'recipes']);
    case 'wire':
      return base.wireLibrary === undefined ? 'unknown' : versionOf((await base.wireLibrary.wires()).find((w) => w.id === key));
    case 'builds':
      return base.builds === undefined ? 'unknown' : versionOf(await base.builds.read(key));
    case 'design-version':
      return base.versions === undefined ? 'unknown' : versionOf(await base.versions.read(head, tail));
    case 'version-working':
      return base.versions === undefined ? 'unknown' : versionOf(await base.versions.working(key));
    case 'version-draft':
      return base.versions === undefined ? 'unknown' : versionOf(await base.versions.readDraft(head, tail));
    case 'model-link':
      return base.modelLinks === undefined ? 'unknown' : versionOf(await base.modelLinks.get(key));
    case 'depiction-meta':
      return base.depictions === undefined ? 'unknown' : versionOf(await base.depictions.readMeta(key));
    case 'depiction-asset': {
      if (base.depictions === undefined) return 'unknown';
      const bytes = await base.depictions.readAsset(head, key.slice(slash + 1));
      return bytes === undefined ? null : versionOf(bytesVersion(bytes));
    }
    case 'doc':
      return base.docs === undefined ? 'unknown' : versionOf(await base.docs.read(key));
    default:
      return 'unknown';
  }
}

async function apply(base: WorkbenchDeps, change: RecordChange): Promise<void> {
  const { kind, key, op } = change;
  const slash = key.lastIndexOf('/');
  const [head, tail] = [key.slice(0, slash), key.slice(slash + 1)];
  const need = <T>(store: T | undefined): T => {
    if (store === undefined) throw new Error(`this host keeps no ${kind} records`);
    return store;
  };
  switch (kind) {
    case 'design':
      if (op === 'put') await base.designs.write(key, change.value as CableDesign);
      else await base.designs.remove(key);
      return;
    case 'definitions':
      await need(base.definitions).write(key as DefinitionKind, change.value as DefinitionRecord[]);
      return;
    case 'asset': {
      const summary = change.value as AssetSummary;
      await need(base.assets).put(Buffer.from(change.bytes as Uint8Array), summary.mime, summary.originalName, summary.src);
      return;
    }
    case 'drawing': {
      const drawings = need(base.drawings);
      if (op === 'put') await drawings.writeMeta(key, change.value as StoredDrawing['meta']);
      else if (op === 'move') await drawings.move(key, change.to as string);
      else await drawings.remove(key);
      return;
    }
    case 'drawing-photo':
      await need(base.drawings).writePhoto(
        key,
        op === 'put' ? { mime: (change.value as { mime: 'image/png' | 'image/jpeg' }).mime, bytes: Buffer.from(change.bytes as Uint8Array) } : undefined,
      );
      return;
    case 'vocab':
      await need(base.vocab).write(change.value as Parameters<VocabStore['write']>[0]);
      return;
    case 'tag-review':
      await need(base.tags).writeReview(change.value as TagReview);
      return;
    case 'wire-library':
      if (key === 'parts') await need(base.wireLibrary).writeParts(change.value as Parameters<WireLibraryStore['writeParts']>[0]);
      else await need(base.wireLibrary).writeRecipes(change.value as Parameters<WireLibraryStore['writeRecipes']>[0]);
      return;
    case 'wire':
      await need(base.wireLibrary).putWire(change.value as WireDefinition);
      return;
    case 'builds':
      await need(base.builds).write(key, change.value as Parameters<BuildsStore['write']>[1]);
      return;
    case 'design-version':
      await need(base.versions).write(change.value as Parameters<VersionStore['write']>[0]);
      return;
    case 'version-working':
      await need(base.versions).setWorking(key, change.value as WorkingState);
      return;
    case 'version-draft': {
      const versions = need(base.versions);
      if (op === 'delete') {
        await versions.removeDraft(head, Number(tail));
        return;
      }
      const n = await versions.addDraft(head, change.value as DraftFile);
      if (n !== Number(tail)) throw new StaleRecordError(kind, key);
      return;
    }
    case 'version-artwork':
      await need(need(base.versions).writeArtwork)(head, { [tail]: change.bytes as Uint8Array });
      return;
    case 'design-versions':
      await need(base.versions).move(key, change.to as string);
      return;
    case 'model-link':
      if (op === 'put') await need(base.modelLinks).put(change.value as ModelLink);
      else await need(base.modelLinks).remove(key);
      return;
    case 'depiction-meta':
      if (op === 'delete') await need(need(base.depictions).removeAsset)(key, 'meta.json');
      else await need(base.depictions).writeMeta(key, change.value as Record<string, unknown>);
      return;
    case 'depiction-asset':
      if (op === 'delete') await need(need(base.depictions).removeAsset)(head, tail);
      else await need(base.depictions).writeAsset(head, tail, change.bytes as Uint8Array);
      return;
    case 'catalog-file':
      if (op === 'put') await need(base.files).write(key, change.bytes as Uint8Array);
      else await need(base.files).remove(key);
      return;
    case 'doc':
      if (op === 'put') await need(base.docs).write(key, change.value);
      else await need(base.docs).remove(key);
      return;
  }
}

/** Which derived records a set of primary changes makes stale. */
export function derivedFor(changes: readonly RecordChange[]): DerivedKind[] {
  const kinds = new Set(changes.map((c) => c.kind));
  const out: DerivedKind[] = [];
  // the tag table: pins, pads and stock colours of the definitions, the reviewed fixes, and each design's instance slots
  if (['definitions', 'vocab', 'tag-review', 'wire', 'wire-library', 'design'].some((k) => kinds.has(k as RecordKind))) out.push('tags');
  // a module's derived records read designs, drawings and definitions
  if (['design', 'drawing', 'definitions', 'wire', 'wire-library', 'vocab', 'builds'].some((k) => kinds.has(k as RecordKind))) {
    out.push('module');
  }
  return out;
}

/**
 * Apply `set` through `base`'s stores: every precondition first (nothing is
 * written if one fails — `StaleRecordError`), then each change in order, then
 * the derived records the changes made stale (plus any `extra` a handler asked
 * for). The caller holds the write lock.
 */
export async function commitChangeSet(base: WorkbenchDeps, set: ChangeSet, extra: ReadonlySet<DerivedKind> = new Set()): Promise<CommitResult> {
  for (const change of set.changes) {
    if (change.expect === undefined) continue;
    const now = await currentVersion(base, change);
    if (now !== 'unknown' && now !== change.expect) throw new StaleRecordError(change.kind, change.key);
  }
  for (const change of set.changes) await apply(base, change);

  const wanted = new Set([...derivedFor(set.changes), ...extra]);
  const derived: DerivedKind[] = [];
  if (wanted.has('tags') && base.tags !== undefined) {
    await base.tags.regenerate();
    derived.push('tags');
  }
  if (wanted.has('module') && base.derived !== undefined) {
    // over a live registry the store exists with no module declaring a record: then nothing was derived
    if ((await base.derived.regenerate()).length > 0 || base.modules === undefined || base.modules.derived().length > 0) derived.push('module');
  }
  return { applied: set.changes.length, derived };
}
