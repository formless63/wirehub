/**
 * The read half of every store on Postgres (`specs/postgres-backend.md`
 * §4.1, task A6).
 *
 * Every read answers from the org's snapshot at the current head version
 * (`snapshot.ts`): the rows rendered through the codec into the file text the
 * file stores read, so each store here is the file store's read path over
 * that text — same parse, same composition, same order — and every answer
 * (and every ETag computed from it) is the file backend's.
 *
 * Bytes (uploaded assets, saved artwork, legacy photos) come from the blob
 * store under their content address (§5.1).
 *
 * The write half is Phase B (B1/B2): until then every write refuses with
 * `ReadOnlyBackendError`, and `pgCommit` refuses a change set before anything
 * is written — a pg studio is a read-only studio.
 */

import { createHash } from 'node:crypto';

import { composeConnectors } from '@wirehub/model';
import type { BoardBuilds, ConnectorRecord, DesignVersionFile, SignalTags, VocabList, WireDefinition, WirePart, WireRecipe, StripPractice } from '@wirehub/model';
import { buildTags, type TagReview } from '@wirehub/catalog/src/tags/build.ts';
import { isDesignId } from '@wirehub/catalog';

import { assetDataUri, type AssetMime, type AssetStore, type AssetSummary } from '../assets.ts';
import type { BlobStore } from '../blobs.ts';
import type { BuildsStore } from '../builds.ts';
import { isDefinitionKind, type DefinitionKind, type DefinitionRecord, type DefinitionStore } from '../definition-store.ts';
import type { DesignStore, DesignSummary } from '../designs.ts';
import type { DrawingStore, StoredDrawing } from '../drawings.ts';
import type { DepictionStore } from '../depictions.ts';
import { isDocPath, parseDoc, type DocStore } from '../storage/doc-store.ts';
import type { ModelLink, ModelLinkStore } from '../models/links.ts';
import { ReadOnlyBackendError, type ChangeSet, type CommitResult } from '../storage/change-set.ts';
import { snapshotDepictions, type DraftFile, type DraftSummary, type VersionStore, type WorkingState } from '../versions.ts';
import type { TagStore, VocabStore } from '../vocab-store.ts';
import type { WireLibraryStore } from '../wire-library.ts';
import { blobObjectKey } from './keys.ts';
import type { Snapshot } from './snapshot.ts';

export { ReadOnlyBackendError };

const notWritten = (what: string): string =>
  `The database backend is read-only until its write path lands (Postgres plan Phase B); ${what} was not written.`;

const readOnly = (what: string) => (): never => {
  throw new ReadOnlyBackendError(notWritten(what));
};

export interface PgReadContext {
  snapshot: () => Promise<Snapshot>;
  blobs: BlobStore | undefined;
  orgId: string;
}

const LIST_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parse<T>(snapshot: Snapshot, relative: string): T | undefined {
  const text = snapshot.source.read(relative);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

/** Bytes of a blob by sha256, or undefined when the store does not have them. */
async function blobBytes(context: PgReadContext, sha256: string): Promise<Buffer | undefined> {
  if (context.blobs === undefined) return undefined;
  return context.blobs.get(blobObjectKey(context.orgId, sha256));
}

export function pgDesignStore(context: PgReadContext): DesignStore {
  return {
    async list(): Promise<DesignSummary[]> {
      const { catalog } = await context.snapshot();
      return catalog.listDesignIds().map((id) => ({ id, label: catalog.loadDesign(id).label }));
    },
    async has(id) {
      return isDesignId(id) && (await context.snapshot()).source.read(`designs/${id}.json`) !== undefined;
    },
    async read(id) {
      if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
      return parse(await context.snapshot(), `designs/${id}.json`);
    },
    write: readOnly('the design'),
    remove: readOnly('the design delete'),
  };
}

export function pgDefinitionStore(context: PgReadContext): DefinitionStore {
  return {
    async list(kind: DefinitionKind): Promise<DefinitionRecord[]> {
      if (!isDefinitionKind(kind)) throw new Error(`'${kind}' is not an editable definition file`);
      const snapshot = await context.snapshot();
      const stored = parse<DefinitionRecord[]>(snapshot, `${kind}.json`);
      if (stored === undefined) return [];
      const { catalog } = snapshot;
      return kind === 'connectors'
        ? composeConnectors(stored as ConnectorRecord[], { bodies: catalog.loadBodies(), interfaces: catalog.loadInterfaces(), vocab: catalog.loadVocab() })
        : stored;
    },
    write: readOnly('the definition list'),
  };
}

export function pgAssetStore(context: PgReadContext): AssetStore {
  const index = async (): Promise<AssetSummary[]> => parse<AssetSummary[]>(await context.snapshot(), 'assets/index.json') ?? [];
  return {
    list: index,
    async get(id) {
      const record = (await index()).find((r) => r.id === id);
      if (record === undefined) return undefined;
      const bytes = await blobBytes(context, id);
      return bytes === undefined ? undefined : { record, bytes };
    },
    put: readOnly('the asset'),
  };
}

const LEGACY_PHOTO: readonly [AssetMime, string][] = [
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
];

export function pgDrawingStore(context: PgReadContext, assets: AssetStore): DrawingStore {
  return {
    async read(id): Promise<StoredDrawing> {
      if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
      const snapshot = await context.snapshot();
      const meta = parse<StoredDrawing['meta']>(snapshot, `drawings/${id}.json`) ?? {};
      for (const [mime, ext] of LEGACY_PHOTO) {
        const sha = snapshot.blobOf.get(`data/drawings/${id}.photo.${ext}`);
        const bytes = sha === undefined ? undefined : await blobBytes(context, sha);
        if (bytes !== undefined) return { meta, photo: assetDataUri(mime, bytes) };
      }
      const assetId = parse<{ assetId?: string }>(snapshot, `drawings/${id}.photo-ref.json`)?.assetId;
      const found = assetId === undefined ? undefined : await assets.get(assetId);
      if (found !== undefined) return { meta, photo: assetDataUri(found.record.mime, found.bytes) };
      return { meta };
    },
    writeMeta: readOnly('the drawing sheet'),
    writePhoto: readOnly('the drawing photo'),
    move: readOnly('the drawing rename'),
    remove: readOnly('the drawing delete'),
  };
}

export function pgVocabStore(context: PgReadContext): VocabStore {
  return {
    ids: async () => (await context.snapshot()).catalog.listVocabIds(),
    async read(list): Promise<VocabList | undefined> {
      const { catalog } = await context.snapshot();
      if (!LIST_ID.test(list) || !catalog.listVocabIds().includes(list)) return undefined;
      return catalog.loadVocabList(list);
    },
    write: readOnly('the vocabulary list'),
  };
}

export function pgTagStore(context: PgReadContext): TagStore {
  return {
    tags: async (): Promise<SignalTags> => (await context.snapshot()).catalog.loadSignalTags(),
    async review(): Promise<TagReview> {
      const review = parse<TagReview>(await context.snapshot(), 'tags/review.json');
      if (review === undefined) throw new Error('the catalog has no tags/review.json');
      return review;
    },
    async preview(review) {
      const { catalog } = await context.snapshot();
      return buildTags({
        vocab: catalog.loadVocab(),
        connectors: catalog.loadConnectors(),
        pcbas: catalog.loadPcbas(),
        wires: catalog.loadWires(),
        designs: catalog.loadDesigns(),
        review,
      }).tags;
    },
    writeReview: readOnly('the tag review'),
    regenerate: readOnly('the tag table'),
  };
}

export function pgWireLibraryStore(context: PgReadContext): WireLibraryStore {
  const read = async <T>(name: string): Promise<T[]> => parse<T[]>(await context.snapshot(), name) ?? [];
  return {
    read: async () => ({ parts: await read<WirePart>('wire-parts.json'), recipes: await read<WireRecipe>('wire-recipes.json') }),
    wires: () => read<WireDefinition>('wires.json'),
    practice: () => read<StripPractice>('strip-practice.json'),
    writeParts: readOnly('the wire parts'),
    writeRecipes: readOnly('the wire recipes'),
    putWire: readOnly('the wire stock'),
  };
}

export function pgBuildsStore(context: PgReadContext): BuildsStore {
  return {
    async list() {
      const snapshot = await context.snapshot();
      return snapshot.source
        .list('builds')
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => ({ name: f.slice(0, -'.json'.length), file: parse<BoardBuilds>(snapshot, `builds/${f}`) as BoardBuilds }));
    },
    async read(name) {
      if (!LIST_ID.test(name)) return undefined;
      return parse<BoardBuilds>(await context.snapshot(), `builds/${name}.json`);
    },
    write: readOnly('the build file'),
  };
}

export function pgModelLinkStore(context: PgReadContext): ModelLinkStore {
  const links = async (): Promise<ModelLink[]> => {
    const file = parse<{ links?: ModelLink[] }>(await context.snapshot(), 'models.json');
    return Array.isArray(file?.links) ? file.links : [];
  };
  return {
    list: links,
    get: async (record) => (await links()).find((link) => link.record === record),
    put: readOnly('the model link'),
    remove: readOnly('the model link'),
  };
}

const numbered = (names: string[]): number[] =>
  names
    .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

/** Saved versions; `depictionsDir` is where today's artwork lives (the file tree until Phase B7). */
export function pgVersionStore(context: PgReadContext, depictionsDir?: string): VersionStore {
  const dir = (id: string): string => {
    if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
    return `designs/_versions/${id}`;
  };
  const checkRev = (rev: number): void => {
    if (!Number.isInteger(rev) || rev < 0) throw new Error(`'${rev}' is not a revision number`);
  };
  return {
    revisions: async (id) => numbered((await context.snapshot()).source.list(dir(id))),
    async read(id, rev) {
      checkRev(rev);
      return parse<DesignVersionFile>(await context.snapshot(), `${dir(id)}/${rev}.json`);
    },
    working: async (id): Promise<WorkingState> => parse<WorkingState>(await context.snapshot(), `${dir(id)}/working.json`) ?? {},
    async drafts(id): Promise<DraftSummary[]> {
      const snapshot = await context.snapshot();
      return numbered(snapshot.source.list(`${dir(id)}/drafts`)).map((n) => {
        const { design: _design, ...rest } = parse<DraftFile>(snapshot, `${dir(id)}/drafts/${n}.json`) as DraftFile;
        return { n, ...rest };
      });
    },
    async readDraft(id, n) {
      checkRev(n);
      return parse<DraftFile>(await context.snapshot(), `${dir(id)}/drafts/${n}.json`);
    },
    // today's artwork: the file tree when one is named, else the database's own depictions (B7)
    snapshotArtwork: (defIds) => (depictionsDir !== undefined ? snapshotDepictions(depictionsDir, defIds) : artworkSnapshot(context, defIds)),
    async readArtworkBlob(id, blob) {
      if (!/^[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(blob)) return undefined;
      const sha = (await context.snapshot()).blobOf.get(`data/${dir(id)}/artwork/${blob}`);
      const bytes = sha === undefined ? undefined : await blobBytes(context, sha);
      return bytes === undefined ? undefined : new Uint8Array(bytes);
    },
    write: readOnly('the saved version'),
    setWorking: readOnly('the working state'),
    addDraft: readOnly('the draft'),
    removeDraft: readOnly('the draft delete'),
    move: readOnly('the versions rename'),
    writeArtwork: readOnly('the version artwork'),
  };
}

/** `deps.commit` for a read-only backend: refuses every change set before anything is written. */
export async function pgCommitReadOnly(set: ChangeSet): Promise<CommitResult> {
  const first = set.changes[0];
  throw new ReadOnlyBackendError(notWritten(first === undefined ? 'the change' : `${first.kind} '${first.key}'`));
}

/** Artwork (B7): `meta.json` records and their files, from the snapshot and the blob store. */
export function pgDepictionStore(context: PgReadContext): DepictionStore {
  const DEF = /^[a-z0-9][a-z0-9.-]*$/;
  return {
    async listDefIds() {
      const { files } = await context.snapshot();
      return [...new Set([...files.keys()].filter((p) => p.startsWith('depictions/') && p.endsWith('/meta.json')).map((p) => p.split('/')[1] as string))].sort();
    },
    async readMeta(defId) {
      if (!DEF.test(defId)) return undefined;
      const text = (await context.snapshot()).files.get(`depictions/${defId}/meta.json`);
      if (typeof text !== 'string') return undefined;
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    },
    async readAsset(defId, file) {
      if (!DEF.test(defId)) return undefined;
      const snapshot = await context.snapshot();
      const content = snapshot.files.get(`depictions/${defId}/${file}`);
      if (typeof content === 'string') return new TextEncoder().encode(content);
      const sha = snapshot.blobOf.get(`depictions/${defId}/${file}`);
      const bytes = sha === undefined ? undefined : await blobBytes(context, sha);
      return bytes === undefined ? undefined : new Uint8Array(bytes);
    },
    dirFor: () => undefined,
    async readBoardMap(defId) {
      const value = parse<unknown>(await context.snapshot(), `kicad-maps/${defId}.json`);
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    },
    writeMeta: readOnly('the depiction manifest'),
    writeAsset: readOnly('the artwork file'),
    writeBoardMap: readOnly('the board map'),
  };
}

/** Catalog documents by path (the `doc` kind), from the snapshot. */
export function pgDocStore(context: PgReadContext): DocStore {
  return {
    async read(path) {
      if (!isDocPath(path)) return undefined;
      const text = (await context.snapshot()).source.read(path.slice('data/'.length));
      return text === undefined ? undefined : parseDoc(path, text);
    },
    write: readOnly('the document'),
    remove: readOnly('the document delete'),
  };
}

/** Today's artwork of `defIds`, hashed per file, with the bytes — `snapshotDepictions` over the snapshot. */
export async function artworkSnapshot(context: PgReadContext, defIds: string[]): Promise<{ files: Record<string, Record<string, string>>; blobs: Record<string, Uint8Array> }> {
  const snapshot = await context.snapshot();
  const store = pgDepictionStore(context);
  const files: Record<string, Record<string, string>> = {};
  const blobs: Record<string, Uint8Array> = {};
  for (const id of [...new Set(defIds)].sort()) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) continue;
    const prefix = `depictions/${id}/`;
    const entry: Record<string, string> = {};
    for (const path of [...snapshot.files.keys()].filter((p) => p.startsWith(prefix)).sort()) {
      const name = path.slice(prefix.length);
      const bytes = await store.readAsset(id, name);
      if (bytes === undefined) continue;
      const hex = createHash('sha256').update(bytes).digest('hex');
      const dot = name.lastIndexOf('.');
      const ext = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
      if (!/^[a-z0-9]{1,8}$/.test(ext)) continue;
      entry[name] = `sha256:${hex}`;
      blobs[`${hex}.${ext}`] = bytes;
    }
    if (Object.keys(entry).length > 0) files[id] = entry;
  }
  return { files, blobs };
}
