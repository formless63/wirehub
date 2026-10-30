/**
 * Enclosure endpoints (WF-MECH). The design inputs live on the shell record itself
 * (`mechanicals/<id>.enclosure`, saved through the ordinary definitions API, so locks, history and
 * revisions apply); these routes read native board geometry and run the generator.
 *
 *   GET  /api/enclosures/boards/:pcba/geometry   the board's native outline, holes, footprints, suggested ports
 *   GET  /api/enclosures/:id                      the last generation (inputs, findings, outputs) and board sources
 *   POST /api/enclosures/:id/generate             queue an `enclosure-generate` job on the record's current inputs (202)
 *
 * The job (`job.ts`) runs the `enclosure` tool pack through the shared runner, with progress and
 * Cancel (`POST /api/jobs/:id/cancel`). A generation stores its outputs as assets (STEP, STL, GLB, PNG), links the GLB as the shell's
 * 3D model (`sourceKind: 'generated'`), and records the run — exact inputs (the spec, the board
 * sources' hashes, the request's hash), tool identity and findings — at `data/enclosures/<id>.json`,
 * all in one change set. The pack runs in the job, outside any lock: a slow solid never blocks edits.
 */

import type { EnclosureSpec, MechanicalDefinition } from '@wirehub/model';

import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { contentETag } from '../etag.ts';
import { boardOutputsAvailability, boardSource, designOfBody, handleToolOutputsRequest } from '../jobs/board-outputs.ts';
import { jobView } from '../jobs/api.ts';
import { toolStageAvailability } from '../jobs/tool-stages.ts';
import { sha256Hex } from '../models/cache.ts';
import { MODEL_SOURCES_DIR } from '../models/links.ts';
import { nativeBoardGeometry, nativeFacts, withFacts, type NativeBoardGeometry } from './board-geometry.ts';
import { glbHeights, type GlbHeights } from './glb-heights.ts';
import { enclosureRunPath, type EnclosureJobRequest, type EnclosureOutput, type EnclosureRun } from './job.ts';
import { buildEnclosureRequest, type NativeLookup } from './request.ts';

export const ENCLOSURE_ROUTES = [
  'GET    /api/enclosures/boards/:pcba/geometry',
  'GET    /api/enclosures/:id',
  'POST   /api/enclosures/:id/generate',
] as const;

export { enclosureRunPath, type EnclosureOutput, type EnclosureRun };

export function isEnclosurePath(path: string): boolean {
  const head = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  return head === '/api/enclosures' || head.startsWith('/api/enclosures/');
}

const RECORD_ID = /^[a-z0-9]+(?:-[a-z0-9]+|(?<=\d)\.\d[a-z0-9]*)*$/;
const fail = (status: number, error: string, hint?: string, extra?: Record<string, unknown>): ApiResponse =>
  ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });
const ok = (body: unknown, headers?: Record<string, string>): ApiResponse => ({ status: 200, body, ...(headers === undefined ? {} : { headers }) });

/** The board's native geometry, from the KiCad board file its 3D model was built from. */
export function nativeLookupOf(deps: WorkbenchDeps): NativeLookup {
  return async (pcba) => {
    const link = await deps.modelLinks?.get(`pcbas/${pcba}`);
    let file = link?.sourceKind === 'kicad-board' ? link.files?.find((f) => f.path.startsWith(`${MODEL_SOURCES_DIR}/`)) : undefined;
    // else the board file this hub keeps for the board, as native outputs find it: the one kept when it
    // was imported (its art cites the hash, until Gerber art replaces it), else the one its newest native output ran from
    if (file === undefined) file = (await boardSource(deps, pcba)).stored;
    if (file === undefined) return { missing: 'it has no KiCad board file (upload one on the board\'s 3D tab).' };
    const text = await deps.docs?.read(file.path);
    if (typeof text !== 'string') return { missing: 'its KiCad board file is not stored on this hub.' };
    if (sha256Hex(new TextEncoder().encode(text)) !== file.sha256) return { missing: 'its stored KiCad board file does not match the hash its model was built from.' };
    try {
      const read = nativeBoardGeometry(text);
      const glb = await exportedHeights(deps, pcba, file.sha256);
      const geometry = glb === undefined ? read : withFacts(read, nativeFacts(read, glb));
      return { geometry, source: { path: file.path, sha256: file.sha256 }, exported: glb !== undefined };
    } catch (error) {
      return { missing: `its KiCad board file could not be read (${error instanceof Error ? error.message : String(error)}).` };
    }
  };
}

/**
 * Part heights from the board's own 3D export: the newest ok `board-3d` run of the `kicad` pack
 * (`jobs/board-outputs.ts`), preferring one made from the same board file.
 */
async function exportedHeights(deps: WorkbenchDeps, pcba: string, sourceSha: string): Promise<{ heights: GlbHeights['heights']; label: string } | undefined> {
  if (deps.toolOutputs === undefined) return undefined;
  const runs = (await deps.toolOutputs.runs(`pcbas/${pcba}`, { limit: 20 })).filter((r) => r.op === 'board-3d' && r.status === 'ok');
  const run = runs.find((r) => r.sources.some((s) => s.sha256 === sourceSha)) ?? runs[0];
  const output = run?.outputs.find((o) => o.role === 'model-glb');
  if (run === undefined || output === undefined) return undefined;
  const file = await deps.toolOutputs.file(output.sha256);
  const read = file === undefined ? undefined : glbHeights(file.bytes);
  if (read === undefined) return undefined;
  const same = run.sources.some((s) => s.sha256 === sourceSha);
  return { heights: read.heights, label: `${run.tool.name} ${run.tool.version} board.glb${same ? '' : ', made from another revision of the board file'}` };
}

export async function handleEnclosureRequest(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '');
  const [, , a, b, c] = parts;
  const native = nativeLookupOf(deps);

  if (a === 'boards') {
    if (method !== 'GET' || c !== 'geometry' || b === undefined || !RECORD_ID.test(b) || parts.length !== 5) return fail(404, 'There is nothing at that address.', ENCLOSURE_ROUTES.join('; '));
    const db = await deps.loadDb();
    if (!db.pcbas.some((p) => p.id === b)) return fail(404, `There is no board '${b}'.`);
    const found = await native(b);
    if ('missing' in found) return ok({ pcba: b, geometry: null, missing: `This board has no native outline: ${found.missing}` });
    return ok({ pcba: b, geometry: found.geometry, source: found.source });
  }

  if (a === undefined || !RECORD_ID.test(a) || parts.length > 4) return fail(404, 'There is nothing at that address.', ENCLOSURE_ROUTES.join('; '));
  const db = await deps.loadDb();
  const record = (db.mechanicals ?? []).find((m) => m.id === a);
  if (record === undefined) return fail(404, `There is no shell '${a}'.`);

  if (method === 'GET' && b === undefined) {
    const run = ((await deps.docs?.read(enclosureRunPath(a))) ?? null) as EnclosureRun | null;
    const boards: Record<string, { geometry: NativeBoardGeometry; source: { path: string; sha256: string } } | { missing: string }> = {};
    for (const board of record.enclosure?.boards ?? []) if (board.geometry === 'native') boards[board.pcba] = await native(board.pcba);
    // the newest generation job of this shell: progress and Cancel while it runs, its error after
    const jobs = deps.jobs === undefined || !deps.jobs.kinds.includes('enclosure-generate') ? [] : await deps.jobs.list({ kind: 'enclosure-generate', limit: 50 });
    const job = jobs.find((j) => j.request['enclosure'] === a);
    const available = await toolStageAvailability(deps, 'enclosure-generate');
    return ok({ id: a, run, boards, available, job: job === undefined ? null : jobView(job) }, { ETag: contentETag(run) });
  }

  if (method === 'POST' && b === 'generate' && parts.length === 4) {
    if (request.user?.role === 'viewer') return fail(403, 'Generating replaces the shell\'s outputs; your role can view them.', 'Ask an owner for the editor role.');
    return generate(a, record, request, deps, native);
  }
  return fail(405, `${method} is not something this address accepts.`, ENCLOSURE_ROUTES.join('; '));
}

async function generate(id: string, record: MechanicalDefinition, request: ApiRequest, deps: WorkbenchDeps, native: NativeLookup): Promise<ApiResponse> {
  const spec = record.enclosure;
  if (spec === undefined) return fail(400, `${record.label} has no enclosure parameters.`, 'Add a board in the enclosure panel and save first.');
  if (deps.assets === undefined || deps.modelLinks === undefined || deps.docs === undefined) return fail(501, 'This hub cannot keep generated models.');
  const available = await toolStageAvailability(deps, 'enclosure-generate');
  if (!available.ok) return fail(503, 'Enclosures cannot be generated on this hub right now.', `${available.reason ?? ''} Saving the parameters still works.`.trim());
  const running = (await deps.jobs!.list({ kind: 'enclosure-generate', limit: 50 })).find((j) => j.request['enclosure'] === id && (j.status === 'queued' || j.status === 'running'));
  if (running !== undefined) return fail(409, 'This shell is being generated already.', 'Wait for it, or cancel it first.');
  const db = await deps.loadDb();
  const built = await buildEnclosureRequest(spec, db.pcbas, native);
  if (built.usable.length === 0 || (built.params['occurrences'] as unknown[]).length === 0) {
    return fail(422, 'Nothing to enclose yet.', 'Pick a board with a KiCad board file, or declare its width and length, and place at least one occurrence.', { findings: built.findings });
  }
  const by = request.user?.name ?? deps.localUser?.name;
  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const design = designOfBody(body);
  // a native board without its own 3D export reads part heights from footprint names: export it first
  const board3d = await queueBoard3d(spec, request, deps, native);
  // the request is built here, from the record as the person saved it: the worker runs exactly this
  // (after a queued board 3D export it is built again from the same record, with the exported heights)
  const jobRequest: EnclosureJobRequest = {
    enclosure: id, label: record.label, params: built.params, spec, sources: built.sources, findings: built.findings,
    ...(by === undefined ? {} : { by }), ...(design === undefined ? {} : { design }), ...(board3d.length === 0 ? {} : { board3d }),
  };
  const job = await deps.jobs!.enqueue('enclosure-generate', { ...jobRequest }, request.user);
  return { status: 202, body: { id, job: jobView(job), findings: built.findings }, headers: { Location: `/api/jobs/${job.id}` } };
}

/**
 * Queue a `board-3d` export for each native board the shell holds that has a stored KiCad source but
 * no 3D export yet, so its tall parts read real heights. Nothing is queued where board outputs cannot
 * run; a board already being exported is waited for rather than queued twice. The job ids, for the
 * generation to wait on.
 */
async function queueBoard3d(spec: EnclosureSpec, request: ApiRequest, deps: WorkbenchDeps, native: NativeLookup): Promise<{ pcba: string; job: string }[]> {
  if (!(await boardOutputsAvailability(deps)).ok) return [];
  const out: { pcba: string; job: string }[] = [];
  const running = (await deps.jobs!.list({ kind: 'board-outputs', limit: 50 })).filter((j) => j.status === 'queued' || j.status === 'running');
  for (const b of new Set(spec.boards.filter((x) => x.geometry === 'native').map((x) => x.pcba))) {
    const found = await native(b);
    if ('missing' in found || found.exported === true) continue;
    const already = running.find((j) => j.request['board'] === b && ((j.request['ops'] as string[] | undefined) ?? []).includes('board-3d'));
    if (already !== undefined) { out.push({ pcba: b, job: already.id }); continue; }
    const started = await handleToolOutputsRequest({ ...request, method: 'POST', path: `/api/tool-outputs/pcbas/${b}`, body: { ops: ['board-3d'] } }, deps);
    const job = (started.body as { job?: { id?: string } } | null)?.job?.id;
    if (started.status === 202 && job !== undefined) out.push({ pcba: b, job });
  }
  return out;
}
