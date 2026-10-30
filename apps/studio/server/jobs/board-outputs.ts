/**
 * Board outputs: one native board → artifact stage through the job seam
 * (`docs/jobs-and-tool-packs.md`). A person asks for outputs on a KiCad board
 * record; the studio pins the exact native source (sha256, preserved as a
 * catalog document) and enqueues a `board-outputs` job; the worker runs the
 * `kicad` tool pack's ops (`tools/kicad/`) through the tool runner and
 * registers each op's verified outputs against the board, its source hash and
 * the tool version (`tools/outputs.ts`).
 *
 *   GET  /api/tool-outputs/pcbas/:id            runs, source state, whether the stage can run
 *   POST /api/tool-outputs/pcbas/:id            { ops?, fileName?, base64?, schematics? } — start (202, the job)
 *   GET  /api/tool-outputs/runs/:runId/log      a run's log (text)
 *
 * Output bytes download through `GET /api/blobs/:sha` (named after the file).
 */

import { createHash } from 'node:crypto';

import { parseDepictionMeta } from '@wirehub/catalog';

import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { commitUnit, publishCatalog } from '../catalog-commit.ts';
import type { BlobStore } from '../blobs.ts';
import { isDepictionDefId } from '../depictions.ts';
import { MODEL_SOURCES_DIR } from '../models/links.ts';
import { UnitOfWork } from '../storage/unit-of-work.ts';
import { withWriteLock } from '../storage/write-lock.ts';
import { TOOL_PACKS, toolOperationName } from '../tools/packs.ts';
import { latestByOp, type ToolOutputStore, type ToolRunRecord } from '../tools/outputs.ts';
import { isSchematicFileName, schematicDocPath as sheetDocPath, schematicNameOf } from './schematic-names.ts';
import { ToolRunError, type ToolRunner } from '../tools/runner.ts';
import { jobView } from './api.ts';
import { cancelSignal } from './cancel-signal.ts';
import { toolStageAvailability } from './tool-stage-availability.ts';
import { MAX_IMPORT_BYTES, type ImportInput } from './import.ts';
import type { JobContext, JobOutcome, JobRun } from './types.ts';

export const BOARD_OUTPUT_ROUTES = [
  'GET    /api/tool-outputs/pcbas/:id',
  'POST   /api/tool-outputs/pcbas/:id',
  'GET    /api/tool-outputs/runs/:runId/log',
] as const;

const PACK = 'kicad';
const OPS = Object.keys(TOOL_PACKS[PACK]!.ops);
/** what Generate makes when no ops are named: the outputs, not the `netlist` check */
const OUTPUT_OPS = OPS.filter((op) => op !== 'netlist');
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const sourceDocPath = (sha: string): string => `${MODEL_SOURCES_DIR}/${sha}.kicad_pcb.txt`;
/** a schematic sheet keeps its file name for the tool (the root sheet names its sub-sheets by it); its document is named safely (`schematic-names.ts`) */
const schematicDocPath = (sha: string, fileName: string): string => sheetDocPath(MODEL_SOURCES_DIR, sha, fileName);

export interface SchematicSource {
  role: 'kicad-sch';
  path: string;
  sha256: string;
  fileName: string;
  input?: ImportInput;
}

export interface BoardOutputsRequest {
  board: string;
  record: string;
  identity: { revision?: string; build?: string };
  pack: string;
  packVersion: string;
  ops: string[];
  source: { role: 'kicad-pcb'; path: string; sha256: string; fileName?: string; input?: ImportInput };
  /** the schematic sheets the `netlist` op reads beside the board */
  schematics?: SchematicSource[];
}

/** `{ design: id | { id, rev } }` in a start request: the design a run is made for. */
export function designOfBody(body: Record<string, unknown>): string | { id: string; rev?: number } | undefined {
  const d = body['design'];
  if (typeof d === 'string' && /^[a-z0-9][a-z0-9.-]{0,127}$/.test(d)) return d;
  if (typeof d === 'object' && d !== null && typeof (d as { id?: unknown }).id === 'string') {
    const { id, rev } = d as { id: string; rev?: unknown };
    return { id, ...(Number.isInteger(rev) && (rev as number) >= 0 ? { rev: rev as number } : {}) };
  }
  return undefined;
}

export function isToolOutputsPath(path: string): boolean {
  return /^\/api\/tool-outputs(\/|$)/.test(path.split('?')[0] ?? '');
}

/* ------------------------------------------------------------------ *
 * The worker's side: the job
 * ------------------------------------------------------------------ */

export interface BoardOutputsJobOptions {
  deps: WorkbenchDeps;
  runner: ToolRunner;
  outputs: ToolOutputStore;
  blobs?: BlobStore;
  /** how often a running op looks for a cancellation, ms (default 1000) */
  pollMs?: number;
}

async function sourceBytes(source: { path: string; sha256: string; input?: ImportInput }, deps: WorkbenchDeps, blobs: BlobStore | undefined): Promise<Uint8Array> {
  let bytes: Uint8Array | undefined;
  if (source.input !== undefined) {
    const input = source.input;
    if ('base64' in input) bytes = new Uint8Array(Buffer.from(input.base64, 'base64'));
    else if (blobs !== undefined) bytes = await blobs.get(input.key).then((b) => (b === undefined ? undefined : new Uint8Array(b)));
  }
  if (bytes === undefined) {
    const text = await deps.docs?.read(source.path);
    if (typeof text === 'string') bytes = new TextEncoder().encode(text);
  }
  if (bytes === undefined) throw new Error(`the source ${source.path} is not stored any more; upload the file again`);
  if (sha256(bytes) !== source.sha256) throw new Error(`the board source does not match its recorded sha256 ${source.sha256.slice(0, 12)}…; nothing was run`);
  return bytes;
}

export async function runBoardOutputsJob(context: JobContext, options: BoardOutputsJobOptions): Promise<JobOutcome> {
  const request = context.job.request as unknown as BoardOutputsRequest;
  if (typeof request.board !== 'string' || !Array.isArray(request.ops) || request.source?.role !== 'kicad-pcb') throw new Error('the board-outputs job has no board, ops or source');
  const bytes = await sourceBytes(request.source, options.deps, options.blobs);
  await context.step(`Board source file verified`);
  const sheets: { source: SchematicSource; bytes: Uint8Array }[] = [];
  if (request.ops.includes('netlist')) {
    for (const sheet of request.schematics ?? []) sheets.push({ source: sheet, bytes: await sourceBytes(sheet, options.deps, options.blobs) });
    if (sheets.length > 0) await context.step(`schematic ${sheets.map((s) => s.source.fileName).join(', ')} verified`);
  }
  const done: { op: string; runId: string; status: string; outputs: number; findings: number }[] = [];
  const failures: string[] = [];
  for (const op of request.ops) {
    if (await context.cancelled?.()) throw new Error('cancelled');
    const cancel = cancelSignal(context, options.pollMs);
    await context.step(`${toolOperationName(request.pack, op)}: running`);
    try {
      const withSheets = op === 'netlist' ? sheets : [];
      const inputs = [{ path: 'board.kicad_pcb', bytes }, ...withSheets.map((s) => ({ path: `sch/${s.source.fileName}`, bytes: s.bytes }))];
      const result = await options.runner.run({ pack: request.pack, op, params: {}, inputs, signal: cancel.signal, jobId: context.job.id });
      const m = result.manifest;
      const run = await options.outputs.register(
        {
          jobId: context.job.id,
          record: request.record,
          identity: request.identity,
          sources: [{ role: 'kicad-pcb', path: request.source.path, sha256: request.source.sha256 }, ...withSheets.map((s) => ({ role: 'kicad-sch', path: s.source.path, sha256: s.source.sha256, fileName: s.source.fileName }))],
          pack: m.pack,
          packVersion: m.packVersion,
          image: result.image.ref,
          imageId: result.image.id,
          tool: m.tool,
          op,
          params: {},
          status: m.status,
          findings: m.findings,
          outputs: m.outputs.map((o) => ({ path: o.path, role: o.role, mediaType: o.mediaType, size: result.files.get(o.path)!.byteLength, sha256: o.sha256 })),
          durationMs: result.durationMs,
          log: result.log,
        },
        result.files,
      );
      done.push({ op, runId: run.id, status: m.status, outputs: run.outputs.length, findings: m.findings.length });
      const notes = m.findings.filter((f) => f.level !== 'info').map((f) => `${f.level}: ${f.message}`);
      await context.step(`${toolOperationName(request.pack, op)}: ${m.status}, ${run.outputs.length} output(s) in ${Math.round(result.durationMs / 100) / 10} s (${m.tool.name} ${m.tool.version})${notes.length === 0 ? '' : ` — ${notes.join('; ')}`}`);
      if (m.status === 'failed') failures.push(`${op}: ${m.findings.filter((f) => f.level === 'error').map((f) => f.message).join('; ') || 'failed'}`);
    } catch (error) {
      if (error instanceof ToolRunError && error.code === 'cancelled') throw error;
      const message = error instanceof Error ? error.message : String(error);
      await context.step(`${toolOperationName(request.pack, op)}: ${message}`);
      failures.push(`${op}: ${message}`);
      // a missing image or an unreachable Docker fails every op the same way
      if (error instanceof ToolRunError && (error.code === 'image-missing' || error.code === 'docker')) break;
    } finally {
      cancel.done();
    }
  }
  if (failures.length > 0 && done.every((d) => d.status !== 'ok')) throw new Error(failures.join(' · '));
  return { result: { board: request.board, source: request.source.sha256, pack: request.pack, packVersion: request.packVersion, runs: done, ...(failures.length === 0 ? {} : { failures }) } };
}

/* ------------------------------------------------------------------ *
 * The studio's side: the API
 * ------------------------------------------------------------------ */

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });

/** Whether a worker (or this process) runs the stage: the worker's heartbeat lists the queue it works. */
export async function boardOutputsAvailability(deps: WorkbenchDeps, env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ ok: boolean; reason?: string }> {
  if (deps.toolOutputs === undefined) return { ok: false, reason: 'Native tool outputs need the database backend (WIREHUB_BACKEND=pg) with a blob store.' };
  return toolStageAvailability(deps, 'board-outputs', env);
}

/** The board's native KiCad source as this hub keeps it: the imported file's hash, and whether its text is stored. */
export async function boardSource(deps: WorkbenchDeps, id: string): Promise<{ imported?: string; stored?: { path: string; sha256: string }; art?: string }> {
  let imported: string | undefined;
  let art: string | undefined;
  const raw = await deps.depictions?.readMeta(id);
  if (raw !== undefined) {
    const meta = parseDepictionMeta(raw, `tool-outputs/${id}`).meta;
    imported = meta?.sources?.find((s) => s.role === 'kicad-pcb')?.sha256;
    // what the board's art is drawn from now (`kicad` preview, `gerber` …): the page offers generated Gerbers when it is not Gerber art
    art = meta?.views['board-top']?.sourceKind;
  }
  const candidates: { path: string; sha256: string }[] = [];
  if (imported !== undefined) candidates.push({ path: sourceDocPath(imported), sha256: imported });
  const link = await deps.modelLinks?.get(`pcbas/${id}`);
  if (link?.sourceKind === 'kicad-board') {
    const file = link.files?.find((f) => f.path.startsWith(`${MODEL_SOURCES_DIR}/`) && f.path.endsWith('.kicad_pcb.txt'));
    if (file !== undefined) candidates.push({ path: file.path, sha256: file.sha256 });
  }
  // else the file the newest run was made from (a file chosen at Generate is stored too)
  for (const run of (await deps.toolOutputs?.runs(`pcbas/${id}`)) ?? []) {
    const used = run.sources.find((src) => src.role === 'kicad-pcb' && src.path.startsWith(`${MODEL_SOURCES_DIR}/`));
    if (used !== undefined) {
      candidates.push({ path: used.path, sha256: used.sha256 });
      break;
    }
  }
  const facts = { ...(imported === undefined ? {} : { imported }), ...(art === undefined ? {} : { art }) };
  for (const c of candidates) {
    if (typeof (await deps.docs?.read(c.path)) === 'string') return { ...facts, stored: c };
  }
  return facts;
}

function runView(run: ToolRunRecord): Record<string, unknown> {
  return { ...run, outputs: run.outputs.map((o) => ({ ...o, href: `/api/blobs/${o.sha256}` })), logHref: `/api/tool-outputs/runs/${run.id}/log` };
}

export async function handleToolOutputsRequest(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '').map((p) => decodeURIComponent(p));
  const [, , kind, id, action, ...rest] = parts;
  if (kind === 'runs' && id !== undefined && action === 'log' && rest.length === 0) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const log = await deps.toolOutputs?.log(id);
    if (log === undefined) return fail(404, 'There is no such tool run.');
    return { status: 200, body: null, bytes: new TextEncoder().encode(log), contentType: 'text/plain; charset=utf-8', headers: { 'x-content-type-options': 'nosniff' } };
  }
  if (kind !== 'pcbas' || !isDepictionDefId(id) || action !== undefined) return fail(404, 'There is nothing at that address.', BOARD_OUTPUT_ROUTES.join('; '));
  const board = (await deps.loadDb()).pcbas.find((b) => b.id === id);
  if (board === undefined) return fail(404, 'That board is not in the library.');
  const record = `pcbas/${id}`;
  const identity = { ...(board.revision === undefined ? {} : { revision: board.revision }), ...(board.build === undefined ? {} : { build: board.build }) };

  if (method === 'GET') {
    const available = await boardOutputsAvailability(deps);
    const source = await boardSource(deps, id);
    const runs = deps.toolOutputs === undefined ? [] : await deps.toolOutputs.runs(record);
    const jobs = deps.jobs === undefined ? [] : (await deps.jobs.list({ kind: 'board-outputs', limit: 20 })).filter((j) => (j.request as Partial<BoardOutputsRequest>).board === id);
    return {
      status: 200,
      body: {
        record, identity, pack: { ...TOOL_PACKS[PACK], ops: TOOL_PACKS[PACK]!.ops }, available, source,
        latest: latestByOp(runs).map(runView), runs: runs.map(runView), jobs: jobs.slice(0, 5).map(jobView),
      },
    };
  }
  if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and POST.');
  if (request.user?.role === 'viewer') return fail(403, 'Viewers cannot start jobs.');
  const available = await boardOutputsAvailability(deps);
  if (!available.ok) return fail(503, 'Board outputs cannot run on this hub right now.', available.reason);
  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const ops = body['ops'] === undefined ? OUTPUT_OPS : body['ops'];
  if (!Array.isArray(ops) || ops.length === 0 || !ops.every((op) => typeof op === 'string' && OPS.includes(op))) return fail(400, `Say which outputs to make: some of ${OPS.join(', ')}.`);
  const jobs = deps.jobs!;

  let source: BoardOutputsRequest['source'];
  const notes: string[] = [];
  const known = await boardSource(deps, id);
  if (typeof body['base64'] === 'string') {
    const fileName = body['fileName'];
    if (typeof fileName !== 'string' || !/^[^\\/\0]{1,200}\.kicad_pcb$/i.test(fileName.trim())) return fail(400, 'Send the board as { "fileName": "….kicad_pcb", "base64": … }.');
    const bytes = new Uint8Array(Buffer.from(body['base64'], 'base64'));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORT_BYTES) return fail(413, 'That file is empty or too big for a board.');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!/^\s*\(kicad_pcb\b/.test(text)) return fail(422, `${fileName} is not a KiCad board file.`, 'Pick the .kicad_pcb the board was designed in.');
    // stored exactly as its text, so the hash is the hash of what a run reads back
    const stored = new TextEncoder().encode(text);
    const sha = sha256(stored);
    const path = sourceDocPath(sha);
    if (known.imported !== undefined && known.imported !== sha) notes.push(`This file differs from the one the board was imported from (${known.imported.slice(0, 12)}…); outputs are recorded against ${sha.slice(0, 12)}….`);
    // the original is kept as a catalog document (one change set), so a later run can repeat it exactly
    if (typeof (await deps.docs?.read(path)) !== 'string') {
      const saved = await withWriteLock(async () => {
        const uow = new UnitOfWork(deps);
        await uow.deps.docs!.write(path, text);
        const response = await commitUnit(uow, { method: 'POST', path: request.path, ...(request.user === undefined ? {} : { user: request.user }) }, { status: 200, body: {} });
        if (response.status < 400 && uow.changes.length > 0) await publishCatalog(deps);
        return response;
      });
      if (saved.status >= 400) return saved;
    }
    // the job reads the staged bytes, so it never races the catalog notification
    const input = (await jobs.stageInput(stored)) as ImportInput;
    source = { role: 'kicad-pcb', path, sha256: sha, fileName: fileName.trim(), input };
  } else if (known.stored !== undefined) {
    source = { role: 'kicad-pcb', path: known.stored.path, sha256: known.stored.sha256 };
  } else {
    return fail(409, 'This board has no stored KiCad source yet.', 'Choose its .kicad_pcb file: it is kept with the board and every output records its hash.');
  }
  let schematics: SchematicSource[] | undefined;
  if ((ops as string[]).includes('netlist')) {
    const picked = await schematicSources(body['schematics'], id, request, deps);
    if ('status' in picked) return picked;
    schematics = picked.sources;
  }
  const jobRequest: BoardOutputsRequest = { board: id, record, identity, pack: PACK, packVersion: TOOL_PACKS[PACK]!.version, ops: ops as string[], source, ...(schematics === undefined || schematics.length === 0 ? {} : { schematics }) };
  // a run made for a design names it, so the job records the design's effective inputs (`effective-inputs.ts`)
  const design = designOfBody(body);
  const job: JobRun = await jobs.enqueue('board-outputs', { ...jobRequest, ...(design === undefined ? {} : { design }) }, request.user);
  return { status: 202, body: { job: jobView(job), notes }, headers: { Location: `/api/jobs/${job.id}` } };
}

/**
 * The schematic sheets for a `netlist` run: the files sent (`[{ fileName, base64 }]`, each kept as a
 * catalog document so a later check can repeat it), else the sheets the board's newest check read.
 * None at all is fine: the run then reports the board's nets only.
 */
async function schematicSources(sent: unknown, id: string, request: ApiRequest, deps: WorkbenchDeps): Promise<{ sources: SchematicSource[] } | ApiResponse> {
  const jobs = deps.jobs!;
  if (sent === undefined) {
    const last = ((await deps.toolOutputs?.runs(`pcbas/${id}`)) ?? []).find((run) => run.op === 'netlist' && run.status === 'ok');
    const sources: SchematicSource[] = [];
    for (const src of last?.sources ?? []) {
      const fileName = src.role !== 'kicad-sch' ? undefined : src.fileName !== undefined && isSchematicFileName(src.fileName) ? src.fileName : schematicNameOf(src.path);
      if (fileName === undefined) continue;
      if (typeof (await deps.docs?.read(src.path)) !== 'string') return fail(409, `The schematic ${fileName} the last check read is not stored any more.`, 'Choose the .kicad_sch files again.');
      sources.push({ role: 'kicad-sch', path: src.path, sha256: src.sha256, fileName });
    }
    return { sources };
  }
  if (!Array.isArray(sent) || sent.length > 64) return fail(400, 'Send the schematic as { "schematics": [{ "fileName": "….kicad_sch", "base64": … }] }.');
  const files: { fileName: string; text: string; sha: string }[] = [];
  for (const item of sent as unknown[]) {
    const { fileName, base64 } = (typeof item === 'object' && item !== null ? item : {}) as { fileName?: unknown; base64?: unknown };
    if (typeof fileName !== 'string' || !isSchematicFileName(fileName.trim()) || typeof base64 !== 'string') return fail(400, 'Each schematic is { "fileName": "….kicad_sch", "base64": … } (a file name, no folders).');
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORT_BYTES) return fail(413, `${fileName} is empty or too big.`);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!/^\s*\(kicad_sch\b/.test(text)) return fail(422, `${fileName} is not a KiCad schematic.`, 'Pick the project\'s .kicad_sch files (KiCad 6 or later).');
    if (files.some((f) => f.fileName === fileName.trim())) return fail(400, `${fileName} is there twice.`);
    files.push({ fileName: fileName.trim(), text, sha: sha256(new TextEncoder().encode(text)) });
  }
  const unsaved: typeof files = [];
  for (const f of files) if (typeof (await deps.docs?.read(schematicDocPath(f.sha, f.fileName))) !== 'string') unsaved.push(f);
  if (unsaved.length > 0) {
    const saved = await withWriteLock(async () => {
      const uow = new UnitOfWork(deps);
      for (const f of unsaved) await uow.deps.docs!.write(schematicDocPath(f.sha, f.fileName), f.text);
      const response = await commitUnit(uow, { method: 'POST', path: request.path, ...(request.user === undefined ? {} : { user: request.user }) }, { status: 200, body: {} });
      if (response.status < 400 && uow.changes.length > 0) await publishCatalog(deps);
      return response;
    });
    if (saved.status >= 400) return saved;
  }
  const sources: SchematicSource[] = [];
  for (const f of files) {
    const stored = new TextEncoder().encode(f.text);
    sources.push({ role: 'kicad-sch', path: schematicDocPath(f.sha, f.fileName), sha256: f.sha, fileName: f.fileName, input: (await jobs.stageInput(stored)) as ImportInput });
  }
  return { sources };
}
