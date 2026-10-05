/**
 * The `import` job (`specs/postgres-backend.md` §7.5; task C2): a module
 * importer run over the catalog as it stands, its proposal staged as a
 * **plan**, and — once a person has looked at it — **published** as one
 * change set.
 *
 * - **Run** (in the worker, or in this process on the file backend): the
 *   importer reads the uploaded file and the catalog and proposes records
 *   (`ImportResult`). What the synchronous import would write
 *   (`module-io.ts` `proposalOf`: new definitions and designs, never one that
 *   exists) goes through the very routes a person's edits would —
 *   `POST /api/definitions/…`, `POST /api/designs` — in one unit of work, so
 *   validation, ordering and the records written are the file backend's by
 *   construction. Nothing is
 *   committed: the staged record changes, each with the version it was read
 *   at (`expect`), are the plan, and their effect on the catalog's files is
 *   kept for review (`job_file`).
 * - **Publish** (`POST /api/jobs/:id/publish`, a request): the plan's changes
 *   commit as one change set. A record that moved since the run fails its
 *   precondition: 409, "changed since the run", nothing written. Derived
 *   records (tag tables, module reports) are recomputed by the commit, never
 *   taken from the plan.
 */

import { createHash } from 'node:crypto';

import { routeWorkbenchRequest, type ApiResponse, type WorkbenchDeps } from '../api.ts';
import { batchItemRequest } from '../batch.ts';
import type { BlobStore } from '../blobs.ts';
import type { StudioUser } from '../me.ts';
import { boardArtFiles, relinkWithArt } from '../models/board-art.ts';
import { ImportExtrasRefused, proposalOf, readImportOptions, stageImportExtras } from '../module-io.ts';
import { CatalogTree, treeWorkbenchDeps } from '../pg/tree.ts';
import { commitChangeSet, UnitOfWork } from '../storage/unit-of-work.ts';
import type { CommitResult, RecordChange } from '../storage/change-set.ts';
import type { JobContext, JobOutcome, PlanFile } from './types.ts';

/** The largest file an importer takes (the upload limit). */
export const MAX_IMPORT_BYTES = 24 * 1024 * 1024;

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The uploaded file, as the job request carries it: in the blob store when there is one, else inline. */
export type ImportInput = { key: string; sha256: string; size: number } | { base64: string; sha256: string; size: number };

export interface ImportRequest {
  module: string;
  importer: string;
  fileName: string;
  input: ImportInput;
  /** the review step's choices (`ImportInput.options` in `@wirehub/modules`) */
  options?: Record<string, string>;
}

export function readImportRequest(request: Record<string, unknown>): ImportRequest {
  const { module, importer, fileName, input, options } = request as Partial<ImportRequest>;
  if (typeof module !== 'string' || typeof importer !== 'string' || typeof fileName !== 'string' || typeof input !== 'object' || input === null) {
    throw new Error('the import job has no module, importer, file name or input');
  }
  const read = readImportOptions(options);
  if (typeof read === 'string') throw new Error(`the import job's options are refused: ${read}`);
  return { module, importer, fileName, input, ...(read === undefined ? {} : { options: read }) };
}

/** The plan as JSON text: an artwork file's bytes travel as base64 (`{ "$base64": … }`). */
export function planText(changes: readonly RecordChange[]): string {
  return JSON.stringify(changes.map((c) => (c.bytes === undefined ? c : { ...c, bytes: { $base64: Buffer.from(c.bytes).toString('base64') } })));
}

/** Where an import's uploaded file is kept until the job has read it (§5.4: an object no row names goes after 24 h). */
export function importInputKey(orgId: string, sha: string): string {
  return `${orgId}/jobs/input/${sha}`;
}

/** Stage the uploaded bytes for the job: into the blob store when there is one. */
export async function stageImportInput(bytes: Uint8Array, blobs: BlobStore | undefined, orgId: string | undefined): Promise<ImportInput> {
  const sha = sha256(bytes);
  if (blobs !== undefined && orgId !== undefined) {
    const key = importInputKey(orgId, sha);
    if (!(await blobs.has(key))) await blobs.put(key, Buffer.from(bytes), 'application/octet-stream');
    return { key, sha256: sha, size: bytes.byteLength };
  }
  return { base64: Buffer.from(bytes).toString('base64'), sha256: sha, size: bytes.byteLength };
}

async function inputBytes(input: ImportInput, blobs: BlobStore | undefined): Promise<Uint8Array> {
  let bytes: Uint8Array | undefined;
  if ('base64' in input) bytes = new Uint8Array(Buffer.from(input.base64, 'base64'));
  else bytes = blobs === undefined ? undefined : await blobs.get(input.key).then((b) => (b === undefined ? undefined : new Uint8Array(b)));
  if (bytes === undefined) throw new Error('the uploaded file is gone from the blob store (it is kept for a day); upload it again');
  if (sha256(bytes) !== input.sha256) throw new Error('the uploaded file does not match its checksum; upload it again');
  return bytes;
}

/**
 * What `changes` would do to the catalog's text files: the plan a person
 * reviews. Computed on the catalog export (the same text on every backend),
 * without preconditions or derived records — the publish checks the one and
 * recomputes the other.
 */
export async function planFiles(deps: WorkbenchDeps, changes: readonly RecordChange[]): Promise<PlanFile[]> {
  if (deps.exportCatalog === undefined || changes.length === 0) return [];
  const exported = await deps.exportCatalog();
  const tree = new CatalogTree(Object.entries(exported.files));
  const { tags: _tags, derived: _derived, ...stores } = treeWorkbenchDeps(tree, { orgId: 'plan' });
  await commitChangeSet(stores, { changes: changes.map(({ expect: _expect, ...c }) => c), context: { method: 'POST', path: '/api/jobs/plan' } });
  const out: PlanFile[] = [];
  for (const [path, raw] of tree.files) {
    // artwork is text too: an imported board's SVG is shown in the plan like any other file
    const svg = typeof raw !== 'string' && path.endsWith('.svg') ? tree.bytes.get(raw.blob) : undefined;
    const content = typeof raw === 'string' ? raw : svg === undefined ? undefined : new TextDecoder().decode(svg);
    if (content === undefined) continue;
    const before = exported.files[path];
    // artwork is a binary file: the export lists it by content address (`blobs`), not as text
    const beforeBlob = before === undefined ? exported.blobs?.[path] : undefined;
    if (before === content || (beforeBlob !== undefined && beforeBlob === sha256(content))) continue;
    out.push({
      path,
      status: before === undefined && beforeBlob === undefined ? 'new' : 'changed',
      ...(typeof before === 'string' ? { beforeEtag: sha256(before) } : beforeBlob === undefined ? {} : { beforeEtag: beforeBlob }),
      content,
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface ImportDeps {
  deps: WorkbenchDeps;
  blobs?: BlobStore;
}

/** The job: run the importer, stage its proposal, keep the plan. */
export async function runImportJob(context: JobContext, { deps, blobs }: ImportDeps): Promise<JobOutcome> {
  const request = readImportRequest(context.job.request);
  const importer = deps.modules?.importer(request.module, request.importer);
  if (importer === undefined) throw new Error(`no module importer ${request.module}:${request.importer} in this deployment`);
  const bytes = await inputBytes(request.input, blobs);
  await context.step(`read ${request.fileName} (${bytes.byteLength} bytes)`);
  const db = await deps.loadDb();
  const proposal = await importer.import({ fileName: request.fileName, bytes, ...(request.options === undefined ? {} : { options: request.options }) }, db);
  const proposed = Object.values(proposal.definitions ?? {}).reduce((n, list) => n + (list?.length ?? 0), 0) + (proposal.designs?.length ?? 0);
  await context.step(`${importer.label} proposed ${proposed} record(s)`);

  const by = context.job.requestedBy;
  const user: StudioUser | undefined = by === undefined ? undefined : { name: by.name, ...(by.email === undefined ? {} : { email: by.email }), source: 'session' };
  // what the synchronous import would write (`module-io.ts`): new records only, never one that exists
  const ids = new Set((await deps.designs.list()).map((d) => d.id));
  const { proposal: summary, requests, extras } = proposalOf(proposal, db, ids);
  const uow = new UnitOfWork(deps);
  const refused: { request: string; status: number; error: unknown }[] = [];
  for (const item of requests) {
    const answer: ApiResponse = await routeWorkbenchRequest(batchItemRequest(item, user === undefined ? {} : { user }), uow.deps);
    if (answer.status >= 400) refused.push({ request: `${item.method} ${item.path}`, status: answer.status, error: answer.body });
  }
  if (refused.length > 0) {
    const first = refused[0]!;
    const words = (first.error as { error?: string } | undefined)?.error ?? `status ${first.status}`;
    throw new Error(`${refused.length} of ${requests.length} proposed record(s) were refused; the first, ${first.request}: ${words}`);
  }
  try {
    const { keptDepictions } = await stageImportExtras(uow.deps, extras);
    for (const id of keptDepictions) summary.existing.push(`depictions/${id}`);
    if (summary.depictions !== undefined) summary.depictions = summary.depictions.filter((id) => !keptDepictions.includes(id));
    // a board whose Gerber art was just imported shows it on its 3D model: re-key the model's link (cs-5k1.29)
    for (const id of summary.depictions ?? []) {
      const link = await uow.deps.modelLinks?.get(`pcbas/${id}`);
      const next = link === undefined ? undefined : relinkWithArt(link, await boardArtFiles(uow.deps.depictions, id));
      if (next !== undefined) await uow.deps.modelLinks!.put(next);
    }
  } catch (error) {
    if (error instanceof ImportExtrasRefused) throw new Error(error.message);
    throw error;
  }
  // artwork (an SVG) is the only file an import plan carries as bytes
  if (uow.changes.some((c) => c.bytes !== undefined && c.kind !== 'depiction-asset')) throw new Error('the importer proposed binary files, which an import plan does not carry');
  const files = await planFiles(deps, uow.changes);
  await context.step(`planned ${uow.changes.length} change(s) to ${files.length} file(s)`);
  return {
    result: {
      importer: `${request.module}:${request.importer}`,
      fileName: request.fileName,
      notes: proposal.notes,
      proposed,
      proposal: summary,
      requests: requests.map((r) => `${r.method} ${r.path}`),
      changes: uow.changes.length,
      // the staged changes as JSON text: key order is data (a jsonb column would sort it, §12 R1)
      plan: planText(uow.changes),
      catalogVersion: (await deps.catalogVersion?.()) ?? null,
    },
    files,
  };
}

/** The staged changes of a finished import job, ready to commit. */
export function planChanges(result: Record<string, unknown> | undefined): RecordChange[] | undefined {
  const plan = result?.['plan'];
  if (typeof plan !== 'string') return undefined;
  const changes = JSON.parse(plan) as unknown;
  if (!Array.isArray(changes)) return undefined;
  return (changes as (RecordChange & { bytes?: unknown })[]).map((c) => {
    const packed = c.bytes as { $base64?: unknown } | undefined;
    return packed !== undefined && typeof packed === 'object' && typeof packed.$base64 === 'string' ? { ...c, bytes: new Uint8Array(Buffer.from(packed.$base64, 'base64')) } : (c as RecordChange);
  });
}

/** Commit a plan as one change set (the caller holds the write lock and maps a stale record to 409). */
export async function commitPlan(deps: WorkbenchDeps, changes: RecordChange[], context: { path: string; user?: StudioUser; message: string }): Promise<CommitResult> {
  const set = {
    changes,
    context: { method: 'POST', path: context.path, body: { message: context.message }, ...(context.user === undefined ? {} : { user: context.user }) },
  };
  const result = deps.commit !== undefined ? await deps.commit(set, new Set()) : await commitChangeSet(deps, set);
  if (deps.afterCommit !== undefined) await Promise.resolve(deps.afterCommit(set)).catch((error: unknown) => console.warn(`[jobs] after commit: ${error instanceof Error ? error.message : String(error)}`));
  return result;
}
