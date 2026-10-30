/**
 * Shared presentation choices — one cover resolver for boards, wire stock and cable designs —
 * stored through the same document/UoW seam on files and Postgres.
 *
 * Candidates per kind (automatic order first):
 * - boards: stored/native depiction views (top, bottom, artwork, schematic), the KiCad tool pack's
 *   renders and layer SVGs, saved 3D camera, then photos attached to notes about the board;
 * - wire stock: layered cutaway (preparation view) and scaled cross-section, both drawn from the
 *   stock's own construction by the existing document renderers, plus a saved 3D camera;
 * - shells: the last enclosure generation's preview image, plus a saved camera on its generated GLB;
 * - designs: the schematic and drawing sheet from the existing document renderers, plus a saved
 *   editor view captured from the design editor.
 *
 * Derived images are rendered on demand when an `<img>` asks for them and cached by record,
 * view, source hash and renderer version; listing a record never renders. Client captures keep
 * their record in a presentation document and their bytes as a binary catalog file
 * (`data/presentation/cover-images/<kind>/<id>/<sha256>.<ext>`, the `catalog-file` change-set kind):
 * on files beside the catalog, on Postgres a `catalog_file` row naming a record blob, so a replaced
 * capture's bytes are swept by the blob GC. Captures saved before that kept the bytes as base64 in a
 * document (`<sha256>.json`): still read, moved on the record's next capture, or all at once by
 * `POST /api/representations/migrate-images`. A capture made from an older source or renderer is
 * stale — the choice (same lineage) survives and the viewer can refresh it.
 */
import { createHash } from 'node:crypto';
import { isDesignId, parseDepictionMeta } from '@wirehub/catalog';
import { drawCutaway } from '@wirehub/docs';
import { renderCrossSection } from '@wirehub/render-svg';
import {
  CAPTURE_VIEWS_OF, COVER_CAPTURE_RENDERERS, isCoverCaptureView, isCoverKind, resolveCover,
  type CoverCamera, type CoverCaptureView, type CoverChoice, type CoverKind, type RepresentationCandidate, type RepresentationIdentity, type RepresentationView,
} from '../src/representations.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from './api.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { isDepictionDefId } from './depictions.ts';
import { knowledgePhotosFor, photoLineage } from './knowledge.ts';
import { handleDocumentRequest } from './documents.ts';
import { svgToPng } from './render/raster.ts';
import { enclosureRunPath, type EnclosureRun } from './enclosures/run.ts';

export const REPRESENTATION_ROUTES = [
  'GET    /api/representations/:kind/:id',
  'PUT    /api/representations/:kind/:id',
  'POST   /api/representations/:kind/:id/captures',
  'GET    /api/representations/:kind/:id/images/:asset',
  'POST   /api/representations/migrate-images',
] as const;
export const coverPath = (id: string, kind: CoverKind = 'pcbas'): string => `data/presentation/covers/${kind}/${id}.json`;
export const capturesPath = (kind: CoverKind, id: string): string => `data/presentation/captures/${kind}/${id}.json`;
/** Where captures saved before the blob store kept their bytes: base64 in a document. Read and migrated, never written. */
export const captureImagePath = (kind: CoverKind, id: string, sha: string): string => `data/presentation/cover-images/${kind}/${id}/${sha}.json`;
const CAPTURE_EXT: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/** A capture's bytes: a binary catalog file (blob-backed on Postgres). */
export const captureFilePath = (kind: CoverKind, id: string, sha: string, mediaType: string): string => `data/presentation/cover-images/${kind}/${id}/${sha}.${CAPTURE_EXT[mediaType] ?? 'png'}`;
/** Bump when a server-side cover renderer changes its output: cached images are re-rendered, choices survive. */
export const DERIVED_COVER_RENDERER = 'cover-raster/1';
const MAX_CAPTURE_BYTES = 1_500_000;
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const fail = (status: number, error: string): ApiResponse => ({ status, body: { error } });

interface StoredCapture {
  view: CoverCaptureView;
  lineage: string;
  /** the source the image was made from (model asset, design version) */
  source: string;
  renderer: string;
  image: { sha256: string; mediaType: string; width: number; height: number };
  camera?: CoverCamera;
  /** the editor view a saved design view was taken from (canvas, schematic) */
  editorView?: string;
}
interface StoredImage { mediaType: string; base64: string }

/** A derived (server-rendered) candidate's render, kept out of the candidate list itself. */
type Render = () => Promise<{ svg: string; widthPx: number }>;
interface Gathered { identity: RepresentationIdentity; candidates: RepresentationCandidate[]; renders: Map<string, Render>; captureSources: Partial<Record<CoverCaptureView, string>> }

// Rendered derived images by cache key (record/view/source/renderer). Small, bounded, per process.
const derivedCache = new Map<string, { bytes: Uint8Array; mediaType: string }>();
function remember(key: string, value: { bytes: Uint8Array; mediaType: string }): void {
  derivedCache.delete(key);
  derivedCache.set(key, value);
  while (derivedCache.size > 200) derivedCache.delete(derivedCache.keys().next().value!);
}

const roundCamera = (camera: CoverCamera): CoverCamera => {
  const r = (v: number): number => Math.round(v * 1e4) / 1e4;
  return { position: camera.position.map(r) as CoverCamera['position'], target: camera.target.map(r) as CoverCamera['target'], up: camera.up.map(r) as CoverCamera['up'], fov: r(camera.fov) };
};
const captureLineage = (identity: RepresentationIdentity, view: CoverCaptureView, camera?: CoverCamera): string =>
  digest(JSON.stringify({ record: identity.record, view, ...(camera === undefined ? {} : { camera: roundCamera(camera) }) }));

function isVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7);
}
function parseCamera(value: unknown): CoverCamera | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  if (!isVec3(c.position) || !isVec3(c.target) || !isVec3(c.up) || typeof c.fov !== 'number' || !(c.fov > 1 && c.fov < 179)) return undefined;
  return roundCamera({ position: c.position, target: c.target, up: c.up, fov: c.fov });
}
/** The image type by its magic bytes, never by what the client claims. */
function sniffImage(bytes: Uint8Array): string | undefined {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}

/** A capture's bytes: the binary file, else the legacy base64 document. */
async function readCaptureImage(deps: WorkbenchDeps, kind: CoverKind, id: string, image: StoredCapture['image']): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
  if (deps.files?.read !== undefined && CAPTURE_EXT[image.mediaType] !== undefined) {
    const bytes = await deps.files.read(captureFilePath(kind, id, image.sha256, image.mediaType));
    if (bytes !== undefined) return { bytes, mediaType: image.mediaType };
  }
  const legacy = await deps.docs?.read(captureImagePath(kind, id, image.sha256)) as StoredImage | undefined;
  return legacy === undefined || typeof legacy.base64 !== 'string' ? undefined : { bytes: new Uint8Array(Buffer.from(legacy.base64, 'base64')), mediaType: legacy.mediaType };
}

/** Whether a capture's bytes are kept (either way), without reading them. */
async function hasCaptureImage(deps: WorkbenchDeps, kind: CoverKind, id: string, image: StoredCapture['image']): Promise<boolean> {
  if (deps.files !== undefined && CAPTURE_EXT[image.mediaType] !== undefined) {
    const path = captureFilePath(kind, id, image.sha256, image.mediaType);
    if (deps.files.has !== undefined ? await deps.files.has(path) : (await deps.files.read?.(path)) !== undefined) return true;
  }
  const legacy = await deps.docs?.read(captureImagePath(kind, id, image.sha256)) as StoredImage | undefined;
  return legacy !== undefined && typeof legacy.base64 === 'string';
}

async function removeCaptureImage(deps: WorkbenchDeps, kind: CoverKind, id: string, image: StoredCapture['image']): Promise<void> {
  if (deps.files !== undefined && CAPTURE_EXT[image.mediaType] !== undefined) {
    const path = captureFilePath(kind, id, image.sha256, image.mediaType);
    if (deps.files.has === undefined || await deps.files.has(path)) await deps.files.remove(path);
  }
  const legacy = captureImagePath(kind, id, image.sha256);
  if (await deps.docs?.read(legacy) !== undefined) await deps.docs!.remove(legacy);
}

/**
 * Move one record's legacy captures (base64 documents) to binary catalog files: write the
 * bytes (checked against their sha256), then remove the document. Returns how many moved.
 */
async function migrateRecordImages(deps: WorkbenchDeps, kind: CoverKind, id: string, except?: string): Promise<{ moved: number; skipped: number }> {
  let moved = 0;
  let skipped = 0;
  if (deps.files === undefined || deps.docs === undefined) return { moved, skipped };
  for (const capture of await readCaptures(deps, kind, id)) {
    if (capture.image.sha256 === except) continue;
    const legacyPath = captureImagePath(kind, id, capture.image.sha256);
    const legacy = await deps.docs.read(legacyPath) as StoredImage | undefined;
    if (legacy === undefined || typeof legacy.base64 !== 'string') continue;
    const bytes = new Uint8Array(Buffer.from(legacy.base64, 'base64'));
    const mediaType = sniffImage(bytes);
    // bytes that are not what the record names stay where they are (and are reported)
    if (digest(bytes) !== capture.image.sha256 || mediaType === undefined || mediaType !== capture.image.mediaType) { skipped += 1; continue; }
    await deps.files.write(captureFilePath(kind, id, capture.image.sha256, mediaType), bytes);
    await deps.docs.remove(legacyPath);
    moved += 1;
  }
  return { moved, skipped };
}

/** `POST /api/representations/migrate-images`: every record's legacy captures, in one change set (owners). */
async function migrateAllImages(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  if (request.method.toUpperCase() !== 'POST') return fail(405, 'This address accepts POST.');
  const role = (request.user ?? deps.localUser)?.role;
  if (role !== undefined && role !== 'owner') return fail(403, 'Only an owner moves stored cover images.');
  if (deps.files === undefined || deps.docs === undefined) return fail(501, 'This hub cannot store cover images as files.');
  const db = await deps.loadDb();
  const records: [CoverKind, string][] = [
    ...db.pcbas.map((b) => ['pcbas', b.id] as [CoverKind, string]),
    ...db.wires.map((w) => ['wires', w.id] as [CoverKind, string]),
    ...(db.mechanicals ?? []).map((m) => ['mechanicals', m.id] as [CoverKind, string]),
    ...((await deps.designs?.list()) ?? []).map((d) => ['designs', d.id] as [CoverKind, string]),
  ];
  let moved = 0;
  let skipped = 0;
  for (const [kind, id] of records) {
    const out = await migrateRecordImages(deps, kind, id);
    moved += out.moved;
    skipped += out.skipped;
  }
  return { status: 200, body: { moved, skipped, records: records.length } };
}

async function readCaptures(deps: WorkbenchDeps, kind: CoverKind, id: string): Promise<StoredCapture[]> {
  const value = await deps.docs?.read(capturesPath(kind, id));
  const list = value !== null && typeof value === 'object' && Array.isArray((value as { captures?: unknown }).captures) ? (value as { captures: StoredCapture[] }).captures : [];
  return list.filter((c) => isCoverCaptureView(c.view) && typeof c.lineage === 'string' && typeof c.image?.sha256 === 'string');
}

const CAPTURE_LABEL: Record<CoverCaptureView, string> = { camera: 'Saved 3D view', 'saved-view': 'Saved editor view' };

/** Candidates from client captures: current only when made from today's source by today's renderer. */
async function captureCandidates(deps: WorkbenchDeps, kind: CoverKind, id: string, identity: RepresentationIdentity, sources: Partial<Record<CoverCaptureView, string>>): Promise<RepresentationCandidate[]> {
  const out: RepresentationCandidate[] = [];
  for (const capture of await readCaptures(deps, kind, id)) {
    if (!CAPTURE_VIEWS_OF[kind].includes(capture.view)) continue;
    const current = sources[capture.view];
    const present = await hasCaptureImage(deps, kind, id, capture.image);
    const stale = current === undefined ? (capture.view === 'camera' ? 'The 3D model this view was saved from is no longer attached.' : 'The saved source is gone.')
      : current !== capture.source ? (kind === 'designs' ? 'The design changed since this view was saved.' : kind === 'wires' ? 'The stock changed since this view was saved.' : 'The 3D model changed since this view was saved.')
      : capture.renderer !== COVER_CAPTURE_RENDERERS[capture.view] ? 'Saved with an older renderer.' : undefined;
    out.push({
      view: capture.view,
      label: capture.view === 'saved-view' && capture.editorView !== undefined ? `Saved ${capture.editorView} view` : CAPTURE_LABEL[capture.view],
      identity, lineage: capture.lineage,
      ...(present && stale === undefined ? { asset: capture.image.sha256, href: `/api/representations/${kind}/${id}/images/${capture.image.sha256}` } : {}),
      ...(present && stale !== undefined ? { stale } : {}),
      sourceKind: 'capture',
      fidelity: capture.view === 'camera' ? (kind === 'wires' ? 'Static render of the stock\'s 3D construction view' : 'Static render of the attached 3D model') : 'Static capture of the design editor',
      limitations: capture.view === 'camera' ? ['A presentation camera; not a dimensioned view.'] : ['A picture of the editor at the saved version; not a drawing.'],
      src: `Captured in the browser (${capture.renderer}) from source ${capture.source.slice(0, 12)}.`,
      sources: [{ role: capture.view === 'camera' ? 'model' : 'design', path: identity.record, sha256: capture.source }],
      ...(capture.camera === undefined ? {} : { camera: capture.camera }),
    });
  }
  return out;
}

function derived(kind: CoverKind, id: string, identity: RepresentationIdentity, view: string, source: string, fields: Omit<RepresentationCandidate, 'view' | 'identity' | 'lineage' | 'asset' | 'href'>): RepresentationCandidate {
  const asset = digest(JSON.stringify({ record: identity.record, view, source, renderer: DERIVED_COVER_RENDERER }));
  // Derived from the record itself: regenerating after an edit or renderer change is the same lineage.
  return { view, identity, lineage: digest(JSON.stringify({ record: identity.record, view, derived: true })), asset, href: `/api/representations/${kind}/${id}/images/${asset}`, ...fields };
}

async function boardCandidates(deps: WorkbenchDeps, id: string): Promise<Gathered | ApiResponse> {
  const board = (await deps.loadDb()).pcbas.find((b) => b.id === id);
  if (board === undefined) return fail(404, 'That board is not in the library.');
  const identity = { record: `pcbas/${id}`, revision: board.revision, ...(board.build === undefined ? {} : { build: board.build }) };
  const candidates: RepresentationCandidate[] = [];
  const raw = await deps.depictions?.readMeta(id);
  const parsed = raw === undefined ? undefined : parseDepictionMeta(raw, `cover/${id}`);
  const meta = parsed?.issues.some((issue) => issue.severity === 'error') === true ? undefined : parsed?.meta;
  if (meta !== undefined && meta.defId === id) {
    const order = ['board-top', 'board-bottom', 'illustration', 'schematic-symbol'];
    for (const view of order) {
      const asset = meta.views[view];
      if (asset === undefined) continue;
      const bytes = await deps.depictions?.readAsset(id, asset.file);
      const sha = bytes === undefined ? undefined : digest(bytes);
      const sources = meta.sources ?? [];
      // Same native input/version/build may regenerate its output without losing the choice.
      // An upload without native source hashes is its own lineage and changes when replaced.
      const lineage = digest(JSON.stringify({ identity, view, sourceKind: asset.sourceKind,
        sources: sources.length === 0 ? sha ?? null : [...sources].sort((a, b) => a.role.localeCompare(b.role) || a.path.localeCompare(b.path)) }));
      candidates.push({ view, label: view === 'board-top' ? 'Board top' : view === 'board-bottom' ? 'Board bottom'
        : asset.sourceKind === 'photo' ? 'Photo' : view === 'illustration' ? 'Artwork' : 'Schematic',
        identity, lineage, ...(sha === undefined ? {} : { asset: sha }), sourceKind: asset.sourceKind,
        fidelity: asset.sourceKind === 'kicad' ? 'Native outline and pads' : asset.sourceKind === 'gerber' ? 'Fabrication-layer artwork' : asset.sourceKind === 'photo' ? 'Stored photograph' : 'Stored artwork',
        limitations: asset.sourceKind === 'kicad' ? ['No component models or fabrication-layer rendering in this preview.'] : [],
        src: asset.src, sources,
        ...(asset.widthUnits === undefined || asset.heightUnits === undefined ? {} : {
          frame: { width: asset.widthUnits, height: asset.heightUnits, mmPerUnit: asset.mmPerUnit, origin: 'top-left', yAxis: 'down' },
        }), ...(asset.mirrorOf === undefined ? {} : { mirrorOf: asset.mirrorOf, mirrorAxis: asset.mirrorAxis ?? 'x' }) });
    }
  }
  // Generated by the kicad tool pack (jobs/board-outputs.ts): the newest ok render of this board, tied to its
  // exact native source and pack version. A run for another revision/build keeps its own identity, so a
  // choice of it reads as stale rather than silently showing older geometry.
  const runs = deps.toolOutputs === undefined ? [] : await deps.toolOutputs.runs(identity.record, { limit: 10 });
  const render = runs.find((run) => run.op === 'board-render' && run.status === 'ok');
  if (render !== undefined) {
    const generated = [
      { role: 'render-top', view: 'kicad-render-top', label: 'KiCad render (top)' },
      { role: 'render-bottom', view: 'kicad-render-bottom', label: 'KiCad render (bottom)' },
      { role: 'board-top-svg', view: 'kicad-svg-top', label: 'KiCad layers (top)' },
      { role: 'board-bottom-svg', view: 'kicad-svg-bottom', label: 'KiCad layers (bottom)' },
    ];
    const runIdentity = { record: identity.record, ...(render.identity.revision === undefined ? {} : { revision: render.identity.revision }), ...(render.identity.build === undefined ? {} : { build: render.identity.build }) };
    for (const g of generated) {
      const output = render.outputs.find((o) => o.role === g.role);
      if (output === undefined) continue;
      const lineage = digest(JSON.stringify({ identity: runIdentity, view: g.view, pack: render.pack, packVersion: render.packVersion, op: render.op, params: render.params, sources: render.sources }));
      candidates.push({ view: g.view, label: g.label, identity: runIdentity, lineage, asset: output.sha256, sourceKind: 'kicad-cli',
        fidelity: `${render.tool.name} ${render.tool.version}`,
        limitations: g.role.startsWith('render') ? ['Component 3D models the pack cannot resolve are left out.'] : [],
        src: `${render.pack} tool pack ${render.packVersion}, ${render.op} of ${render.sources.map((s) => `${s.role} ${s.sha256.slice(0, 12)}`).join(', ')}`,
        sources: render.sources, ...(g.role === 'board-bottom-svg' ? { mirrorOf: 'kicad-svg-top', mirrorAxis: 'x' as const } : {}) });
    }
  }
  const model = await deps.modelLinks?.get(`pcbas/${id}`);
  const captureSources = model === undefined ? {} : { camera: model.asset };
  candidates.push(...await captureCandidates(deps, 'pcbas', id, identity, captureSources));
  candidates.push(...await notePhotoCandidates(deps, `definition:pcbas:${id}`, identity));
  return { identity, candidates, renders: new Map(), captureSources };
}

/** Photos attached to notes about a record (specs/knowledge.md): presentation candidates only, after the native views. */
async function notePhotoCandidates(deps: WorkbenchDeps, record: string, identity: RepresentationIdentity): Promise<RepresentationCandidate[]> {
  const out: RepresentationCandidate[] = [];
  for (const photo of await knowledgePhotosFor(deps, record)) {
    const stored = await deps.assets?.get(photo.asset);
    out.push({ view: `note-photo-${photo.asset.slice(0, 12)}`, label: `Photo · ${photo.title}`.slice(0, 80), identity,
      lineage: photoLineage(identity, photo.asset), ...(stored === undefined ? {} : { asset: photo.asset }), sourceKind: 'photo',
      fidelity: 'Stored photograph', limitations: ['A photograph; not geometry or terminal positions.'],
      src: `Attached to note ${photo.note} (${photo.name}).`, sources: [] });
  }
  return out;
}

async function wireCandidates(deps: WorkbenchDeps, id: string): Promise<Gathered | ApiResponse> {
  const wire = (await deps.loadDb()).wires.find((w) => w.id === id);
  if (wire === undefined) return fail(404, 'That wire stock is not in the library.');
  const identity: RepresentationIdentity = { record: `wires/${id}` };
  const source = contentETag(wire).replaceAll('"', '');
  const sources = [{ role: 'definition', path: `wires/${id}`, sha256: source }];
  const renders = new Map<string, Render>();
  const cutaway = derived('wires', id, identity, 'cutaway', source, {
    label: 'Layered cutaway', sourceKind: 'construction', fidelity: 'Drawn from the stock\'s construction, layer by layer',
    limitations: ['Layers step evenly so each can be seen; not to scale.'], src: `Drawn from wires/${id}'s element tree.`, sources,
  });
  renders.set(cutaway.asset!, async () => {
    const art = drawCutaway(wire);
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${art.width} ${art.height}" width="${art.width}" height="${art.height}">${art.body}</svg>`, widthPx: 720 };
  });
  const section = derived('wires', id, identity, 'cross-section', source, {
    label: 'Cross-section', sourceKind: 'construction', fidelity: 'Scaled cross-section from documented diameters',
    limitations: ['Stocks without documented diameters show a stated placeholder.'], src: `Drawn from wires/${id}'s documented diameters.`, sources,
  });
  renders.set(section.asset!, async () => ({ svg: renderCrossSection(wire), widthPx: 480 }));
  const candidates = [cutaway, section];
  // The stock's 3D view is drawn from its own construction: a saved camera is tied to that version.
  const captureSources = { camera: source };
  candidates.push(...await captureCandidates(deps, 'wires', id, identity, captureSources), ...await notePhotoCandidates(deps, `definition:wires:${id}`, identity));
  return { identity, candidates, renders, captureSources };
}

async function designCandidates(deps: WorkbenchDeps, id: string): Promise<Gathered | ApiResponse> {
  const design = await deps.designs?.read(id);
  if (design === undefined) return fail(404, 'There is no design with that id.');
  const identity: RepresentationIdentity = { record: `designs/${id}` };
  const version = contentETag(design).replaceAll('"', '');
  // The cache key is the design version plus the catalog generation (`deps.catalogVersion`, a cheap
  // token the storage seam already keeps): a board-art or connector change re-renders the schematic
  // without hashing the catalog per list row. Lineage stays per record, so a cover choice survives.
  const generation = (await deps.catalogVersion?.()) ?? '';
  const source = generation === '' ? version : digest(`${version}:${generation}`);
  const sources = [{ role: 'design', path: `designs/${id}`, sha256: version }];
  const renders = new Map<string, Render>();
  const sheet = (kind: 'schematic' | 'drawing', widthPx: number): Render => async () => {
    const out = await handleDocumentRequest('GET', ['api', 'designs', id, 'documents', kind], new URLSearchParams('format=svg'), deps);
    if (out === undefined || out.status !== 200 || out.bytes === undefined) throw new Error(`The ${kind} could not be drawn.`);
    return { svg: new TextDecoder().decode(out.bytes), widthPx };
  };
  const schematic = derived('designs', id, identity, 'schematic', source, {
    label: 'Schematic', sourceKind: 'document', fidelity: 'The design\'s schematic, with library board artwork',
    limitations: [], src: `Rendered from designs/${id} (working copy).`, sources,
  });
  renders.set(schematic.asset!, sheet('schematic', 960));
  const drawing = derived('designs', id, identity, 'drawing', source, {
    label: 'Drawing sheet', sourceKind: 'document', fidelity: 'The design\'s drawing sheet',
    limitations: ['A whole sheet; small in a list.'], src: `Rendered from designs/${id} (working copy).`, sources,
  });
  renders.set(drawing.asset!, sheet('drawing', 960));
  const captureSources = { 'saved-view': version };
  const candidates = [schematic, drawing, ...await deviceExportCandidates(deps, identity), ...await captureCandidates(deps, 'designs', id, identity, captureSources), ...await notePhotoCandidates(deps, `design:${id}`, identity)];
  return { identity, candidates, renders, captureSources };
}

/**
 * A device's newest export (`devices/export-job.ts`): its rendered preview, tied to the
 * exact request (its sha256) and pack version, so a chosen cover goes stale when a newer export replaces it.
 */
async function deviceExportCandidates(deps: WorkbenchDeps, identity: RepresentationIdentity): Promise<RepresentationCandidate[]> {
  const runs = deps.toolOutputs === undefined ? [] : await deps.toolOutputs.runs(identity.record, { limit: 12 });
  const run = runs.find((r) => r.op === 'device-assemble' && r.status === 'ok' && r.outputs.some((o) => o.role === 'preview-image'));
  const preview = run?.outputs.find((o) => o.role === 'preview-image');
  if (run === undefined || preview === undefined) return [];
  const request = typeof run.params['requestSha256'] === 'string' ? run.params['requestSha256'] : run.id;
  const rev = (run.params['design'] as { rev?: number } | undefined)?.rev;
  return [{
    view: 'device-preview', label: 'Device export', identity, lineage: digest(JSON.stringify({ identity, view: 'device-preview', pack: run.pack, packVersion: run.packVersion, request })),
    asset: preview.sha256, sourceKind: 'device-export', fidelity: `${run.tool.name} ${run.tool.version}`,
    limitations: ['Boards without a native 3D export are drawn from their outlines.'],
    src: `${run.pack} tool pack ${run.packVersion}, device export of ${rev === undefined ? 'the saved design' : `Rev ${rev}`}, ${run.createdAt.slice(0, 10)}`,
    sources: run.sources,
  }];
}

/**
 * Shells (mechanicals): the last enclosure generation's preview image, tied to the exact request
 * (its sha256) and pack version, plus a saved camera on the generated GLB. Same resolver, no second path.
 */
async function mechanicalCandidates(deps: WorkbenchDeps, id: string): Promise<Gathered | ApiResponse> {
  const record = ((await deps.loadDb()).mechanicals ?? []).find((m) => m.id === id);
  if (record === undefined) return fail(404, 'That shell is not in the library.');
  const identity: RepresentationIdentity = { record: `mechanicals/${id}` };
  const candidates: RepresentationCandidate[] = [];
  const run = (await deps.docs?.read(enclosureRunPath(id)) ?? null) as EnclosureRun | null;
  if (run !== null && run.status === 'ok') {
    const preview = run.outputs.find((o) => o.role === 'preview-image' && o.asset !== undefined);
    if (preview !== undefined) {
      const lineage = digest(JSON.stringify({ identity, view: 'enclosure-preview', pack: run.pack, packVersion: run.packVersion, request: run.requestSha256 }));
      candidates.push({ view: 'enclosure-preview', label: 'Enclosure preview', identity, lineage, asset: preview.asset!, sourceKind: 'enclosure',
        fidelity: `${run.tool.name ?? run.pack} ${run.tool.version ?? ''}`.trim(),
        limitations: ['A preview of the generated shell; not a dimensioned drawing.'],
        src: `${run.pack} tool pack ${run.packVersion}, generated ${run.generatedAt.slice(0, 10)} from request ${run.requestSha256.slice(0, 12)}`,
        sources: [{ role: 'enclosure-request', path: `mechanicals/${id}`, sha256: run.requestSha256 }] });
    }
  }
  const model = await deps.modelLinks?.get(`mechanicals/${id}`);
  const captureSources = model === undefined ? {} : { camera: model.asset };
  candidates.push(...await captureCandidates(deps, 'mechanicals', id, identity, captureSources), ...await notePhotoCandidates(deps, `definition:mechanicals:${id}`, identity));
  return { identity, candidates, renders: new Map(), captureSources };
}

function gather(deps: WorkbenchDeps, kind: CoverKind, id: string): Promise<Gathered | ApiResponse> {
  return kind === 'pcbas' ? boardCandidates(deps, id) : kind === 'wires' ? wireCandidates(deps, id)
    : kind === 'mechanicals' ? mechanicalCandidates(deps, id) : designCandidates(deps, id);
}

async function serveImage(deps: WorkbenchDeps, kind: CoverKind, id: string, asset: string, gathered: Gathered): Promise<ApiResponse> {
  if (!/^[0-9a-f]{64}$/.test(asset)) return fail(400, 'That is not an image address.');
  const headers = { ETag: `"${asset}"`, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
  const candidate = gathered.candidates.find((c) => c.asset === asset);
  if (candidate === undefined) return fail(404, 'That preview changed or is gone. Reload the previews.');
  if (candidate.sourceKind === 'capture') {
    const capture = (await readCaptures(deps, kind, id)).find((c) => c.image.sha256 === asset);
    const image = capture === undefined ? undefined : await readCaptureImage(deps, kind, id, capture.image);
    if (image === undefined) return fail(404, 'That saved preview is missing.');
    return { status: 200, body: null, bytes: image.bytes, contentType: image.mediaType, headers };
  }
  let hit = derivedCache.get(asset);
  if (hit === undefined) {
    const render = gathered.renders.get(asset);
    if (render === undefined) return fail(404, 'That preview is not rendered here.');
    try {
      const { svg, widthPx } = await render();
      hit = { bytes: await svgToPng(svg, widthPx), mediaType: 'image/png' };
    } catch (error) {
      return fail(422, `This preview could not be drawn: ${error instanceof Error ? error.message : String(error)}`);
    }
    remember(asset, hit);
  }
  return { status: 200, body: null, bytes: hit.bytes, contentType: hit.mediaType, headers };
}

export async function handleRepresentationRequest(request: ApiRequest, parts: string[], deps: WorkbenchDeps): Promise<ApiResponse> {
  const [, , kind, id, section, asset] = parts;
  if (kind === 'migrate-images' && parts.length === 3) return migrateAllImages(request, deps);
  const validId = kind === 'designs' ? isDesignId(id)
    : kind === 'mechanicals' ? typeof id === 'string' && id.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+|(?<=\d)\.\d[a-z0-9]*)*$/.test(id)
    : isDepictionDefId(id);
  if (!isCoverKind(kind) || id === undefined || !validId || parts.length > 6 || (section !== undefined && section !== 'captures' && section !== 'images')
    || (section === 'images') !== (asset !== undefined) || (section === 'captures' && parts.length !== 5)) return fail(404, 'There is no representation at this address.');
  // These endpoints describe working records only. Historical geometry must come from a frozen
  // revision's depiction source, never by silently treating ?rev as a live read.
  if (new URLSearchParams(request.path.split('?')[1]).has('rev')) return fail(400, 'This address describes the working record. Open the saved revision for historical artwork.');
  const method = request.method.toUpperCase();
  const allowed = section === undefined ? ['GET', 'PUT'] : section === 'images' ? ['GET'] : ['POST'];
  if (!allowed.includes(method)) return fail(405, `This address accepts ${allowed.join(' and ')}.`);
  if (deps.docs === undefined) return fail(501, 'This hub cannot store cover choices.');
  const gathered = await gather(deps, kind, id);
  if ('status' in gathered) return gathered;
  if (section === 'images') return serveImage(deps, kind, id, asset!, gathered);
  const path = coverPath(id, kind);
  const choice = (await deps.docs.read(path) ?? null) as CoverChoice | null;
  const current: RepresentationView = { identity: gathered.identity, choice, candidates: gathered.candidates, captureSources: gathered.captureSources };
  // Include the available sources in the ETag so an intervening import also refuses a stale choice.
  const etag = contentETag(current);
  const answer = (value: RepresentationView): ApiResponse => ({ status: 200, body: { ...value, resolution: resolveCover(value) }, headers: { ETag: contentETag(value) } });
  if (method === 'GET') return answer(current);
  const guard = checkIfMatch(request.headers?.['if-match'], etag, 'cover', current.identity.record);
  if (guard !== undefined) return guard;
  if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) return fail(400, 'Send a cover choice, or null for automatic.');
  if (section === 'captures') return saveCapture(request.body as Record<string, unknown>, deps, kind, id, current, answer);
  if (!('choice' in request.body)) return fail(400, 'Send a cover choice, or null for automatic.');
  const value = request.body.choice;
  if (value === null) {
    await deps.docs.remove(path);
    return answer({ ...current, choice: null });
  }
  if (typeof value !== 'object' || Array.isArray(value) || !('view' in value) || !('lineage' in value)) return fail(400, 'Choose one of the available previews.');
  const candidate = current.candidates.find((c) => c.view === value.view && c.lineage === value.lineage && c.asset !== undefined);
  if (candidate === undefined) return fail(409, 'That preview is unavailable or changed. Reload the previews and choose again.');
  const next: CoverChoice = { view: candidate.view, lineage: candidate.lineage };
  await deps.docs.write(path, next);
  return answer({ ...current, choice: next });
}

/** "Use this view as cover": store the static image with its source/renderer identity and choose it. */
async function saveCapture(body: Record<string, unknown>, deps: WorkbenchDeps, kind: CoverKind, id: string, current: RepresentationView,
  answer: (value: RepresentationView) => ApiResponse): Promise<ApiResponse> {
  const docs = deps.docs!;
  const view = body.view;
  if (!isCoverCaptureView(view) || !CAPTURE_VIEWS_OF[kind].includes(view)) return fail(400, 'This record cannot take that kind of saved view.');
  const source = current.captureSources?.[view];
  if (source === undefined) return fail(409, view === 'camera' ? 'This record has no 3D model to save a view of.' : 'There is nothing to capture.');
  if (body.source !== source) return fail(409, 'The record changed since this view was drawn. Reload, then save the view again.');
  if (body.renderer !== COVER_CAPTURE_RENDERERS[view]) return fail(409, 'This page is out of date. Reload it, then save the view again.');
  const camera = view === 'camera' ? parseCamera(body.camera) : undefined;
  if (view === 'camera' && camera === undefined) return fail(400, 'Send the camera the view was rendered with.');
  const editorView = view === 'saved-view' && (body.editorView === 'canvas' || body.editorView === 'schematic') ? body.editorView : undefined;
  if (typeof body.image !== 'string' || body.image.length > MAX_CAPTURE_BYTES * 1.4) return fail(413, 'Send the image as base64, at most 1.5 MB.');
  const bytes = new Uint8Array(Buffer.from(body.image, 'base64'));
  const mediaType = sniffImage(bytes);
  if (mediaType === undefined || bytes.length > MAX_CAPTURE_BYTES) return fail(400, 'The image must be a PNG, JPEG or WebP of at most 1.5 MB.');
  const width = typeof body.width === 'number' && body.width > 0 ? Math.round(body.width) : 0;
  const height = typeof body.height === 'number' && body.height > 0 ? Math.round(body.height) : 0;
  const sha = digest(bytes);
  const lineage = captureLineage(current.identity, view, camera);
  const capture: StoredCapture = { view, lineage, source, renderer: COVER_CAPTURE_RENDERERS[view], image: { sha256: sha, mediaType, width, height },
    ...(camera === undefined ? {} : { camera }), ...(editorView === undefined ? {} : { editorView }) };
  const before = await readCaptures(deps, kind, id);
  const replaced = before.find((c) => c.view === view);
  // the record's older captures move out of base64 documents first (the replaced one is removed below)
  await migrateRecordImages(deps, kind, id, replaced !== undefined && replaced.image.sha256 !== sha ? replaced.image.sha256 : undefined);
  if (deps.files !== undefined) await deps.files.write(captureFilePath(kind, id, sha, mediaType), bytes);
  else await docs.write(captureImagePath(kind, id, sha), { mediaType, base64: Buffer.from(bytes).toString('base64') } satisfies StoredImage);
  await docs.write(capturesPath(kind, id), { captures: [...before.filter((c) => c.view !== view), capture] });
  if (replaced !== undefined && replaced.image.sha256 !== sha) await removeCaptureImage(deps, kind, id, replaced.image);
  const next: CoverChoice = { view, lineage };
  if (body.use !== false) await docs.write(coverPath(id, kind), next);
  const candidates = await captureCandidates(deps, kind, id, current.identity, current.captureSources ?? {});
  // Within one unit of work the reads above may not see the staged writes; describe the result directly.
  const fresh: RepresentationCandidate = candidates.find((c) => c.view === view && c.asset === sha) ?? {
    view, label: view === 'saved-view' && editorView !== undefined ? `Saved ${editorView} view` : CAPTURE_LABEL[view], identity: current.identity, lineage, asset: sha,
    href: `/api/representations/${kind}/${id}/images/${sha}`, sourceKind: 'capture',
    fidelity: view === 'camera' ? 'Static render of the attached 3D model' : 'Static capture of the design editor',
    limitations: [], src: `Captured in the browser (${capture.renderer}) from source ${source.slice(0, 12)}.`,
    sources: [{ role: view === 'camera' ? 'model' : 'design', path: current.identity.record, sha256: source }], ...(camera === undefined ? {} : { camera }),
  };
  return answer({ ...current, choice: body.use === false ? current.choice : next, candidates: [...current.candidates.filter((c) => c.view !== view), fresh] });
}
