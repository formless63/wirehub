/**
 * Documents and exports without a browser — `/api/designs/:id/documents/:kind`
 * and `/api/designs/:id/exports/:format` (`docs/exports.md`).
 *
 *   GET /api/designs/:id/documents/:kind?format=…&rev=…&paper=…&variation=…&page=…&copies=…&preset=…&qr=1&quantity=…&scale=…&explode=1
 *       kind: schematic · build-sheet · bom · test-spec · drawing · labels · formboard
 *       format: html · svg · pdf · csv · png · lbx (which a kind comes in: `render/index.ts`; labels also take template= and printer=)
 *   GET /api/designs/:id/exports/:format?rev=…&quantity=…
 *       format: bom.csv · wire-list.csv · cut-list.csv · crimp-list.csv · production.xlsx ·
 *       continuity.csv · continuity.json · labels.csv · labels.svg · labels.lbx
 *   GET /api/definitions/wires/:id/wire-spec?format=html|svg|pdf&paper=…
 *       a wire stock's spec sheet (the Library's Spec tab), named WSS_<document number>
 *   GET /api/exports   the list of export formats
 *
 * `rev` is a saved revision number, or `latest`; without it the working copy is
 * rendered. A revision renders from the definitions frozen when it was saved,
 * the working copy from the live library. Same functions as the browser's
 * Documents view, so the answer is the file the toolbar would download.
 */

import { isDesignId } from '@wirehub/catalog';
import { BASE_EXPORTS, LABEL_PRESET_IDS, LBX_PRINTER_IDS, registeredLabelTemplates, PAPER_IDS, baseExport, parsePaper, parseScale, readTestParameters, type DrawingArt, type RevisionRow, type DrawingMeta, type FormatOptions, type TestParameters } from '@wirehub/docs';
import { knownPartNumbers, releasedRevision, stableJson, versionDb, versionSummary, type CableDesign, type Db, type DesignVersionFile, type KnownPartNumber, type PartNumberScheme, type VersionSummary } from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';

import type { ApiResponse } from './api.ts';
import type { DesignStore } from './designs.ts';
import type { DrawingStore } from './drawings.ts';
import { type ApprovalFacts, type PdfProvenance, DEFAULT_FORMAT, DOCUMENT_FORMATS, DOCUMENT_KIND_FORMATS, DOCUMENT_KINDS, isDocumentFormat, isDocumentKind, releaseMeta, renderDocument, withBranding } from './render/index.ts';
import { approvalPolicy, BRANDING_PATH, brandingView, effectiveTestDefaults, type BrandingRecord } from './settings.ts';
import { brandingArt } from '../module-art.ts';
import type { AssetStore } from './assets.ts';
import { pdfEngineOf, type PdfEngine } from './render/browser-pdf.ts';
import type { RuntimeSettings } from './runtime-settings.ts';
import type { DocStore } from './storage/doc-store.ts';
import type { VersionStore } from './versions.ts';
import { withDesignLibrary } from './assemblies.ts';
import type { DepictionStore } from './depictions.ts';
import { depictionIdsOf, revisionDepictions, safeCatalog, storeDepictions } from './render/depictions.ts';
import { partNumberSchemeOf, type SchemeDeps } from './part-number-scheme.ts';
import { isWireSpecFormat, renderWireSpec, WIRE_SPEC_FORMATS } from './render/wire-spec.ts';
import type { WireLibraryStore } from './wire-library.ts';
import type { Awaitable } from './storage/change-set.ts';
import { DOCUMENT_CACHE_VERSION, sha256Hex, type CachedDocument, type DocumentCache } from './document-cache.ts';

export const DOCUMENT_ROUTES = [
  'GET    /api/designs/:id/documents/:kind',
  'GET    /api/designs/:id/exports/:format',
  'GET    /api/definitions/wires/:id/wire-spec',
  'GET    /api/exports',
] as const;

export interface DocumentDeps extends SchemeDeps {
  designs: DesignStore;
  loadDb: () => Awaitable<Db>;
  versions?: VersionStore;
  drawings?: DrawingStore;
  /** the environment's default test parameters (`WIREHUB_TEST_DEFAULTS`): the fallback the engineering settings override */
  testDefaults?: TestParameters;
  /** catalog documents by path: where the engineering settings live */
  docs?: DocStore;
  /** the artwork store: given it, the sheets draw its artwork (uploaded boards included), not only the catalog tree's */
  depictions?: DepictionStore;
  /** the wire stock recipes and parts the spec sheet reads */
  wireLibrary?: WireLibraryStore;
  /** the asset store: the branding's logo is read from it */
  assets?: AssetStore;
  /** bytes by content address: where the branding's typeface is read when a pack shipped it */
  blob?: (sha256: string) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined>;
  /** the browser engine the HTML sheets are printed to PDF with (`WIREHUB_PDF_ENGINE_URL`, `render/browser-pdf.ts`); absent: the headless PDFs */
  pdfEngine?: PdfEngine;
  /** the live settings: the PDF engine named in Settings when the host handed none over */
  runtimeSettings?: RuntimeSettings;
  /** released renders by render key (`document-cache.ts`); absent: a revision is rendered on every request */
  documentCache?: DocumentCache;
}

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

/** `WIREHUB_TEST_DEFAULTS`: a JSON object of test parameters. Throws a sentence when it is not one. */
export function testDefaultsFromEnv(env: Readonly<Record<string, string | undefined>>): TestParameters | undefined {
  const raw = env['WIREHUB_TEST_DEFAULTS'];
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WIREHUB_TEST_DEFAULTS is not JSON. Set it to an object such as {"isolationVolts":250}.');
  }
  const read = readTestParameters(parsed);
  if (!read.ok) throw new Error(`WIREHUB_TEST_DEFAULTS is not valid: ${read.problems.join(' ')}`);
  return Object.keys(read.parameters).length === 0 ? undefined : read.parameters;
}

export interface Loaded {
  design: CableDesign;
  db: Db;
  drawing: DrawingMeta;
  photo?: string;
  target: 'working' | number | undefined;
  /** set when the hub requires approvals and a saved revision is rendered */
  approvals?: ApprovalFacts;
  /** the saved revision's file, when one is rendered: its frozen artwork is drawn */
  version?: DesignVersionFile;
}

/** The revision a `rev` names: a number, `latest`, or `released` (the latest approved revision with approvals on, else the latest saved). */
export async function resolveRevision(deps: DocumentDeps, id: string, rev: string): Promise<number | ApiResponse> {
  if (deps.versions === undefined) return fail(501, 'This hub does not keep saved revisions.', 'Leave out ?rev= to render the working copy.');
  if (rev === 'latest') {
    const all = await deps.versions.revisions(id);
    const last = all[all.length - 1];
    if (last === undefined) return fail(404, `'${id}' has no saved revision.`, 'Save a version first, or leave out ?rev=.');
    return last;
  }
  if (rev === 'released') {
    const { released, approvalsOn } = await releasedOf(deps, id);
    if (released === undefined) return fail(404, `'${id}' has no ${approvalsOn ? 'approved' : 'saved'} revision.`, 'Approve a saved version first, or leave out ?rev=.');
    return released;
  }
  if (/^\d{1,6}$/.test(rev)) return Number(rev);
  return fail(400, `'${rev}' is not a revision number.`, 'Use a whole number such as 2, or latest.');
}

/** The approved release: the latest approved revision (approvals on), else the latest saved. */
export async function releasedOf(deps: DocumentDeps, id: string): Promise<{ released?: number; approvalsOn: boolean }> {
  const policy = await approvalPolicy(deps.docs);
  const summaries: VersionSummary[] = [];
  for (const n of (await deps.versions?.revisions(id)) ?? []) {
    const f = await deps.versions?.read(id, n);
    if (f !== undefined) summaries.push(versionSummary(f));
  }
  const released = releasedRevision(summaries, policy.enabled);
  return { ...(released === undefined ? {} : { released }), approvalsOn: policy.enabled };
}

/** A saved revision as the sheets render it: its own design and frozen definitions, the drawing sidecar of today. */
export async function loadRevision(deps: DocumentDeps, id: string, number: number, known?: DesignVersionFile): Promise<Loaded | ApiResponse> {
  const file = known ?? (await deps.versions?.read(id, number));
  if (file === undefined) return fail(404, `'${id}' has no saved Rev ${number}.`, 'GET /api/designs/:id/versions lists the revisions.');
  const live = await deps.loadDb();
  const sidecar = deps.drawings === undefined ? undefined : await deps.drawings.read(id);
  const drawing: DrawingMeta = sidecar?.meta ?? {};
  const photo = sidecar?.photo;
  const policy = await approvalPolicy(deps.docs);
  const frozen = { ...file.design, id };
  return {
    design: frozen,
    // its sub-assemblies are pinned to saved versions: as frozen as it is
    db: await withDesignLibrary(deps, frozen, versionDb(file.definitions, live)),
    drawing,
    ...(photo === undefined ? {} : { photo }),
    target: number,
    version: file,
    ...(policy.enabled ? { approvals: { ...(file.approval === undefined ? {} : { approval: file.approval }) } } : {}),
  };
}

async function load(deps: DocumentDeps, id: string, rev: string | null): Promise<Loaded | ApiResponse> {
  if (!(await deps.designs.has(id))) return fail(404, `There is no design called '${id}'.`, 'Pick one from GET /api/designs.');
  if (rev === null || rev === '') {
    const working = await deps.designs.read(id);
    if (working === undefined) return fail(404, `There is no design called '${id}'.`, 'Pick one from GET /api/designs.');
    const live = await deps.loadDb();
    const sidecar = deps.drawings === undefined ? undefined : await deps.drawings.read(id);
    const drawing: DrawingMeta = sidecar?.meta ?? {};
    const photo = sidecar?.photo;
    // a design placing sub-assemblies reads them from the design library
    return { design: working, db: await withDesignLibrary(deps, working, live), drawing, ...(photo === undefined ? {} : { photo }), target: deps.versions !== undefined ? 'working' : undefined };
  }
  const number = await resolveRevision(deps, id, rev);
  if (typeof number !== 'number') return number;
  return await loadRevision(deps, id, number);
}

/** The artwork the sheets draw: the store's (uploaded boards too) when the hub keeps one, a revision's own copy over it. `undefined`: the catalog tree, as before. */
async function artworkOf(deps: DocumentDeps, loaded: Loaded): Promise<DepictionSource | undefined> {
  if (deps.depictions === undefined && loaded.version === undefined) return undefined;
  try {
    const live = deps.depictions === undefined ? safeCatalog() : await storeDepictions(deps.depictions, depictionIdsOf(loaded.design, loaded.db));
    return loaded.version === undefined || deps.versions === undefined ? live : await revisionDepictions(deps.versions, loaded.version, live);
  } catch {
    // artwork is presentation: a store that cannot be read draws the catalog's tree
    return undefined;
  }
}

/** The numbering scheme and every number in use: what the BOM's proposals for unnumbered parts read. */
async function partNumbersOf(deps: DocumentDeps, loaded: Loaded): Promise<{ scheme: PartNumberScheme; known: readonly KnownPartNumber[] } | undefined> {
  if (deps.loadPartNumberFiles === undefined && deps.modules === undefined) return undefined;
  try {
    const designs: CableDesign[] = [];
    const pns: KnownPartNumber[] = [];
    for (const summary of await deps.designs.list()) {
      const design = await deps.designs.read(summary.id);
      if (design === undefined) continue;
      designs.push(design);
      const pn = (await deps.drawings?.read(summary.id))?.meta.partNumber;
      if (pn !== undefined) pns.push({ pn, kind: 'design', source: `drawings/${summary.id}` });
    }
    return { scheme: await partNumberSchemeOf(deps), known: knownPartNumbers(loaded.db, designs, pns) };
  } catch {
    return undefined;
  }
}

/** The drawing's revision table: one row per saved revision up to the one rendered (a working copy gets its own row), oldest first. */
async function revisionRows(deps: DocumentDeps, id: string, target: 'working' | number | undefined): Promise<RevisionRow[] | undefined> {
  if (deps.versions === undefined) return undefined;
  const rows: RevisionRow[] = [];
  try {
    for (const n of await deps.versions.revisions(id)) {
      if (typeof target === 'number' && n > target) break;
      const file = await deps.versions.read(id, n);
      if (file === undefined) continue;
      rows.push({ rev: String(n), description: file.note.trim() === '' ? `Revision ${n}` : file.note.trim(), date: file.savedAt.slice(0, 10).replace(/-/g, '.'), by: file.savedBy });
    }
  } catch {
    // the table is a convenience: a version store that cannot be read prints the sheet without it
    return undefined;
  }
  if (target === 'working') rows.push({ rev: '—', description: 'Working copy, not released' });
  return rows;
}

function today(): string {
  const d = new Date();
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

function positive(value: string | null, name: string): number | undefined | ApiResponse {
  if (value === null || value === '') return undefined;
  if (!/^\d{1,4}$/.test(value) || Number(value) < 1) return fail(400, `${name} must be a whole number from 1.`);
  return Number(value);
}

/** The response headers that say how a PDF was made (`docs/exports.md`): the renderer, and why the browser engine was not used when it could have been. */
export function pdfHeaders(pdf: { renderer: string; fallback?: string } | undefined): Record<string, string> {
  if (pdf === undefined) return {};
  // a header is ASCII on one line
  const ascii = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?').slice(0, 400);
  return { 'X-WireHub-PDF-Renderer': pdf.renderer, ...(pdf.fallback === undefined ? {} : { 'X-WireHub-PDF-Fallback': ascii(pdf.fallback) }) };
}

/** The hub's branding as drawing art for the sheets the server draws, as the browser registers it (`installBranding`). */
async function brandingOf(deps: DocumentDeps, db: Db): Promise<DrawingArt | undefined> {
  if (deps.docs === undefined) return undefined;
  try {
    const record = (await deps.docs.read(BRANDING_PATH)) as BrandingRecord | undefined;
    // the typeface, and the drawing art the library holds as data (this hub's file and its packs')
    return brandingArt(await brandingView(record, deps.assets, { ...(deps.blob === undefined ? {} : { blob: deps.blob }), db }));
  } catch {
    // branding is presentation: a settings document that cannot be read leaves the generic text
    return undefined;
  }
}

function file(output: { mimeType: string; fileName: string; body: string | Uint8Array }, inline: boolean, extraHeaders: Record<string, string> = {}): ApiResponse {
  const bytes = typeof output.body === 'string' ? new TextEncoder().encode(output.body) : output.body;
  return {
    status: 200,
    body: null,
    bytes,
    contentType: output.mimeType,
    headers: {
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${downloadName(output.fileName)}"`,
      // a rendered sheet is a document, never a page that runs anything
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  };
}

/** The file name a download carries (`Content-Disposition`). */
export function downloadName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Sheets a browser shows in place; everything else downloads. */
function inlineMedia(mimeType: string): boolean {
  return mimeType.startsWith('text/html') || mimeType === 'image/svg+xml' || mimeType === 'application/pdf';
}

/** The date a saved revision prints in a date stamp: the approval's when it is approved, else when it was saved (`YYYY.MM.DD`). */
export function stampDate(file: Pick<DesignVersionFile, 'savedAt' | 'approval'>): string {
  const at = file.approval?.state === 'approved' ? file.approval.at : file.savedAt;
  return at.slice(0, 10).replace(/-/g, '.');
}

/* ------------------------------------------------------------------ *
 * Released renders: render keys and the document cache (`docs/document-manifest.md`)
 * ------------------------------------------------------------------ */

/** A stable, quoted content tag: the sha256 of the value's key-sorted JSON (backend-independent). */
export function stableTag(value: unknown): string {
  return `"${sha256Hex(new TextEncoder().encode(stableJson(value))).slice(0, 32)}"`;
}

/**
 * The name a revision render has in the manifest (`documents/<kind>.<format>`, `exports/<id>`) when
 * the request asks with default options only (`rev`, and `format` for a document); otherwise
 * `undefined`, and the render is made per request as before.
 */
export function revisionRenderName(section: 'documents' | 'exports', name: string, query: URLSearchParams): string | undefined {
  const rev = query.get('rev');
  if (rev === null || rev === '') return undefined;
  const allowed = section === 'documents' ? ['rev', 'format'] : ['rev'];
  for (const key of query.keys()) if (!allowed.includes(key)) return undefined;
  if (query.getAll('rev').length > 1 || query.getAll('format').length > 1) return undefined;
  if (section === 'exports') return baseExport(name) === undefined ? undefined : `exports/${name}`;
  if (!isDocumentKind(name)) return undefined;
  const format = query.get('format') ?? DEFAULT_FORMAT[name];
  return isDocumentFormat(format) && DOCUMENT_KIND_FORMATS[name].includes(format) ? `documents/${name}.${format}` : undefined;
}

/** Everything a saved revision's renders may depend on, but the name: the render key's inputs. */
export interface RenderContext {
  id: string;
  rev: number;
  file: DesignVersionFile;
  /** the version file's content tag (approval included) */
  versionEtag: string;
  inputs: {
    drawing: string;
    branding: string;
    engineering: string;
    approvalsOn: boolean;
    pdfEngine: 'browser' | 'none';
    modules: string[];
  };
}

async function readTag(read: () => Promise<unknown>): Promise<string> {
  try {
    return stableTag((await read()) ?? null);
  } catch {
    return stableTag(null);
  }
}

export async function renderContextOf(deps: DocumentDeps, id: string, file: DesignVersionFile): Promise<RenderContext> {
  const sidecar = deps.drawings === undefined ? undefined : await deps.drawings.read(id);
  // the sidecar's revision follows the latest save: left out, so a newer revision does not move this one's key
  const { revision: _revision, ...meta } = sidecar?.meta ?? {};
  const photo = sidecar?.photo === undefined ? null : sha256Hex(new TextEncoder().encode(sidecar.photo));
  const modules = (deps.modules as { modules?: readonly { id: string; version: string }[] } | undefined)?.modules ?? [];
  return {
    id,
    rev: file.rev,
    file,
    versionEtag: stableTag(file),
    inputs: {
      drawing: stableTag({ meta, photo }),
      branding: await readTag(async () => deps.docs?.read(BRANDING_PATH)),
      engineering: await readTag(async () => effectiveTestDefaults(deps)),
      approvalsOn: (await approvalPolicy(deps.docs)).enabled,
      pdfEngine: pdfEngineOf(deps) === undefined ? 'none' : 'browser',
      modules: modules.map((m) => `${m.id}@${m.version}`).sort(),
    },
  };
}

/**
 * The render key: what a released render is stored under. The hub's own version and live
 * overlays (today's library, artwork, part numbers) are left out on purpose: the first render of
 * a revision stays its render until one of these changes (bump `DOCUMENT_CACHE_VERSION` to redo all).
 */
export function renderKeyOf(context: RenderContext, name: string): string {
  return sha256Hex(new TextEncoder().encode(stableJson({
    key: 'wirehub.render-key/1',
    cache: DOCUMENT_CACHE_VERSION,
    design: context.id,
    rev: context.rev,
    version: context.versionEtag,
    name,
    drawing: context.inputs.drawing,
    branding: context.inputs.branding,
    engineering: context.inputs.engineering,
    approvalsOn: context.inputs.approvalsOn,
    pdfEngine: context.inputs.pdfEngine,
    modules: context.inputs.modules,
  })));
}

export type Served = { ok: true; doc: CachedDocument; key: string; inline: boolean } | { ok: false; response: ApiResponse };

/** renders in progress per cache and key: two requests for the same render wait for one */
const inFlight = new WeakMap<DocumentCache, Map<string, Promise<Served>>>();

/**
 * A saved revision's render by name: from the document cache when it holds the key, else rendered
 * (from `loader`'s design) and stored (a racing writer's stored copy wins). Without a cache it is
 * rendered each time, with the same key and hash headers.
 */
export async function serveRevision(deps: DocumentDeps, context: RenderContext, name: string, loader: () => Promise<Loaded | ApiResponse>): Promise<Served> {
  const key = renderKeyOf(context, name);
  const cache = deps.documentCache;
  const inline = name.startsWith('documents/') && !/\.(csv|png|lbx)$/.test(name);
  if (cache !== undefined) {
    const hit = await cache.get(key);
    if (hit !== undefined) return { ok: true, doc: hit, key, inline: inline && inlineMedia(hit.mediaType) };
  }
  const run = async (): Promise<Served> => {
    const loaded = await loader();
    if ('status' in loaded) return { ok: false, response: loaded };
    const slash = name.indexOf('/');
    const section = name.slice(0, slash) as 'documents' | 'exports';
    const rest = name.slice(slash + 1);
    const dot = rest.lastIndexOf('.');
    const query = section === 'documents' ? new URLSearchParams({ rev: String(context.rev), format: rest.slice(dot + 1) }) : new URLSearchParams({ rev: String(context.rev) });
    const rendered = await renderFor(deps, context.id, loaded, section, section === 'documents' ? rest.slice(0, dot) : rest, query);
    if (!rendered.ok) return rendered;
    const bytes = typeof rendered.output.body === 'string' ? new TextEncoder().encode(rendered.output.body) : rendered.output.body;
    const doc: CachedDocument = {
      bytes,
      sha256: sha256Hex(bytes),
      mediaType: rendered.output.mimeType,
      fileName: rendered.output.fileName,
      ...(rendered.pdf === undefined ? {} : { renderer: rendered.pdf.renderer, ...(rendered.pdf.fallback === undefined ? {} : { fallback: rendered.pdf.fallback }) }),
      renderedAt: new Date().toISOString(),
    };
    const stored = cache === undefined ? doc : await cache.putIfAbsent(key, doc, { design: context.id, rev: context.rev });
    return { ok: true, doc: stored, key, inline: rendered.inline };
  };
  if (cache === undefined) return await run();
  let running = inFlight.get(cache);
  if (running === undefined) inFlight.set(cache, (running = new Map()));
  const pending = running.get(key);
  if (pending !== undefined) return await pending;
  const started = run();
  running.set(key, started);
  try {
    return await started;
  } finally {
    running.delete(key);
  }
}

/** A stored revision render as the response: content-hash `ETag`, hash and key headers, `If-None-Match` → 304. */
export function revisionFile(doc: CachedDocument, key: string, inline: boolean, ifNoneMatch?: string): ApiResponse {
  const etag = `"sha256:${doc.sha256}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    'X-WireHub-Content-SHA256': doc.sha256,
    'X-WireHub-Render-Key': key,
    ...pdfHeaders(doc.renderer === undefined ? undefined : { renderer: doc.renderer, ...(doc.fallback === undefined ? {} : { fallback: doc.fallback }) }),
  };
  if (ifNoneMatch !== undefined && ifNoneMatch.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === etag)) {
    return { status: 304, body: null, headers };
  }
  return file({ mimeType: doc.mediaType, fileName: doc.fileName, body: doc.bytes }, inline, headers);
}

async function wireSpec(method: string, id: string, query: URLSearchParams, deps: DocumentDeps): Promise<ApiResponse> {
  if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
  const db = await deps.loadDb();
  const wire = db.wires.find((w) => w.id === id);
  if (wire === undefined) return fail(404, `There is no wire stock called '${id}'.`, 'Pick one from GET /api/definitions/wires.');
  const asked = query.get('format') ?? 'html';
  if (!isWireSpecFormat(asked)) return fail(400, `'${asked}' is not a format for a spec sheet.`, `Formats: ${WIRE_SPEC_FORMATS.join(', ')}.`);
  const paperAsked = query.get('paper');
  const paper = paperAsked === null || paperAsked === '' ? null : parsePaper(paperAsked);
  if (paperAsked !== null && paperAsked !== '' && paper === undefined) return fail(400, `paper must be one of ${PAPER_IDS.join(', ')}, not '${paperAsked}'.`);
  const library = await deps.wireLibrary?.read();
  const recipe = library?.recipes.find((r) => r.id === id);
  const manufacturers = db.vocab?.['manufacturers']?.entries;
  // the hub's branding (settings): who issues it and what its files are called; the browser registers the same
  const branding = (await deps.docs?.read(BRANDING_PATH)) as BrandingRecord | undefined;
  try {
    const options = {
      ...(branding?.organisation === undefined ? {} : { organisation: branding.organisation }),
      ...(branding?.standard === undefined ? {} : { standard: branding.standard }),
      ...(branding?.rights === undefined ? {} : { rightsNotice: branding.rights }),
      ...(branding?.filePrefix === undefined ? {} : { filePrefix: branding.filePrefix }),
      ...(recipe === undefined ? {} : { recipe }),
      ...(library === undefined ? {} : { parts: library.parts }),
      ...(manufacturers === undefined ? {} : { manufacturers }),
      ...(paper === null || paper === undefined ? {} : { paper }),
    };
    if (asked === 'pdf') {
      // the sheet printed by the browser engine, when there is one; else the headless pages
      let fallback = 'No browser PDF engine is configured (WIREHUB_PDF_ENGINE_URL), so this is the headless PDF, not the printed HTML sheet (format=html prints that in a browser).';
      const engine = pdfEngineOf(deps);
      if (engine !== undefined) {
        const html = renderWireSpec(wire, 'html', options);
        try {
          const bytes = await engine.htmlToPdf(html.body as string);
          return file({ mimeType: 'application/pdf', fileName: html.fileName.replace(/\.html$/, '.pdf'), body: bytes }, true, pdfHeaders({ renderer: 'browser' }));
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          console.warn(`[documents] browser PDF of the ${id} spec sheet: ${why}; sent the headless PDF instead`);
          fallback = `The browser PDF engine failed (${why}), so this is the headless PDF, not the printed HTML sheet.`;
        }
      }
      return file(renderWireSpec(wire, 'pdf', options), true, pdfHeaders({ renderer: 'text-layout', fallback }));
    }
    return file(renderWireSpec(wire, asked, options), true);
  } catch (error) {
    return fail(422, `The spec sheet of ${id} could not be rendered.`, error instanceof Error ? error.message : String(error));
  }
}

/** `undefined` when the path is not one of the document routes. `headers`: the request's lower-cased headers (`if-none-match`). */
export async function handleDocumentRequest(method: string, parts: string[], query: URLSearchParams, deps: DocumentDeps, headers?: Record<string, string>): Promise<ApiResponse | undefined> {
  const [, head, id, section, name, ...rest] = parts;
  if (head === 'definitions' && id === 'wires' && parts.length === 5 && rest.length === 0 && parts[4] === 'wire-spec') return wireSpec(method, parts[3] as string, query, deps);
  if (head === 'exports' && id === undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    return {
      status: 200,
      body: {
        exports: BASE_EXPORTS.map(({ id: formatId, label, description, group }) => ({ id: formatId, label, description, group })),
        documents: DOCUMENT_KINDS.map((kind) => ({ kind, default: DEFAULT_FORMAT[kind] })),
        formats: DOCUMENT_FORMATS,
      },
    };
  }
  if (head !== 'designs' || id === undefined || (section !== 'documents' && section !== 'exports')) return undefined;
  if (rest.length > 0 || name === undefined) return fail(404, `${parts.join('/')} is not part of the server API.`, `Try ${DOCUMENT_ROUTES.join('; ')}.`);
  if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
  if (!isDesignId(id)) return fail(400, `${JSON.stringify(id)} cannot be used as a design id.`);

  // a saved revision with default options: served from the document cache by its render key
  const revisionName = revisionRenderName(section, name, query);
  if (revisionName !== undefined && deps.versions !== undefined) {
    if (!(await deps.designs.has(id))) return fail(404, `There is no design called '${id}'.`, 'Pick one from GET /api/designs.');
    const number = await resolveRevision(deps, id, query.get('rev') as string);
    if (typeof number !== 'number') return number;
    const version = await deps.versions.read(id, number);
    if (version === undefined) return fail(404, `'${id}' has no saved Rev ${number}.`, 'GET /api/designs/:id/versions lists the revisions.');
    const context = await renderContextOf(deps, id, version);
    const served = await serveRevision(deps, context, revisionName, () => loadRevision(deps, id, number, version));
    if (!served.ok) return served.response;
    return revisionFile(served.doc, served.key, served.inline, headers?.['if-none-match']);
  }

  const loaded = await load(deps, id, query.get('rev'));
  if ('status' in loaded) return loaded;
  const rendered = await renderFor(deps, id, loaded, section, name, query);
  return rendered.ok ? file(rendered.output, rendered.inline, pdfHeaders(rendered.pdf)) : rendered.response;
}

/** A render's bytes and how to send them, or the refusal to send. */
type Rendered =
  | { ok: true; output: { mimeType: string; fileName: string; body: string | Uint8Array }; pdf?: PdfProvenance; inline: boolean }
  | { ok: false; response: ApiResponse };

/** Render one document or export of a loaded design (no cache). */
async function renderFor(deps: DocumentDeps, id: string, loaded: Loaded, section: 'documents' | 'exports', name: string, query: URLSearchParams): Promise<Rendered> {
  const refuse = (response: ApiResponse): Rendered => ({ ok: false, response });
  const page = positive(query.get('page'), 'page');
  if (typeof page === 'object') return refuse(page);
  const copies = positive(query.get('copies'), 'copies');
  if (typeof copies === 'object') return refuse(copies);
  const quantity = positive(query.get('quantity'), 'quantity');
  if (typeof quantity === 'object') return refuse(quantity);
  const paperAsked = query.get('paper');
  const paper = paperAsked === null || paperAsked === '' ? null : parsePaper(paperAsked);
  if (paperAsked !== null && paperAsked !== '' && paper === undefined) return refuse(fail(400, `paper must be one of ${PAPER_IDS.join(', ')}, not '${paperAsked}'.`));
  // the label stock and the QR code, for this print (absent: the hub's settings)
  const presetAsked = query.get('preset');
  if (presetAsked !== null && presetAsked !== '' && !LABEL_PRESET_IDS.includes(presetAsked)) return refuse(fail(400, `preset must be one of ${LABEL_PRESET_IDS.join(', ')}, not '${presetAsked}'.`));
  const preset = presetAsked === null || presetAsked === '' ? undefined : presetAsked;
  const templateAsked = query.get('template');
  if (templateAsked !== null && templateAsked !== '' && registeredLabelTemplates()[templateAsked] === undefined) return refuse(fail(400, `template must be one of ${Object.keys(registeredLabelTemplates()).join(', ')}, not '${templateAsked}'.`));
  const template = templateAsked === null || templateAsked === '' ? undefined : templateAsked;
  const printerAsked = query.get('printer');
  if (printerAsked !== null && printerAsked !== '' && !LBX_PRINTER_IDS.includes(printerAsked)) return refuse(fail(400, `printer must be one of ${LBX_PRINTER_IDS.join(', ')}, not '${printerAsked}'.`));
  const printer = printerAsked === null || printerAsked === '' ? undefined : printerAsked;
  const qrAsked = query.get('qr');
  if (qrAsked !== null && !['', '0', '1', 'true', 'false'].includes(qrAsked)) return refuse(fail(400, `qr must be 1 or 0, not '${qrAsked}'.`));
  const qr = qrAsked === null || qrAsked === '' ? undefined : qrAsked === '1' || qrAsked === 'true';
  const variation = query.get('variation') ?? undefined;
  // the BOM lists each sub-assembly's parts instead of one line for it
  const explode = query.get('explode') === '1' || query.get('explode') === 'true';
  const scaleText = query.get('scale');
  const scale = scaleText === null || scaleText === '' ? undefined : parseScale(scaleText);
  if (scaleText !== null && scaleText !== '' && scale === undefined) return refuse(fail(400, `scale must be a number or a ratio such as 0.5 or 1:2, between 1:100 and 10:1, not '${scaleText}'.`));
  const meta = releaseMeta(loaded.drawing, loaded.target, loaded.approvals);
  const orgDefaults = await effectiveTestDefaults(deps);

  // a saved revision renders without proposals for unnumbered parts: those read today's numbers, not the revision's
  const revision = typeof loaded.target === 'number';
  const wantsProposals = !revision && ((section === 'documents' && (name === 'bom' || name === 'build-sheet')) || (section === 'exports' && (name === 'bom.csv' || name === 'production.xlsx')));
  const artwork = section === 'documents' && ['schematic', 'build-sheet', 'bom'].includes(name) ? await artworkOf(deps, loaded) : undefined;
  const partNumbers = wantsProposals ? await partNumbersOf(deps, loaded) : undefined;
  // the title block's organisation, logo and notes: the sheets the browser draws with them
  const branding = section === 'documents' && (name === 'drawing' || name === 'build-sheet' || name === 'bom' || name === 'test-spec' || name === 'formboard' || name === 'schematic' || name === 'labels') || (section === 'exports' && (name === 'labels.lbx' || name === 'labels.svg')) ? await brandingOf(deps, loaded.db) : undefined;
  // the drawing's revision table: the saved revisions up to the one printed
  const revisions = section === 'documents' && name === 'drawing' ? await revisionRows(deps, id, loaded.target) : undefined;

  if (section === 'exports') {
    const format = baseExport(name);
    if (format === undefined) return refuse(fail(404, `There is no export called '${name}'.`, `Formats: ${BASE_EXPORTS.map((f) => f.id).join(', ')}.`));
    const options: FormatOptions = {
      drawing: meta,
      ...(paper === null || paper === undefined ? {} : { paper }),
      ...(variation === undefined ? {} : { variation }),
      ...(typeof loaded.target === 'number' ? { revisionNumber: loaded.target } : {}),
      ...(meta.test === undefined ? {} : { testParameters: meta.test }),
      ...(orgDefaults === undefined ? {} : { testDefaults: orgDefaults }),
      ...(page === undefined ? {} : { page }),
      ...(copies === undefined ? {} : { copies }),
      ...(preset === undefined ? {} : { preset }),
      ...(qr === undefined ? {} : { qr }),
      ...(template === undefined ? {} : { template }),
      ...(printer === undefined ? {} : { printer }),
      ...(quantity === undefined ? {} : { buildQty: quantity }),
      ...(explode ? { explode: true } : {}),
      ...(partNumbers === undefined ? {} : { partNumbers }),
    };
    try {
      return { ok: true, output: withBranding(branding, () => format.render(loaded.design, loaded.db, options)), inline: false };
    } catch (error) {
      return refuse(fail(422, `${format.label} could not be made for ${id}.`, error instanceof Error ? error.message : String(error)));
    }
  }

  if (!isDocumentKind(name)) return refuse(fail(404, `There is no document called '${name}'.`, `Documents: ${DOCUMENT_KINDS.join(', ')}.`));
  const asked = query.get('format');
  if (asked !== null && !isDocumentFormat(asked)) return refuse(fail(400, `'${asked}' is not a format.`, `Formats: ${DOCUMENT_FORMATS.join(', ')}.`));
  const result = await renderDocument({
    kind: name,
    format: asked === null ? DEFAULT_FORMAT[name] : (asked as (typeof DOCUMENT_FORMATS)[number]),
    design: loaded.design,
    db: loaded.db,
    drawing: meta,
    ...(loaded.photo === undefined ? {} : { photo: loaded.photo }),
    ...(typeof loaded.target === 'number' ? { revisionNumber: loaded.target } : {}),
    ...(loaded.target === 'working' ? { unreleased: true } : {}),
    ...(loaded.approvals !== undefined && loaded.approvals.approval?.state !== 'approved' ? { unreleased: true, unreleasedLabel: 'UNAPPROVED' } : {}),
    ...(paper === null || paper === undefined ? {} : { paper }),
    ...(variation === undefined ? {} : { variation }),
    ...(loaded.approvals?.approval?.state === 'approved' ? { checked: loaded.approvals.approval.by } : {}),
    ...(revisions === undefined ? {} : { revisions }),
    ...(page === undefined ? {} : { page }),
    ...(copies === undefined ? {} : { copies }),
    ...(preset === undefined ? {} : { labelPreset: preset }),
    ...(qr === undefined ? {} : { labelQr: qr }),
    ...(template === undefined ? {} : { labelTemplate: template }),
    ...(printer === undefined ? {} : { labelPrinter: printer }),
    ...(scale === undefined ? {} : { scale }),
    ...(quantity === undefined ? {} : { buildQty: quantity }),
    ...(explode ? { explode: true } : {}),
    ...(orgDefaults === undefined ? {} : { testDefaults: orgDefaults }),
    ...(artwork === undefined ? {} : { depictions: artwork }),
    ...(partNumbers === undefined ? {} : { partNumbers }),
    ...(branding === undefined ? {} : { branding }),
    ...(pdfEngineOf(deps) === undefined ? {} : { pdfEngine: pdfEngineOf(deps) as PdfEngine }),
    // a revision is stamped with its release date (approved: the approval's, else when it was saved), never today's
    today: loaded.version !== undefined && revision ? stampDate(loaded.version) : today(),
  });
  if (!result.ok) return refuse(fail(result.status, result.error, result.hint));
  return { ok: true, output: result.output, ...(result.pdf === undefined ? {} : { pdf: result.pdf }), inline: inlineMedia(result.output.mimeType) };
}
