/**
 * `/api/firmware` — firmware projects linked to a board and its occurrences, and their compiles
 * (WF-FW first journey, `docs/firmware.md`).
 *
 * Records are catalog documents through the shared doc seam (`data/firmware/projects.json`, one
 * build history per project in `data/firmware/builds/<id>.json`), so the file and database
 * backends both keep them. Bytes — uploaded source, binaries, logs — are content-addressed in the
 * blob store (`store.ts`). A compile is a `firmware-compile` job (`job.ts`) that runs the `firmware-platformio` pack
 * through the shared tool-pack runner and never touches a device.
 */

import { createHash } from 'node:crypto';

import { isDesignId } from '@wirehub/catalog';
import { configProblems, effectiveConfig, isFirmwareId, type ConfigParams, type FirmwareBuild, type FirmwareProject, type FirmwareSourceFile } from '../../src/firmware.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { readAllDesigns } from '../designs.ts';
import { checkIfMatch, contentETag } from '../etag.ts';
import { jobView } from '../jobs/api.ts';
import { toolStageAvailability } from '../jobs/tool-stages.ts';
import type { JobRun } from '../jobs/types.ts';
import { commissionedShas, COMMISSION_ROUTES, handleCommissioningIndex, handleProjectCommissioning, RESERVED_FIRMWARE_IDS } from './commission.ts';
import { firmwareExamples } from './examples.ts';
import { buildsDoc, readBuilds, updateBuilds, type FirmwareJobRequest } from './job.ts';
import { firmwareBytes } from './store.ts';
import { firmwareTargets } from './targets.ts';

export const FIRMWARE_ROUTES = [
  'GET    /api/firmware',
  'PUT    /api/firmware',
  'GET    /api/firmware/targets',
  'GET    /api/firmware/occurrences',
  'GET    /api/firmware/:id',
  'POST   /api/firmware/:id/source',
  'POST   /api/firmware/:id/compile',
  'GET    /api/firmware/:id/files/:sha',
  ...COMMISSION_ROUTES,
] as const;

export const PROJECTS_DOC = 'data/firmware/projects.json';
export { buildsDoc };
const MAX_SOURCE_FILES = 200;

export { firmwareTargets };

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const SAFE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]{1,200}$/;

async function readProjects(deps: WorkbenchDeps): Promise<FirmwareProject[]> {
  const value = await deps.docs?.read(PROJECTS_DOC);
  return Array.isArray(value) ? (value as FirmwareProject[]) : [];
}
/**
 * The builds as shown: a build still queued or running is matched to its job, so one whose job
 * ended without it (interrupted by a restart, cancelled before it started, a job forgotten by an
 * in-memory store) reads as such, with the job's latest step while it runs.
 */
async function shownBuilds(deps: WorkbenchDeps, builds: FirmwareBuild[]): Promise<FirmwareBuild[]> {
  const open = builds.filter((b) => b.status === 'queued' || b.status === 'running');
  if (open.length === 0) return builds;
  const jobs = deps.jobs === undefined ? [] : await deps.jobs.list({ kind: 'firmware-compile', limit: 100 });
  const byBuild = new Map<string, JobRun>();
  for (const j of jobs) if (typeof j.request['build'] === 'string' && !byBuild.has(j.request['build'] as string)) byBuild.set(j.request['build'] as string, j);
  return builds.map((b) => {
    if (b.status !== 'queued' && b.status !== 'running') return b;
    const job = byBuild.get(b.id);
    if (job === undefined) return { ...b, status: 'error', message: 'Interrupted: the server stopped during this compile. Compile again.' };
    const view = { ...b, job: job.id, ...(job.steps.length === 0 ? {} : { progress: job.steps.at(-1)!.text }) };
    if (job.status === 'queued' || job.status === 'running') return { ...view, status: job.status };
    if (job.status === 'cancelled') return { ...view, status: 'cancelled', message: job.error ?? 'Cancelled.' };
    // the job finished but the build record was not updated (the process stopped in between)
    return { ...view, status: 'error', message: job.error ?? `The compile job ended (${job.status}) without a result. Compile again.` };
  });
}

/** `POST /api/firmware/:id/compile` is answered outside the request's unit of work (see updateBuilds). */
export function isFirmwareCompilePath(path: string, method: string): boolean {
  return method.toUpperCase() === 'POST' && /^\/api\/firmware\/[a-z0-9-]+\/compile$/.test(path.split('?')[0] ?? '');
}

/** Problems with one project record, in words. */
function projectProblems(p: unknown): string[] {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return ['A project must be an object.'];
  const r = p as Partial<FirmwareProject>;
  const out: string[] = [];
  if (typeof r.id !== 'string' || !isFirmwareId(r.id)) out.push('id: kebab-case, up to 80 characters.');
  else if ((RESERVED_FIRMWARE_IDS as readonly string[]).includes(r.id) || r.id === 'targets' || r.id === 'occurrences') out.push(`${r.id}: that id names a route; choose another.`);
  if (typeof r.label !== 'string' || r.label.trim() === '') out.push(`${r.id ?? '?'}: a label is needed.`);
  // an uncited source is a finding on a draft project (`projectFindings`), not a refusal; only its shape is checked
  if (r.src !== undefined && typeof r.src !== 'string') out.push(`${r.id ?? '?'}: src is text — where the source comes from.`);
  if (r.toolchain === undefined || !firmwareTargets().some((t) => t.id === r.toolchain?.target && t.pack === r.toolchain?.pack)) {
    out.push(`${r.id ?? '?'}: toolchain.target must be one of ${firmwareTargets().map((t) => t.id).join(', ')} with the pack that declares it.`);
  }
  if (!Array.isArray(r.source)) out.push(`${r.id ?? '?'}: source must be a list (empty until files are uploaded).`);
  out.push(...configProblems(r.params ?? {}).map((m) => `${r.id}: ${m}`));
  if (!Array.isArray(r.occurrences)) out.push(`${r.id ?? '?'}: occurrences must be a list.`);
  for (const o of r.occurrences ?? []) {
    if (typeof o?.design !== 'string' || !isDesignId(o.design) || typeof o.instance !== 'string') out.push(`${r.id}: each occurrence names a design and a board instance in it.`);
    else out.push(...configProblems(o.overrides ?? {}).map((m) => `${r.id} in ${o.design}/${o.instance}: ${m}`));
  }
  return out;
}

/** What a saved project still lacks — said, not refused (saving is not approval). */
function projectFindings(projects: readonly FirmwareProject[]): string[] {
  return projects.flatMap((p) => (typeof p.src !== 'string' || p.src.trim() === '' ? [`${p.id}: does not say where its source comes from yet.`] : []));
}

/** Each occurrence checked against its design: findings, never a refusal (a draft may point ahead). */
async function occurrenceFindings(deps: WorkbenchDeps, project: FirmwareProject): Promise<{ design: string; instance: string; problem?: string; designLabel?: string; instanceDef?: string }[]> {
  const out = [];
  for (const o of project.occurrences) {
    const design = isDesignId(o.design) ? await deps.designs.read(o.design) : undefined;
    const inst = design?.instances.pcbas.find((i) => i.id === o.instance);
    out.push({
      design: o.design,
      instance: o.instance,
      ...(design === undefined ? { problem: 'That design is not in the catalog.' } : { designLabel: design.label }),
      ...(design !== undefined && inst === undefined ? { problem: 'That design has no board instance with this id.' } : {}),
      ...(inst !== undefined && project.board !== undefined && inst.def !== project.board ? { problem: `That instance is a different board (${inst.def}).` } : {}),
      ...(inst === undefined ? {} : { instanceDef: inst.def }),
    });
  }
  return out;
}

export async function handleFirmwareRequest(request: ApiRequest, parts: string[], deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const [, , id, action, sha] = parts;
  if (deps.docs === undefined) return fail(501, 'This hub cannot store firmware projects.');
  const query = new URLSearchParams(request.path.split('?')[1]);

  if (id === undefined) {
    const projects = await readProjects(deps);
    const etag = contentETag(projects);
    if (method === 'GET') {
      const board = query.get('board');
      const design = query.get('design');
      const shown = projects.filter((p) => (board === null || p.board === board) && (design === null || p.occurrences.some((o) => o.design === design)));
      return { status: 200, body: { projects: shown, targets: firmwareTargets(), etag }, headers: { ETag: etag } };
    }
    if (method !== 'PUT') return fail(405, 'This address accepts GET and PUT.');
    const guard = checkIfMatch(request.headers?.['if-match'], etag, 'firmware projects', 'firmware');
    if (guard !== undefined) return guard;
    const body = request.body as { projects?: unknown } | undefined;
    if (!Array.isArray(body?.projects)) return fail(400, 'Send { projects: [...] }.');
    const next = body.projects as FirmwareProject[];
    const problems = next.flatMap(projectProblems);
    const ids = next.map((p) => p.id);
    if (new Set(ids).size !== ids.length) problems.push('Two projects share an id.');
    if (problems.length > 0) return { status: 400, body: { error: 'Some project values cannot be saved.', problems } };
    const sorted = [...next].map((p) => (p.src === undefined ? { ...p, src: '' } : p)).sort((a, b) => a.id.localeCompare(b.id));
    await deps.docs.write(PROJECTS_DOC, sorted);
    const tag = contentETag(sorted);
    const findings = projectFindings(sorted);
    return { status: 200, body: { projects: sorted, targets: firmwareTargets(), etag: tag, ...(findings.length === 0 ? {} : { findings }) }, headers: { ETag: tag } };
  }

  if (id === 'targets' && action === undefined) return method === 'GET' ? { status: 200, body: { targets: firmwareTargets() } } : fail(405, 'GET only.');
  if (id === 'occurrences' && action === undefined) {
    // every placement of a board (or of every board) in the designs: what an occurrence can point at
    if (method !== 'GET') return fail(405, 'GET only.');
    const board = query.get('board');
    const designs = await readAllDesigns(deps.designs);
    const rows = designs.flatMap((d) => d.instances.pcbas.filter((i) => board === null || i.def === board)
      .map((i) => ({ design: d.id, designLabel: d.label, instance: i.id, board: i.def, ...(i.note === undefined ? {} : { note: i.note }) })));
    return { status: 200, body: { occurrences: rows } };
  }
  const index = await handleCommissioningIndex(request, id, deps, () => readProjects(deps));
  if (index !== undefined) return index;
  if (!isFirmwareId(id)) return fail(404, 'There is no firmware project at this address.');
  const projects = await readProjects(deps);
  const project = projects.find((p) => p.id === id);
  if (project === undefined) return fail(404, 'That firmware project does not exist.');

  if (action === undefined) {
    if (method !== 'GET') return fail(405, 'GET only; save projects with PUT /api/firmware.');
    const db = await deps.loadDb();
    const board = project.board === undefined ? undefined : db.pcbas.find((b) => b.id === project.board);
    return { status: 200, body: {
      project,
      builds: await shownBuilds(deps, await readBuilds(deps, id)),
      occurrences: await occurrenceFindings(deps, project),
      board: project.board === undefined ? null : board === undefined ? { id: project.board, missing: true } : { id: board.id, label: board.label ?? board.id },
      targets: firmwareTargets(),
      // the pack's synthetic examples, offered while the project has no source
      ...(project.source.length === 0 ? { examples: firmwareExamples(project.toolchain.pack, project.toolchain.target) } : {}),
      etag: contentETag(projects),
    } };
  }

  if (action === 'files' && sha !== undefined) {
    if (method !== 'GET') return fail(405, 'GET only.');
    if (!/^[0-9a-f]{64}$/.test(sha)) return fail(400, 'Not a content address.');
    const builds = await readBuilds(deps, id);
    const known = project.source.find((s) => s.sha256 === sha)
      ?? (await commissionedShas(deps, id)).find((c) => c.sha256 === sha)
      ?? builds.flatMap((b) => [...b.outputs, ...(b.log === undefined ? [] : [{ path: 'log.txt', sha256: b.log, mediaType: 'text/plain', role: 'log', bytes: 0 }])]).find((o) => o.sha256 === sha);
    if (known === undefined) return fail(404, 'This project names no such file.');
    const bytes = await firmwareBytes().get(sha);
    if (bytes === undefined) return fail(404, 'The bytes of that file are no longer stored.');
    const name = known.path.split('/').pop() ?? 'file';
    const text = name.endsWith('.txt') || name.endsWith('.json');
    return { status: 200, body: null, bytes, contentType: text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      headers: { 'content-disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable' } };
  }

  if (action === 'source' && method === 'POST') {
    // replace the project's source with these files: { files: [{ path, base64 }], etag }
    const body = request.body as { files?: { path?: unknown; base64?: unknown }[] } | undefined;
    if (!Array.isArray(body?.files) || body.files.length === 0 || body.files.length > MAX_SOURCE_FILES) return fail(400, `Send { files: [{ path, base64 }] } with 1 to ${MAX_SOURCE_FILES} files.`);
    const guard = checkIfMatch(request.headers?.['if-match'], contentETag(projects), 'firmware projects', id);
    if (guard !== undefined) return guard;
    const source: FirmwareSourceFile[] = [];
    for (const f of body.files) {
      if (typeof f.path !== 'string' || !SAFE_PATH.test(f.path) || typeof f.base64 !== 'string') return fail(400, `A file needs a relative path (letters, digits, _ . / -) and base64 bytes: ${String(f.path)}`);
      const bytes = Buffer.from(f.base64, 'base64');
      const digest = sha256(bytes);
      await firmwareBytes().put(digest, bytes);
      source.push({ path: f.path, sha256: digest, bytes: bytes.length });
    }
    source.sort((a, b) => a.path.localeCompare(b.path));
    const next = projects.map((p) => (p.id === id ? { ...p, source } : p));
    await deps.docs.write(PROJECTS_DOC, next);
    const tag = contentETag(next);
    return { status: 200, body: { project: { ...project, source }, etag: tag }, headers: { ETag: tag } };
  }

  if (action !== undefined) {
    const commissioning = await handleProjectCommissioning(request, project, action, parts.slice(4), deps, () => readBuilds(deps, id));
    if (commissioning !== undefined) return commissioning;
  }

  return fail(405, 'Not an action of a firmware project.', `Try one of: ${FIRMWARE_ROUTES.join('; ')}.`);
}

/** Starts a compile: records the build as queued and enqueues its `firmware-compile` job (202). */
export async function handleFirmwareCompile(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This hub cannot store firmware projects.');
  if (request.user?.role === 'viewer') return fail(403, 'Viewers cannot start compiles.');
  const id = (request.path.split('?')[0] ?? '').split('/')[3] ?? '';
  const project = (await readProjects(deps)).find((p) => p.id === id);
  if (project === undefined) return fail(404, 'That firmware project does not exist.');
  const body = (request.body ?? {}) as { occurrence?: { design?: unknown; instance?: unknown }; network?: unknown };
  let occurrence: { design: string; instance: string } | undefined;
  if (body.occurrence !== undefined) {
    const o = body.occurrence;
    const found = project.occurrences.find((x) => x.design === o.design && x.instance === o.instance);
    if (found === undefined) return fail(400, 'That occurrence is not linked to this project.');
    occurrence = { design: found.design, instance: found.instance };
  }
  if (project.source.length === 0) return fail(409, 'Upload the firmware source first.');
  const defines: ConfigParams = effectiveConfig(project, occurrence);
  const problems = configProblems(defines);
  if (problems.length > 0) return { status: 400, body: { error: 'The configuration cannot be passed to the build.', problems } };
  const available = await toolStageAvailability(deps, 'firmware-compile', process.env, project.toolchain.target);
  if (!available.ok) return fail(503, 'Compiles cannot run on this hub right now.', available.reason);
  const network = body.network === true;
  const startedAt = new Date().toISOString();
  const build: FirmwareBuild = {
    id: `${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${sha256(Buffer.from(`${id}${startedAt}${Math.random()}`)).slice(0, 6)}`,
    project: id, startedAt, status: 'queued', network, ...(occurrence === undefined ? {} : { occurrence }),
    effective: { target: project.toolchain.target, ...(project.toolchain.environment === undefined ? {} : { environment: project.toolchain.environment }), defines, source: project.source },
    outputs: [], findings: [],
  };
  await updateBuilds(deps, id, (all) => [build, ...all]);
  const jobRequest: FirmwareJobRequest = {
    project: id, build: build.id, target: build.effective.target, ...(build.effective.environment === undefined ? {} : { environment: build.effective.environment }),
    defines, source: project.source, network, ...(occurrence === undefined ? {} : { occurrence, design: occurrence.design }),
  };
  let job: JobRun;
  try {
    job = await deps.jobs!.enqueue('firmware-compile', { ...jobRequest }, request.user);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateBuilds(deps, id, (all) => all.map((b) => (b.id === build.id ? { ...b, status: 'error', message: `The compile could not be queued: ${message}`, finishedAt: new Date().toISOString() } : b)));
    return fail(503, 'The compile could not be queued.', message);
  }
  return { status: 202, body: { build: { ...build, job: job.id }, job: jobView(job) }, headers: { Location: `/api/jobs/${job.id}` } };
}
