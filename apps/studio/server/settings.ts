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
 */

import { costingRulesProblems, electricalRulesProblems, type CostingRules, DEFAULT_AMPACITY, DEFAULT_ELECTRICAL_RULES, type ElectricalRules } from '@wirehub/model';
import { FILE_PREFIX_PATTERN, readTestParameters, type TestParameters } from '@wirehub/docs';
import { stripUnsafeSvg } from '@wirehub/catalog/src/depictions/index.ts';

import type { ApiResponse } from './api.ts';
import { assetDataUri, decodeImageDataUri, type AssetStore } from './assets.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { MAX_LOGO_BYTES, sanitizePng } from './png-sanitize.ts';
import { svgToPng } from './render/raster.ts';
import type { DocStore } from './storage/doc-store.ts';

export const BRANDING_PATH = 'data/settings/branding.json';

export const ENGINEERING_PATH = 'data/settings/engineering.json';

export const SETTINGS_ROUTES = [
  'GET    /api/settings/branding',
  'PUT    /api/settings/branding',
  'GET    /api/settings/engineering',
  'PUT    /api/settings/engineering',
] as const;

/** Roles a person can approve a release with. */
export type ApproverRole = 'owner' | 'editor';

/**
 * `data/settings/engineering.json`: how this hub tests, checks and releases.
 * Every section optional; an absent section means the built-in behaviour (and,
 * for `testDefaults`, the `WIREHUB_TEST_DEFAULTS` environment variable).
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

/** The test defaults in force: the environment's (fallback) with the settings page's laid over, parameter by parameter. */
export async function effectiveTestDefaults(deps: { docs?: DocStore; testDefaults?: TestParameters }): Promise<TestParameters | undefined> {
  const set = (await readEngineering(deps.docs))?.testDefaults;
  if (set === undefined && deps.testDefaults === undefined) return undefined;
  const merged = { ...(deps.testDefaults ?? {}), ...(set ?? {}) };
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
  src: string;
}

/** What the API returns: the record plus the logo as a data URI, so one request draws a sheet. */
export interface BrandingView extends Omit<BrandingRecord, 'logo'> {
  logo?: string;
  logoDataUri?: string;
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

interface SettingsDeps {
  docs?: DocStore;
  assets?: AssetStore;
  /** the environment's test defaults (`WIREHUB_TEST_DEFAULTS`): the fallback the engineering settings override */
  testDefaults?: TestParameters;
}

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

async function view(record: BrandingRecord | undefined, assets: AssetStore | undefined): Promise<BrandingView> {
  if (record === undefined) return { src: SRC };
  const found = record.logo === undefined || assets === undefined ? undefined : await assets.get(record.logo);
  return { ...record, ...(found === undefined ? {} : { logoDataUri: assetDataUri(found.record.mime, found.bytes) }) };
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
  if (td !== undefined && td !== null) {
    const read = readTestParameters(td);
    if (!read.ok) return fail(400, `The test defaults are not valid: ${read.problems.join(' ')}`);
    if (Object.keys(read.parameters).length > 0) next.testDefaults = read.parameters;
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

export async function handleSettingsRequest(method: string, parts: string[], body: unknown, deps: SettingsDeps, ifMatch: string | undefined): Promise<ApiResponse | undefined> {
  if (parts[0] !== 'api' || parts[1] !== 'settings') return undefined;
  if (parts[2] === 'engineering' && parts.length === 3) return await handleEngineering(method, body, deps, ifMatch);
  if (parts[2] !== 'branding' || parts.length !== 3) return undefined;
  if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.', 'Hub settings are stored with the catalog.');
  const current = (await deps.docs.read(BRANDING_PATH)) as BrandingRecord | undefined;
  const etag = contentETag(current ?? null);
  if (method === 'GET') return { status: 200, body: await view(current, deps.assets), headers: { ETag: etag } };
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
  const saved = empty ? undefined : next;
  return { status: 200, body: await view(saved, deps.assets), headers: { ETag: contentETag(saved ?? null) } };
}
