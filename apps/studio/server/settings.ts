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
 * by id. Nothing here is a document renderer: the browser registers what this
 * returns as drawing art (`installBranding`, `module-art.ts`), after a module's art,
 * so a module still wins and an empty setting leaves the generic text.
 */

import type { ApiResponse } from './api.ts';
import { assetDataUri, decodeImageDataUri, type AssetStore } from './assets.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { sanitizePng } from './png-sanitize.ts';
import type { DocStore } from './storage/doc-store.ts';

export const BRANDING_PATH = 'data/settings/branding.json';

export const SETTINGS_ROUTES = ['GET    /api/settings/branding', 'PUT    /api/settings/branding'] as const;

/** What is kept in the document. Every field optional: unset = the generic text. */
export interface BrandingRecord {
  organisation?: string;
  standard?: string;
  rights?: string;
  designer?: string;
  /** the title block's three-line general note */
  notes?: [string, string, string];
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
  ['standard', 80],
  ['rights', 160],
  ['designer', 80],
] as const;

const SRC = 'Hub settings (entered in the app)';

interface SettingsDeps {
  docs?: DocStore;
  assets?: AssetStore;
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

export async function handleSettingsRequest(method: string, parts: string[], body: unknown, deps: SettingsDeps, ifMatch: string | undefined): Promise<ApiResponse | undefined> {
  if (parts[0] !== 'api' || parts[1] !== 'settings') return undefined;
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
  // logo: a data URI sets it, null removes it, absent keeps what is there
  const logo = input['logo'];
  if (logo === undefined) {
    if (current?.logo !== undefined) next.logo = current.logo;
  } else if (logo !== null) {
    if (typeof logo !== 'string') return fail(400, 'logo is a PNG data URI, or null to remove it.');
    const decoded = decodeImageDataUri(logo);
    if (decoded === undefined || decoded.mime !== 'image/png') return fail(400, 'The logo must be a PNG.', 'SVG and JPEG are not accepted: the drawing sheet embeds a raster logo.');
    const clear = sanitizePng(decoded.bytes);
    if (!clear.ok) return fail(400, clear.reason);
    if (deps.assets === undefined) return fail(501, 'This studio does not keep a shared asset library.', 'There is nowhere to keep the logo.');
    next.logo = (await deps.assets.put(clear.bytes, 'image/png', 'logo.png', 'Organisation logo (hub settings), sanitised to its pixel chunks.')).id;
  }
  const empty = Object.keys(next).every((k) => k === 'src');
  if (empty) await deps.docs.remove(BRANDING_PATH);
  else await deps.docs.write(BRANDING_PATH, next);
  const saved = empty ? undefined : next;
  return { status: 200, body: await view(saved, deps.assets), headers: { ETag: contentETag(saved ?? null) } };
}
