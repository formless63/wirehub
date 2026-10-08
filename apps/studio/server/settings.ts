/**
 * Hub settings: the organisation's identity on every document (cs-5k1.2).
 *
 *   GET /api/settings/branding   the settings, the logo's bytes inline, an ETag
 *   PUT /api/settings/branding   replace them (If-Match); owner or editor
 *
 * Stored as one catalog document, `data/settings/branding.json`, written through
 * the unit of work like every other record, so both backends keep it with the
 * catalog (and in the export). The logo is a PNG, sanitised on the way in
 * (`png-sanitize.ts`) and kept as a content-addressed asset; the document names it
 * by id. An SVG logo is cleaned of anything active (`stripUnsafeSvg`) and
 * rasterised to a PNG here (the same resvg the PDF pages use), so what is kept
 * is always a PNG. Nothing here is a document renderer: the browser registers what this
 * returns as drawing art (`installBranding`, `module-art.ts`), after a module's art,
 * so a module still wins and an empty setting leaves the generic text.
 *
 * Two more things a hub brings as data, stored beside the logo and used everywhere a document is drawn:
 *
 * - **A typeface** (`font`): a TrueType, OpenType or WOFF2 file uploaded here
 *   (`POST /api/settings/branding/fonts`, with a confirmation that the uploader holds a licence that lets
 *   documents embed it) and kept as an asset, or a font a data pack ships under `fonts/`. The record names
 *   the regular face and, optionally, a bold by content address. The sheets carry it inline (HTML, SVG and
 *   the browser engine's PDF), the drawing's raster PDF and the vector PDF embed it where they can
 *   (`render/brand-font.ts` says which).
 * - **Drawing art** (`drawing-art.json`): faces, plugs and cutaways by definition id, in the shape a module's
 *   `art.drawing` has, as this hub's own file; a data pack may ship one too, and the two layer.
 */

import { costingRulesProblems, electricalRulesProblems, type CostingRules, DEFAULT_AMPACITY, DEFAULT_ELECTRICAL_RULES, type ElectricalRules } from '@wirehub/model';
import { FILE_PREFIX_PATTERN, readTestParameters, type TestParameters } from '@wirehub/docs';
import { stripUnsafeSvg } from '@wirehub/catalog/src/depictions/index.ts';

import { drawingArtProblems, type BrandFace } from '@wirehub/docs';
import type { Db, DrawingArtData } from '@wirehub/model';

import type { ApiResponse } from './api.ts';
import { assetDataUri, decodeImageDataUri, isFontAsset, type AssetMime, type AssetStore } from './assets.ts';
import type { StudioUser } from './me.ts';
import { MAX_FONT_BYTES, brandFace, inspectFont, type FontInfo } from './render/brand-font.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { MAX_LOGO_BYTES, sanitizePng } from './png-sanitize.ts';
import { svgToPng } from './render/raster.ts';
import type { Awaitable } from './storage/change-set.ts';
import type { DocStore } from './storage/doc-store.ts';
import { handleStoreSources, isStoreSourcesPath, type StoreSourceDeps } from './store-settings.ts';

export const BRANDING_PATH = 'data/settings/branding.json';

/** This hub's own drawing art (a data pack's layers under it). */
export const DRAWING_ART_PATH = 'data/drawing-art.json';

export const ENGINEERING_PATH = 'data/settings/engineering.json';

/** Small per-hub UI state that belongs to the hub, not a browser (the dismissed "New hub" strip). */
export const HUB_PATH = 'data/settings/hub.json';

export const SETTINGS_ROUTES = [
  'GET    /api/settings/branding',
  'PUT    /api/settings/branding',
  'GET    /api/settings/engineering',
  'PUT    /api/settings/engineering',
  'GET    /api/settings/hub',
  'PUT    /api/settings/hub',
  'GET    /api/settings/stores',
  'PUT    /api/settings/stores',
] as const;

/** Roles a person can approve a release with. */
export type ApproverRole = 'owner' | 'editor';

/**
 * `data/settings/engineering.json`: how this hub tests, checks and releases.
 * Every section optional; an absent section means the built-in behaviour (and,
 * for `testDefaults`, the `WIREHUB_TEST_DEFAULTS` environment variable). Where the variable
 * sets a parameter it wins over this document, as every runtime setting does.
 */
export interface EngineeringRecord {
  /** the organisation's default continuity test parameters */
  testDefaults?: TestParameters;
  /** thresholds of the electrical rules (`@wirehub/model` electrical.ts) */
  electrical?: ElectricalRules;
  /** the organisation's currency and labour rate for the BOM cost roll-up (cs-5k1.17) */
  costing?: CostingRules;
  /** release approvals on saved versions */
  approvals?: { enabled: boolean; approverRoles?: ApproverRole[] };
  src: string;
}

const ENGINEERING_SRC = 'Hub settings (entered in the app)';

export async function readEngineering(docs: DocStore | undefined): Promise<EngineeringRecord | undefined> {
  return docs === undefined ? undefined : ((await docs.read(ENGINEERING_PATH)) as EngineeringRecord | undefined);
}

/**
 * The test defaults in force, parameter by parameter: what `WIREHUB_TEST_DEFAULTS` sets wins (the
 * settings rule: a variable that is set is "set by the server"), then what Settings saved.
 */
export async function effectiveTestDefaults(deps: { docs?: DocStore; testDefaults?: TestParameters }): Promise<TestParameters | undefined> {
  const set = (await readEngineering(deps.docs))?.testDefaults;
  if (set === undefined && deps.testDefaults === undefined) return undefined;
  const merged = { ...(set ?? {}), ...(deps.testDefaults ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** Whether approvals are on, and who may approve. */
export async function approvalPolicy(docs: DocStore | undefined): Promise<{ enabled: boolean; approverRoles: ApproverRole[] }> {
  const a = (await readEngineering(docs))?.approvals;
  return { enabled: a?.enabled === true, approverRoles: a?.approverRoles !== undefined && a.approverRoles.length > 0 ? a.approverRoles : ['owner'] };
}

/** What is kept in the document. Every field optional: unset = the generic text. */
export interface BrandingRecord {
  organisation?: string;
  standard?: string;
  rights?: string;
  designer?: string;
  /** the prefix of exported wire spec files (default `WSS_`) */
  filePrefix?: string;
  /** the title block's three-line general note */
  notes?: [string, string, string];
  /** the title block's tolerance table: up to five label/value rows */
  tolerances?: [string, string][];
  /** an asset id (sha256) of the sanitised PNG */
  logo?: string;
  /** the typeface the documents are set in: font files by content address (an uploaded asset, or a font a pack ships) */
  font?: { regular: string; bold?: string };
  src: string;
}

/** A brand typeface as the API answers it: the face the sheets register, and which font file it is. */
export interface BrandFaceView extends BrandFace {
  /** the sha256 of the font file */
  id: string;
}

/** What the API returns: the record plus the logo as a data URI and the typeface and art in full, so one request draws a sheet. */
export interface BrandingView extends Omit<BrandingRecord, 'logo' | 'font'> {
  logo?: string;
  logoDataUri?: string;
  /** the chosen typeface with its bytes and measured widths */
  font?: { regular: BrandFaceView; bold?: BrandFaceView };
  /** the drawing art in force: this hub's own file, with its packs' under it */
  art?: DrawingArtData;
}

/** Where the settings read what is not in the asset library: a pack's fonts by content address, the catalog loaded with the packs' data. */
export interface BrandingContext {
  /** bytes by content address (`GET /api/blobs/:sha`): the asset library's files and a pack's */
  blob?: (sha256: string) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined>;
  /** the catalog's library, whose `drawingArt` is this hub's own art with its packs' */
  db?: Db;
}

const TEXT_FIELDS = [
  ['organisation', 80],
  ['filePrefix', 16],
  ['standard', 80],
  ['rights', 160],
  ['designer', 80],
] as const;

const SRC = 'Hub settings (entered in the app)';

/** the title block's tolerance box holds this many rows */
const MAX_TOLERANCE_ROWS = 5;

interface SettingsDeps extends Pick<StoreSourceDeps, 'store' | 'setup'> {
  docs?: DocStore;
  assets?: AssetStore;
  /** bytes by content address: where a font a pack shipped is read */
  blob?: BrandingContext['blob'];
  /** the library with the packs' data layered in (its `drawingArt` is what the sheets draw with) */
  loadDb?: () => Awaitable<Db>;
  /** the installed packs: which fonts they shipped */
  installedPacks?: () => Awaitable<{ packs: readonly { id: string; assets?: Record<string, string> }[] } | undefined>;
  /** the environment's test defaults (`WIREHUB_TEST_DEFAULTS`): parameters it sets win over the engineering settings */
  testDefaults?: TestParameters;
}

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

/** The library the settings read the drawing art from; branding is presentation, so a library that cannot be read leaves the art out. */
async function libraryOf(deps: Pick<SettingsDeps, 'loadDb'>): Promise<Db | undefined> {
  try {
    return deps.loadDb === undefined ? undefined : await deps.loadDb();
  } catch {
    return undefined;
  }
}

/** The bytes of a font by content address: an uploaded asset, else a file a pack shipped. */
async function fontBytes(id: string, assets: AssetStore | undefined, context: BrandingContext): Promise<Uint8Array | undefined> {
  const asset = assets === undefined ? undefined : await assets.get(id);
  if (asset !== undefined) return isFontAsset(asset.record) ? new Uint8Array(asset.bytes) : undefined;
  const packed = await context.blob?.(id);
  return packed?.mediaType.startsWith('font/') === true ? packed.bytes : undefined;
}

/** The branding as the API answers it: the record, the logo's bytes as a data URI, the typeface and the art. */
export async function brandingView(record: BrandingRecord | undefined, assets: AssetStore | undefined, context: BrandingContext = {}): Promise<BrandingView> {
  const art = context.db?.drawingArt;
  const { font: fontRecord, ...rest } = record ?? { src: SRC };
  const found = rest.logo === undefined || assets === undefined ? undefined : await assets.get(rest.logo);
  const face = async (id: string | undefined): Promise<BrandFaceView | undefined> => {
    if (id === undefined) return undefined;
    const bytes = await fontBytes(id, assets, context);
    if (bytes === undefined) return undefined;
    try {
      return { id, ...brandFace(bytes) };
    } catch {
      // a font that no longer reads leaves the documents in the bundled sans
      return undefined;
    }
  };
  const regular = await face(fontRecord?.regular);
  const bold = regular === undefined ? undefined : await face(fontRecord?.bold);
  return {
    ...rest,
    ...(found === undefined ? {} : { logoDataUri: assetDataUri(found.record.mime, found.bytes) }),
    ...(regular === undefined ? {} : { font: { regular, ...(bold === undefined ? {} : { bold }) } }),
    ...(art === undefined ? {} : { art }),
  };
}

function clean(value: unknown, field: string, max: number): { value?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') return { error: `${field} must be text.` };
  const text = value.trim();
  if (text === '') return {};
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return { error: `${field} cannot contain control characters.` };
  if (text.length > max) return { error: `${field} is longer than ${max} characters.` };
  return { value: text };
}

function engineeringView(record: EngineeringRecord | undefined, envDefaults: TestParameters | undefined): Record<string, unknown> {
  return {
    ...(record ?? { src: ENGINEERING_SRC }),
    // read-only context for the page: what applies when a section is left empty
    env: { testDefaults: envDefaults ?? null },
    builtIn: { electrical: DEFAULT_ELECTRICAL_RULES, ampacity: DEFAULT_AMPACITY },
  };
}

async function handleEngineering(method: string, body: unknown, deps: SettingsDeps, ifMatch: string | undefined): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.', 'Hub settings are stored with the catalog.');
  const current = await readEngineering(deps.docs);
  const etag = contentETag(current ?? null);
  if (method === 'GET') return { status: 200, body: engineeringView(current, deps.testDefaults), headers: { ETag: etag } };
  if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
  const guard = checkIfMatch(ifMatch, etag, 'settings', 'engineering');
  if (guard !== undefined) return guard;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, 'Send the settings as a JSON object.');
  const input = body as Record<string, unknown>;
  const next: EngineeringRecord = { src: ENGINEERING_SRC };
  const td = input['testDefaults'];
  {
    const read = td === undefined || td === null ? ({ ok: true, parameters: {} } as const) : readTestParameters(td);
    if (!read.ok) return fail(400, `The test defaults are not valid: ${read.problems.join(' ')}`);
    const parameters: Record<string, number> = { ...read.parameters };
    // a parameter the server's variable sets is not changed here: what was saved is kept (or the server's own value adopted)
    for (const [key, fromServer] of Object.entries(deps.testDefaults ?? {})) {
      const saved = (current?.testDefaults as Record<string, number> | undefined)?.[key];
      const given = parameters[key];
      if (given !== undefined && given !== saved && given !== fromServer) {
        return fail(409, `${key} is set by the server (WIREHUB_TEST_DEFAULTS); it cannot be changed here.`, 'Leave it out, or ask whoever runs the server to unset the variable.');
      }
      if (given === fromServer) continue;
      if (saved === undefined) delete parameters[key];
      else parameters[key] = saved;
    }
    if (Object.keys(parameters).length > 0) next.testDefaults = parameters as TestParameters;
  }
  const el = input['electrical'];
  if (el !== undefined && el !== null) {
    const problems = electricalRulesProblems(el);
    if (problems.length > 0) return fail(400, `The electrical rules are not valid: ${problems.join(' ')}`);
    if (Object.keys(el as object).length > 0) next.electrical = el as ElectricalRules;
  }
  const co = input['costing'];
  if (co !== undefined && co !== null) {
    const problems = costingRulesProblems(co);
    if (problems.length > 0) return fail(400, `The costing settings are not valid: ${problems.join(' ')}`);
    if (Object.keys(co as object).length > 0) next.costing = co as CostingRules;
  }
  const ap = input['approvals'];
  if (ap !== undefined && ap !== null) {
    if (typeof ap !== 'object' || Array.isArray(ap) || typeof (ap as { enabled?: unknown }).enabled !== 'boolean') return fail(400, 'approvals is { enabled: true or false, approverRoles? }.');
    const roles = (ap as { approverRoles?: unknown }).approverRoles;
    if (roles !== undefined && (!Array.isArray(roles) || roles.some((r) => r !== 'owner' && r !== 'editor'))) return fail(400, 'approverRoles is a list of owner and editor.');
    next.approvals = { enabled: (ap as { enabled: boolean }).enabled, ...(roles === undefined || (roles as string[]).length === 0 ? {} : { approverRoles: [...new Set(roles as ApproverRole[])].sort() }) };
  }
  const empty = Object.keys(next).every((k) => k === 'src');
  if (empty) await deps.docs.remove(ENGINEERING_PATH);
  else await deps.docs.write(ENGINEERING_PATH, next);
  const saved = empty ? undefined : next;
  return { status: 200, body: engineeringView(saved, deps.testDefaults), headers: { ETag: contentETag(saved ?? null) } };
}

/**
 * `data/settings/hub.json`: UI state of the hub itself. Today one flag, `welcomeDismissed`: the
 * "New hub" strip on the designs list was closed by someone, for everyone.
 */
export interface HubRecord {
  welcomeDismissed?: boolean;
  src: string;
}

async function handleHub(method: string, body: unknown, deps: SettingsDeps): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.', 'Hub settings are stored with the catalog.');
  const current = (await deps.docs.read(HUB_PATH)) as HubRecord | undefined;
  const view = (record: HubRecord | undefined): ApiResponse => ({ status: 200, body: { welcomeDismissed: record?.welcomeDismissed === true }, headers: { ETag: contentETag(record ?? null) } });
  if (method === 'GET') return view(current);
  if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, 'Send the settings as a JSON object.');
  const given = (body as Record<string, unknown>)['welcomeDismissed'];
  if (given !== undefined && typeof given !== 'boolean') return fail(400, 'welcomeDismissed is true or false.');
  const dismissed = given === undefined ? current?.welcomeDismissed === true : given;
  if (!dismissed) {
    await deps.docs.remove(HUB_PATH);
    return view(undefined);
  }
  const next: HubRecord = { welcomeDismissed: true, src: 'Hub settings (entered in the app)' };
  await deps.docs.write(HUB_PATH, next);
  return view(next);
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

/** One font a hub may choose: uploaded here, or shipped by an installed pack. */
export interface FontChoice {
  /** the sha256 of the font file */
  id: string;
  /** the file's name as uploaded (a pack's: its path) */
  name: string;
  family: string;
  subfamily?: string;
  format: FontInfo['format'];
  source: 'upload' | 'pack';
  /** the pack that ships it */
  pack?: string;
  bytes: number;
  /** the vector PDF embeds it (else those pages keep the bundled sans) */
  embeddable: boolean;
  /** the headless raster PDF of the drawing can draw with it (else it keeps the bundled sans) */
  rasterizable: boolean;
}

const choiceOf = (id: string, name: string, bytes: Uint8Array, source: FontChoice['source'], pack?: string): FontChoice | undefined => {
  try {
    const info = inspectFont(bytes);
    return {
      id,
      name,
      family: info.family,
      ...(info.subfamily === undefined ? {} : { subfamily: info.subfamily }),
      format: info.format,
      source,
      ...(pack === undefined ? {} : { pack }),
      bytes: bytes.length,
      embeddable: info.embeddable,
      rasterizable: info.rasterizable,
    };
  } catch {
    return undefined;
  }
};

/** Every font this hub may choose: the fonts uploaded to its asset library, and those its installed packs ship (`fonts/`). */
export async function listFonts(deps: Pick<SettingsDeps, 'assets' | 'blob' | 'installedPacks'>): Promise<FontChoice[]> {
  const out: FontChoice[] = [];
  for (const summary of (await deps.assets?.list()) ?? []) {
    if (!isFontAsset(summary)) continue;
    const found = await deps.assets?.get(summary.id);
    const choice = found === undefined ? undefined : choiceOf(summary.id, summary.originalName, new Uint8Array(found.bytes), 'upload');
    if (choice !== undefined) out.push(choice);
  }
  for (const pack of (await deps.installedPacks?.())?.packs ?? []) {
    for (const [path, sha] of Object.entries(pack.assets ?? {})) {
      if (!path.startsWith('fonts/') || path.endsWith('.json') || out.some((c) => c.id === sha)) continue;
      const found = await deps.blob?.(sha);
      const choice = found === undefined ? undefined : choiceOf(sha, path, found.bytes, 'pack', pack.id);
      if (choice !== undefined) out.push(choice);
    }
  }
  return out.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
}

const LICENCE_PROMPT = 'Confirm you hold a licence that lets this font be embedded in the documents this hub generates (PDF, HTML sheets and drawings).';

/** Upload a font: checked, and kept as an asset. The caller confirmed the licence. */
async function uploadFont(body: unknown, deps: SettingsDeps, user: StudioUser | undefined): Promise<ApiResponse> {
  if (deps.assets === undefined) return fail(501, 'This studio does not keep a shared asset library.', 'There is nowhere to keep the font.');
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, 'Send { name, data, licence } as JSON.');
  const input = body as { name?: unknown; data?: unknown; licence?: unknown };
  if (input.licence !== true) return fail(400, LICENCE_PROMPT, 'Send "licence": true once you have confirmed it.');
  if (typeof input.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$/.test(input.name.trim())) return fail(400, 'name is the font file\'s name, such as Brand-Regular.ttf.');
  if (typeof input.data !== 'string') return fail(400, 'data is the font file, base64 encoded (or a data: URI).');
  const encoded = input.data.replace(/^data:[^,]*;base64,/, '');
  if (!/^[A-Za-z0-9+/\s]*={0,2}$/.test(encoded)) return fail(400, 'data is the font file, base64 encoded.');
  // bound the work before decoding: base64 is 4/3 of the bytes
  if (encoded.length > Math.ceil((MAX_FONT_BYTES * 4) / 3) + 16) return fail(413, `That font is larger than ${MAX_FONT_BYTES / 1024} KiB.`, 'Use a subset or a static (not variable) face.');
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  let info: FontInfo;
  try {
    info = inspectFont(bytes);
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : 'That font could not be read.');
  }
  const who = user?.name ?? 'someone';
  const src = `Branding font upload (hub settings): ${info.family}${info.subfamily === undefined ? '' : ` ${info.subfamily}`}, ${info.format}. ${who} confirmed a licence that lets documents embed it.`;
  const stored = await deps.assets.put(Buffer.from(bytes), info.mime as AssetMime, input.name.trim(), src);
  const choice = choiceOf(stored.id, stored.originalName, bytes, 'upload');
  return { status: 200, body: { font: choice ?? { id: stored.id, name: stored.originalName } } };
}

/* ------------------------------------------------------------------ *
 * Drawing art
 * ------------------------------------------------------------------ */

/**
 * `{ drawingArt }` for a library whose own art file changed from `before` to `after`: the art the packs add
 * (what the library held, less the keys the old file had) under the new own art.
 */
function layeredArt(merged: DrawingArtData | undefined, before: DrawingArtData | undefined, after: DrawingArtData | undefined): { drawingArt?: DrawingArtData } {
  const out: DrawingArtData = {};
  for (const section of ['faces', 'plugs', 'cutaways'] as const) {
    const packs = Object.fromEntries(Object.entries(merged?.[section] ?? {}).filter(([id]) => before?.[section]?.[id] === undefined));
    const all = { ...packs, ...(after?.[section] ?? {}) };
    if (Object.keys(all).length > 0) out[section] = all;
  }
  return Object.keys(out).length === 0 ? {} : { drawingArt: out };
}

const MAX_ART_BYTES = 2 * 1024 * 1024;
const MAX_ART_ENTRIES = 500;
const ART_SECTIONS = ['faces', 'plugs', 'cutaways'] as const;
const ART_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** This hub's drawing art as entered: only the three sections, ids and SVG checked, every cutaway's SVG stripped of anything active. */
function cleanArt(input: unknown): { art?: DrawingArtData; error?: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { error: 'art is an object with faces, plugs and cutaways.' };
  const raw = input as Record<string, unknown>;
  const stray = Object.keys(raw).filter((k) => k !== 'src' && !(ART_SECTIONS as readonly string[]).includes(k));
  if (stray.length > 0) return { error: `art has only faces, plugs and cutaways, not '${stray[0]}'.` };
  if (JSON.stringify(raw).length > MAX_ART_BYTES) return { error: `The drawing art is larger than ${MAX_ART_BYTES / 1024 / 1024} MiB.` };
  const out: DrawingArtData = {};
  let entries = 0;
  for (const section of ART_SECTIONS) {
    const map = raw[section];
    if (map === undefined) continue;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) return { error: `${section} is an object keyed by definition id.` };
    const kept: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(map)) {
      entries += 1;
      if (!ART_ID.test(id)) return { error: `${section}: '${id}' is not a definition id (lowercase letters, digits, dot, dash).` };
      if (section === 'cutaways' && typeof (value as { svg?: unknown } | null)?.svg === 'string') {
        const clean = stripUnsafeSvg((value as { svg: string }).svg);
        if (clean.svg === undefined) return { error: `The cutaway '${id}' cannot be used: ${clean.error ?? 'it is not an SVG'}.` };
        kept[id] = { ...(value as object), svg: clean.svg };
      } else kept[id] = value;
    }
    if (Object.keys(kept).length > 0) out[section] = kept;
  }
  if (entries > MAX_ART_ENTRIES) return { error: `At most ${MAX_ART_ENTRIES} faces, plugs and cutaways in all.` };
  const problems = drawingArtProblems(out);
  if (problems.length > 0) return { error: `The drawing art cannot be used: ${problems.join('; ')}.` };
  return { art: { src: SRC, ...out } };
}

export async function handleSettingsRequest(method: string, parts: string[], body: unknown, deps: SettingsDeps, ifMatch: string | undefined, user?: StudioUser): Promise<ApiResponse | undefined> {
  if (parts[0] !== 'api' || parts[1] !== 'settings') return undefined;
  if (isStoreSourcesPath(parts)) return await handleStoreSources(method, body, deps, ifMatch, user);
  if (parts[2] === 'engineering' && parts.length === 3) return await handleEngineering(method, body, deps, ifMatch);
  if (parts[2] === 'hub' && parts.length === 3) return await handleHub(method, body, deps);
  if (parts[2] === 'branding' && parts[3] === 'fonts' && parts.length === 4) {
    if (method === 'GET') return { status: 200, body: { fonts: await listFonts(deps), limits: { bytes: MAX_FONT_BYTES, formats: ['ttf', 'otf', 'woff2'] }, licence: LICENCE_PROMPT } };
    if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers GET (the fonts you may choose) and POST (upload one).');
    return await uploadFont(body, deps, user);
  }
  if (parts[2] !== 'branding' || parts.length !== 3) return undefined;
  if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.', 'Hub settings are stored with the catalog.');
  const current = (await deps.docs.read(BRANDING_PATH)) as BrandingRecord | undefined;
  const ownArt = (await deps.docs.read(DRAWING_ART_PATH)) as DrawingArtData | undefined;
  const etag = contentETag({ branding: current ?? null, art: ownArt ?? null });
  const context = async (): Promise<BrandingContext> => {
    const db = await libraryOf(deps);
    return { ...(deps.blob === undefined ? {} : { blob: deps.blob }), ...(db === undefined ? {} : { db }) };
  };
  if (method === 'GET') {
    const view = await brandingView(current, deps.assets, await context());
    // the art this hub entered itself, apart from what packs add (the page edits only its own)
    return { status: 200, body: { ...view, ...(ownArt === undefined ? {} : { ownArt }) }, headers: { ETag: etag } };
  }
  if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
  const guard = checkIfMatch(ifMatch, etag, 'settings', 'branding');
  if (guard !== undefined) return guard;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, 'Send the settings as a JSON object.');
  const input = body as Record<string, unknown>;
  const next: BrandingRecord = { src: SRC };
  for (const [field, max] of TEXT_FIELDS) {
    const got = clean(input[field], field, max);
    if (got.error !== undefined) return fail(400, got.error);
    if (got.value !== undefined) next[field] = got.value;
  }
  if (next.filePrefix !== undefined && !FILE_PREFIX_PATTERN.test(next.filePrefix)) {
    return fail(400, 'filePrefix may use letters, digits, dot, dash and underscore, up to 16 characters.', 'For example WSS_ or ACME-WS-.');
  }
  if (input['notes'] !== undefined && input['notes'] !== null) {
    const notes = input['notes'];
    if (!Array.isArray(notes) || notes.length !== 3) return fail(400, 'notes are three lines of text.');
    const lines: string[] = [];
    for (const [i, line] of notes.entries()) {
      const got = clean(line, `notes line ${i + 1}`, 24);
      if (got.error !== undefined) return fail(400, got.error);
      lines.push(got.value ?? '');
    }
    if (lines.some((l) => l !== '')) next.notes = lines as [string, string, string];
  }
  if (input['tolerances'] !== undefined && input['tolerances'] !== null) {
    const rows = input['tolerances'];
    if (!Array.isArray(rows) || rows.length > MAX_TOLERANCE_ROWS) return fail(400, `tolerances are at most ${MAX_TOLERANCE_ROWS} rows of a label and a value.`);
    const kept: [string, string][] = [];
    for (const [i, row] of rows.entries()) {
      if (!Array.isArray(row) || row.length !== 2) return fail(400, `tolerances row ${i + 1} is a label and a value.`);
      const label = clean(row[0], `tolerances row ${i + 1} label`, 12);
      if (label.error !== undefined) return fail(400, label.error);
      const value = clean(row[1], `tolerances row ${i + 1} value`, 10);
      if (value.error !== undefined) return fail(400, value.error);
      if (label.value === undefined && value.value === undefined) continue;
      kept.push([label.value ?? '', value.value ?? '']);
    }
    if (kept.length > 0) next.tolerances = kept;
  }
  // typeface: { regular, bold? } (font ids from GET .../fonts) sets it, null removes it, absent keeps what is there
  const font = input['font'];
  if (font === undefined) {
    if (current?.font !== undefined) next.font = current.font;
  } else if (font !== null) {
    if (typeof font !== 'object' || Array.isArray(font) || typeof (font as { regular?: unknown }).regular !== 'string') return fail(400, 'font is { regular, bold? } naming fonts you may choose, or null for the standard sans.');
    const choices = await listFonts(deps);
    const wanted = font as { regular: string; bold?: unknown };
    const regular = choices.find((c) => c.id === wanted.regular);
    if (regular === undefined) return fail(400, 'That font is not one this hub holds.', 'Upload it first (POST /api/settings/branding/fonts), or install the pack that ships it.');
    const bold = wanted.bold === undefined || wanted.bold === null ? undefined : choices.find((c) => c.id === wanted.bold);
    if (wanted.bold !== undefined && wanted.bold !== null && bold === undefined) return fail(400, 'The bold font is not one this hub holds.');
    next.font = { regular: regular.id, ...(bold === undefined ? {} : { bold: bold.id }) };
  }
  // drawing art: an object sets this hub's own, null removes it, absent keeps it
  let nextArt: DrawingArtData | undefined = ownArt;
  if (input['art'] !== undefined) {
    if (input['art'] === null) nextArt = undefined;
    else {
      const checked = cleanArt(input['art']);
      if (checked.error !== undefined) return fail(400, checked.error);
      nextArt = checked.art;
    }
  }
  // logo: a data URI sets it, null removes it, absent keeps what is there
  const logo = input['logo'];
  if (logo === undefined) {
    if (current?.logo !== undefined) next.logo = current.logo;
  } else if (logo !== null) {
    if (typeof logo !== 'string') return fail(400, 'logo is a PNG or SVG data URI, or null to remove it.');
    let pngBytes: Uint8Array | undefined;
    let how = 'sanitised to its pixel chunks';
    const svg = /^data:image\/svg\+xml(?:;charset=[\w-]+)?(;base64)?,([\s\S]*)$/i.exec(logo);
    if (svg !== null) {
      // an SVG is cleaned of scripts and external references, then drawn to a PNG: the sheets embed a raster logo
      let source: string;
      try {
        source = svg[1] === undefined ? decodeURIComponent(svg[2] as string) : Buffer.from(svg[2] as string, 'base64').toString('utf8');
      } catch {
        return fail(400, 'The SVG logo could not be read.');
      }
      if (source.length > MAX_LOGO_BYTES) return fail(400, `The logo is larger than ${MAX_LOGO_BYTES / 1024} KiB.`);
      const stripped = stripUnsafeSvg(source);
      if (stripped.svg === undefined) return fail(400, `The SVG logo cannot be used: ${stripped.error ?? 'it is not an SVG'}.`);
      try {
        pngBytes = await svgToPng(stripped.svg, 1024);
      } catch (error) {
        return fail(400, error instanceof Error ? error.message : 'That SVG could not be drawn.');
      }
      how = 'rasterised from an SVG upload';
    } else {
      const decoded = decodeImageDataUri(logo);
      if (decoded === undefined || decoded.mime !== 'image/png') return fail(400, 'The logo must be a PNG or an SVG.', 'JPEG is not accepted: the drawing sheet embeds a raster logo.');
      pngBytes = decoded.bytes;
    }
    const clear = sanitizePng(pngBytes);
    if (!clear.ok) return fail(400, clear.reason);
    if (deps.assets === undefined) return fail(501, 'This studio does not keep a shared asset library.', 'There is nowhere to keep the logo.');
    next.logo = (await deps.assets.put(clear.bytes, 'image/png', 'logo.png', `Organisation logo (hub settings), ${how}.`)).id;
  }
  const empty = Object.keys(next).every((k) => k === 'src');
  if (empty) await deps.docs.remove(BRANDING_PATH);
  else await deps.docs.write(BRANDING_PATH, next);
  if (nextArt === undefined) {
    if (ownArt !== undefined) await deps.docs.remove(DRAWING_ART_PATH);
  } else if (nextArt !== ownArt) await deps.docs.write(DRAWING_ART_PATH, nextArt);
  const saved = empty ? undefined : next;
  // the answer shows the art as it will draw: this hub's own over what its packs add (the library as read before this save, less the keys this hub's file held)
  const library = await libraryOf(deps);
  const view = await brandingView(saved, deps.assets, { ...(deps.blob === undefined ? {} : { blob: deps.blob }), ...(library === undefined ? {} : { db: { ...library, ...layeredArt(library.drawingArt, ownArt, nextArt) } }) });
  return { status: 200, body: { ...view, ...(nextArt === undefined ? {} : { ownArt: nextArt }) }, headers: { ETag: contentETag({ branding: saved ?? null, art: nextArt ?? null }) } };
}
