/**
 * Print preparation (WF-PRINT): slice a mechanical record's parts for FDM printing with a pinned
 * slicer pack (`tools/slicer-prusaslicer/`), through the job seam and the shared tool runner. The
 * result is files plus provenance — G-code, the slicer's estimates, the exact effective profile —
 * never an operation on a printer.
 *
 * What can be sliced, each pinned by its sha256: the STL outputs of the record's last enclosure
 * generation; its 3D model link when that is an STL (an STL kept as sent, or the uploaded STL kept
 * beside the converted GLB — the GLB itself may be thinned for the viewer and is never sliced); and
 * print files uploaded here, STL or 3MF (`files.ts`).
 *
 *   GET    /api/print/profiles                       the hub's printer/material/process profiles (+ hashes)
 *   GET    /api/print/slicers/orcaslicer/profiles    OrcaSlicer's presets for the listed makers (or that they are being read)
 *   POST   /api/print/slicers/orcaslicer/profiles    read them again (a job; once per pack version is enough)
 *   GET    /api/print/slicers/orcaslicer/tweaks      the hub's OrcaSlicer setting tweaks per printer preset
 *   PUT    /api/print/slicers/orcaslicer/tweaks      { printer, settings } — save one printer's tweaks ({} clears them)
 *   PUT    /api/print/profiles                       { profiles } — save them (one change set)
 *   GET    /api/print/mechanicals/:id                printable parts, availability, runs, jobs, variants
 *   POST   /api/print/mechanicals/:id                { parts, orientation, slicer?, printer, material, process, adjustments? } → 202 job
 *                                                     (slicer orcaslicer: printer/material/process are OrcaSlicer preset names, `orca.ts`)
 *   POST   /api/print/mechanicals/:id/files          { name, data (base64) } — keep an STL or 3MF to slice
 *   DELETE /api/print/mechanicals/:id/files/:asset   forget a print file (the stored bytes stay)
 *   POST   /api/print/mechanicals/:id/variants       { runId, note? } — keep a manufacturing variant on the record
 *
 * Runs register like every tool run (`tools/outputs.ts`) against `mechanicals/<id>`; G-code
 * downloads through `GET /api/blobs/:sha`.
 */

import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { enclosureRunPath, type EnclosureRun } from '../enclosures/run.ts';
import { jobView } from '../jobs/api.ts';
import type { JobRun } from '../jobs/types.ts';
import { TOOL_PACKS } from '../tools/packs.ts';
import type { ToolRunRecord } from '../tools/outputs.ts';
import { PRINT_JOB, PRINT_OP, PRINT_PACK } from './job.ts';
import { catalogView, ORCA_PACK, ORCA_TWEAKS_PATH, orcaProfile, orcaVendors, parseOrcaTweaks, readOrcaCatalog, readOrcaTweaks, SLICERS, type OrcaProfile, type SlicerId } from './orca.ts';
import { isViewableModelAsset } from '../assets.ts';
import { printFilesPath, readPrintFiles, sniffPrintFile, type PrintFile } from './files.ts';
import { cachedSize, readSourcePart, sourceParts } from './sources.ts';
import { PRINT_PACKS, printTechnology, RESIN_PACK, withResinStarters } from './resin.ts';
import { effectiveProfiles, mergedProfile, parseAdjustments, parseProfiles, profileHash, PRINT_PROFILES_PATH, type PrintAdjustments, type PrintProfile, type PrintProfileKind } from './profiles.ts';

export const PRINT_ROUTES = [
  'GET    /api/print/profiles',
  'PUT    /api/print/profiles',
  'GET    /api/print/slicers/orcaslicer/profiles',
  'POST   /api/print/slicers/orcaslicer/profiles',
  'GET    /api/print/slicers/orcaslicer/tweaks',
  'PUT    /api/print/slicers/orcaslicer/tweaks',
  'GET    /api/print/mechanicals/:id',
  'POST   /api/print/mechanicals/:id',
  'POST   /api/print/mechanicals/:id/files',
  'DELETE /api/print/mechanicals/:id/files/:asset',
  'POST   /api/print/mechanicals/:id/variants',
] as const;

export { PRINT_JOB, PRINT_OP, PRINT_PACK } from './job.ts';
export const ORIENTATIONS = ['as-designed', 'flat'] as const;
export type PrintOrientation = (typeof ORIENTATIONS)[number];

export const printVariantsPath = (id: string): string => `data/print/variants/${id}.json`;

/** Where a printable part comes from: the last enclosure generation, the record's 3D model link, or an uploaded print file. */
export type PrintPartOrigin = 'enclosure' | 'model' | 'file';

/** A part the job slices: an STL (or one 3MF plate) kept as an asset, pinned by its hash. */
export interface PrintPart {
  /** unique on the record; ends in .stl or .3mf (the pack goes by the extension) */
  path: string;
  role: string;
  asset: string;
  sha256: string;
  bytes: number;
  /** absent on requests made before parts had other origins: an enclosure part */
  origin?: PrintPartOrigin;
  format?: 'stl' | '3mf';
  /** a model link's source file (`sources.ts`): its path there; put into the asset store before a slice */
  source?: string;
  /** an STL's bounding box, mm */
  size?: [number, number, number];
}

export interface PrintPrepareRequest {
  mechanical: string;
  record: string;
  label: string;
  pack: string;
  packVersion: string;
  parts: PrintPart[];
  orientation: PrintOrientation;
  /** PrusaSlicer: the hub's merged profile; OrcaSlicer: its presets by name (+ vendor, output) */
  profile: ReturnType<typeof mergedProfile> & Partial<Pick<OrcaProfile, 'presets' | 'vendor' | 'output' | 'tweaks'>>;
  /** the enclosure run the parts came from, when an enclosure part is among them */
  source?: { path: string; generatedAt: string; requestSha256: string };
}

export interface ManufacturingVariant {
  id: string;
  savedAt: string;
  by?: string;
  runId: string;
  parts: { path: string; sha256: string }[];
  orientation: string;
  /** `labels`: what the pickers showed (absent on variants saved before labels were kept) */
  profile: { sha256: string; printer: string; material: string; process: string; labels?: { printer: string; material: string; process: string }; effectiveSha256?: string; adjustments?: PrintAdjustments };
  slicer: { name: string; version: string; image: string };
  estimates: { printTimeText?: string; printTimeSeconds?: number; filamentG?: number; filamentMm?: number; layers?: number; resinMl?: number };
  gcode?: { path: string; sha256: string };
  note?: string;
}

const RECORD_ID = /^[a-z0-9]+(?:-[a-z0-9]+|(?<=\d)\.\d[a-z0-9]*)*$/;
const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });
const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });

export function isPrintPath(path: string): boolean {
  return /^\/api\/print(\/|$)/.test(path.split('?')[0] ?? '');
}

export interface PrintDeps {
  /** commit a write as one change set */
  transact: (write: (deps: WorkbenchDeps) => Promise<ApiResponse>) => Promise<ApiResponse>;
  now?: () => string;
}

async function readProfiles(deps: WorkbenchDeps): Promise<{ profiles: PrintProfile[]; saved: boolean }> {
  return withResinStarters(effectiveProfiles(await deps.docs?.read(PRINT_PROFILES_PATH)));
}

function profileView(p: PrintProfile): Record<string, unknown> {
  return { ...p, sha256: profileHash(p) };
}

const fileName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '') || 'part';

/** When a record's model gives nothing to slice: the one line the panel shows on its drop zone. */
export const GLB_ONLY = '3D model is GLB only. Drop the STL to slice.';

/**
 * Everything on the record that can be sliced: the STL parts of its last successful enclosure
 * generation, its model link's STL (kept beside the GLB, or the STL/3MF source files an imported
 * link cites, `sources.ts`), and its print files. `modelNote` is set when the record has a model
 * but nothing of it can be sliced.
 */
async function printableParts(deps: WorkbenchDeps, id: string): Promise<{ parts: PrintPart[]; run?: EnclosureRun; modelNote?: string }> {
  const parts: PrintPart[] = [];
  const found = (await deps.docs?.read(enclosureRunPath(id))) as EnclosureRun | undefined | null;
  const run = found === undefined || found === null || found.status !== 'ok' ? undefined : found;
  for (const o of run?.outputs ?? []) {
    if (o.mediaType === 'model/stl' && o.asset !== undefined) parts.push({ path: o.path, role: o.role, asset: o.asset, sha256: o.sha256, bytes: o.bytes, origin: 'enclosure', format: 'stl' });
  }
  let modelNote: string | undefined;
  const link = await deps.modelLinks?.get(`mechanicals/${id}`);
  // a generated link is the enclosure's own GLB: its STL parts are already listed
  if (link !== undefined && link.sourceKind !== 'generated' && link.parametric === undefined) {
    const stl = link.original?.mime === 'model/stl' ? link.original.asset : undefined;
    const linked = stl === undefined && link.files === undefined ? await deps.assets?.get(link.asset) : undefined;
    if (stl !== undefined) {
      parts.push({ path: `model/${fileName(link.original!.name)}`.replace(/(\.stl)?$/i, '.stl'), role: 'model', asset: stl, sha256: stl, bytes: link.original!.bytes, origin: 'model', format: 'stl' });
    } else if (linked !== undefined && linked.record.mime === 'model/stl' && isViewableModelAsset(linked.record)) {
      parts.push({ path: `model/${fileName(linked.record.originalName)}`.replace(/(\.stl)?$/i, '.stl'), role: 'model', asset: link.asset, sha256: link.asset, bytes: linked.record.bytes, origin: 'model', format: 'stl' });
    } else {
      const sources = link.files === undefined ? [] : await sourceParts(deps, link);
      for (const f of sources) {
        const path = `model/${fileName(f.name)}`;
        parts.push({ path: parts.some((p) => p.path === path) ? path.replace(/(\.[a-z0-9]+)$/i, `-${f.sha256.slice(0, 8)}$1`) : path, role: 'model', asset: f.sha256, sha256: f.sha256, bytes: f.bytes, origin: 'model', format: f.format, source: f.source, ...(f.size === undefined ? {} : { size: f.size }) });
      }
      if (sources.length === 0) modelNote = GLB_ONLY;
    }
  }
  for (const f of readPrintFiles(await deps.docs?.read(printFilesPath(id)))) {
    const format = f.mime === 'model/3mf' ? '3mf' : 'stl';
    const path = `files/${fileName(f.name)}`.replace(new RegExp(`(\\.${format})?$`, 'i'), `.${format}`);
    // two uploads of the same name: the later keeps a short hash so each path stays unique
    const unique = parts.some((p) => p.path === path) ? path.replace(new RegExp(`\\.${format}$`), `-${f.asset.slice(0, 8)}.${format}`) : path;
    parts.push({ path: unique, role: 'print-file', asset: f.asset, sha256: f.asset, bytes: f.bytes, origin: 'file', format });
  }
  // each STL's size, for what fits a printer's bed (read once per hash)
  for (const p of parts) {
    if (p.format === '3mf' || p.size !== undefined) continue;
    const size = await cachedSize(p.sha256, async () => { const got = await deps.assets?.get(p.asset); return got === undefined ? undefined : new Uint8Array(got.bytes); });
    if (size !== undefined) p.size = size;
  }
  return { parts, ...(run === undefined ? {} : { run }), ...(modelNote === undefined ? {} : { modelNote }) };
}

export async function printAvailability(deps: WorkbenchDeps): Promise<{ ok: boolean; reason?: string }> {
  if (deps.toolOutputs === undefined) return { ok: false, reason: 'Print preparation needs the database backend (WIREHUB_BACKEND=pg) with a blob store.' };
  if (deps.jobs === undefined || !deps.jobs.kinds.includes(PRINT_JOB)) return { ok: false, reason: 'This hub does not run print-preparation jobs.' };
  if (deps.jobs.worker !== undefined) {
    const beat = await deps.jobs.worker();
    if (beat === undefined) return { ok: false, reason: 'No background worker has reported in yet.' };
    if (!beat.queues.includes(PRINT_JOB)) return { ok: false, reason: `The worker has no tool runner. Enable WIREHUB_TOOL_RUNNER=docker and build the ${PRINT_PACK} pack image (tools/${PRINT_PACK}/README.md).` };
  }
  return { ok: true };
}

/** OrcaSlicer's preset list for the panel: ready (the list), or the job reading it, or nothing yet. */
async function orcaCatalogState(deps: WorkbenchDeps): Promise<{ status: 'ready' | 'reading' | 'missing' | 'failed'; catalog?: Record<string, unknown>; readAt?: string; job?: Record<string, unknown>; vendors: string[] }> {
  const vendors = orcaVendors();
  const listed = await readOrcaCatalog(deps);
  const jobs = deps.jobs === undefined ? [] : (await deps.jobs.list({ kind: PRINT_JOB, limit: 30 })).filter((j) => (j.request as { task?: unknown }).task === 'profiles');
  const job = jobs[0];
  if (listed !== undefined) return { status: 'ready', catalog: catalogView(listed.catalog), readAt: listed.createdAt, vendors, ...(job === undefined ? {} : { job: jobView(job) }) };
  if (job === undefined) return { status: 'missing', vendors };
  return { status: job.status === 'queued' || job.status === 'running' ? 'reading' : job.status === 'failed' ? 'failed' : 'missing', job: jobView(job), vendors };
}

function runView(run: ToolRunRecord): Record<string, unknown> {
  return { ...run, outputs: run.outputs.map((o) => ({ ...o, href: `/api/blobs/${o.sha256}` })), logHref: `/api/tool-outputs/runs/${run.id}/log` };
}

export async function handlePrintRequest(request: ApiRequest, deps: WorkbenchDeps, print: PrintDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '').map((p) => decodeURIComponent(p));
  const [, , a, b, c, ...rest] = parts;
  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const viewer = request.user?.role === 'viewer';

  if (a === 'profiles' && b === undefined) {
    if (method === 'GET') {
      const { profiles, saved } = await readProfiles(deps);
      return ok({ profiles: profiles.map(profileView), saved, path: PRINT_PROFILES_PATH });
    }
    if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
    if (viewer) return fail(403, 'Viewers cannot change print profiles.');
    const parsed = parseProfiles(body['profiles']);
    if ('error' in parsed) return fail(400, parsed.error);
    for (const kind of ['printer', 'material', 'process'] as PrintProfileKind[]) {
      if (!parsed.profiles.some((p) => p.kind === kind)) return fail(400, `Keep at least one ${kind} profile.`);
    }
    return print.transact(async (d) => {
      await d.docs!.write(PRINT_PROFILES_PATH, parsed.profiles);
      return ok({ profiles: parsed.profiles.map(profileView), saved: true, path: PRINT_PROFILES_PATH });
    });
  }

  if (a === 'slicers' && b === 'orcaslicer' && c === 'profiles' && rest.length === 0) {
    if (method === 'GET') return ok(await orcaCatalogState(deps));
    if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and POST.');
    if (viewer) return fail(403, 'Viewers cannot start jobs.');
    const available = await printAvailability(deps);
    if (!available.ok) return fail(503, 'Print preparation cannot run on this hub right now.', available.reason);
    const state = await orcaCatalogState(deps);
    if (state.job !== undefined && (state.job['status'] === 'queued' || state.job['status'] === 'running')) return ok(state, 202);
    const job = await deps.jobs!.enqueue(PRINT_JOB, { task: 'profiles', pack: ORCA_PACK, packVersion: TOOL_PACKS[ORCA_PACK]!.version, vendors: orcaVendors() }, request.user);
    return { status: 202, body: { ...state, job: jobView(job) }, headers: { Location: `/api/jobs/${job.id}` } };
  }

  if (a === 'slicers' && b === 'orcaslicer' && c === 'tweaks' && rest.length === 0) {
    const tweaks = readOrcaTweaks(await deps.docs?.read(ORCA_TWEAKS_PATH));
    if (method === 'GET') return ok({ tweaks });
    if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
    if (viewer) return fail(403, 'Viewers cannot change print settings.');
    const printer = body['printer'];
    if (typeof printer !== 'string' || printer.trim() === '' || printer.length > 200) return fail(400, 'Name the OrcaSlicer printer preset.');
    const parsed = parseOrcaTweaks(body['settings'] ?? {});
    if ('error' in parsed) return fail(400, parsed.error);
    const next = { ...tweaks };
    if (Object.keys(parsed.settings).length === 0) delete next[printer];
    else next[printer] = parsed.settings;
    return print.transact(async (d) => {
      await d.docs!.write(ORCA_TWEAKS_PATH, next);
      return ok({ tweaks: next });
    });
  }

  if (a !== 'mechanicals' || b === undefined || !RECORD_ID.test(b) || rest.length > (c === 'files' ? 1 : 0)) return fail(404, 'There is nothing at that address.', PRINT_ROUTES.join('; '));
  const record = (await deps.loadDb()).mechanicals?.find((m) => m.id === b);
  if (record === undefined) return fail(404, `There is no mechanical record '${b}'.`);
  const recordKey = `mechanicals/${b}`;

  if (c === undefined && method === 'GET') {
    const { parts: printable, run, modelNote } = await printableParts(deps, b);
    const { profiles } = await readProfiles(deps);
    const files = readPrintFiles(await deps.docs?.read(printFilesPath(b)));
    const runs = deps.toolOutputs === undefined ? [] : (await deps.toolOutputs.runs(recordKey, { limit: 20 })).filter((r) => PRINT_PACKS.includes(r.pack));
    const jobs = deps.jobs === undefined ? [] : (await deps.jobs.list({ kind: PRINT_JOB, limit: 30 })).filter((j) => (j.request as Partial<PrintPrepareRequest>).mechanical === b);
    const variants = ((await deps.docs?.read(printVariantsPath(b))) ?? []) as ManufacturingVariant[];
    return ok({
      record: recordKey, label: record.label, pack: { ...TOOL_PACKS[PRINT_PACK], op: PRINT_OP }, resinPack: { ...TOOL_PACKS[RESIN_PACK], op: PRINT_OP }, available: await printAvailability(deps),
      slicers: SLICERS.map((id) => ({ id, ...TOOL_PACKS[id === 'orcaslicer' ? ORCA_PACK : PRINT_PACK]! })),
      parts: printable, files, ...(modelNote === undefined ? {} : { modelNote }),
      source: run === undefined ? null : { generatedAt: run.generatedAt, requestSha256: run.requestSha256 },
      profiles: profiles.map(profileView), runs: runs.map(runView), jobs: jobs.slice(0, 5).map(jobView), variants,
    });
  }

  if (c === undefined && method === 'POST') {
    if (viewer) return fail(403, 'Viewers cannot start jobs.');
    const available = await printAvailability(deps);
    if (!available.ok) return fail(503, 'Print preparation cannot run on this hub right now.', available.reason);
    const { parts: printable, run } = await printableParts(deps, b);
    if (printable.length === 0) return fail(409, `${record.label} has nothing to slice yet.`, 'Generate its enclosure, attach an STL as its 3D model, or upload an STL or 3MF print file.');
    const wanted = body['parts'] === undefined ? printable.filter((p) => p.format !== '3mf').map((p) => p.path) : body['parts'];
    if (!Array.isArray(wanted) || wanted.length === 0 || !wanted.every((p) => typeof p === 'string' && printable.some((q) => q.path === p))) {
      return fail(400, `Choose parts from: ${printable.map((p) => p.path).join(', ')}.`);
    }
    const chosen = printable.filter((p) => (wanted as string[]).includes(p.path));
    if (chosen.some((p) => p.format === '3mf') && chosen.length > 1) return fail(400, 'A 3MF is sliced on its own, as its own plate.', 'Choose the 3MF alone, or only STL parts.');
    // a model link's source file: into the asset store (content-addressed) where the job reads every part
    for (const p of chosen.filter((q) => q.source !== undefined)) {
      if (deps.assets === undefined) return fail(501, 'This hub cannot keep print files.');
      if ((await deps.assets.get(p.sha256)) !== undefined) continue;
      const bytes = await readSourcePart(deps, p.source!, p.sha256);
      if (bytes === undefined) return fail(409, `${p.path} is not readable here any more.`, 'Its source file moved or changed; drop the STL on the panel to slice it.');
      const kept = await print.transact(async (d) => {
        await d.assets!.put(Buffer.from(bytes), p.format === '3mf' ? 'model/3mf' : 'model/stl', p.path.replace(/^model\//, ''), `${p.source}, the source file of ${record.label}'s 3D model, kept for printing`);
        return ok({});
      });
      if (kept.status >= 300) return kept;
    }
    const adjusted = parseAdjustments(body['adjustments']);
    if ('error' in adjusted) return fail(400, adjusted.error);
    const orientation = (body['orientation'] ?? 'as-designed') as PrintOrientation;
    if (!ORIENTATIONS.includes(orientation)) return fail(400, 'Orientation is as-designed or flat.');
    const slicer = (body['slicer'] ?? 'prusaslicer') as SlicerId;
    if (!SLICERS.includes(slicer)) return fail(400, `The slicer is ${SLICERS.join(' or ')}.`);
    if (slicer === 'orcaslicer') {
      const listed = await readOrcaCatalog(deps);
      if (listed === undefined) return fail(409, "OrcaSlicer's printer presets have not been read yet.", 'POST /api/print/slicers/orcaslicer/profiles reads them (the print panel does this when OrcaSlicer is chosen).');
      const profile = orcaProfile(listed.catalog, { printer: body['printer'], material: body['material'], process: body['process'] }, adjusted.adjustments, readOrcaTweaks(await deps.docs?.read(ORCA_TWEAKS_PATH)));
      if ('error' in profile) return fail(400, profile.error);
      const orcaRequest: PrintPrepareRequest = {
        mechanical: b, record: recordKey, label: record.label, pack: ORCA_PACK, packVersion: TOOL_PACKS[ORCA_PACK]!.version,
        parts: chosen, orientation, profile,
        ...(run === undefined || !chosen.some((p) => p.origin === 'enclosure') ? {} : { source: { path: enclosureRunPath(b), generatedAt: run.generatedAt, requestSha256: run.requestSha256 } }),
      };
      const job: JobRun = await deps.jobs!.enqueue(PRINT_JOB, { ...orcaRequest }, request.user);
      return { status: 202, body: { job: jobView(job) }, headers: { Location: `/api/jobs/${job.id}` } };
    }
    const { profiles } = await readProfiles(deps);
    const pick = (kind: PrintProfileKind): PrintProfile | undefined => {
      const id = body[kind];
      return profiles.find((p) => p.kind === kind && (id === undefined ? true : p.id === id));
    };
    const printer = pick('printer');
    const material = pick('material');
    const process = pick('process');
    if (printer === undefined || material === undefined || process === undefined) return fail(400, 'Choose a printer, a material and a process profile the hub has.');
    const technology = printTechnology(printer);
    if (printTechnology(material) !== technology || printTechnology(process) !== technology) return fail(400, `${printer.label} is a ${technology === 'resin' ? 'resin' : 'FDM'} printer: choose ${technology === 'resin' ? 'resin' : 'FDM'} material and process profiles.`);
    const pack = technology === 'resin' ? RESIN_PACK : PRINT_PACK;
    if (technology === 'resin') delete adjusted.adjustments.brimMm;
    const info = TOOL_PACKS[pack]!;
    const jobRequest: PrintPrepareRequest = {
      mechanical: b, record: recordKey, label: record.label, pack, packVersion: info.version,
      parts: chosen, orientation,
      profile: mergedProfile({ printer, material, process }, adjusted.adjustments),
      ...(run === undefined || !chosen.some((p) => p.origin === 'enclosure') ? {} : { source: { path: enclosureRunPath(b), generatedAt: run.generatedAt, requestSha256: run.requestSha256 } }),
    };
    const job: JobRun = await deps.jobs!.enqueue(PRINT_JOB, { ...jobRequest }, request.user);
    return { status: 202, body: { job: jobView(job) }, headers: { Location: `/api/jobs/${job.id}` } };
  }

  if (c === 'files' && method === 'POST' && rest.length === 0) {
    if (viewer) return fail(403, 'Viewers cannot add print files.');
    if (deps.assets === undefined || deps.docs === undefined) return fail(501, 'This hub cannot keep print files.');
    const name = body['name'];
    const data = body['data'];
    if (typeof name !== 'string') return fail(400, 'The upload needs the file name.');
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(data)) return fail(400, 'The upload needs the file, base64-encoded, as `data`.');
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    const sniffed = sniffPrintFile(name, bytes);
    if ('error' in sniffed) return fail(422, sniffed.error, sniffed.hint);
    const by = request.user?.name ?? deps.localUser?.name;
    const at = (print.now ?? (() => new Date().toISOString()))();
    return print.transact(async (d) => {
      const stored = await d.assets!.put(Buffer.from(bytes), sniffed.mime, sniffed.name, `${sniffed.name}, uploaded for printing ${record.label} by ${by ?? 'a user'} on ${at.slice(0, 10)}`);
      const file: PrintFile = { name: sniffed.name, asset: stored.id, mime: sniffed.mime, bytes: bytes.byteLength, uploadedAt: at, ...(by === undefined ? {} : { by }) };
      const existing = readPrintFiles(await d.docs!.read(printFilesPath(b)));
      const next = [...existing.filter((f) => f.asset !== stored.id), file];
      await d.docs!.write(printFilesPath(b), next);
      return ok({ file, files: next }, 201);
    });
  }

  if (c === 'files' && method === 'DELETE' && rest.length === 1) {
    if (viewer) return fail(403, 'Viewers cannot remove print files.');
    const asset = rest[0]!;
    return print.transact(async (d) => {
      const existing = readPrintFiles(await d.docs!.read(printFilesPath(b)));
      if (!existing.some((f) => f.asset === asset)) return fail(404, 'That print file is not on this record.');
      const next = existing.filter((f) => f.asset !== asset);
      await d.docs!.write(printFilesPath(b), next);
      return ok({ files: next });
    });
  }

  if (c === 'variants' && method === 'POST') {
    if (viewer) return fail(403, 'Viewers cannot change records.');
    const runId = body['runId'];
    if (typeof runId !== 'string') return fail(400, 'Say which print run the variant keeps ({ runId }).');
    const runs = deps.toolOutputs === undefined ? [] : await deps.toolOutputs.runs(recordKey, { limit: 50 });
    const run = runs.find((r) => r.id === runId && PRINT_PACKS.includes(r.pack) && r.status === 'ok');
    if (run === undefined) return fail(404, 'There is no successful print run with that id on this record.');
    const summaryOut = run.outputs.find((o) => o.role === 'summary');
    const summaryFile = summaryOut === undefined ? undefined : await deps.toolOutputs!.file(summaryOut.sha256);
    const summary = summaryFile === undefined ? {} : (JSON.parse(new TextDecoder().decode(summaryFile.bytes)) as Record<string, unknown>);
    const params = run.params as { orientation?: string; profile?: { sha256: string; parts: Record<PrintProfileKind, { id: string; label?: string }>; adjustments?: PrintAdjustments } };
    const gcode = run.outputs.find((o) => o.role === 'gcode' || o.role === 'printer-file');
    const note = typeof body['note'] === 'string' && body['note'].trim() !== '' ? body['note'].trim().slice(0, 2000) : undefined;
    const by = request.user?.name ?? deps.localUser?.name;
    const variant: ManufacturingVariant = {
      id: `v${run.id.slice(0, 8)}`,
      savedAt: (print.now ?? (() => new Date().toISOString()))(),
      ...(by === undefined ? {} : { by }),
      runId: run.id,
      parts: run.sources.filter((s) => s.role === 'stl' || s.role === '3mf').map((s) => ({ path: s.path, sha256: s.sha256 })),
      orientation: params.orientation ?? 'as-designed',
      profile: {
        sha256: params.profile?.sha256 ?? '', printer: params.profile?.parts.printer.id ?? '', material: params.profile?.parts.material.id ?? '', process: params.profile?.parts.process.id ?? '',
        ...(params.profile === undefined ? {} : { labels: { printer: params.profile.parts.printer.label ?? params.profile.parts.printer.id, material: params.profile.parts.material.label ?? params.profile.parts.material.id, process: params.profile.parts.process.label ?? params.profile.parts.process.id } }),
        ...(typeof summary['effectiveProfileSha256'] === 'string' ? { effectiveSha256: summary['effectiveProfileSha256'] } : {}),
        ...(params.profile?.adjustments === undefined ? {} : { adjustments: params.profile.adjustments }),
      },
      slicer: { name: run.tool.name, version: run.tool.version, image: run.image },
      estimates: {
        ...(typeof summary['printTimeText'] === 'string' ? { printTimeText: summary['printTimeText'] } : {}),
        ...(typeof summary['printTimeSeconds'] === 'number' ? { printTimeSeconds: summary['printTimeSeconds'] } : {}),
        ...(typeof summary['filamentG'] === 'number' ? { filamentG: summary['filamentG'] } : {}),
        ...(typeof summary['filamentMm'] === 'number' ? { filamentMm: summary['filamentMm'] } : {}),
        ...(typeof summary['layers'] === 'number' ? { layers: summary['layers'] } : {}),
        ...(typeof summary['resinMl'] === 'number' ? { resinMl: summary['resinMl'] } : {}),
      },
      ...(gcode === undefined ? {} : { gcode: { path: gcode.path, sha256: gcode.sha256 } }),
      ...(note === undefined ? {} : { note }),
    };
    return print.transact(async (d) => {
      const existing = ((await d.docs!.read(printVariantsPath(b))) ?? []) as ManufacturingVariant[];
      const next = [variant, ...existing.filter((v) => v.runId !== run.id)];
      await d.docs!.write(printVariantsPath(b), next);
      return ok({ variant, variants: next });
    });
  }
  return fail(405, `${method} is not something this address accepts.`, PRINT_ROUTES.join('; '));
}
