/**
 * Design versions — `/api/designs/:id/versions…` (* specs/studio-workbench.md "Design versions").
 *
 *   GET    /api/designs/:id/versions                     list + working status + drafts
 *   GET    /api/designs/:id/versions/:rev                one version file
 *   GET    /api/designs/:id/versions/:rev/artwork        the artwork copied into it
 *   POST   /api/designs/:id/versions                     { note }    save the stored working copy
 *   POST   /api/designs/:id/versions/:rev/unlock         { reason }
 *   PUT    /api/designs/:id/versions/:rev                { design }  save an unlocked version's edit, re-lock
 *   POST   /api/designs/:id/versions/:rev/lock           re-lock without an edit
 *   POST   /api/designs/:id/versions/:rev/submit         { comment }  ask for release approval
 *   POST   /api/designs/:id/versions/:rev/approve        { comment }  approver roles only
 *   POST   /api/designs/:id/versions/:rev/reject         { comment }  approver roles only
 *   POST   /api/designs/:id/versions/:rev/branch         { confirm: rev }  new version from this
 *   POST   /api/designs/:id/versions/drafts/:n/restore   { confirm: n }    bring a displaced working copy back
 *
 * The workbench's rules hold: a candidate validates before anything is
 * written (a version against its own frozen definitions, a working copy
 * against the live library), ids and numbers are checked before they become
 * paths, and a write that says nothing new leaves the file alone. Saved
 * versions are never overwritten except by a recorded unlock → edit.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dataPath, designVersionsDir, isDesignId } from '@wirehub/catalog';
import {
  artworkBlobName,
  canonicalVersionFile,
  createVersion,
  designsDiffer,
  pinSubassemblies,
  workingDiffers,
  editVersion,
  errors,
  formatVersionJson,
  nextRevision,
  relockVersion,
  unlockVersion,
  validateDesign,
  validateVersion,
  versionDb,
  versionArtwork,
  versionSummary,
  type ArtworkFiles,
  type CableDesign,
  type Db,
  type DesignVersionFile,
  type Issue,
  type VersionSummary,
  approvalStepProblem,
  approveVersion,
  rejectVersion,
  releasedRevision,
  submitVersion,
} from '@wirehub/model';

import type { ApiError, ApiResponse } from './api.ts';
import type { DesignStore } from './designs.ts';
import type { DrawingStore } from './drawings.ts';
import type { StudioUser } from './me.ts';
import { contentETag } from './etag.ts';
import { writeFileAtomic } from './atomic-write.ts';
import { recordWrite } from './write-journal.ts';
import type { Awaitable } from './storage/change-set.ts';
import type { DocStore } from './storage/doc-store.ts';
import { approvalPolicy } from './settings.ts';
import { withDesignLibrary } from './assemblies.ts';
import type { DomainEvent } from './webhooks/events.ts';
import { hubCatalogSource } from './catalog-files.ts';

export const VERSION_ROUTES = [
  'GET    /api/designs/:id/versions',
  'GET    /api/designs/:id/versions/:rev',
  'GET    /api/designs/:id/versions/:rev/artwork',
  'POST   /api/designs/:id/versions',
  'PUT    /api/designs/:id/versions/:rev',
  'POST   /api/designs/:id/versions/:rev/unlock',
  'POST   /api/designs/:id/versions/:rev/lock',
  'POST   /api/designs/:id/versions/:rev/submit',
  'POST   /api/designs/:id/versions/:rev/approve',
  'POST   /api/designs/:id/versions/:rev/reject',
  'POST   /api/designs/:id/versions/:rev/branch',
  'POST   /api/designs/:id/versions/drafts/:n/restore',
] as const;

/** `_versions/<id>/working.json` — what the working copy descends from. */
export interface WorkingState {
  basedOnRev?: number;
}

/** `_versions/<id>/drafts/<n>.json` — a working copy displaced by "New version from this". */
export interface DraftFile {
  savedAt: string;
  savedBy: string;
  basedOnRev?: number;
  reason: string;
  design: CableDesign;
}

export interface DraftSummary {
  n: number;
  savedAt: string;
  savedBy: string;
  basedOnRev?: number;
  reason: string;
}

export interface VersionStore {
  revisions(id: string): Awaitable<number[]>;
  read(id: string, rev: number): Awaitable<DesignVersionFile | undefined>;
  write(file: DesignVersionFile): Awaitable<void>;
  working(id: string): Awaitable<WorkingState>;
  setWorking(id: string, state: WorkingState): Awaitable<void>;
  drafts(id: string): Awaitable<DraftSummary[]>;
  readDraft(id: string, n: number): Awaitable<DraftFile | undefined>;
  /** stores a draft under the next free number and returns it */
  addDraft(id: string, draft: DraftFile): Awaitable<number>;
  removeDraft(id: string, n: number): Awaitable<void>;
  /** follow a design rename */
  move(from: string, to: string): Awaitable<void>;
  /**
   * Today's artwork of these definitions (the live depiction tree), hashed
   * per file, with the bytes ready to copy into a version. Absent: the host
   * keeps no artwork, and versions carry none.
   */
  snapshotArtwork?(defIds: string[]): Awaitable<ArtworkSnapshot>;
  /** copy blobs into `id`'s artwork store (content-addressed: an existing blob is left alone) */
  writeArtwork?(id: string, blobs: Record<string, Uint8Array>): Awaitable<void>;
  /** one stored blob (`<hex>.<ext>`), or undefined */
  readArtworkBlob?(id: string, blob: string): Awaitable<Uint8Array | undefined>;
}

/** What `snapshotArtwork` hands back. */
export interface ArtworkSnapshot {
  /** defId → file → `sha256:<hex>` (only definitions that have artwork) */
  files: Record<string, ArtworkFiles>;
  /** `<hex>.<ext>` → bytes */
  blobs: Record<string, Uint8Array>;
}

/**
 * A version's own artwork, shaped like the studio's depiction modules
 * (`<defId>/<file>` paths): manifests parsed, SVG as text, raster as data URIs.
 */
export interface VersionArtwork {
  meta: Record<string, unknown>;
  vector: Record<string, string>;
  raster: Record<string, string>;
  /** definitions whose copy could not be read back (a missing blob) */
  missing: string[];
}

const RASTER_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const BLOB_NAME = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

function safeDefId(id: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*$/.test(id) && !id.includes('..');
}

/** Read and hash the live depiction files of `defIds` from `depictionsDir`. */
export function snapshotDepictions(depictionsDir: string | undefined, defIds: string[]): ArtworkSnapshot {
  const files: Record<string, ArtworkFiles> = {};
  const blobs: Record<string, Uint8Array> = {};
  if (depictionsDir === undefined) return { files, blobs };
  for (const id of [...new Set(defIds)].sort()) {
    if (!safeDefId(id)) continue;
    const path = join(depictionsDir, id);
    if (!existsSync(path)) continue;
    const entry: ArtworkFiles = {};
    for (const name of readdirSync(path).sort()) {
      const bytes = readFileSync(join(path, name));
      const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const blob = artworkBlobName(name, hash);
      if (blob === undefined) continue;
      entry[name] = hash;
      blobs[blob] = new Uint8Array(bytes);
    }
    if (Object.keys(entry).length > 0) files[id] = entry;
  }
  return { files, blobs };
}

/** A version's copied artwork, read back from its store. */
export async function readVersionArtwork(store: VersionStore, file: DesignVersionFile): Promise<VersionArtwork> {
  const out: VersionArtwork = { meta: {}, vector: {}, raster: {}, missing: [] };
  for (const [defId, files] of Object.entries(versionArtwork(file))) {
    const staged: Omit<VersionArtwork, 'missing'> = { meta: {}, vector: {}, raster: {} };
    let complete = true;
    for (const [name, hash] of Object.entries(files)) {
      const blob = artworkBlobName(name, hash);
      const bytes = blob === undefined ? undefined : await store.readArtworkBlob?.(file.designId, blob);
      if (bytes === undefined) {
        complete = false;
        break;
      }
      const path = `${defId}/${name}`;
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      const text = (): string => new TextDecoder().decode(bytes);
      if (name === 'meta.json') staged.meta[path] = JSON.parse(text()) as unknown;
      else if (ext === 'svg') staged.vector[path] = text();
      else if (RASTER_TYPES[ext] !== undefined) staged.raster[path] = `data:${RASTER_TYPES[ext]};base64,${Buffer.from(bytes).toString('base64')}`;
    }
    if (!complete) {
      out.missing.push(defId);
      continue;
    }
    Object.assign(out.meta, staged.meta);
    Object.assign(out.vector, staged.vector);
    Object.assign(out.raster, staged.raster);
  }
  return out;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeIfChanged(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, text, 'utf8');
}

function checkRev(rev: number): void {
  if (!Number.isInteger(rev) || rev < 0) throw new Error(`'${rev}' is not a revision number`);
}

/**
 * The catalog directory as the store: `data/designs/_versions/<id>/…`. Given no `root`, what it reads is the
 * live catalog with its installed packs under it (a pack can supply saved versions, so the next revision
 * number counts them) and what it writes is the catalog's own; given a `root`, that directory alone.
 */
export function fileVersionStore(
  root?: (id: string) => string,
  depictionsDir: string | undefined = dataPath('../depictions'),
): VersionStore {
  const dir = (id: string): string => {
    if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
    return root === undefined ? dataPath(designVersionsDir(id)) : root(id);
  };
  const layered = root === undefined ? hubCatalogSource() : undefined;
  /** a file of `_versions/<id>/` as the hub sees it (pack layers under the catalog's own) */
  const textOf = (id: string, relative: string): string | undefined => {
    if (layered !== undefined) {
      dir(id);
      return layered.read(`${designVersionsDir(id)}/${relative}`);
    }
    const path = join(dir(id), relative);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };
  const namesIn = (id: string, relative: string): string[] => {
    if (layered !== undefined) {
      dir(id);
      return layered.list(relative === '' ? designVersionsDir(id) : `${designVersionsDir(id)}/${relative}`);
    }
    const path = relative === '' ? dir(id) : join(dir(id), relative);
    return existsSync(path) ? readdirSync(path) : [];
  };
  const numbered = (id: string, relative: string): number[] =>
    namesIn(id, relative)
      .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  const ownNumbered = (path: string): number[] => {
    if (!existsSync(path)) return [];
    return readdirSync(path)
      .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  };
  return {
    revisions: (id) => numbered(id, ''),
    read(id, rev) {
      checkRev(rev);
      const text = textOf(id, `${rev}.json`);
      return text === undefined ? undefined : (JSON.parse(text) as DesignVersionFile);
    },
    write(file) {
      checkRev(file.rev);
      writeIfChanged(join(dir(file.designId), `${file.rev}.json`), formatVersionJson(file));
    },
    working(id) {
      const text = textOf(id, 'working.json');
      return text === undefined ? {} : (JSON.parse(text) as WorkingState);
    },
    setWorking(id, state) {
      writeIfChanged(join(dir(id), 'working.json'), json(state.basedOnRev === undefined ? {} : { basedOnRev: state.basedOnRev }));
    },
    drafts(id) {
      return numbered(id, 'drafts').map((n) => {
        const { design: _design, ...rest } = JSON.parse(textOf(id, `drafts/${n}.json`) as string) as DraftFile;
        return { n, ...rest };
      });
    },
    readDraft(id, n) {
      checkRev(n);
      const text = textOf(id, `drafts/${n}.json`);
      return text === undefined ? undefined : (JSON.parse(text) as DraftFile);
    },
    addDraft(id, draft) {
      const taken = [...new Set([...numbered(id, 'drafts'), ...ownNumbered(join(dir(id), 'drafts'))])];
      const n = taken.length === 0 ? 1 : Math.max(...taken) + 1;
      writeIfChanged(join(dir(id), 'drafts', `${n}.json`), json(draft));
      return n;
    },
    removeDraft(id, n) {
      checkRev(n);
      const path = join(dir(id), 'drafts', `${n}.json`);
      if (existsSync(path)) unlinkSync(path);
      recordWrite(path);
    },
    move(from, to) {
      const source = dir(from);
      if (!existsSync(source) || from === to) return;
      const target = dir(to);
      // whole directories: staging them picks up every file moved in or out
      recordWrite(source, target);
      if (existsSync(target)) rmSync(target, { recursive: true });
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
      // the snapshots name their design; a renamed cable's history follows it
      for (const rev of ownNumbered(target)) {
        const path = join(target, `${rev}.json`);
        const file = JSON.parse(readFileSync(path, 'utf8')) as DesignVersionFile;
        writeFileAtomic(path, formatVersionJson({ ...file, designId: to, design: { ...file.design, id: to } }), 'utf8');
      }
    },
    snapshotArtwork: (defIds) => snapshotDepictions(depictionsDir, defIds),
    writeArtwork(id, blobs) {
      const target = join(dir(id), 'artwork');
      for (const name of Object.keys(blobs).sort()) {
        if (!BLOB_NAME.test(name)) continue;
        const path = join(target, name);
        // content-addressed: the name is the bytes' hash, so a blob already there is already right
        if (existsSync(path)) continue;
        mkdirSync(target, { recursive: true });
        writeFileAtomic(path, blobs[name] as Uint8Array);
      }
    },
    readArtworkBlob(id, blob) {
      if (!BLOB_NAME.test(blob)) return undefined;
      const path = join(dir(id), 'artwork', blob);
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
    },
  };
}

/** For tests and read-only hosts; with `depictionsDir`, versions copy artwork from it. */
export function memoryVersionStore(depictionsDir?: string): VersionStore {
  const versions = new Map<string, Map<number, DesignVersionFile>>();
  const artwork = new Map<string, Map<string, Uint8Array>>();
  const working = new Map<string, WorkingState>();
  const drafts = new Map<string, Map<number, DraftFile>>();
  const of = <T, K = number>(map: Map<string, Map<K, T>>, id: string): Map<K, T> => {
    let inner = map.get(id);
    if (inner === undefined) {
      inner = new Map();
      map.set(id, inner);
    }
    return inner;
  };
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    revisions: (id) => [...of(versions, id).keys()].sort((a, b) => a - b),
    read: (id, rev) => {
      const file = of(versions, id).get(rev);
      return file === undefined ? undefined : clone(file);
    },
    write: (file) => void of(versions, file.designId).set(file.rev, JSON.parse(formatVersionJson(file)) as DesignVersionFile),
    working: (id) => ({ ...(working.get(id) ?? {}) }),
    setWorking: (id, state) => void working.set(id, { ...state }),
    drafts: (id) =>
      [...of(drafts, id).entries()]
        .sort(([a], [b]) => a - b)
        .map(([n, { design: _design, ...rest }]) => ({ n, ...rest })),
    readDraft: (id, n) => {
      const draft = of(drafts, id).get(n);
      return draft === undefined ? undefined : clone(draft);
    },
    addDraft: (id, draft) => {
      const inner = of(drafts, id);
      const n = inner.size === 0 ? 1 : Math.max(...inner.keys()) + 1;
      inner.set(n, clone(draft));
      return n;
    },
    removeDraft: (id, n) => void of(drafts, id).delete(n),
    ...(depictionsDir === undefined
      ? {}
      : {
          snapshotArtwork: (defIds: string[]) => snapshotDepictions(depictionsDir, defIds),
          writeArtwork: (id: string, blobs: Record<string, Uint8Array>) => {
            for (const [name, bytes] of Object.entries(blobs)) {
              if (!of(artwork, id).has(name)) of(artwork, id).set(name, bytes);
            }
          },
          readArtworkBlob: (id: string, blob: string) => artwork.get(id)?.get(blob),
        }),
    move: (from, to) => {
      for (const map of [versions, drafts, artwork] as Map<string, Map<unknown, unknown>>[]) {
        const inner = map.get(from);
        if (inner === undefined) continue;
        map.delete(from);
        map.set(to, inner);
      }
      for (const file of of(versions, to).values()) {
        file.designId = to;
        file.design.id = to;
      }
      const state = working.get(from);
      if (state !== undefined) {
        working.delete(from);
        working.set(to, state);
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * What the handlers need
 * ------------------------------------------------------------------ */

export interface VersionDeps {
  designs: DesignStore;
  loadDb: () => Awaitable<Db>;
  versions?: VersionStore;
  drawings?: DrawingStore;
  /** the engineering settings live here (release approvals on or off, who approves) */
  docs?: DocStore;
  /** ISO time stamp (injected by tests) */
  now?: () => string;
}

function fail(status: number, error: string, hint?: string, issues?: Issue[]): ApiResponse {
  const body: ApiError = { error, ...(hint === undefined ? {} : { hint }) };
  if (issues !== undefined) body.issues = issues;
  return { status, body };
}

function ok(body: unknown, status = 200): ApiResponse {
  return { status, body };
}

function objectBody(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseNumber(segment: string | undefined): number | undefined {
  return segment !== undefined && /^\d{1,6}$/.test(segment) ? Number(segment) : undefined;
}

/** What a version list shows about the working copy. */
export interface WorkingStatus {
  basedOnRev?: number;
  /** the working copy's design differs from `basedOnRev`'s (true when nothing is saved yet) */
  unreleased: boolean;
  /** the number the next Save version will take */
  nextRev: number;
  latestRev?: number;
  /** release approvals are on (hub settings) */
  approvals?: boolean;
  /** with approvals on: the latest approved revision, the released one (absent: none approved yet) */
  releasedRev?: number;
}

export interface VersionListing {
  revisions: VersionSummary[];
  working: WorkingStatus;
  drafts: DraftSummary[];
}

/** The working copy's release state — also what the cable list's chip reads. */
export async function workingStatus(deps: VersionDeps, id: string, working: CableDesign | undefined): Promise<WorkingStatus> {
  const store = deps.versions;
  const revs = await store?.revisions(id) ?? [];
  const latestRev = revs[revs.length - 1];
  const state = await store?.working(id) ?? {};
  const basedOnRev = state.basedOnRev ?? latestRev;
  const base = basedOnRev === undefined ? undefined : await store?.read(id, basedOnRev);
  // the pins a save froze its sub-assemblies to are not a change
  const unreleased = working === undefined || base === undefined ? true : workingDiffers(working, base.design);
  const policy = await approvalPolicy(deps.docs);
  let releasedRev: number | undefined;
  if (policy.enabled && store !== undefined) {
    const summaries: VersionSummary[] = [];
    for (const rev of revs) {
      const file = await store.read(id, rev);
      if (file !== undefined) summaries.push(versionSummary(file));
    }
    releasedRev = releasedRevision(summaries, true);
  }
  return {
    ...(policy.enabled ? { approvals: true, ...(releasedRev === undefined ? {} : { releasedRev }) } : {}),
    ...(basedOnRev === undefined ? {} : { basedOnRev }),
    unreleased,
    nextRev: nextRevision(revs, (await deps.drawings?.read(id))?.meta.revision),
    ...(latestRev === undefined ? {} : { latestRev }),
  };
}

async function listing(deps: VersionDeps, store: VersionStore, id: string): Promise<VersionListing> {
  const revisions: ReturnType<typeof versionSummary>[] = [];
  for (const rev of await store.revisions(id)) {
    const file = await store.read(id, rev);
    if (file !== undefined) revisions.push(versionSummary(file));
  }
  return { revisions, working: await workingStatus(deps, id, await deps.designs.read(id)), drafts: await store.drafts(id) };
}

function frozenIds(file: Pick<DesignVersionFile, 'definitions'>): string[] {
  const d = file.definitions;
  return [...d.connectors, ...d.pcbas, ...d.wires, ...d.components, ...d.mechanicals].map((def) => def.id);
}

/** Today's artwork of every definition the version froze. */
async function artwork(store: VersionStore, file: Pick<DesignVersionFile, 'definitions'>): Promise<ArtworkSnapshot> {
  return (await store.snapshotArtwork?.(frozenIds(file))) ?? { files: {}, blobs: {} };
}

/** Only the blobs `files` names. */
function blobsFor(snapshot: ArtworkSnapshot, files: Record<string, ArtworkFiles>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const entry of Object.values(files)) {
    for (const [name, hash] of Object.entries(entry)) {
      const blob = artworkBlobName(name, hash);
      const bytes = blob === undefined ? undefined : snapshot.blobs[blob];
      if (blob !== undefined && bytes !== undefined) out[blob] = bytes;
    }
  }
  return out;
}

/** Write a version and the artwork blobs it names (blobs first: a file never names a blob that is not there). */
async function writeWithArtwork(store: VersionStore, file: DesignVersionFile, snapshot: ArtworkSnapshot): Promise<void> {
  const copied = versionArtwork(file);
  if (Object.keys(copied).length > 0) await store.writeArtwork?.(file.designId, blobsFor(snapshot, copied));
  await store.write(file);
}

function versionRejected(id: string, rev: number, issues: Issue[]): ApiResponse {
  return fail(
    422,
    `Rev ${rev} of '${id}' does not validate against its own definitions.`,
    'Nothing was written. Fix the problems listed below first.',
    issues,
  );
}

async function saveVersion(deps: VersionDeps, store: VersionStore, id: string, body: unknown, user: StudioUser): Promise<ApiResponse> {
  const note = text(objectBody(body).note);
  if (note === '') {
    return fail(400, 'A saved version needs a note.', 'Say what this revision is — "first release", "moved sync to pin 20" …');
  }
  const design = await deps.designs.read(id);
  if (design === undefined) return fail(404, `There is no design called '${id}'.`, 'Pick one from the cable list.');
  // the designs it places, as a saved version freezes them (each pinned to its released revision)
  const live = await withDesignLibrary(deps, design, await deps.loadDb());
  const failures = errors([...validateDesign(design, live), ...pinSubassemblies(design, live).issues]);
  if (failures.length > 0) {
    return fail(422, `'${id}' has problems that have to be fixed before it can be released.`, 'Nothing was saved. Fix them in the editor, save, then save the version.', failures);
  }
  const revs = await store.revisions(id);
  const status = await workingStatus(deps, id, design);
  if (revs.length > 0 && !status.unreleased) {
    return fail(409, `The working copy is identical to Rev ${String(status.basedOnRev)}.`, 'There is nothing new to release — make a change first.');
  }
  const drawing = await deps.drawings?.read(id);
  const rev = nextRevision(revs, drawing?.meta.revision);
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const draft = createVersion({
    design,
    db: live,
    rev,
    at,
    by: user.name,
    note,
    ...(status.basedOnRev === undefined ? {} : { basedOnRev: status.basedOnRev }),
  });
  const art = await artwork(store, draft);
  const file = canonicalVersionFile({ ...draft, depictions: art.files });
  const issues = errors(validateVersion(file, live.assemblies));
  if (issues.length > 0) return versionRejected(id, rev, issues);
  await writeWithArtwork(store, file, art);
  await store.setWorking(id, { basedOnRev: rev });
  // the title block and the CLI tools read the drawing's revision: keep it the released number
  let drawingRewritten = false;
  if (deps.drawings !== undefined && drawing !== undefined && drawing.meta.revision !== String(rev)) {
    await deps.drawings.writeMeta(id, { ...drawing.meta, revision: String(rev) });
    drawingRewritten = true;
  }
  // this save just rewrote the drawing sidecar behind whichever browser has
  // it open (drawing-form bug): say so, with its fresh
  // ETag, so that form's own stale-write guard does not have to find out the
  // hard way — a 409 on its very next save
  const drawingTag = drawingRewritten ? { drawingTag: contentETag(await deps.drawings?.read(id)) } : {};
  const subject = { kind: 'design', id, label: design.label, rev };
  const approvalsOn = (await approvalPolicy(deps.docs)).enabled;
  const events: DomainEvent[] = [{ type: 'version.saved', subject, summary: { rev, note, ...(status.basedOnRev === undefined ? {} : { basedOnRev: status.basedOnRev }) } }];
  // with approvals off a saved revision is the released one; with them on it is released when approved
  if (!approvalsOn) events.push({ type: 'version.released', subject, summary: { rev, note, approved: false } });
  return { ...ok({ version: versionSummary(file), ...drawingTag, ...await listing(deps, store, id) }, 201), events };
}

async function readVersion(store: VersionStore, id: string, rev: number): Promise<{ ok: true; file: DesignVersionFile } | { ok: false; response: ApiResponse }> {
  const file = await store.read(id, rev);
  if (file === undefined) {
    return { ok: false, response: fail(404, `'${id}' has no saved Rev ${rev}.`, 'Open the version list to see which revisions exist.') };
  }
  return { ok: true, file };
}

async function unlock(deps: VersionDeps, store: VersionStore, file: DesignVersionFile, body: unknown, user: StudioUser): Promise<ApiResponse> {
  const reason = text(objectBody(body).reason);
  if (reason === '') return fail(400, 'Unlocking a saved version needs a reason.', 'Write why it has to change — it is kept in the version history.');
  if (file.unlocked !== undefined) {
    return fail(409, `Rev ${file.rev} is already unlocked (by ${file.unlocked.by}: "${file.unlocked.reason}").`, 'Save & lock or Lock it first.');
  }
  const next = unlockVersion(file, (deps.now ?? (() => new Date().toISOString()))(), user.name, reason);
  await store.write(next);
  return ok(next);
}

async function relock(deps: VersionDeps, store: VersionStore, file: DesignVersionFile, user: StudioUser): Promise<ApiResponse> {
  if (file.unlocked === undefined) return fail(409, `Rev ${file.rev} is already locked.`);
  const next = relockVersion(file, (deps.now ?? (() => new Date().toISOString()))(), user.name);
  await store.write(next);
  return ok(next);
}

/** submit, approve or reject a saved version, with the person's role checked and a comment required */
async function approvalStep(
  deps: VersionDeps,
  store: VersionStore,
  file: DesignVersionFile,
  step: 'submit' | 'approve' | 'reject',
  body: unknown,
  user: StudioUser,
): Promise<ApiResponse> {
  const policy = await approvalPolicy(deps.docs);
  if (!policy.enabled) return fail(409, 'Release approvals are not turned on for this hub.', 'An owner turns them on under Settings, Release approvals.');
  const role = user.role;
  if (role === 'viewer') return fail(403, 'Your role can view versions but not submit or approve them.');
  if (step !== 'submit' && role !== undefined && !policy.approverRoles.includes(role)) {
    return fail(403, `Only ${policy.approverRoles.join(' or ')} can ${step} a release.`, 'Ask someone with that role, or have the hub settings allow editors to approve.');
  }
  const comment = text(objectBody(body).comment);
  if (comment === '') return fail(400, `A ${step} needs a comment.`, step === 'submit' ? 'Say what the reviewer should look at.' : 'Say why — it is kept in the version history and printed with the approval.');
  const problem = approvalStepProblem(file, step);
  if (problem !== undefined) return fail(409, problem);
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const next = (step === 'submit' ? submitVersion : step === 'approve' ? approveVersion : rejectVersion)(file, at, user.name, comment);
  await store.write(next);
  const subject = { kind: 'design', id: file.designId, label: file.design.label, rev: file.rev };
  const summary = { rev: file.rev, comment, by: user.name };
  const events: DomainEvent[] =
    step === 'submit'
      ? [{ type: 'version.submitted', subject, summary }]
      : step === 'approve'
        ? [{ type: 'version.approved', subject, summary }, { type: 'version.released', subject, summary: { ...summary, approved: true } }]
        : [{ type: 'version.rejected', subject, summary }];
  return { ...ok({ version: versionSummary(next), ...await listing(deps, store, file.designId) }), events };
}

async function editLocked(deps: VersionDeps, store: VersionStore, file: DesignVersionFile, body: unknown, user: StudioUser): Promise<ApiResponse> {
  if (file.unlocked === undefined) {
    return fail(409, `Rev ${file.rev} is locked.`, 'Unlock it with a reason first — a saved version never changes silently.');
  }
  const design = objectBody(body).design as CableDesign | undefined;
  if (design === undefined || typeof design !== 'object' || !Array.isArray(design.joints) || typeof design.instances !== 'object') {
    return fail(400, 'That is not a cable design document.', 'Send { design } — the edited version.');
  }
  if (design.id !== file.designId) {
    return fail(400, `This edit is for '${file.designId}', but the document says '${String(design.id)}'.`, 'A version cannot be moved to another design.');
  }
  const live = await withDesignLibrary(deps, design, await deps.loadDb());
  const frozenDb = versionDb(file.definitions, live);
  const checkDb = live.assemblies === undefined ? frozenDb : { ...frozenDb, assemblies: live.assemblies };
  const failures = errors([...validateDesign(design, checkDb), ...pinSubassemblies(design, checkDb).issues]);
  if (failures.length > 0) {
    return fail(422, `Rev ${file.rev} has problems that have to be fixed before it can be locked again.`, 'Nothing was written.', failures);
  }
  const edited = editVersion(file, design, live, (deps.now ?? (() => new Date().toISOString()))(), user.name);
  // artwork the revision already kept stays its own; a part new to it is copied as it is today
  const art = await artwork(store, edited);
  const fresh = Object.fromEntries(Object.entries(art.files).filter(([defId]) => edited.depictions[defId] === undefined));
  const next = canonicalVersionFile({ ...edited, depictions: { ...edited.depictions, ...fresh } });
  const issues = errors(validateVersion(next, live.assemblies));
  if (issues.length > 0) return versionRejected(file.designId, file.rev, issues);
  await writeWithArtwork(store, next, art);
  return ok(next);
}

/** Replace the working copy with `design`, keeping the one it displaces as a draft. */
async function replaceWorking(
  deps: VersionDeps,
  store: VersionStore,
  id: string,
  design: CableDesign,
  basedOnRev: number | undefined,
  reason: string,
  user: StudioUser,
): Promise<ApiResponse> {
  const live = await withDesignLibrary(deps, design, await deps.loadDb());
  const failures = errors(validateDesign(design, live));
  if (failures.length > 0) {
    return fail(
      422,
      'That version no longer fits the current Library, so it cannot become the working copy.',
      'Nothing was changed. A definition it uses was removed or changed — the problems are listed below.',
      failures,
    );
  }
  const current = await deps.designs.read(id);
  let draft: number | undefined;
  if (current !== undefined && designsDiffer(current, design)) {
    const state = await store.working(id);
    draft = await store.addDraft(id, {
      savedAt: (deps.now ?? (() => new Date().toISOString()))(),
      savedBy: user.name,
      ...(state.basedOnRev === undefined ? {} : { basedOnRev: state.basedOnRev }),
      reason,
      design: current,
    });
  }
  await deps.designs.write(id, design);
  await store.setWorking(id, basedOnRev === undefined ? {} : { basedOnRev });
  return ok({ design: await deps.designs.read(id), ...(draft === undefined ? {} : { keptDraft: draft }), ...await listing(deps, store, id) });
}

/**
 * Everything under `/api/designs/:id/versions`; `undefined` for anything else.
 * `parts` is the decoded path (`['api', 'designs', id, 'versions', …]`).
 */
export async function handleVersionRequest(
  method: string,
  parts: string[],
  body: unknown,
  deps: VersionDeps,
  user: StudioUser,
): Promise<ApiResponse | undefined> {
  const [, head, id, section, first, second, third, ...rest] = parts;
  if (head !== 'designs' || section !== 'versions' || id === undefined) return undefined;
  if (!isDesignId(id)) return fail(400, `${JSON.stringify(id)} cannot be used as a design id.`);
  const store = deps.versions;
  if (store === undefined) return fail(501, 'This hub does not keep design versions.', 'The working copy still saves as usual.');
  if (!await deps.designs.has(id)) return fail(404, `There is no design called '${id}'.`, 'Pick one from the cable list.');
  if (rest.length > 0) return fail(404, `${parts.join('/')} is not part of the server API.`);

  if (first === undefined) {
    if (method === 'GET') return ok(await listing(deps, store, id));
    if (method === 'POST') return await saveVersion(deps, store, id, body, user);
    return fail(405, `${method} is not something this address accepts.`, 'It answers GET and POST.');
  }

  if (first === 'drafts') {
    const n = parseNumber(second);
    if (n === undefined || third !== 'restore') return fail(404, `${parts.join('/')} is not part of the server API.`);
    if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
    const draft = await store.readDraft(id, n);
    if (draft === undefined) return fail(404, `'${id}' has no kept draft ${n}.`);
    if (objectBody(body).confirm !== n) {
      return fail(400, 'Restoring a draft replaces the working copy and has to be confirmed.', `Nothing was changed. Send { confirm: ${n} }.`);
    }
    const response = await replaceWorking(deps, store, id, { ...draft.design, id }, draft.basedOnRev, `replaced by kept draft ${n}`, user);
    if (response.status < 300) await store.removeDraft(id, n);
    return response.status < 300 ? ok({ ...(response.body as object), drafts: await store.drafts(id) }) : response;
  }

  const rev = parseNumber(first);
  if (rev === undefined) return fail(400, `'${first}' is not a revision number.`, 'Revisions are whole numbers: 0, 1, 2 …');
  const found = await readVersion(store, id, rev);
  if (!found.ok) return found.response;
  const file = found.file;

  if (second === undefined) {
    if (method === 'GET') {
      // not stored: which parts' artwork differs today from the copy this revision keeps
      // (the revision still draws its own copy — this only says the Library moved on)
      const now = (await artwork(store, file)).files;
      const artworkChanged = Object.keys(file.depictions).filter((def) => {
        const kept = file.depictions[def];
        const today = now[def];
        if (kept === undefined || today === undefined) return false;
        if (typeof kept === 'string') return false;
        return JSON.stringify(Object.entries(kept).sort()) !== JSON.stringify(Object.entries(today).sort());
      });
      return ok({ ...file, artworkChanged });
    }
    if (method === 'PUT') return await editLocked(deps, store, file, body, user);
    return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
  }
  if (third !== undefined) return fail(404, `${parts.join('/')} is not part of the server API.`);
  if (second === 'artwork') {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    return ok(await readVersionArtwork(store, file));
  }
  if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
  if (second === 'unlock') return await unlock(deps, store, file, body, user);
  if (second === 'lock') return await relock(deps, store, file, user);
  if (second === 'submit' || second === 'approve' || second === 'reject') return await approvalStep(deps, store, file, second, body, user);
  if (second === 'branch') {
    if (objectBody(body).confirm !== rev) {
      return fail(400, 'Starting a new version from an old one replaces the working copy and has to be confirmed.', `Nothing was changed. Send { confirm: ${rev} }.`);
    }
    return await replaceWorking(deps, store, id, file.design, rev, `replaced by a new version from Rev ${rev}`, user);
  }
  return fail(404, `${parts.join('/')} is not part of the server API.`);
}
